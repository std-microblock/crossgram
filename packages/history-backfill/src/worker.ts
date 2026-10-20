import type {
  ActivePlatformSession, HistoryBackfillPage, HistorySyncConversation, IMHistoryQuery, StoredMessageAnchor,
} from '@mtproto-relay/bridge'
import { SequenceCoverage } from './coverage.js'
import type {
  BackfillConversationSnapshot, BackfillEvent, BackfillFloorReason, BackfillMode, BackfillSessionSnapshot,
  BackfillSessionStatus, BackfillSettings, BackfillSnapshot,
} from './types.js'

/** 回填依赖的 bridge 能力（即 `ctx.historySync` 的子集），便于测试替换。 */
export interface BackfillHost {
  sessions(): ActivePlatformSession[]
  lastActivityAt(platformSessionId: string): number | undefined
  supportsHistory(binding: ActivePlatformSession): boolean
  supportsSequenceHistory(binding: ActivePlatformSession): boolean
  listConversations(platformSessionId: string): Promise<HistorySyncConversation[]>
  readStoredSequences(
    platformSessionId: string, conversationId: string, options: { below?: number, limit: number },
  ): Promise<number[]>
  oldestStoredMessage(platformSessionId: string, conversationId: string): Promise<StoredMessageAnchor | undefined>
  backfill(
    binding: Pick<ActivePlatformSession, 'platform' | 'session'>,
    conversationId: string,
    query: IMHistoryQuery,
  ): Promise<HistoryBackfillPage>
}

export interface BackfillWorkerOptions extends BackfillSettings {
  enabled: boolean
  /** 会话列表的刷新周期。 */
  conversationRefreshMs?: number
  /** 初始化覆盖区间时每批读取的已存序号数量。 */
  bootstrapBatch?: number
  now?: () => number
  random?: () => number
  log?: (level: 'info' | 'warn' | 'debug', format: string, ...args: unknown[]) => void
}

const DAY_MS = 86_400_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 6 * 60 * 60_000
const RECENT_EVENTS = 50

interface ConversationState {
  conversationId: string
  title: string
  kind: string
  mode: BackfillMode
  /** 本地没有任何序号可用，已从序号模式降级为锚点模式。 */
  demoted?: boolean
  coverage: SequenceCoverage
  bootstrapped: boolean
  upperSequence?: number
  floorReached: boolean
  floorReason?: BackfillFloorReason
  oldest?: { id: string, timestamp: number }
  requests: number
  fetched: number
  inserted: number
  failures: number
  nextAttemptAt: number
  lastRunAt?: number
  lastError?: string
}

interface SessionState {
  platformSessionId: string
  platformId: string
  conversations: Map<string, ConversationState>
  /** 按最近活跃时间倒序的会话 ID。 */
  order: string[]
  loadedAt?: number
  dayKey: string
  requestsToday: number
  status: BackfillSessionStatus
}

type Work =
  | { kind: 'gap', state: ConversationState, low: number, high: number }
  | { kind: 'floor', state: ConversationState }

/**
 * 空闲时慢慢回读各会话的历史，把缺失的部分补回本地库。
 *
 * - 群聊（平台支持按序号读取时）：用已存 msgSeq 推导覆盖区间，先补顶部和中间的空洞，再向更早方向追溯。
 * - 私聊或不支持序号的平台：以本地最早一条为锚点向前翻页，直到上游没有更多。
 *
 * 全部状态只保存在内存里；重启后会根据库内已存序号重新推导。每次 tick 最多发出一个上游请求，
 * 只在账号最近 `idleAfterMs` 内没有客户端操作时工作，并受每日请求上限约束。
 */
export class HistoryBackfillWorker {
  enabled: boolean
  private readonly _sessions = new Map<string, SessionState>()
  private readonly _recent: BackfillEvent[] = []
  private _busy = false
  private _cursor = 0
  private readonly _now: () => number
  private readonly _random: () => number

  constructor(private readonly _host: BackfillHost, private _options: BackfillWorkerOptions) {
    this.enabled = _options.enabled
    this._now = _options.now ?? Date.now
    this._random = _options.random ?? Math.random
  }

  get settings(): BackfillSettings {
    const { idleAfterMs, intervalMs, pageSize, dailyRequestCap, maxAgeDays } = this._options
    return { idleAfterMs, intervalMs, pageSize, dailyRequestCap, maxAgeDays }
  }

  get busy(): boolean {
    return this._busy
  }

