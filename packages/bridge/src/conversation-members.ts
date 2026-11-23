import type { Database } from '@cordisjs/plugin-database'
import { BoundedMap } from './bounded-map.js'
import type { MessageStore } from './message-store.js'
import type { ActivePlatformSession, IMPlatformService } from './platform-manager.js'
import {
  serviceActionMembers,
  type IMConversation,
  type IMMessage,
  type IMPlatform,
  type PlatformSession,
} from './platform.js'
import { isLocalOnlyConversation } from './request-inbox.js'

export type ConversationMemberSource = 'member-list' | 'message'

const MEMBER_WRITE_CHUNK_SIZE = 500
const KNOWN_MEMBER_CACHE_LIMIT = 50_000

const DEFAULT_SYNC_OPTIONS = {
  enabled: true,
  intervalMs: 2_000,
  idleIntervalMs: 60_000,
  pageIntervalMs: 100,
  refreshIntervalMs: 6 * 60 * 60 * 1_000,
  idleAfterMs: 30_000,
  retryCooldownMs: 30 * 60 * 1_000,
  pageSize: 500,
  maxMembersPerConversation: 10_000,
  scanDeadlineMs: 60_000,
} as const

/**
 * 将会话归一化为「共同群组」归属的顶层群/频道 ID。
 * 私聊与本地合成会话返回 `undefined`；频道下的子频道（如 Discord 话题频道）归并到父频道。
 */
export function displayGroupConversationId(
  conversation: Pick<IMConversation, 'id' | 'kind' | 'parentId' | 'metadata'> | undefined,
): string | undefined {
  if (!conversation || conversation.kind === 'direct' || isLocalOnlyConversation(conversation as IMConversation)) {
    return undefined
  }
  if (conversation.kind === 'channel' && conversation.parentId) return conversation.parentId
  return conversation.id
}

function memberCacheKey(platformSessionId: string, platformConversationId: string, platformUserId: string): string {
  return `${platformSessionId}\u0000${platformConversationId}\u0000${platformUserId}`
}

function conversationCacheKey(platformSessionId: string, platformConversationId: string): string {
  return `${platformSessionId}\u0000${platformConversationId}`
}

function normalizeUserIds(userIds: readonly string[]): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const raw of userIds) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return unique
}

/** 持久化的群/频道成员关系索引，为 `users.getFullUser` 与 `messages.getCommonChats` 提供毫秒级反查。 */
export class ConversationMemberStore {
  private readonly _known = new BoundedMap<string, ConversationMemberSource>(KNOWN_MEMBER_CACHE_LIMIT)
  private readonly _syncedAt = new Map<string, number | null>()

  constructor(
    private readonly _database: Database,
    private readonly _now: () => number = Date.now,
  ) {}

  async recordMembers(
    platformSessionId: string,
    platformConversationId: string,
    userIds: readonly string[],
    source: ConversationMemberSource,
  ): Promise<number> {
    const normalized = normalizeUserIds(userIds)
    if (!normalized.length) return 0
    const pending: string[] = []
    for (const userId of normalized) {
      const cached = this._known.get(memberCacheKey(platformSessionId, platformConversationId, userId))
      if (cached === 'member-list' || (cached === 'message' && source === 'message')) continue
      pending.push(userId)
    }
    if (!pending.length) return 0
    const now = this._now()
    const updatedAt = new Date(now)
    for (let offset = 0; offset < pending.length; offset += MEMBER_WRITE_CHUNK_SIZE) {
      const chunk = pending.slice(offset, offset + MEMBER_WRITE_CHUNK_SIZE)
      await this._database.upsert(
        'mtproto_conversation_member',
        chunk.map((platformUserId) => ({
          platformSessionId,
          platformConversationId,
          platformUserId,
          source,
          updatedAt,
        })),
        ['platformSessionId', 'platformConversationId', 'platformUserId'],
      )
      for (const platformUserId of chunk) {
        this._known.set(memberCacheKey(platformSessionId, platformConversationId, platformUserId), source)
      }
    }
    if (source === 'member-list') {
      this._syncedAt.set(conversationCacheKey(platformSessionId, platformConversationId), now)
    }
    return pending.length
  }

