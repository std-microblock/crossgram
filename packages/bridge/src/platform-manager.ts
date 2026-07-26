import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import { Service, type Context } from 'cordis'
import type { PlatformSessionRow } from './models.js'
import { MessageStore, type DeleteResult, type IngestResult, type ReactionResult, type ReadResult } from './message-store.js'
import type {
  IMConversation, IMDialog, IMDialogPage, IMEvent, IMHistoryPage, IMHistoryQuery, IMMessage, IMMessageSearchPage,
  IMMessageSearchQuery, IMPlatform, PlatformSession,
  Unsubscribe,
} from './platform.js'

export class PlatformRegistry {
  private readonly _platforms = new Map<string, IMPlatform>()

  constructor(platforms: readonly (readonly [string, IMPlatform])[] = []) {
    for (const [registrationId, platform] of platforms) this.register(registrationId, platform)
  }

  register(registrationId: string, platform: IMPlatform): Unsubscribe {
    if (this._platforms.has(registrationId)) throw new Error(`duplicate IM platform ID: ${registrationId}`)
    this._platforms.set(registrationId, platform)
    return () => {
      if (this._platforms.get(registrationId) === platform) this._platforms.delete(registrationId)
    }
  }

  get(id: string): IMPlatform | undefined {
    return this._platforms.get(id)
  }

  get ids(): string[] {
    return [...this._platforms.keys()]
  }

  require(id: string): IMPlatform {
    const platform = this.get(id)
    if (!platform) throw new Error(`IM platform is not registered: ${id}`)
    return platform
  }
}

export type PlatformRegistryEvent = 'register' | 'unregister'
export type PlatformRegistryListener = (
  event: PlatformRegistryEvent,
  registrationId: string,
  platform: IMPlatform,
) => void

/** Resolve the stable Cordis config-entry ID, with a fallback for direct `ctx.plugin()` usage. */
export function resolvePlatformPluginId(ctx: Context, fallback?: string): string {
  const entryId = (ctx.fiber as typeof ctx.fiber & {
    entry?: { options?: { id?: unknown } }
  }).entry?.options?.id
  if (typeof entryId === 'string' && entryId) return entryId
  if (fallback) return fallback
  throw new Error('IM platform must be loaded from a named Cordis config entry')
}

/** Cordis-owned adapter registry exposed as `ctx.imPlatform`. */
export class IMPlatformService extends Service {
  readonly registry: PlatformRegistry
  private readonly _listeners = new Set<PlatformRegistryListener>()

  constructor(ctx: Context) {
    super(ctx, 'imPlatform')
    this.registry = new PlatformRegistry()
  }

  get(id: string): IMPlatform | undefined {
    return this.registry.get(id)
  }

  require(id: string): IMPlatform {
    return this.registry.require(id)
  }

  get ids(): string[] {
    return this.registry.ids
  }

  /** Register an adapter for the lifetime of the calling Cordis plugin fiber. */
  register(platform: IMPlatform, registrationId = resolvePlatformPluginId(this.ctx)): Unsubscribe {
    return this.ctx.effect(() => {
      const unregister = this.registry.register(registrationId, platform)
      this._emit('register', registrationId, platform)
      return () => {
        unregister()
        this._emit('unregister', registrationId, platform)
      }
    }, `imPlatform.register(${registrationId})`)
  }

  onChange(listener: PlatformRegistryListener): Unsubscribe {
    return this.ctx.effect(() => {
      this._listeners.add(listener)
      return () => this._listeners.delete(listener)
    }, 'imPlatform.onChange')
  }

  private _emit(event: PlatformRegistryEvent, registrationId: string, platform: IMPlatform): void {
    for (const listener of this._listeners) listener(event, registrationId, platform)
  }
}

/** Owns one durable event subscription per active platform session. */
export class PlatformSubscriptionManager {
  private readonly _subscriptions = new Map<string, {
    platformId: string
    pending: Promise<Unsubscribe>
  }>()
  private readonly _eventQueues = new Map<string, Promise<PlatformEventPublishResult>>()

