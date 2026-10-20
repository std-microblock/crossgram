import { describe, expect, it, vi } from 'vitest'
import type { ActivePlatformSession, HistorySyncConversation, IMHistoryQuery } from '@mtproto-relay/bridge'
import { HistoryBackfillWorker, type BackfillHost, type BackfillWorkerOptions } from './worker.js'

const NOW = Date.UTC(2027, 0, 15, 12)

interface FakeConversation {
  conversation: HistorySyncConversation
  /** 上游存在的序号 → 时间戳；`hidden` 表示撤回/灰条（计入原始区间但不返回消息）。 */
  upstream: Map<number, { timestamp: number, hidden?: boolean }>
  stored: Set<number>
  /** 私聊：按时间排序的上游消息 ID。 */
  directIds?: string[]
}

function binding(id = 'session-a', sequenceHistory = true): ActivePlatformSession {
  return {
    registrationId: id,
    session: { platformSessionId: id, platformId: 'qq', userId: 'self', credentials: {}, metadata: {} },
    platform: {
      capabilities: {
        history: true,
        ...(sequenceHistory ? { sequenceHistory: 'group' as const } : {}),
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 1, maxMedia: 1 },
        conversations: { groups: true, channels: true, subchannels: true },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getHistory() { return { messages: [] } },
    },
  } as ActivePlatformSession
}

function group(id: string, upstreamMax: number, stored: number[], options: {
  hidden?: number[], startAt?: number, timestamp?: (sequence: number) => number,
} = {}): FakeConversation {
  const upstream = new Map<number, { timestamp: number, hidden?: boolean }>()
  for (let sequence = options.startAt ?? 1; sequence <= upstreamMax; sequence++) {
    upstream.set(sequence, {
      timestamp: options.timestamp?.(sequence) ?? NOW / 1000 - (upstreamMax - sequence) * 60,
      ...(options.hidden?.includes(sequence) ? { hidden: true } : {}),
    })
  }
  return {
    conversation: {
      conversationId: id, kind: 'group', title: id, localOnly: false,
      lastMessage: { id: `${id}-${upstreamMax}`, timestamp: NOW / 1000, sequence: upstreamMax },
    },
    upstream,
    stored: new Set(stored),
  }
}

function createHost(conversations: FakeConversation[], bindings = [binding()]) {
  let lastActivity: number | undefined
  const calls: Array<{ conversationId: string, query: IMHistoryQuery }> = []
  const byId = new Map(conversations.map((item) => [item.conversation.conversationId, item]))
  const host: BackfillHost = {
    sessions: () => bindings,
    lastActivityAt: () => lastActivity,
    supportsHistory: () => true,
    supportsSequenceHistory: (item) => item.platform.capabilities.sequenceHistory === 'group',
    listConversations: async () => conversations.map((item) => item.conversation),
    readStoredSequences: async (_session, conversationId, options) => [...byId.get(conversationId)!.stored]
      .filter((value) => options.below === undefined || value < options.below)
      .sort((left, right) => right - left)
      .slice(0, options.limit),
    oldestStoredMessage: async (_session, conversationId) => {
      const item = byId.get(conversationId)!
      const id = item.directIds?.find((value) => item.stored.has(Number(value.slice(1))))
      return id ? { id, timestamp: Number(id.slice(1)) } : undefined
    },
    backfill: vi.fn(async (_binding, conversationId, query) => {
      calls.push({ conversationId, query })
      const item = byId.get(conversationId)!
      if (query.beforeSequence !== undefined) {
        const high = Number(query.beforeSequence)
        const records = [...item.upstream.entries()]
          .filter(([sequence]) => sequence <= high)
          .sort((left, right) => right[0] - left[0])
          .slice(0, query.limit ?? 50)
        const visible = records.filter(([, value]) => !value.hidden)
        let inserted = 0
        for (const [sequence] of visible) {
          if (!item.stored.has(sequence)) inserted++
          item.stored.add(sequence)
        }
        const oldest = visible.at(-1)
        return {
          fetched: visible.length,
          inserted,
          ...(oldest ? { oldest: { id: `${conversationId}-${oldest[0]}`, timestamp: oldest[1].timestamp } } : {}),
          ...(records.length ? {
            coverage: { minSequence: String(records.at(-1)![0]), maxSequence: String(records[0][0]) },
          } : {}),
        }
      }
      const ids = item.directIds!
      const anchorIndex = ids.indexOf(query.before!.id)
      const page = ids.slice(Math.max(0, anchorIndex - (query.limit ?? 50)), anchorIndex)
      for (const id of page) item.stored.add(Number(id.slice(1)))
      return {
        fetched: page.length,
        inserted: page.length,
        ...(page.length ? { oldest: { id: page[0], timestamp: Number(page[0].slice(1)) } } : {}),
      }
    }),
  }
  return { host, calls, setActivity: (value: number | undefined) => { lastActivity = value }, byId }
}

