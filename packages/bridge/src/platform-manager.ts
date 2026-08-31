import { createHash } from 'node:crypto'
import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import type { ServerConnection } from '@mtproto-relay/mtproto'
import type Long from 'long'
import { Context, Service, type Fiber } from 'cordis'
import type { PlatformSessionRow } from './models.js'
import { MessageStore, type DeleteResult, type IngestResult, type ReactionResult, type ReadResult } from './message-store.js'
import { isLocalOnlyConversation, requestInboxConversation, requestInboxMessage } from './request-inbox.js'
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
export type RecalledMessageMode = 'hide' | 'show'
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
  private readonly _activeSessions = new Map<string, ActivePlatformSession>()
  private _ingestLocalMessage?: (
    session: PlatformSession,
    conversation: IMConversation,
    message: IMMessage,
  ) => Promise<PlatformEventPublishResult>

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
    const dispose = this.ctx.on('im-platform/session', listener)
    return () => { dispose() }
  }

  onCommittedEvent(listener: CommittedPlatformEventListener): Unsubscribe {
    const dispose = this.ctx.on('im-platform/event-committed', listener)
    return () => { dispose() }
  }

  attachLocalMessageIngress(
    ingest: (session: PlatformSession, conversation: IMConversation, message: IMMessage) => Promise<PlatformEventPublishResult>,
  ): void {
    this._ingestLocalMessage = ingest
  }

  async ingestLocalMessage(
    session: PlatformSession,
    conversation: IMConversation,
    message: IMMessage,
  ): Promise<PlatformEventPublishResult> {
    if (!this._ingestLocalMessage) throw new Error('platform message ingress is not attached')
    return this._ingestLocalMessage(session, conversation, message)
  }

  emitCommittedEvent(session: PlatformSession, event: CommittedPlatformEvent): void {
    this.ctx.emit('im-platform/event-committed', session, event)
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
    const dispose = this.ctx.on('im-platform/change', listener)
    return () => { dispose() }
  }

  private _emit(event: PlatformRegistryEvent, registrationId: string, platform: IMPlatform): void {
    this.ctx.emit('im-platform/change', event, registrationId, platform)
  }

  private _emitSession(event: PlatformSessionEvent, binding: ActivePlatformSession): void {
    this.ctx.emit('im-platform/session', event, binding)
  }
}

interface PlatformSessionFiberState {
  context?: Context
  tail: Promise<PlatformEventPublishResult>
  pending: number
}

interface PlatformSessionFiberConfig {
  open(ctx: Context): Promise<Unsubscribe>
}

async function platformSessionFiber(ctx: Context, config: PlatformSessionFiberConfig) {
  return config.open(ctx)
}

interface PlatformEventFiberConfig {
  session: PlatformSession
  event: IMEvent
  options?: PlatformEventDeliveryOptions
  run(ctx: Context): Promise<PlatformEventPublishResult>
  result?: PlatformEventPublishResult
}

async function platformEventFiber(ctx: Context, config: PlatformEventFiberConfig) {
  const eventCtx = ctx.extend({
    bridgeEvent: { event: config.event, options: config.options },
  })
  config.result = await config.run(eventCtx)
}