  constructor(
    private readonly _database: Database,
    private readonly _registry: PlatformRegistry,
    private readonly _store: MessageStore,
    private readonly _onError: (error: unknown, session?: PlatformSession) => void = () => {},
    private readonly _onEvent?: (
      session: PlatformSession,
      event: CommittedPlatformEvent,
      options?: PlatformEventDeliveryOptions,
    ) => PlatformEventPublishResult | Promise<PlatformEventPublishResult>,
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
  ) {}

  async startActiveSessions(platformId?: string): Promise<void> {
    const rows = await this._database.get('mtproto_platform_session', {
      active: true,
      ...(platformId ? { platformId } : {}),
    })
    await Promise.all(rows.map(async (row) => {
      const session = sessionFromRow(row)
      try {
        await this._store.pruneUpdateDeliveries(session.platformSessionId)
        await this.ensure(session)
      } catch (error) {
        this._onError(error, session)
      }
    }))
  }

  async ensure(session: PlatformSession): Promise<void> {
    const existing = this._subscriptions.get(session.platformSessionId)
    if (existing) {
      await existing.pending
      return
    }
    const platform = this._registry.require(session.platformId)
    this._onTrace?.(
      'platform subscription start platform=%s session=%s', session.platformId, session.platformSessionId,
    )
    const pending = platform.subscribe(session, async (event) => {
      await this._enqueue(session, event)
    })
    this._subscriptions.set(session.platformSessionId, { platformId: session.platformId, pending })
    try {
      await pending
      this._onTrace?.(
        'platform subscription ready platform=%s session=%s', session.platformId, session.platformSessionId,
      )
    } catch (error) {
      if (this._subscriptions.get(session.platformSessionId)?.pending === pending) {
        this._subscriptions.delete(session.platformSessionId)
      }
      throw error
    }
  }

  /**
   * Commits an event produced by a local RPC action through the same ordered
   * persistence and update-delivery pipeline as adapter subscription events.
   */
  ingestLocalEvent(
    session: PlatformSession,
    event: IMEvent,
    options?: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
    return this._enqueue(session, event, options)
  }

  async stopPlatform(platformId: string): Promise<void> {
    const selected = [...this._subscriptions.entries()]
      .filter(([, subscription]) => subscription.platformId === platformId)
    for (const [sessionId] of selected) this._subscriptions.delete(sessionId)
    const unsubscribes = await Promise.allSettled(selected.map(([, subscription]) => subscription.pending))
    await Promise.allSettled(unsubscribes.map(async (result) => {
      if (result.status === 'fulfilled') await result.value()
    }))
  }

  async stop(): Promise<void> {
    const subscriptions = [...this._subscriptions.values()].map((subscription) => subscription.pending)
    this._subscriptions.clear()
    const queues = [...this._eventQueues.values()]
    await Promise.allSettled(queues)
    const unsubscribes = await Promise.allSettled(subscriptions)
    await Promise.allSettled(unsubscribes.map(async (result) => {
      if (result.status === 'fulfilled') await result.value()
    }))
  }

  private _enqueue(
    session: PlatformSession,
    event: IMEvent,
    options?: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
    const key = session.platformSessionId
    this._onTrace?.(
      'platform event enqueue platform=%s session=%s %s queued=%s',
      session.platformId, key, platformEventSummary(event), this._eventQueues.has(key),
    )
    const previous = this._eventQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this._ingestEvent(session, event, options))
    this._eventQueues.set(key, current)
    current.catch((error) => {
      this._onTrace?.(
        'platform event failed platform=%s session=%s %s error=%s',
        session.platformId, key, platformEventSummary(event), formatError(error),
      )
      this._onError(error, session)
    }).finally(() => {
      if (this._eventQueues.get(key) === current) this._eventQueues.delete(key)
    })
    return current
  }

  private async _ingestEvent(
    session: PlatformSession,
    event: IMEvent,
    options?: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
    if (event.type === 'conversation') {
      await this._store.upsertConversation(session, event.conversation)
    } else if (event.type === 'message') {
      const result = await this._store.ingest(session, event.conversation, event.message)
      this._onTrace?.(
        'platform message ingested platform=%s session=%s conversation=%s message=%s created=%s changed=%s projection=%d',
        session.platformId, session.platformSessionId, event.conversation.id, event.message.id,
        result.created, result.changed, result.projection.length,
      )
      const published = await this._onEvent?.(session, { event, result }, options)
      this._onTrace?.(
        'platform message committed platform=%s session=%s conversation=%s message=%s',
        session.platformId, session.platformSessionId, event.conversation.id, event.message.id,
      )
      return published
    } else if (event.type === 'message-edit') {
      const result = await this._store.ingest(session, event.conversation, event.message)
      return this._onEvent?.(session, { event, result }, options)
    } else if (event.type === 'message-delete') {
      const result = await this._store.deleteMessages(session, event.conversation, event.messageIds)
      return this._onEvent?.(session, { event, result }, options)
    } else if (event.type === 'message-reactions') {
      const result = await this._store.setReactions(session, event.conversation, event.target, event.context)
      return this._onEvent?.(session, { event, result }, options)
    } else if (event.type === 'read') {
      const result = await this._store.markRead(session, event.conversationId, event.upToMessageId)
      if (result) return this._onEvent?.(session, { event, result }, options)
    }
  }
}

