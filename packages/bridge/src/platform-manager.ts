import { createHash } from 'node:crypto'
import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import type { ServerConnection } from '@mtproto-relay/mtproto'
import { Service, type Context } from 'cordis'
import type { PlatformSessionRow } from './models.js'
import { MessageStore, type DeleteResult, type IngestResult, type ReactionResult, type ReadResult } from './message-store.js'
import { isRequestInboxConversation, requestInboxConversation, requestInboxMessage } from './request-inbox.js'
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

export interface ActivePlatformSession {
  registrationId: string
  platform: IMPlatform
  session: PlatformSession
}

export type PlatformSessionEvent = 'activate' | 'deactivate'
export type PlatformSessionListener = (event: PlatformSessionEvent, binding: ActivePlatformSession) => void
export type CommittedPlatformEventListener = (
  session: PlatformSession,
  event: CommittedPlatformEvent,
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
  private readonly _activeSessions = new Map<string, ActivePlatformSession>()
  private readonly _sessionListeners = new Set<PlatformSessionListener>()
  private readonly _committedEventListeners = new Set<CommittedPlatformEventListener>()

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

  get sessions(): ActivePlatformSession[] {
    return [...this._activeSessions.values()]
  }

  activateSession(registrationId: string, platform: IMPlatform, session: PlatformSession): void {
    const current = this._activeSessions.get(registrationId)
    if (current?.platform === platform && current.session === session) return
    if (current && (current.platform !== platform || current.session.platformSessionId !== session.platformSessionId)) {
      this._emitSession('deactivate', current)
    }
    const binding = { registrationId, platform, session }
    this._activeSessions.set(registrationId, binding)
    this._emitSession('activate', binding)
  }

  deactivateSession(registrationId: string, platform?: IMPlatform): void {
    const binding = this._activeSessions.get(registrationId)
    if (!binding || (platform && binding.platform !== platform)) return
    this._activeSessions.delete(registrationId)
    this._emitSession('deactivate', binding)
  }

  onSessionChange(listener: PlatformSessionListener): Unsubscribe {
    return this.ctx.effect(() => {
      this._sessionListeners.add(listener)
      return () => this._sessionListeners.delete(listener)
    }, 'imPlatform.onSessionChange')
  }

  onCommittedEvent(listener: CommittedPlatformEventListener): Unsubscribe {
    return this.ctx.effect(() => {
      this._committedEventListeners.add(listener)
      return () => this._committedEventListeners.delete(listener)
    }, 'imPlatform.onCommittedEvent')
  }

  emitCommittedEvent(session: PlatformSession, event: CommittedPlatformEvent): void {
    for (const listener of [...this._committedEventListeners]) listener(session, event)
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

  private _emitSession(event: PlatformSessionEvent, binding: ActivePlatformSession): void {
    for (const listener of [...this._sessionListeners]) listener(event, binding)
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
      void this._reconcileSession(platform, session).catch((error) => {
        this._onTrace?.(
          'platform startup reconciliation failed platform=%s session=%s error=%s',
          session.platformId, session.platformSessionId, formatError(error),
        )
        this._onError(error, session)
      })
    } catch (error) {
      if (this._subscriptions.get(session.platformSessionId)?.pending === pending) {
        this._subscriptions.delete(session.platformSessionId)
      }
      throw error
    }
  }

  private async _reconcileSession(platform: IMPlatform, session: PlatformSession): Promise<void> {
    if (platform.capabilities.history && platform.getDialogs) {
      const data = new PlatformDataService(
        platform, session, this._store, this._onTrace, undefined,
        (event) => this._enqueue(session, event),
      )
      let afterId: string | undefined
      const visited = new Set<string | undefined>()
      while (!visited.has(afterId)) {
        visited.add(afterId)
        const page = await data.getDialogsPage({ limit: 500, afterId })
        if (!page.dialogs.length) break
        const lastId = page.dialogs.at(-1)!.conversation.id
        const hasMore = Boolean(page.nextCursor)
          || (page.total !== undefined && visited.size * 500 < page.total)
          || page.dialogs.length >= 500
        if (!hasMore || lastId === afterId) break
        afterId = lastId
      }
    }
    if (!platform.getRequests) return
    let cursor: string | undefined
    const visitedCursors = new Set<string | undefined>()
    while (!visitedCursors.has(cursor)) {
      visitedCursors.add(cursor)
      const page = await platform.getRequests(session, { limit: 500, cursor })
      // Cursor pages may overlap. Re-ingesting an unchanged request is a
      // no-op, while a later duplicate can carry its terminal state and must
      // edit the pending inbox projection rather than being discarded.
      for (const request of page.requests) {
        await this._enqueue(session, { type: 'request', request })
      }
      if (!page.nextCursor || page.nextCursor === cursor) break
      cursor = page.nextCursor
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
      if (result) return this._onEvent?.(session, { event, result }, options)
    } else if (event.type === 'request') {
      const stored = await this._store.ingestRequest(session, event.request)
      const conversation = requestInboxConversation()
      const message = requestInboxMessage(stored.request)
      // Request persistence alone is not a delivery marker: a prior failure may
      // have committed a legacy request row before its inbox projection. The
      // message ingestion result determines whether this replay is a new
      // message, an edit, or a complete no-op.
      if (!stored.message.created && !stored.message.changed && event.delivery !== 'recovery') return
      if (stored.message.created) {
        return this._onEvent?.(session, {
          event: { type: 'message', conversation, message }, result: stored.message,
        }, options)
      }
      return this._onEvent?.(session, {
        event: {
          type: 'message-edit',
          eventId: requestInboxEditEventId(stored.request.id, message),
          conversation,
          message,
        },
        result: stored.message,
      }, event.delivery === 'recovery' ? { ...options, forceDelivery: true } : options)
    } else if (event.type === 'read') {
      const result = await this._store.markRead(session, event.conversationId, event.upToMessageId)
      if (result) return this._onEvent?.(session, { event, result }, options)
    } else if (event.type === 'voice-call') {
      // Calls are intentionally transient and bypass every database/journal path.
      return this._onEvent?.(session, { event }, options)
    }
  }
}