  /** 下一次 tick 的延迟，在 `intervalMs` 基础上加最多 50% 的随机抖动。 */
  nextDelay(): number {
    return Math.round(this._options.intervalMs * (1 + this._random() * 0.5))
  }

  resetConversation(platformSessionId: string, conversationId: string): boolean {
    const state = this._sessions.get(platformSessionId)?.conversations.get(conversationId)
    if (!state) return false
    state.failures = 0
    state.nextAttemptAt = 0
    state.floorReached = false
    state.floorReason = undefined
    state.lastError = undefined
    return true
  }

  /** 执行一轮：最多一个上游请求。返回是否发出了请求。 */
  async tick(): Promise<boolean> {
    if (this._busy) return false
    this._busy = true
    try {
      return await this._tick()
    } finally {
      this._busy = false
    }
  }

  private async _tick(): Promise<boolean> {
    const bindings = this._host.sessions()
    this._forgetInactive(bindings)
    if (!bindings.length) return false
    const now = this._now()
    for (let offset = 0; offset < bindings.length; offset++) {
      const binding = bindings[(this._cursor + offset) % bindings.length]
      const session = this._session(binding, now)
      if (!this.enabled) {
        session.status = 'disabled'
        continue
      }
      if (!this._host.supportsHistory(binding)) {
        session.status = 'unsupported'
        continue
      }
      if (session.requestsToday >= this._options.dailyRequestCap) {
        session.status = 'capped'
        continue
      }
      const lastActivity = this._host.lastActivityAt(binding.session.platformSessionId)
      if (lastActivity !== undefined && now - lastActivity < this._options.idleAfterMs) {
        session.status = 'waiting-idle'
        continue
      }
      await this._refreshConversations(binding, session, now)
      const work = await this._nextWork(session, now)
      if (!work) {
        session.status = 'done'
        continue
      }
      session.status = 'working'
      this._cursor = (this._cursor + offset + 1) % bindings.length
      await this._run(binding, session, work)
      return true
    }
    return false
  }

  private _forgetInactive(bindings: readonly ActivePlatformSession[]): void {
    const active = new Set(bindings.map((binding) => binding.session.platformSessionId))
    for (const id of this._sessions.keys()) if (!active.has(id)) this._sessions.delete(id)
  }

  private _session(binding: ActivePlatformSession, now: number): SessionState {
    const id = binding.session.platformSessionId
    let session = this._sessions.get(id)
    if (!session) {
      session = {
        platformSessionId: id,
        platformId: binding.session.platformId,
        conversations: new Map(),
        order: [],
        dayKey: dayKey(now),
        requestsToday: 0,
        status: 'waiting-idle',
      }
      this._sessions.set(id, session)
    }
    const today = dayKey(now)
    if (session.dayKey !== today) {
      session.dayKey = today
      session.requestsToday = 0
    }
    return session
  }

  private async _refreshConversations(binding: ActivePlatformSession, session: SessionState, now: number): Promise<void> {
    const refreshMs = this._options.conversationRefreshMs ?? 10 * 60_000
    if (session.loadedAt !== undefined && now - session.loadedAt < refreshMs) return
    const sequenceCapable = this._host.supportsSequenceHistory(binding)
    const conversations = await this._host.listConversations(session.platformSessionId)
    session.loadedAt = now
    session.order = []
    for (const conversation of conversations) {
      if (conversation.localOnly) continue
      const mode: BackfillMode = sequenceCapable && conversation.kind !== 'direct' ? 'sequence' : 'anchor'
      let state = session.conversations.get(conversation.conversationId)
      if (!state || (state.mode !== mode && !state.demoted)) {
        state = {
          conversationId: conversation.conversationId,
          title: conversation.title,
          kind: conversation.kind,
          mode,
          coverage: new SequenceCoverage(),
          bootstrapped: false,
          floorReached: false,
          requests: 0,
          fetched: 0,
          inserted: 0,
          failures: 0,
          nextAttemptAt: 0,
        }
        session.conversations.set(conversation.conversationId, state)
      }
      state.title = conversation.title
      state.kind = conversation.kind
      const upper = conversation.lastMessage?.sequence
      if (upper !== undefined && (state.upperSequence === undefined || upper > state.upperSequence)) {
        state.upperSequence = upper
      }
      session.order.push(conversation.conversationId)
    }
  }