function platformEventSummary(event: IMEvent): string {
  if (event.type === 'message' || event.type === 'message-edit') {
    return `type=${event.type} conversation=${event.conversation.id} message=${event.message.id} sender=${event.message.senderId} outgoing=${Boolean(event.message.outgoing)} parts=${event.message.content.parts.length}`
  }
  if (event.type === 'message-delete') {
    return `type=message-delete conversation=${event.conversation.id} eventId=${event.eventId} messages=${event.messageIds.join(',')}`
  }
  if (event.type === 'message-reactions') {
    return `type=message-reactions conversation=${event.conversation.id} eventId=${event.eventId} message=${event.target.messageId} reactions=${event.context.reactions.length}`
  }
  if (event.type === 'read') {
    return `type=read conversation=${event.conversationId} upToMessage=${event.upToMessageId}`
  }
  return `type=conversation conversation=${event.conversation.id}`
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.stack ?? `${error.name}: ${error.message}`
}

function profileMilliseconds(value: number): number {
  return Math.round(value * 100) / 100
}

export type CommittedPlatformEvent =
  | { event: Extract<IMEvent, { type: 'message' }>, result: IngestResult }
  | { event: Extract<IMEvent, { type: 'message-edit' }>, result: IngestResult }
  | { event: Extract<IMEvent, { type: 'message-delete' }>, result: DeleteResult }
  | { event: Extract<IMEvent, { type: 'message-reactions' }>, result: ReactionResult }
  | { event: Extract<IMEvent, { type: 'read' }>, result: ReadResult }

export interface PlatformEventDeliveryOptions {
  /** Do not push an update to the auth key receiving the same payload via RPC. */
  excludeAuthKeyId?: string
  /** Treat the durable delivery as published even when no socket push was sent. */
  deliveredViaRpc?: boolean
}

export type PlatformEventPublishResult = tl.RawUpdates | void