function createWorker(host: BackfillHost, overrides: Partial<BackfillWorkerOptions> = {}, clock = { now: NOW }) {
  return new HistoryBackfillWorker(host, {
    enabled: true, idleAfterMs: 60_000, intervalMs: 1_000, pageSize: 50, dailyRequestCap: 1_000, maxAgeDays: 0,
    now: () => clock.now, random: () => 0, ...overrides,
  })
}

async function drain(worker: HistoryBackfillWorker, limit = 200): Promise<number> {
  let requests = 0
  for (let index = 0; index < limit; index++) {
    if (!await worker.tick()) break
    requests++
  }
  return requests
}

describe('HistoryBackfillWorker', () => {
  it('fills the top gap, then middle gaps, then walks back to the first message', async () => {
    const room = group('room', 300, [...range(100, 120), ...range(250, 280)])
    const { host, calls } = createHost([room])
    const worker = createWorker(host)

    await drain(worker)

    expect(room.stored.size).toBe(300)
    // 第一请求补顶部（停机期间缺的 281-300），随后是 121-249 的中间空洞，最后才向 99 以下追溯。
    expect(calls[0].query).toEqual({ beforeSequence: '300', limit: 20 })
    expect(calls[1].query).toEqual({ beforeSequence: '249', limit: 50 })
    expect(calls.findIndex((call) => Number(call.query.beforeSequence) < 100))
      .toBeGreaterThan(calls.findIndex((call) => call.query.beforeSequence === '249'))
    const snapshot = worker.snapshot().sessions[0].conversations[0]
    expect(snapshot).toMatchObject({
      mode: 'sequence', floorReached: true, floorReason: 'start', gapCount: 0, minSequence: 1, maxSequence: 300,
    })
    expect(await worker.tick()).toBe(false)
    expect(worker.snapshot().sessions[0].status).toBe('done')
  })

  it('treats recalled or filtered sequences inside the raw range as covered instead of refetching them', async () => {
    const room = group('room', 40, [40], { hidden: range(10, 39) })
    const { host, calls } = createHost([room])
    const worker = createWorker(host, { pageSize: 50 })

    await drain(worker)

    expect(calls).toHaveLength(1)
    expect(calls[0].query).toEqual({ beforeSequence: '39', limit: 50 })
    expect(worker.snapshot().sessions[0].conversations[0]).toMatchObject({
      gapCount: 0, floorReached: true, covered: 40,
    })
  })

  it('stops walking back at the upstream start even when it is above sequence 1', async () => {
    const room = group('room', 120, range(100, 120), { startAt: 80 })
    const { host, calls } = createHost([room])
    const worker = createWorker(host, { pageSize: 10 })

    await drain(worker)

    expect(room.stored.size).toBe(41)
    expect(calls.at(-1)?.query).toEqual({ beforeSequence: '79', limit: 10 })
    expect(worker.snapshot().sessions[0].conversations[0]).toMatchObject({ floorReached: true, floorReason: 'start' })
  })

  it('stops walking back past the configured maximum age', async () => {
    const room = group('room', 1000, [1000], { timestamp: (sequence) => NOW / 1000 - (1000 - sequence) * 3600 })
    const { host } = createHost([room])
    const worker = createWorker(host, { maxAgeDays: 2, pageSize: 20 })

    await drain(worker)

    const state = worker.snapshot().sessions[0].conversations[0]
    expect(state).toMatchObject({ floorReached: true, floorReason: 'age' })
    expect(room.stored.size).toBeGreaterThanOrEqual(48)
    expect(room.stored.size).toBeLessThan(80)
  })

  it('only works while the account is idle and respects the daily request cap', async () => {
    const room = group('room', 500, [500])
    const clock = { now: NOW }
    const { host, setActivity, calls } = createHost([room])
    const worker = createWorker(host, { dailyRequestCap: 3, pageSize: 10 }, clock)

    setActivity(NOW - 10_000)
    expect(await worker.tick()).toBe(false)
    expect(worker.snapshot().sessions[0].status).toBe('waiting-idle')

    clock.now = NOW + 60_000
    expect(await drain(worker)).toBe(3)
    expect(worker.snapshot().sessions[0]).toMatchObject({ status: 'capped', requestsToday: 3 })

    clock.now = NOW + 86_400_000
    expect(await worker.tick()).toBe(true)
    expect(calls).toHaveLength(4)
  })

  it('backs off a failing conversation and lets the WebUI reset it', async () => {
    const room = group('room', 100, [100])
    const clock = { now: NOW }
    const { host } = createHost([room])
    vi.mocked(host.backfill).mockRejectedValueOnce(new Error('kernel busy')).mockRejectedValueOnce(new Error('kernel busy'))
    const worker = createWorker(host, {}, clock)

    expect(await worker.tick()).toBe(true)
    let state = worker.snapshot().sessions[0].conversations[0]
    expect(state).toMatchObject({ failures: 1, lastError: 'kernel busy', nextAttemptAt: NOW + 30_000 })
    expect(await worker.tick()).toBe(false)

    clock.now = NOW + 30_000
    expect(await worker.tick()).toBe(true)
    state = worker.snapshot().sessions[0].conversations[0]
    expect(state).toMatchObject({ failures: 2, nextAttemptAt: NOW + 30_000 + 60_000 })
    expect(worker.snapshot().recent[0]).toMatchObject({ error: 'kernel busy', kind: 'floor' })

    expect(worker.resetConversation('session-a', 'room')).toBe(true)
    expect(await worker.tick()).toBe(true)
    expect(worker.snapshot().sessions[0].conversations[0]).toMatchObject({ failures: 0 })
  })

  it('walks direct chats backwards from the oldest stored message', async () => {
    const ids = range(1, 25).map((value) => `m${1_700_000_000 + value}`)
    const dm: FakeConversation = {
      conversation: { conversationId: 'dm', kind: 'direct', title: 'Alice', localOnly: false },
      upstream: new Map(),
      stored: new Set(ids.slice(20).map((id) => Number(id.slice(1)))),
      directIds: ids,
    }
    const { host, calls } = createHost([dm])
    const worker = createWorker(host, { pageSize: 8 })

    await drain(worker)

    expect(dm.stored.size).toBe(25)
    expect(calls[0].query).toEqual({ before: { id: ids[20], timestamp: Number(ids[20].slice(1)) }, limit: 8 })
    expect(worker.snapshot().sessions[0].conversations[0]).toMatchObject({ mode: 'anchor', floorReached: true })
  })

  it('uses anchor mode for groups when the platform cannot read by sequence', async () => {
    const ids = range(1, 5).map((value) => `m${1_700_000_000 + value}`)
    const room: FakeConversation = {
      conversation: { conversationId: 'room', kind: 'group', title: 'Room', localOnly: false },
      upstream: new Map(),
      stored: new Set([Number(ids[4].slice(1))]),
      directIds: ids,
    }
    const { host, calls } = createHost([room], [binding('session-a', false)])
    await drain(createWorker(host))
    expect(calls.every((call) => call.query.before && call.query.beforeSequence === undefined)).toBe(true)
    expect(room.stored.size).toBe(5)
  })

  it('pauses entirely while disabled and skips local-only conversations', async () => {
    const room = group('room', 10, [10])
    const inbox: FakeConversation = {
      conversation: { conversationId: 'inbox', kind: 'direct', title: 'Requests', localOnly: true },
      upstream: new Map(), stored: new Set(),
    }
    const { host, calls } = createHost([room, inbox])
    const worker = createWorker(host, { enabled: false })
    expect(await worker.tick()).toBe(false)
    expect(worker.snapshot()).toMatchObject({ enabled: false, sessions: [{ status: 'disabled' }] })

    worker.enabled = true
    await drain(worker)
    expect(calls.every((call) => call.conversationId === 'room')).toBe(true)
    expect(worker.snapshot().sessions[0].conversations.map((item) => item.conversationId)).toEqual(['room'])
  })

  it('round-robins between active accounts', async () => {
    const a = group('a', 200, [200])
    const b = group('b', 200, [200])
    const sessions = [binding('session-a'), binding('session-b')]
    const hostA = createHost([a], sessions)
    // 两个账号共享同一个 host 实现，按会话 ID 区分数据。
    const hostB = createHost([b], sessions)
    const host: BackfillHost = {
      ...hostA.host,
      listConversations: async (id) => id === 'session-a' ? [a.conversation] : [b.conversation],
      readStoredSequences: (id, ...rest) => (id === 'session-a' ? hostA : hostB).host.readStoredSequences(id, ...rest),
      backfill: (item, ...rest) => (item.session.platformSessionId === 'session-a' ? hostA : hostB).host.backfill(item, ...rest),
    }
    const worker = createWorker(host, { pageSize: 10 })
    for (let index = 0; index < 4; index++) await worker.tick()
    expect(hostA.calls).toHaveLength(2)
    expect(hostB.calls).toHaveLength(2)
  })
})

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}