  private async _nextWork(session: SessionState, now: number): Promise<Work | undefined> {
    const ready = session.order
      .map((id) => session.conversations.get(id))
      .filter((state): state is ConversationState => Boolean(state) && state!.nextAttemptAt <= now)
    // 先补所有会话顶部与中间的空洞（缺口离当前最近，用户最可能翻到），再统一向更早方向追溯。
    for (const state of ready) {
      if (state.mode !== 'sequence') continue
      if (!state.bootstrapped) await this._bootstrap(session, state)
      const gap = state.coverage.highestGap(state.upperSequence)
      if (gap) return { kind: 'gap', state, low: gap.low, high: gap.high }
    }
    for (const state of ready) {
      if (!state.floorReached) return { kind: 'floor', state }
    }
    return undefined
  }

  private async _bootstrap(session: SessionState, state: ConversationState): Promise<void> {
    const batch = this._options.bootstrapBatch ?? 5_000
    const sequences: number[] = []
    let below: number | undefined
    for (;;) {
      const page = await this._host.readStoredSequences(session.platformSessionId, state.conversationId, {
        below, limit: batch,
      })
      sequences.push(...page)
      if (page.length < batch) break
      const next = page.at(-1)!
      if (below !== undefined && next >= below) break
      below = next
    }
    const rebuilt = SequenceCoverage.fromSequences(sequences)
    for (const span of state.coverage.spans) rebuilt.add(span.start, span.end)
    state.coverage = rebuilt
    state.bootstrapped = true
  }

  private async _run(binding: ActivePlatformSession, session: SessionState, work: Work): Promise<void> {
    const { state } = work
    const now = this._now()
    state.lastRunAt = now
    let query: IMHistoryQuery
    let range: string
    let lowerBound: number | undefined
    if (work.kind === 'gap') {
      const limit = Math.max(1, Math.min(this._options.pageSize, work.high - work.low + 1))
      query = { beforeSequence: String(work.high), limit }
      range = `seq ${work.low}-${work.high}`
      lowerBound = work.low
    } else if (state.mode === 'sequence') {
      const min = state.coverage.min
      if (min !== undefined && min <= 1) {
        this._floor(state, 'start')
        return
      }
      if (min === undefined) {
        // 本地一条带序号的消息都没有、也不知道最新序号：退回按锚点向前翻页。
        state.mode = 'anchor'
        state.demoted = true
        return this._run(binding, session, work)
      }
      query = { beforeSequence: String(min - 1), limit: this._options.pageSize }
      range = `seq <${min}`
    } else {
      const anchor = state.oldest
        ?? await this._host.oldestStoredMessage(session.platformSessionId, state.conversationId)
      if (!anchor) {
        this._floor(state, 'empty')
        return
      }
      state.oldest = { id: anchor.id, timestamp: anchor.timestamp }
      if (this._beyondAge(anchor.timestamp, now)) {
        this._floor(state, 'age')
        return
      }
      query = { before: { id: anchor.id, timestamp: anchor.timestamp }, limit: this._options.pageSize }
      range = `before ${anchor.id}`
    }

    session.requestsToday++
    state.requests++
    let page: HistoryBackfillPage
    try {
      page = await this._host.backfill(binding, state.conversationId, query)
    } catch (error) {
      state.failures++
      state.lastError = error instanceof Error ? error.message : String(error)
      state.nextAttemptAt = now + Math.min(BACKOFF_BASE_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS)
      this._record(session, state, work.kind, range, 0, 0, state.lastError)
      this._options.log?.('warn', 'history backfill failed session=%s conversation=%s range=%s error=%s',
        session.platformSessionId, state.conversationId, range, state.lastError)
      return
    }
    state.failures = 0
    state.lastError = undefined
    state.nextAttemptAt = 0
    state.fetched += page.fetched
    state.inserted += page.inserted
    if (page.oldest && (!state.oldest || page.oldest.timestamp < state.oldest.timestamp)) state.oldest = page.oldest

    if (query.beforeSequence !== undefined) {
      const high = Number(query.beforeSequence)
      const rawMin = page.coverage ? Number(page.coverage.minSequence) : undefined
      if (rawMin !== undefined && Number.isSafeInteger(rawMin) && rawMin <= high) {
        // 上游从 high 往下连续返回到 rawMin，区间内缺的序号已确认不存在或不可见。
        state.coverage.add(rawMin, high)
        if (rawMin <= 1) this._floor(state, 'start')
      } else if (work.kind === 'gap') {
        state.coverage.add(lowerBound ?? high, high)
      } else {
        // 更早方向没有任何记录：已经到会话起点（或上游可读范围的起点）。
        state.coverage.add(1, high)
        this._floor(state, 'start')
      }
    } else {
      const anchorId = query.before?.id
      // 上游没有更早的消息，或翻页没有前进（只返回了锚点本身）：视为已到起点。
      if (page.fetched === 0 || !page.oldest || page.oldest.id === anchorId) this._floor(state, 'start')
    }
    if (work.kind === 'floor' && !state.floorReached && state.oldest && this._beyondAge(state.oldest.timestamp, now)) {
      this._floor(state, 'age')
    }
    this._record(session, state, work.kind, range, page.fetched, page.inserted)
    this._options.log?.('debug', 'history backfill session=%s conversation=%s mode=%s kind=%s range=%s fetched=%d inserted=%d',
      session.platformSessionId, state.conversationId, state.mode, work.kind, range, page.fetched, page.inserted)
  }