/** Synchronizes optional upstream history into the canonical database before reads. */
export class PlatformDataService {
  static readonly HISTORY_SYNC_FRESH_MS = 1_000
  private static readonly _historySyncs = new Map<string, Promise<void>>()
  private readonly _freshHistorySyncs = new Map<string, number>()

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _store: MessageStore,
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    private readonly _now: () => number = () => performance.now(),
  ) {}

  async getDialogs(query: { limit?: number, afterId?: string } = {}): Promise<IMDialog[]> {
    return (await this.getDialogsPage(query)).dialogs
  }

  async getDialogsPage(query: { limit?: number, afterId?: string } = {}): Promise<IMDialogPage> {
    let upstream: IMDialog[] = []
    let upstreamPage: IMDialogPage | undefined
    const hasUpstream = Boolean(this._platform.capabilities.history && this._platform.getDialogs)
    if (hasUpstream) {
      upstreamPage = await this._platform.getDialogs(this._session, query)
      upstream = upstreamPage.dialogs
    }
    const stored = await this._store.listDialogs(this._session.platformSessionId, {
      limit: query.limit,
      afterConversationId: query.afterId,
    })
    if (!hasUpstream) return { dialogs: stored, total: stored.length }
    // A history-capable adapter's current page is authoritative. Returning all
    // previously stored rows leaks removed dialogs and legacy conversation IDs
    // forever (for example after an adapter fixes its opaque-ID mapping).
    const persisted = new Map(stored.map((dialog) => [dialog.conversation.id, dialog]))
    await this._ingestDialogs(upstream.filter((dialog) => dialogNeedsPersistence(
      dialog, persisted.get(dialog.conversation.id),
    )))
    const dialogs = upstream.map((dialog) => {
      const cached = persisted.get(dialog.conversation.id)
      return {
        ...cached,
        ...dialog,
        conversation: { ...cached?.conversation, ...dialog.conversation },
        lastMessage: dialog.lastMessage ?? cached?.lastMessage,
      }
    })
    return { dialogs, nextCursor: upstreamPage?.nextCursor, total: upstreamPage?.total }
  }

  async getHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<IMHistoryPage> {
    return { messages: await this._loadHistory(conversationId, query, true) }
  }

  /** Fetch and persist one upstream page without hydrating rows the caller will not consume. */
  async syncHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<void> {
    const key = historySyncKey(this._session, conversationId, query)
    const now = this._now()
    const freshUntil = this._freshHistorySyncs.get(key)
    if (freshUntil !== undefined) {
      if (freshUntil > now) return
      this._freshHistorySyncs.delete(key)
    }
    const existing = PlatformDataService._historySyncs.get(key)
    if (existing) return existing
    const pending = this._loadHistory(conversationId, query, false).then(() => {})
    PlatformDataService._historySyncs.set(key, pending)
    try {
      await pending
      this._freshHistorySyncs.delete(key)
      this._freshHistorySyncs.set(key, this._now() + PlatformDataService.HISTORY_SYNC_FRESH_MS)
      if (this._freshHistorySyncs.size > 256) {
        this._freshHistorySyncs.delete(this._freshHistorySyncs.keys().next().value!)
      }
    } finally {
      if (PlatformDataService._historySyncs.get(key) === pending) {
        PlatformDataService._historySyncs.delete(key)
      }
    }
  }

  private async _loadHistory(
    conversationId: string,
    query: IMHistoryQuery,
    readStored: boolean,
  ): Promise<IMMessage[]> {
    const startedAt = performance.now()
    this._onTrace?.(
      'history data profile stage=start conversation=%s limit=%d',
      conversationId, query.limit ?? 100,
    )
    let conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    if (!conversation) {
      await this.getDialogs()
      conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    }
    conversation ??= { id: conversationId, kind: 'direct', title: conversationId }
    const conversationMs = performance.now() - startedAt

    let upstreamMs = 0
    let ingestMs = 0
    let upstreamMessages = 0
    if (this._platform.capabilities.history && this._platform.getHistory) {
      const upstreamAt = performance.now()
      this._onTrace?.('history data profile stage=upstream-start conversation=%s', conversationId)
      const page = await this._platform.getHistory(this._session, { id: conversationId }, query)
      upstreamMs = performance.now() - upstreamAt
      upstreamMessages = page.messages.length
      const ingestAt = performance.now()
      this._onTrace?.(
        'history data profile stage=ingest-start conversation=%s upstreamMs=%d messages=%d',
        conversationId, profileMilliseconds(upstreamMs), upstreamMessages,
      )
      await this._store.ingestMany(
        this._session,
        conversation,
        page.messages.slice().sort((left, right) => right.timestamp - left.timestamp),
        { allocation: 'history' },
      )
      ingestMs = performance.now() - ingestAt
    }
    let readMs = 0
    const messages = readStored
      ? await (async () => {
          const readAt = performance.now()
          const stored = await this._store.readHistory(
            this._session.platformSessionId, conversationId, { limit: query.limit ?? 100 },
          )
          readMs = performance.now() - readAt
          return stored
        })()
      : []
    this._onTrace?.(
      'history data profile conversation=%s limit=%d readStored=%s upstreamMessages=%d storedMessages=%d conversationMs=%d upstreamMs=%d ingestMs=%d readMs=%d totalMs=%d',
      conversationId, query.limit ?? 100, readStored, upstreamMessages, messages.length,
      profileMilliseconds(conversationMs), profileMilliseconds(upstreamMs), profileMilliseconds(ingestMs),
      profileMilliseconds(readMs), profileMilliseconds(performance.now() - startedAt),
    )
    return messages
  }

  async searchMessages(
    conversationId: string,
    query: IMMessageSearchQuery,
  ): Promise<IMMessageSearchPage> {
    if (!this._platform.searchMessages) return { messages: [] }
    let conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    if (!conversation) {
      await this.getDialogs()
      conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    }
    conversation ??= { id: conversationId, kind: 'direct', title: conversationId }
    const page = await this._platform.searchMessages(this._session, { id: conversationId }, query)
    await this._store.ingestMany(
      this._session,
      conversation,
      page.messages.slice().sort((left, right) => right.timestamp - left.timestamp),
      { allocation: 'history' },
    )
    return page
  }

  async getMessage(conversationId: string, messageId: string): Promise<IMMessage | null> {
    if (!this._platform.getMessage) return null
    let conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    if (!conversation) {
      await this.getDialogs()
      conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    }
    conversation ??= { id: conversationId, kind: 'direct', title: conversationId }
    const message = await this._platform.getMessage(this._session, { id: conversationId }, messageId)
    if (!message) return null
    await this._store.ingest(this._session, conversation, message, { allocation: 'history' })
    return message
  }

  private async _ingestDialogs(dialogs: readonly IMDialog[]): Promise<void> {
    await this._store.ingestDialogs(this._session, dialogs)
  }
}