  /**
   * 用一份完整的群成员列表快照对账：补齐缺失成员、升级 `message` 来源记录，并移除已不在群内的旧成员。
   */
  async reconcileConversationMembers(
    platformSessionId: string,
    platformConversationId: string,
    userIds: readonly string[],
  ): Promise<{ added: number, removed: number }> {
    const normalized = normalizeUserIds(userIds)
    const nextSet = new Set(normalized)
    const existing = await this._database.get(
      'mtproto_conversation_member',
      { platformSessionId, platformConversationId },
      ['platformUserId', 'source'],
    )
    const existingByUser = new Map(existing.map((row) => [row.platformUserId, row.source]))
    const toUpsert: string[] = []
    let added = 0
    for (const userId of normalized) {
      const previous = existingByUser.get(userId)
      if (previous === undefined) {
        added++
        toUpsert.push(userId)
      } else if (previous !== 'member-list') {
        toUpsert.push(userId)
      }
    }
    const toRemove: string[] = []
    for (const userId of existingByUser.keys()) {
      if (!nextSet.has(userId)) toRemove.push(userId)
    }

    const now = this._now()
    const updatedAt = new Date(now)
    for (let offset = 0; offset < toUpsert.length; offset += MEMBER_WRITE_CHUNK_SIZE) {
      const chunk = toUpsert.slice(offset, offset + MEMBER_WRITE_CHUNK_SIZE)
      await this._database.upsert(
        'mtproto_conversation_member',
        chunk.map((platformUserId) => ({
          platformSessionId,
          platformConversationId,
          platformUserId,
          source: 'member-list' as const,
          updatedAt,
        })),
        ['platformSessionId', 'platformConversationId', 'platformUserId'],
      )
    }
    for (let offset = 0; offset < toRemove.length; offset += MEMBER_WRITE_CHUNK_SIZE) {
      const chunk = toRemove.slice(offset, offset + MEMBER_WRITE_CHUNK_SIZE)
      await this._database.remove('mtproto_conversation_member', {
        platformSessionId,
        platformConversationId,
        platformUserId: { $in: chunk },
      })
    }

    for (const userId of normalized) {
      this._known.set(memberCacheKey(platformSessionId, platformConversationId, userId), 'member-list')
    }
    for (const userId of toRemove) {
      this._known.delete(memberCacheKey(platformSessionId, platformConversationId, userId))
    }
    if (nextSet.size > 0) {
      this._syncedAt.set(conversationCacheKey(platformSessionId, platformConversationId), now)
    }
    return { added, removed: toRemove.length }
  }

  async removeMember(
    platformSessionId: string,
    platformConversationId: string,
    platformUserId: string,
  ): Promise<void> {
    if (!platformUserId) return
    await this._database.remove('mtproto_conversation_member', {
      platformSessionId,
      platformConversationId,
      platformUserId,
    })
    this._known.delete(memberCacheKey(platformSessionId, platformConversationId, platformUserId))
  }

  async listUserConversations(platformSessionId: string, platformUserId: string): Promise<string[]> {
    if (!platformUserId) return []
    const rows = await this._database.get(
      'mtproto_conversation_member',
      { platformSessionId, platformUserId },
      ['platformConversationId'],
    )
    return [...new Set(rows.map((row) => row.platformConversationId))]
  }