  private _beyondAge(timestamp: number, now: number): boolean {
    const maxAgeDays = this._options.maxAgeDays
    return maxAgeDays > 0 && timestamp * 1000 < now - maxAgeDays * DAY_MS
  }

  private _floor(state: ConversationState, reason: BackfillFloorReason): void {
    state.floorReached = true
    state.floorReason = reason
  }

  private _record(
    session: SessionState, state: ConversationState, kind: 'gap' | 'floor', range: string,
    fetched: number, inserted: number, error?: string,
  ): void {
    this._recent.unshift({
      at: this._now(),
      platformSessionId: session.platformSessionId,
      conversationId: state.conversationId,
      title: state.title,
      mode: state.mode,
      kind,
      range,
      fetched,
      inserted,
      ...(error ? { error } : {}),
    })
    this._recent.length = Math.min(this._recent.length, RECENT_EVENTS)
  }

  snapshot(): BackfillSnapshot {
    return {
      enabled: this.enabled,
      busy: this._busy,
      settings: this.settings,
      sessions: [...this._sessions.values()].map((session) => this._sessionSnapshot(session)),
      recent: this._recent.map((event) => ({ ...event })),
    }
  }

  private _sessionSnapshot(session: SessionState): BackfillSessionSnapshot {
    const conversations = session.order.flatMap((id) => {
      const state = session.conversations.get(id)
      return state ? [conversationSnapshot(state)] : []
    })
    const lastActivityAt = this._host.lastActivityAt(session.platformSessionId)
    return {
      platformSessionId: session.platformSessionId,
      platformId: session.platformId,
      status: this.enabled ? session.status : 'disabled',
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      requestsToday: session.requestsToday,
      dailyRequestCap: this._options.dailyRequestCap,
      totals: {
        conversations: conversations.length,
        complete: conversations.filter((item) => item.floorReached && item.gapCount === 0).length,
        gaps: conversations.reduce((sum, item) => sum + item.gapCount, 0),
        missing: conversations.reduce((sum, item) => sum + item.missing, 0),
        fetched: conversations.reduce((sum, item) => sum + item.fetched, 0),
        inserted: conversations.reduce((sum, item) => sum + item.inserted, 0),
      },
      conversations,
    }
  }
}

function conversationSnapshot(state: ConversationState): BackfillConversationSnapshot {
  const gaps = state.mode === 'sequence' && state.bootstrapped
    ? state.coverage.gapStats(state.upperSequence)
    : { count: 0, missing: 0 }
  return {
    conversationId: state.conversationId,
    title: state.title,
    kind: state.kind,
    mode: state.mode,
    bootstrapped: state.bootstrapped,
    spans: state.coverage.size,
    covered: state.coverage.covered,
    ...(state.coverage.min !== undefined ? { minSequence: state.coverage.min } : {}),
    ...(state.coverage.max !== undefined ? { maxSequence: state.coverage.max } : {}),
    ...(state.upperSequence !== undefined ? { upperSequence: state.upperSequence } : {}),
    gapCount: gaps.count,
    missing: gaps.missing,
    floorReached: state.floorReached,
    ...(state.floorReason ? { floorReason: state.floorReason } : {}),
    ...(state.oldest ? { oldestTimestamp: state.oldest.timestamp } : {}),
    requests: state.requests,
    fetched: state.fetched,
    inserted: state.inserted,
    failures: state.failures,
    ...(state.nextAttemptAt ? { nextAttemptAt: state.nextAttemptAt } : {}),
    ...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  }
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}