function historySyncKey(
  session: PlatformSession,
  conversationId: string,
  query: IMHistoryQuery,
): string {
  return JSON.stringify([
    session.platformId,
    session.platformSessionId,
    conversationId,
    query.limit ?? 100,
    query.cursor ?? null,
    query.afterId ?? null,
    query.before?.id ?? null,
    query.before?.timestamp ?? null,
    query.after?.id ?? null,
    query.after?.timestamp ?? null,
  ])
}

function dialogNeedsPersistence(upstream: IMDialog, stored: IMDialog | undefined): boolean {
  if (!stored) return true
  if (upstream.unreadCount !== stored.unreadCount) return true
  if (
    upstream.conversation.kind !== stored.conversation.kind
    || upstream.conversation.title !== stored.conversation.title
    || upstream.conversation.parentId !== stored.conversation.parentId
    || upstream.conversation.spaceId !== stored.conversation.spaceId
    || JSON.stringify(upstream.conversation.metadata ?? {}) !== JSON.stringify(stored.conversation.metadata ?? {})
  ) return true
  const upstreamMessage = upstream.lastMessage
  const storedMessage = stored.lastMessage
  if (!upstreamMessage || !storedMessage) return upstreamMessage !== storedMessage
  return upstreamMessage.id !== storedMessage.id
    || upstreamMessage.timestamp !== storedMessage.timestamp
    || upstreamMessage.senderId !== storedMessage.senderId
    || JSON.stringify(upstreamMessage.content) !== JSON.stringify(storedMessage.content)
    || JSON.stringify(upstreamMessage.metadata ?? {}) !== JSON.stringify(storedMessage.metadata ?? {})
}

export function sessionFromRow(row: PlatformSessionRow): PlatformSession {
  return {
    platformSessionId: row.id,
    platformId: row.platformId,
    userId: row.userId,
    credentials: row.credentials,
    metadata: row.metadata,
  }
}

/** Repair IDs written by the short-lived implementation that persisted the full loader tree path. */
export async function migrateQualifiedPlatformIds(database: Database, platformId: string): Promise<number> {
  const rows = await database.get('mtproto_platform_session', {})
  const legacyIds = [...new Set(rows
    .map((row) => row.platformId)
    .filter((id) => id !== platformId && id.endsWith(`:${platformId}`)))]
  let migrated = 0
  for (const legacyId of legacyIds) {
    const sessions = await database.get('mtproto_platform_session', { platformId: legacyId })
    migrated += sessions.length
    await database.set('mtproto_platform_session', { platformId: legacyId }, { platformId })
    await database.set('mtproto_auth_session', { platformId: legacyId }, { platformId })
    await database.set('mtproto_auth_binding', { platformId: legacyId }, { platformId })
  }
  return migrated
}