function requestInboxEditEventId(requestId: string, message: import('./platform.js').IMMessage): string {
  const hash = createHash('sha256').update(JSON.stringify({
    requestId,
    text: message.content.parts,
    inlineKeyboard: message.content.inlineKeyboard,
  })).digest('hex')
  return `bridge-request:${encodeURIComponent(requestId)}:${hash}`
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
  if (event.type === 'voice-call') {
    return `type=voice-call signal=${event.signal} media=${event.media} conversation=${event.conversation.id}`
  }
  if (event.type === 'request') return `type=request request=${event.request.id} kind=${event.request.kind}`
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
  | { event: Extract<IMEvent, { type: 'voice-call' }> }

export interface PlatformEventDeliveryOptions {
  /** Do not push an update to the auth key receiving the same payload via RPC. */
  excludeAuthKeyId?: string
  /** Do not push the update back through the connection receiving it via RPC. */
  excludeConnection?: ServerConnection
  /** Treat the durable delivery as published even when no socket push was sent. */
  deliveredViaRpc?: boolean
  /** Internal recovery path for an unchanged projection whose update was not delivered. */
  forceDelivery?: boolean
}

export type PlatformEventPublishResult = tl.RawUpdates | void

/** Synchronizes optional upstream history into the canonical database before reads. */
export class PlatformDataService {

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _store: MessageStore,
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    now: () => number = () => performance.now(),
    private readonly _publishRecovered?: (
      event: Extract<IMEvent, { type: 'message' }>,
    ) => Promise<unknown>,
  ) {
    void now
  }

  async getDialogs(query: { limit?: number, afterId?: string } = {}): Promise<IMDialog[]> {
    return (await this.getDialogsPage(query)).dialogs
  }

  getDialogsPage(query: { limit?: number, afterId?: string } = {}): Promise<IMDialogPage> {
    return this._loadDialogsPage(query)
  }

  async getSubdialogsPage(
    parentId: string,
    query: { limit?: number, afterId?: string } = {},
  ): Promise<IMDialogPage> {
    if (!this._platform.getSubdialogs) return { dialogs: [], total: 0 }
    const page = await this._platform.getSubdialogs(this._session, { id: parentId }, query)
    const stored = await this._store.readDialogs(
      this._session.platformSessionId,
      page.dialogs.map((dialog) => dialog.conversation.id),
    )
    await this._reconcileDialogs(page.dialogs, stored)
    return page
  }

  private async _loadDialogsPage(query: { limit?: number, afterId?: string }): Promise<IMDialogPage> {
    const stored = await this._store.listDialogs(this._session.platformSessionId, {
      limit: query.limit,
      afterConversationId: query.afterId,
    })
    if (!this._platform.capabilities.history || !this._platform.getDialogs) {
      return { dialogs: stored, total: stored.length }
    }
    const requestInbox = (await this._store.readDialogs(
      this._session.platformSessionId, ['bridge:request-inbox'],
    ))[0]
    const injectRequestInbox = requestInbox && query.afterId === undefined
    const upstreamQuery = query.afterId === 'bridge:request-inbox'
      ? { ...query, afterId: undefined }
      : injectRequestInbox
        ? { ...query, limit: Math.max(1, (query.limit ?? 100) - 1) }
        : query
    let upstreamPage: IMDialogPage
    try {
      upstreamPage = await this._platform.getDialogs(this._session, upstreamQuery)
    } catch (error) {
      if (!stored.length) throw error
      this._onTrace?.(
        'dialog upstream refresh failed; serving stored page session=%s dialogs=%d error=%s',
        this._session.platformSessionId, stored.length, String(error),
      )
      return { dialogs: stored, total: stored.length }
    }
    const upstreamDialogs = upstreamPage.dialogs.filter((dialog) =>
      dialog.conversation.id !== 'bridge:request-inbox')
    const persistedDialogs = await this._store.readDialogs(
      this._session.platformSessionId,
      upstreamDialogs.map((dialog) => dialog.conversation.id),
    )
    await this._reconcileDialogs(upstreamDialogs, persistedDialogs)
    const persisted = new Map(persistedDialogs.map((dialog) => [dialog.conversation.id, dialog]))
    const dialogs = upstreamDialogs.map((dialog) => {
      const previous = persisted.get(dialog.conversation.id)
      return {
        ...previous,
        ...dialog,
        conversation: { ...previous?.conversation, ...dialog.conversation },
        lastMessage: dialog.lastMessage ?? previous?.lastMessage,
      }
    })
    // Fetching one upstream entry for a limit-one request preserves its total
    // and continuation cursor, but the synthetic inbox still consumes that
    // requested slot.
    const upstreamSlots = injectRequestInbox ? Math.max(0, (query.limit ?? 100) - 1) : undefined
    const pageDialogs = upstreamSlots === undefined ? dialogs : dialogs.slice(0, upstreamSlots)
    return {
      ...upstreamPage,
      dialogs: injectRequestInbox ? [requestInbox, ...pageDialogs] : pageDialogs,
      ...(injectRequestInbox && upstreamPage.total !== undefined ? { total: upstreamPage.total + 1 } : {}),
    }
  }

  private async _reconcileDialogs(upstream: readonly IMDialog[], stored: readonly IMDialog[]): Promise<void> {
    const persisted = new Map(stored.map((dialog) => [dialog.conversation.id, dialog]))
    for (const dialog of upstream) {
      const previous = persisted.get(dialog.conversation.id)
      if (previous) await this._recoverDialogMessages(dialog, previous)
    }
    const changed = upstream.filter((dialog) => dialogNeedsPersistence(
      dialog, persisted.get(dialog.conversation.id),
    ))
    if (changed.length) await this._store.ingestDialogs(this._session, changed)
  }

  private async _recoverDialogMessages(dialog: IMDialog, stored: IMDialog): Promise<void> {
    const latest = dialog.lastMessage
    if (!this._publishRecovered || !latest || latest.id === stored.lastMessage?.id) return
    let recovered = [latest]
    if (stored.lastMessage && this._platform.getHistory) {
      try {
        const page = await this._platform.getHistory(this._session, dialog.conversation, {
          after: { id: stored.lastMessage.id, timestamp: stored.lastMessage.timestamp },
          limit: 100,
        })
        recovered = [...page.messages, latest]
      } catch (error) {
        this._onTrace?.(
          'dialog recovery history failed conversation=%s previous=%s latest=%s error=%s',
          dialog.conversation.id, stored.lastMessage.id, latest.id, String(error),
        )
      }
    }
    const unique = [...new Map(recovered.map((message) => [message.id, message])).values()]
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    for (const message of unique) {
      const existing = await this._store.findProjectedByPlatformId(
        this._session.platformSessionId, dialog.conversation.id, message.id,
      )
      if (existing) continue
      await this._publishRecovered({
        type: 'message', delivery: 'recovery', conversation: dialog.conversation, message,
      })
    }
  }

  async getHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<IMHistoryPage> {
    return { messages: await this._loadHistory(conversationId, query, true) }
  }

  /** Fetch and persist one upstream page before every read; HTTP ETag handles unchanged QQNT responses. */
  async syncHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<void> {
    await this._loadHistory(conversationId, query, false)
  }

  private async _loadHistory(
    conversationId: string,
    query: IMHistoryQuery,
    readStored: boolean,
  ): Promise<IMMessage[]> {
    const startedAt = performance.now()
    this._onTrace?.(
      'history data profile stage=start conversation=%s limit=%d', conversationId, query.limit ?? 100,
    )
    let conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    if (!conversation) {
      await this.getDialogs()
      conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    }
    conversation ??= { id: conversationId, kind: 'direct', title: conversationId }
    const [storedDialog] = await this._store.readDialogs(this._session.platformSessionId, [conversationId])
    const conversationMs = performance.now() - startedAt

    let upstreamMs = 0
    let ingestMs = 0
    let upstreamMessages = 0
    if (!isRequestInboxConversation(conversation)
      && this._platform.capabilities.history && this._platform.getHistory) {
      const upstreamAt = performance.now()
      this._onTrace?.('history data profile stage=upstream-start conversation=%s', conversationId)
      const page = await this._platform.getHistory(this._session, { id: conversationId }, query)
      upstreamMs = performance.now() - upstreamAt
      upstreamMessages = page.messages.length
      const ingestAt = performance.now()
      const remaining: IMMessage[] = []
      const baseline = storedDialog?.lastMessage
      const canPublish = Boolean(
        this._publishRecovered && baseline && !query.cursor && !query.before && !query.after,
      )
      for (const message of page.messages.slice().sort((left, right) =>
        left.timestamp - right.timestamp || left.id.localeCompare(right.id))) {
        const existing = await this._store.findProjectedByPlatformId(
          this._session.platformSessionId, conversationId, message.id,
        )
        const isNewer = baseline && (
          message.timestamp > baseline.timestamp
          || (message.timestamp === baseline.timestamp && message.id.localeCompare(baseline.id) > 0)
        )
        if (!existing && canPublish && isNewer) {
          await this._publishRecovered!({
            type: 'message', delivery: 'recovery', conversation, message,
          })
        } else {
          remaining.push(message)
        }
      }
      if (remaining.length) {
        await this._store.ingestMany(this._session, conversation, remaining, { allocation: 'history' })
      }
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