/** Owns one durable event subscription per active platform session. */
export class PlatformSubscriptionManager {
  private readonly _subscriptions = new Map<string, {
    platformId: string
    fiber: Fiber
    state: PlatformSessionFiberState
  }>()

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
    private readonly _ctx: Context = new Context(),
    private readonly _recalledMessageMode: RecalledMessageMode = 'show',
  ) {}

  async startActiveSessions(platformId?: string): Promise<void> {
    const rows = await this._database.get('mtproto_platform_session', {
      active: true,
      ...(platformId ? { platformId } : {}),
    })
    await Promise.all(rows.map(async (row) => {
      const [auth] = await this._database.get('mtproto_auth_session', {
        platformId: row.platformId, platformSessionId: row.id,
      })
      const session = sessionFromRow(row, auth?.virtualPhone)
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
      await existing.fiber
      return
    }
    const platform = this._registry.require(session.platformId)
    const state: PlatformSessionFiberState = { tail: Promise.resolve(), pending: 0 }
    this._onTrace?.(
      'platform subscription start platform=%s session=%s', session.platformId, session.platformSessionId,
    )
    const fiber = this._ctx.plugin(platformSessionFiber, {
      open: async (fiberCtx) => {
        const sessionCtx = fiberCtx.extend({ bridgeSession: { platform, session } })
        state.context = sessionCtx
        const unsubscribe = await platform.subscribe(session, async (event) => {
          await this._enqueue(session, event)
        })
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
        return async () => {
          await state.tail.catch(() => {})
          await unsubscribe()
        }
      },
    })
    this._subscriptions.set(session.platformSessionId, { platformId: session.platformId, fiber, state })
    try {
      await fiber
    } catch (error) {
      if (this._subscriptions.get(session.platformSessionId)?.fiber === fiber) {
        this._subscriptions.delete(session.platformSessionId)
      }
      await fiber.dispose()
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
    await Promise.allSettled(selected.map(([, subscription]) => subscription.fiber.dispose()))
  }

  async stop(): Promise<void> {
    const subscriptions = [...this._subscriptions.values()].map((subscription) => subscription.fiber)
    this._subscriptions.clear()
    await Promise.allSettled(subscriptions.map((fiber) => fiber.dispose()))
  }

  private _enqueue(
    session: PlatformSession,
    event: IMEvent,
    options?: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
    const queuedAt = performance.now()
    const key = session.platformSessionId
    const subscription = this._subscriptions.get(key)
    if (!subscription) {
      return this.ensure(session).then(() => this._enqueue(session, event, options))
    }
    this._onTrace?.(
      'platform event enqueue platform=%s session=%s %s queued=%s',
      session.platformId, key, platformEventSummary(event), subscription.state.pending > 0,
    )
    const previous = subscription.state.tail
    let queueWaitMs = 0
    let executeMs = 0
    const current = previous.catch(() => {}).then(async () => {
      queueWaitMs = performance.now() - queuedAt
      const executeAt = performance.now()
      const parent = subscription.state.context
      if (!parent) throw new Error(`platform session fiber is not initialized: ${key}`)
      const config: PlatformEventFiberConfig = {
        session,
        event,
        options,
        run: (eventCtx) => eventCtx.waterfall(
          eventCtx,
          'bridge/platform-event',
          session,
          event,
          options,
          () => this._ingestEvent(eventCtx, session, event, options),
        ),
      }
      const fiber = parent.plugin(platformEventFiber, config)
      try {
        await fiber
        return config.result
      } finally {
        await fiber.dispose()
        executeMs = performance.now() - executeAt
      }
    })
    subscription.state.pending++
    subscription.state.tail = current
    current.catch((error) => {
      this._onTrace?.(
        'platform event failed platform=%s session=%s %s error=%s',
        session.platformId, key, platformEventSummary(event), formatError(error),
      )
      this._onError(error, session)
    }).finally(() => {
      const totalMs = performance.now() - queuedAt
      if (options?.deliveredViaRpc && totalMs >= 1_000) {
        this._onTrace?.(
          'slow local event profile platform=%s session=%s %s queueWaitMs=%d executeMs=%d totalMs=%d pending=%d',
          session.platformId, key, platformEventSummary(event),
          profileMilliseconds(queueWaitMs), profileMilliseconds(executeMs), profileMilliseconds(totalMs),
          subscription.state.pending,
        )
      }
      subscription.state.pending--
      if (subscription.state.tail === current) subscription.state.tail = Promise.resolve()
    })
    return current
  }

  private async _ingestEvent(
    eventCtx: Context,
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
      const published = await this._publishCommitted(eventCtx, session, { event, result }, options)
      this._onTrace?.(
        'platform message committed platform=%s session=%s conversation=%s message=%s',
        session.platformId, session.platformSessionId, event.conversation.id, event.message.id,
      )
      return published
    } else if (event.type === 'message-edit') {
      const result = await this._store.ingest(session, event.conversation, event.message)
      return this._publishCommitted(eventCtx, session, { event, result }, options)
    } else if (event.type === 'message-delete') {
      if (this._registry.require(session.platformId).platformKind === 'qq' && !options?.deliveredViaRpc) {
        const messages = await this._store.readProjectedByPlatformIds(
          session.platformSessionId,
          event.messageIds.map((platformMessageId) => ({
            conversationId: event.conversation.id, platformMessageId,
          })),
        )
        for (const { source } of messages) {
          const hasText = source.content.parts.some((part) => part.type === 'text' && part.text)
          if (!hasText && this._recalledMessageMode === 'show') continue
          const message = this._recalledMessageMode === 'show'
            ? markRecalledForLegacyClients(source)
            : { ...source, recalled: true }
          const result = await this._store.ingest(session, event.conversation, message)
          const eventId = `qqnt-recall:${encodeURIComponent(event.conversation.id)}:${encodeURIComponent(source.id)}`
          if (this._recalledMessageMode === 'hide') {
            const deleted = await this._store.deleteMessages(session, event.conversation, [source.id])
            await this._publishCommitted(eventCtx, session, {
              event: { type: 'message-delete', eventId, conversation: event.conversation,
                messageIds: [source.id], timestamp: event.timestamp },
              result: deleted,
            }, options)
          } else {
            await this._publishCommitted(eventCtx, session, {
              event: { type: 'message-edit', eventId, conversation: event.conversation, message },
              result,
            }, options)
          }
        }
        return
      }
      const result = await this._store.deleteMessages(session, event.conversation, event.messageIds)
      return this._publishCommitted(eventCtx, session, { event, result }, options)
    } else if (event.type === 'message-reactions') {
      const result = await this._store.setReactions(session, event.conversation, event.target, event.context)
      if (result) return this._publishCommitted(eventCtx, session, { event, result }, options)
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
        return this._publishCommitted(eventCtx, session, {
          event: { type: 'message', conversation, message }, result: stored.message,
        }, options)
      }
      return this._publishCommitted(eventCtx, session, {
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
      if (result) return this._publishCommitted(eventCtx, session, { event, result }, options)
    } else if (event.type === 'voice-call') {
      // Calls are intentionally transient and bypass every database/journal path.
      return this._publishCommitted(eventCtx, session, { event }, options)
    }
  }

  private async _publishCommitted(
    eventCtx: Context,
    session: PlatformSession,
    event: CommittedPlatformEvent,
    options?: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
    const result = await eventCtx.waterfall(
      eventCtx,
      'bridge/platform-event/publish',
      session,
      event,
      options,
      () => Promise.resolve(this._onEvent?.(session, event, options)),
    )
    await eventCtx.parallel(eventCtx, 'im-platform/event-committed', session, event)
    return result
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
  /** Correlate observer pushes with optimistic messages created by the sending client. */
  messageRandomIds?: readonly Long[]
  /** Preserve the sending client's reply thread root while reconciling its optimistic item. */
  messageReplyToTopId?: number
  /** Internal recovery path for an unchanged projection whose update was not delivered. */
  forceDelivery?: boolean
}

export type PlatformEventPublishResult = tl.RawUpdates | void

/** Synchronizes optional upstream history into the canonical database before reads. */
export class PlatformDataService {
  private readonly _dialogPageLoads = new Map<string, Promise<IMDialogPage>>()
  private readonly _historyLoads = new Map<string, Promise<IMMessage[]>>()
  private readonly _dialogReconciliationRevisions = new Map<string, string>()
  private readonly _dialogReconciliationJobs = new Map<string, Promise<void>>()
  private _dialogReconciliationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _store: MessageStore,
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    now: () => number = () => performance.now(),
    private readonly _publishRecovered?: (
      event: Extract<IMEvent, { type: 'message' }>,
      options?: PlatformEventDeliveryOptions,
    ) => Promise<unknown>,
  ) {
    void now
  }

  async getDialogs(query: { limit?: number, afterId?: string } = {}): Promise<IMDialog[]> {
    return (await this.getDialogsPage(query)).dialogs
  }

  getDialogsPage(query: { limit?: number, afterId?: string } = {}): Promise<IMDialogPage> {
    const key = `${query.limit ?? ''}\0${query.afterId ?? ''}`
    const active = this._dialogPageLoads.get(key)
    if (active) return active
    const pending = this._loadDialogsPage(query).finally(() => {
      if (this._dialogPageLoads.get(key) === pending) this._dialogPageLoads.delete(key)
    })
    this._dialogPageLoads.set(key, pending)
    return pending
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
    await this._persistDialogs(page.dialogs, stored)
    this._scheduleDialogReconciliation(page.dialogs, stored)
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
    // Bridge-owned peers are a fully local prefix. Enumerate it in batches so
    // the cursor remains independent from adapters and is never capped at 500.
    const allBridgeOwned = await this._bridgeOwnedDialogs()
    const ownedAnchor = query.afterId === undefined
      ? -1
      : allBridgeOwned.findIndex((dialog) => dialog.conversation.id === query.afterId)
    const continuingBridgeOwned = ownedAnchor >= 0
    const bridgeOwned = query.afterId === undefined || continuingBridgeOwned
      ? allBridgeOwned.slice(ownedAnchor + 1, ownedAnchor + 1 + (query.limit ?? 100))
      : []
    const bridgeOwnedRemaining = continuingBridgeOwned && ownedAnchor + 1 + bridgeOwned.length < allBridgeOwned.length
    const injectBridgeOwned = bridgeOwned.length > 0
    // A local cursor must never be forwarded upstream. Fetch one upstream row
    // only to retain its total while the local prefix still has another page.
    const upstreamQuery = continuingBridgeOwned
      ? { ...query, afterId: undefined, limit: bridgeOwnedRemaining ? 1 : Math.max(1, (query.limit ?? 100) - bridgeOwned.length) }
      : injectBridgeOwned
        ? { ...query, limit: Math.max(1, (query.limit ?? 100) - bridgeOwned.length) }
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
      dialog.conversation.metadata?.bridgeOwned !== true)
    const persistedDialogs = await this._store.readDialogs(
      this._session.platformSessionId,
      upstreamDialogs.map((dialog) => dialog.conversation.id),
    )
    // Dialog projections call _userId while materializing preview messages.
    // Await the durable ingest so sender/referenced-user rows are visible
    // before returning the authoritative page; never race persistence against
    // projection or continue it in the background.
    await this._persistDialogs(upstreamDialogs, persistedDialogs)
    this._scheduleDialogReconciliation(upstreamDialogs, persistedDialogs)
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
    const upstreamSlots = injectBridgeOwned ? Math.max(0, (query.limit ?? 100) - bridgeOwned.length) : undefined
    const pageDialogs = upstreamSlots === undefined ? dialogs : dialogs.slice(0, upstreamSlots)
    return {
      ...upstreamPage,
      dialogs: injectBridgeOwned ? [...bridgeOwned, ...pageDialogs] : pageDialogs,
      ...(upstreamPage.total !== undefined
        ? { total: upstreamPage.total + allBridgeOwned.length }
        : {}),
    }
  }

  private async _bridgeOwnedDialogs(): Promise<IMDialog[]> {
    const dialogs: IMDialog[] = []
    const seen = new Set<string>()
    let afterConversationId: string | undefined
    while (true) {
      const batch = await this._store.listDialogs(this._session.platformSessionId, {
        limit: 100,
        afterConversationId,
      })
      if (!batch.length) return dialogs
      for (const dialog of batch) {
        if (dialog.conversation.metadata?.bridgeOwned === true && !seen.has(dialog.conversation.id)) {
          seen.add(dialog.conversation.id)
          dialogs.push(dialog)
        }
      }
      const next = batch.at(-1)!.conversation.id
      if (batch.length < 100 || next === afterConversationId) return dialogs
      afterConversationId = next
    }
  }

  private _scheduleDialogReconciliation(upstream: readonly IMDialog[], stored: readonly IMDialog[]): void {
    const persisted = new Map(stored.map((dialog) => [dialog.conversation.id, dialog]))
    for (const dialog of upstream) {
      const previous = persisted.get(dialog.conversation.id)
      if (!previous || !dialog.lastMessage || dialog.lastMessage.id === previous.lastMessage?.id) continue
      const revision = dialogRevision(dialog)
      if (this._dialogReconciliationRevisions.get(dialog.conversation.id) === revision) continue
      this._dialogReconciliationRevisions.set(dialog.conversation.id, revision)
      const scheduled = this._dialogReconciliationTail.catch(() => undefined).then(async () => {
        await this._recoverDialogMessages(dialog, previous)
      }).catch((error) => {
        if (this._dialogReconciliationRevisions.get(dialog.conversation.id) === revision) {
          this._dialogReconciliationRevisions.delete(dialog.conversation.id)
        }
        this._onTrace?.(
          'dialog background reconciliation failed conversation=%s error=%s',
          dialog.conversation.id, formatError(error),
        )
      }).finally(() => {
        if (this._dialogReconciliationJobs.get(dialog.conversation.id) === scheduled) {
          this._dialogReconciliationJobs.delete(dialog.conversation.id)
        }
      })
      this._dialogReconciliationJobs.set(dialog.conversation.id, scheduled)
      this._dialogReconciliationTail = scheduled
    }
  }

  private async _persistDialogs(upstream: readonly IMDialog[], stored: readonly IMDialog[]): Promise<void> {
    const persisted = new Map(stored.map((dialog) => [dialog.conversation.id, dialog]))
    const changed = upstream.filter((dialog) => dialogNeedsPersistence(
      dialog, persisted.get(dialog.conversation.id),
    ))
    if (changed.length) await this._store.ingestDialogs(this._session, changed)
  }

  private async _recoverDialogMessages(dialog: IMDialog, stored: IMDialog | undefined): Promise<void> {
    const latest = dialog.lastMessage
    if (!stored || !this._publishRecovered || !latest || latest.id === stored.lastMessage?.id) return
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
      await this._publishRecovered({
        type: 'message', delivery: 'recovery', conversation: dialog.conversation, message,
      }, { forceDelivery: true })
    }
  }

  async getHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<IMHistoryPage> {
    return { messages: await this._coalescedHistoryLoad(conversationId, query, true) }
  }

  /** Fetch and persist one upstream page before every read; HTTP ETag handles unchanged QQNT responses. */
  async syncHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<void> {
    await this._coalescedHistoryLoad(conversationId, query, false)
  }

  private _coalescedHistoryLoad(
    conversationId: string,
    query: IMHistoryQuery,
    readStored: boolean,
  ): Promise<IMMessage[]> {
    const key = historyLoadKey(conversationId, query, readStored)
    const active = this._historyLoads.get(key)
    if (active) return active
    const pending = this._loadHistory(conversationId, query, readStored).finally(() => {
      if (this._historyLoads.get(key) === pending) this._historyLoads.delete(key)
    })
    this._historyLoads.set(key, pending)
    return pending
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
    let [conversation, storedDialogs] = await Promise.all([
      this._store.getConversation(this._session.platformSessionId, conversationId),
      this._store.readDialogs(this._session.platformSessionId, [conversationId]),
    ])
    if (!conversation) {
      await this.getDialogs()
      ;[conversation, storedDialogs] = await Promise.all([
        this._store.getConversation(this._session.platformSessionId, conversationId),
        this._store.readDialogs(this._session.platformSessionId, [conversationId]),
      ])
    }
    conversation ??= { id: conversationId, kind: 'direct', title: conversationId }
    const [storedDialog] = storedDialogs
    const conversationMs = performance.now() - startedAt

    let upstreamMs = 0
    let ingestMs = 0
    let upstreamMessages = 0
    if (!isLocalOnlyConversation(conversation)
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
        this._publishRecovered && baseline && !query.cursor && !query.before && !query.after
        && !this._dialogReconciliationJobs.has(conversationId),
      )
      const existingIds = canPublish
        ? new Set(await this._store.readExistingPlatformMessageIds(
            this._session.platformSessionId,
            conversationId,
            page.messages.flatMap((message) => [message.id, ...(message.sourceIds ?? [])]),
          ))
        : new Set<string>()
      for (const message of page.messages.slice().sort((left, right) =>
        left.timestamp - right.timestamp || left.id.localeCompare(right.id))) {
        const existing = [message.id, ...(message.sourceIds ?? [])]
          .some((platformMessageId) => existingIds.has(platformMessageId))
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
function markRecalledForLegacyClients(source: IMMessage): IMMessage {
  let changed = source.recalled !== true
  const parts = source.content.parts.map((part) => {
    if (part.type !== 'text' || !part.text) return part
    if (part.entities?.some((entity) =>
      entity.type === 'strikethrough' && entity.offset === 0 && entity.length === part.text.length)) {
      return part
    }
    changed = true
    return {
      ...part,
      entities: [...part.entities ?? [], {
        type: 'strikethrough' as const, offset: 0, length: part.text.length,
      }],
    }
  })
  return changed ? { ...source, recalled: true, content: { ...source.content, parts } } : source
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

function dialogRevision(dialog: IMDialog): string {
  return JSON.stringify([
    dialog.conversation.kind,
    dialog.conversation.title,
    dialog.conversation.parentId,
    dialog.conversation.spaceId,
    dialog.conversation.metadata ?? null,
    dialog.unreadCount,
    dialog.lastMessage?.id ?? null,
    dialog.lastMessage?.timestamp ?? null,
    dialog.lastMessage?.senderId ?? null,
    dialog.lastMessage?.content ?? null,
    dialog.lastMessage?.metadata ?? null,
  ])
}

function historyLoadKey(
  conversationId: string,
  query: IMHistoryQuery,
  readStored: boolean,
): string {
  return JSON.stringify([
    conversationId,
    readStored,
    query.cursor ?? null,
    query.limit ?? null,
    query.afterId ?? null,
    query.before?.id ?? null,
    query.before?.timestamp ?? null,
    query.after?.id ?? null,
    query.after?.timestamp ?? null,
  ])
}

export function sessionFromRow(row: PlatformSessionRow, virtualPhone?: string): PlatformSession {
  return {
    platformSessionId: row.id,
    platformId: row.platformId,
    userId: row.userId,
    credentials: row.credentials,
    metadata: row.metadata,
    virtualPhone,
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