  async memberListSyncedAt(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<number | undefined> {
    const key = conversationCacheKey(platformSessionId, platformConversationId)
    if (this._syncedAt.has(key)) {
      const cached = this._syncedAt.get(key)
      return cached === null ? undefined : cached
    }
    const [row] = await this._database.select('mtproto_conversation_member', {
      platformSessionId,
      platformConversationId,
      source: 'member-list',
    }).limit(1).execute()
    const timestamp = row ? new Date(row.updatedAt).getTime() : null
    this._syncedAt.set(key, timestamp)
    return timestamp === null ? undefined : timestamp
  }

  async hasMemberListSync(platformSessionId: string, platformConversationId: string): Promise<boolean> {
    return (await this.memberListSyncedAt(platformSessionId, platformConversationId)) !== undefined
  }

  /**
   * 从群消息被动记录成员：
   * - 实时消息（`live: true`）总是记录发言者与入群成员；
   * - 历史补拉/恢复消息仅在该群尚未完成成员列表全量对账时写入，避免把已退群的旧发言者重新写回。
   */
  async recordMessageMembers(
    platformSessionId: string,
    conversation: Pick<IMConversation, 'id' | 'kind' | 'parentId' | 'metadata'>,
    message: Pick<IMMessage, 'senderId' | 'content'>,
    options: { live?: boolean } = {},
  ): Promise<number> {
    const groupId = displayGroupConversationId(conversation)
    if (!groupId) return 0
    if (!options.live && await this.hasMemberListSync(platformSessionId, groupId)) {
      return 0
    }
    const userIds = [
      message.senderId,
      ...serviceActionMembers(message.content.serviceAction).map((member) => member.id),
    ]
    return this.recordMembers(platformSessionId, groupId, userIds, 'message')
  }
}

export interface ConversationMemberSyncOptions {
  enabled?: boolean
  intervalMs?: number
  idleIntervalMs?: number
  pageIntervalMs?: number
  refreshIntervalMs?: number
  idleAfterMs?: number
  retryCooldownMs?: number
  pageSize?: number
  maxMembersPerConversation?: number
  scanDeadlineMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  log?: (level: 'debug' | 'info' | 'warn', format: string, ...args: unknown[]) => void
}

export interface ConversationMemberSyncTickResult {
  status: 'disabled' | 'idle' | 'synced' | 'failed'
  platformSessionId?: string
  conversationId?: string
  members?: number
  partial?: boolean
  added?: number
  removed?: number
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 后台低速群成员索引同步器：每次 tick 最多顺序扫描一个群，优先补齐尚未同步过成员列表的群，
 * 并在客户端空闲时按周期刷新旧快照，以保持 `messages.getCommonChats` 准确且不打扰正常使用。
 */
export class ConversationMemberSyncWorker {
  enabled: boolean
  private readonly _intervalMs: number
  private readonly _idleIntervalMs: number
  private readonly _pageIntervalMs: number
  private readonly _refreshIntervalMs: number
  private readonly _idleAfterMs: number
  private readonly _retryCooldownMs: number
  private readonly _pageSize: number
  private readonly _maxMembers: number
  private readonly _scanDeadlineMs: number
  private readonly _now: () => number
  private readonly _sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly _log?: ConversationMemberSyncOptions['log']
  private readonly _lastSyncedAt = new Map<string, number>()
  private readonly _retryAfter = new Map<string, number>()
  private readonly _abort = new AbortController()
  private _lastHadWork = false

  constructor(
    private readonly _sessions: () => readonly Pick<ActivePlatformSession, 'platform' | 'session'>[],
    private readonly _store: Pick<MessageStore, 'listConversations'>,
    private readonly _members: ConversationMemberStore,
    private readonly _lastActivityAt?: (platformSessionId: string) => number | undefined,
    options: ConversationMemberSyncOptions = {},
  ) {
    this.enabled = options.enabled ?? DEFAULT_SYNC_OPTIONS.enabled
    this._intervalMs = options.intervalMs ?? DEFAULT_SYNC_OPTIONS.intervalMs
    this._idleIntervalMs = options.idleIntervalMs ?? DEFAULT_SYNC_OPTIONS.idleIntervalMs
    this._pageIntervalMs = options.pageIntervalMs ?? DEFAULT_SYNC_OPTIONS.pageIntervalMs
    this._refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_SYNC_OPTIONS.refreshIntervalMs
    this._idleAfterMs = options.idleAfterMs ?? DEFAULT_SYNC_OPTIONS.idleAfterMs
    this._retryCooldownMs = options.retryCooldownMs ?? DEFAULT_SYNC_OPTIONS.retryCooldownMs
    this._pageSize = options.pageSize ?? DEFAULT_SYNC_OPTIONS.pageSize
    this._maxMembers = options.maxMembersPerConversation ?? DEFAULT_SYNC_OPTIONS.maxMembersPerConversation
    this._scanDeadlineMs = options.scanDeadlineMs ?? DEFAULT_SYNC_OPTIONS.scanDeadlineMs
    this._now = options.now ?? Date.now
    this._sleep = options.sleep ?? defaultSleep
    this._log = options.log
  }

  stop(): void {
    this._abort.abort()
  }

  nextDelay(): number {
    return this.enabled && this._lastHadWork ? this._intervalMs : this._idleIntervalMs
  }

  async tick(): Promise<ConversationMemberSyncTickResult> {
    this._lastHadWork = false
    if (!this.enabled || this._abort.signal.aborted) {
      return { status: 'disabled' }
    }
    const target = await this._pickNextTarget()
    if (!target) {
      return { status: 'idle' }
    }
    const { binding, conversation } = target
    const key = conversationCacheKey(binding.session.platformSessionId, conversation.id)
    try {
      const scan = await this._scanConversationMembers(binding.platform, binding.session, conversation.id)
      if (this._abort.signal.aborted) return { status: 'disabled' }
      let added = 0
      let removed = 0
      if (!scan.partial && scan.userIds.length > 0) {
        const diff = await this._members.reconcileConversationMembers(
          binding.session.platformSessionId,
          conversation.id,
          scan.userIds,
        )
        added = diff.added
        removed = diff.removed
      } else if (scan.userIds.length > 0) {
        added = await this._members.recordMembers(
          binding.session.platformSessionId,
          conversation.id,
          scan.userIds,
          'member-list',
        )
      }
      this._lastSyncedAt.set(key, this._now())
      this._retryAfter.delete(key)
      this._lastHadWork = true
      this._log?.(
        'debug',
        'conversation member sync session=%s conversation=%s members=%d partial=%s added=%d removed=%d',
        binding.session.platformSessionId, conversation.id, scan.userIds.length, scan.partial, added, removed,
      )
      return {
        status: 'synced',
        platformSessionId: binding.session.platformSessionId,
        conversationId: conversation.id,
        members: scan.userIds.length,
        partial: scan.partial,
        added,
        removed,
      }
    } catch (error) {
      this._retryAfter.set(key, this._now() + this._retryCooldownMs)
      this._lastHadWork = true
      this._log?.(
        'warn',
        'conversation member sync failed session=%s conversation=%s error=%s',
        binding.session.platformSessionId,
        conversation.id,
        error instanceof Error ? error.message : String(error),
      )
      return {
        status: 'failed',
        platformSessionId: binding.session.platformSessionId,
        conversationId: conversation.id,
      }
    }
  }

  private async _pickNextTarget(): Promise<{
    binding: Pick<ActivePlatformSession, 'platform' | 'session'>
    conversation: IMConversation
  } | undefined> {
    const now = this._now()
    let staleCandidate: {
      binding: Pick<ActivePlatformSession, 'platform' | 'session'>
      conversation: IMConversation
      lastSyncedAt: number
    } | undefined

    for (const binding of this._sessions()) {
      if (this._abort.signal.aborted) return undefined
      if (!binding.platform.capabilities.members?.list || !binding.platform.getConversationMembers) continue
      const conversations = await this._store.listConversations(binding.session.platformSessionId)
      const groups = conversations.filter((conversation) => displayGroupConversationId(conversation) === conversation.id)
      const lastActivity = this._lastActivityAt?.(binding.session.platformSessionId)
      const sessionIdle = lastActivity === undefined || now - lastActivity >= this._idleAfterMs

      for (const conversation of groups) {
        const key = conversationCacheKey(binding.session.platformSessionId, conversation.id)
        const retryAt = this._retryAfter.get(key)
        if (retryAt !== undefined && now < retryAt) continue

        const syncedAt = await this._members.memberListSyncedAt(binding.session.platformSessionId, conversation.id)
        if (syncedAt === undefined) {
          return { binding, conversation }
        }
        if (!sessionIdle) continue
        const lastSyncedAt = Math.max(syncedAt, this._lastSyncedAt.get(key) ?? 0)
        if (now - lastSyncedAt < this._refreshIntervalMs) continue
        if (!staleCandidate || lastSyncedAt < staleCandidate.lastSyncedAt) {
          staleCandidate = { binding, conversation, lastSyncedAt }
        }
      }
    }
    return staleCandidate ? { binding: staleCandidate.binding, conversation: staleCandidate.conversation } : undefined
  }

  private async _scanConversationMembers(
    platform: IMPlatform,
    session: PlatformSession,
    conversationId: string,
  ): Promise<{ userIds: string[], partial: boolean }> {
    const seenUsers = new Set<string>()
    const seenCursors = new Set<string>()
    const deadline = this._now() + this._scanDeadlineMs
    let cursor: string | undefined
    let partial = false

    for (;;) {
      if (this._abort.signal.aborted) {
        partial = true
        break
      }
      const remaining = this._maxMembers - seenUsers.size
      if (remaining <= 0) {
        partial = true
        break
      }
      const page = await platform.getConversationMembers!(session, { id: conversationId }, {
        ...(cursor ? { cursor } : {}),
        limit: Math.max(1, Math.min(this._pageSize, remaining)),
      })
      for (const member of page.members) {
        const id = member.user.id.trim()
        if (id) seenUsers.add(id)
      }
      const nextCursor = page.nextCursor
      if (!nextCursor || !page.members.length) break
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        partial = true
        break
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
      if (seenUsers.size >= this._maxMembers || this._now() >= deadline) {
        partial = true
        break
      }
      if (this._pageIntervalMs > 0) {
        await this._sleep(this._pageIntervalMs, this._abort.signal)
      }
    }
    return { userIds: [...seenUsers], partial }
  }
}

export function memberSyncSessions(platforms: IMPlatformService): readonly ActivePlatformSession[] {
  return platforms.sessions
}
