import type { Context, Logger } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import {
  IMMessageSendRejectedError, IMMessageTargetUnavailableError, messagePartText, resolvePlatformPluginId,
  type IMConversation, type IMConversationMember, type IMConversationMemberPage, type IMConversationRef, type IMDialogPage,
  type IMDirectDownload, type IMDownloadOptions, type IMEvent, type IMHistoryPage, type IMHistoryQuery, type IMMedia, type IMMessage, type IMMessageInput,
  type IMMessageSearchPage, type IMMessageSearchQuery, type IMPageQuery, type IMPlatform, type IMReactionContext, type IMReactionResource, type IMReactionTarget, type IMReadTarget, type IMTransferOptions,
  type IMUser, type IMUserPage, type PlatformCapabilities, type PlatformSession, type Unsubscribe,
  type VoiceCallMediaProvider, type VoiceWorkerCall, type VoiceWorkerMediaEndpoint,
} from '@mtproto-relay/bridge'
import { QQNTClient, QQNTMessageSendRejectedError, type QQNTClientOptions } from './client.js'
import { defineQQNTEventCheckpointModel } from './event-checkpoint.js'
import { QQStickerProvider } from './sticker-provider.js'
import { QQVoiceMedia } from './voice-media.js'
import { QQBridgePcmTransport } from './qq-bridge-pcm-transport.js'
import { defineLegacyQQMediaSchema } from './legacy-media-schema.js'
import { defineQQMediaPreviewModel, mediaPreviewKey, QQMediaPreviewer } from './media-preview.js'
import { migrateLegacyQQMessageMedia } from './raw-media-migration.js'
import { migrateLegacyQQGroupAliasUsers } from './user-name-migration.js'
import type {
  QQMediaLocator, QQStickerReference, WireCallSignalEvent, WireConversation, WireEvent, WireMedia, WireMessage,
  WireMultiForwardLocator, WireNativeAvsdkEvent, WireReactionState, WireTextPart,
} from './protocol.js'


const MIN_PROTOCOL_VERSION = 19
const MAX_PROTOCOL_VERSION = 21

export interface Config extends QQNTClientOptions {
  /** Hide QQ gray-tip service messages whose text contains any configured entry. */
  grayTipFilters?: string[]
  /** Generate tiny photoStrippedSize payloads after delivering the original message. */
  generatePreviews?: boolean
  /** Maximum number of concurrent inline preview generation jobs. */
  previewConcurrency?: number
}

const DEFAULT_GRAY_TIP_FILTERS = ['回应了你的消息']

export const Config = z.object({
  endpoint: z.string().default('http://127.0.0.1:18767/v1'),
  webSocketEndpoint: z.string(),
  token: z.string().role('secret'),
  grayTipFilters: z.array(z.string()).default(DEFAULT_GRAY_TIP_FILTERS),
  generatePreviews: z.boolean().default(false),
  previewConcurrency: z.natural().min(1).max(8).default(2),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export const name = 'im-platform-qqnt'
export const inject = ['imPlatform', 'imSticker', 'database', 'model']

const DIALOGS_POLL_INTERVAL_MS = 15_000
const REACTION_CATALOG_GRACE_MS = 10
const REACTION_CATALOG_RPC_GRACE_MS = 250
const REACTION_CATALOG_RETRY_DELAY_MS = 60_000
const WEBSOCKET_RECONNECT_BASE_DELAY_MS = 1_000
const WEBSOCKET_RECONNECT_MAX_DELAY_MS = 60_000
const MULTI_FORWARD_CONVERSATION_PREFIX = 'qqnt-multi-forward:'
const GLOBAL_SUBSCRIPTION_LEASES_KEY = '__crossgramQQNTSubscriptionLeasesV1' as const
const EMPTY_GROUP_REACTION_CATALOG: IMReactionContext = {
  available: [], reactions: [], maxSelected: 20,
}

interface QQNTSubscriptionLease {
  stop(): Promise<void>
}

function globalSubscriptionLeases(): Map<string, QQNTSubscriptionLease> {
  const globalState = globalThis as typeof globalThis & Partial<Record<
    typeof GLOBAL_SUBSCRIPTION_LEASES_KEY,
    Map<string, QQNTSubscriptionLease>
  >>
  return globalState[GLOBAL_SUBSCRIPTION_LEASES_KEY] ??= new Map()
}

class QQNTEventHandlingError extends Error {
  constructor(
    readonly eventId: string | undefined,
    readonly eventSummary: string,
    cause: unknown,
  ) {
    super(
      `QQNT event handler failed streamEventId=${eventId ?? '<none>'} ${eventSummary}: ${formatError(cause)}`,
      { cause },
    )
    this.name = 'QQNTEventHandlingError'
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const voiceMedia = new QQVoiceMedia(ctx)
  const id = resolvePlatformPluginId(ctx, 'qqnt')
  const stickerProviderId = `${id}:stickers`
  defineQQNTEventCheckpointModel(ctx)
  defineLegacyQQMediaSchema(ctx)
  defineQQMediaPreviewModel(ctx)
  const mediaCachePath = resolve(process.cwd(), 'data', 'qqnt-media-cache', id)
  ctx.effect(async () => {
    await ctx.database.prepared()
    const userRows = await migrateLegacyQQGroupAliasUsers(ctx.database, id)
    if (userRows) {
      ctx.logger('platform-qqnt').info(
        'migrated %d legacy QQ group-card user names to stable profile nicknames',
        userRows,
      )
    }
    const result = await migrateLegacyQQMessageMedia(ctx.database, id, mediaCachePath)
    if (result.mediaRows) {
      ctx.logger('platform-qqnt').info(
        'migrated %d legacy server-transformed QQ message media rows to raw direct-download projection',
        result.mediaRows,
      )
    }
    return () => undefined
  })
  const logger = ctx.logger('platform-qqnt')
  const mediaPreviews = new QQMediaPreviewer({
    enabled: config.generatePreviews,
    concurrency: config.previewConcurrency,
    database: ctx.database,
  })
  const platform = new QQNTPlatform(config, stickerProviderId, mediaPreviews, logger, ctx.database, voiceMedia)
  ctx.imPlatform.register(platform, id)
  ctx.imSticker.register(
    new QQStickerProvider(platform.client, stickerProviderId, undefined, logger, id),
    stickerProviderId,
  )
}

export class QQNTPlatform implements IMPlatform<QQMediaLocator> {
  readonly platformKind = 'qq'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    readState: { markRead: true, events: false },
    search: true,
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 20_000,
      maxMedia: 9,
    },
    conversations: { groups: true, channels: false, subchannels: false },
    members: { list: true, administrators: true, permissions: false },
    avatars: { users: true, conversations: true },
    messageActions: {
      delete: {
        own: { supported: true, maxAgeSeconds: 120 },
        others: { supported: true, maxAgeSeconds: 120 },
      },
      edit: { mode: 'delete-and-resend', maxAgeSeconds: 120 },
      forward: { mode: 'native', preservesAuthor: true },
    },
    reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 20 },
    stickers: { native: true, upload: false, formats: ['static', 'animated', 'video'] },
  }

  readonly client: QQNTClient
  readonly voiceMedia?: VoiceCallMediaProvider
  readonly voiceCalls = {
    control: (
      _session: PlatformSession,
      callRef: string,
      operation: 'accept' | 'reject' | 'hangup',
    ) => this.client.controlCall(callRef, operation),
  }
  private readonly database?: Database
  private readonly qqVoiceMedia?: QQVoiceMedia
  private readonly conversations = new Map<string, IMConversation<QQMediaLocator>>()
  private readonly firstUnreadSeq = new Map<string, string>()
  private reactionCatalog?: IMReactionContext
  private reactionCatalogPromise?: Promise<IMReactionContext>
  private reactionCatalogRetryAt = 0
  private readonly grayTipFilters: readonly string[]
  private readonly originSessions = new Map<string, string>()
  private readonly multiForwardLocators = new Map<string, WireMultiForwardLocator>()
  private readonly multiForwardPreviewJobs = new Map<string, Promise<string | undefined>>()
  private readonly multiForwardCleanupJobs = new Map<string, Promise<void>>()
  private readonly multiForwardCleanupSessions = new Set<string>()
  private readonly eventHandlers = new Map<
    string,
    (event: IMEvent<QQMediaLocator>) => void | Promise<void>
  >()
  private readonly preparedDialogPages = new Map<string, {
    page: IMDialogPage<QQMediaLocator>
    rawPage: IMDialogPage<QQMediaLocator>
    cachedAt: number
    firstPage: boolean
    platformSessionId: string
  }>()
  private readonly dialogPageRefreshes = new Map<string, Promise<IMDialogPage<QQMediaLocator>>>()
  private readonly inlinePreviewMessageJobs = new Map<string, Promise<void>>()
  private readonly inlinePreviewPublished = new Set<string>()

  constructor(
    options: Config = {},
    private readonly stickerProviderId = 'qqnt:stickers',
    private readonly mediaPreviews = new QQMediaPreviewer({
      enabled: options.generatePreviews,
      concurrency: options.previewConcurrency,
    }),
    private readonly logger?: Logger,
    databaseOrVoiceMedia?: Database | QQVoiceMedia,
    qqVoiceMedia?: QQVoiceMedia,
  ) {
    const legacyVoiceMedia = qqVoiceMedia ? undefined
      : typeof (databaseOrVoiceMedia as QQVoiceMedia | undefined)?.start === 'function'
        ? databaseOrVoiceMedia as QQVoiceMedia
        : undefined
    this.database = legacyVoiceMedia ? undefined : databaseOrVoiceMedia as Database | undefined
    this.qqVoiceMedia = qqVoiceMedia ?? legacyVoiceMedia
    this.client = new QQNTClient({
      ...options,
      token: options.token ?? process.env.QQNT_BRIDGE_TOKEN,
    })
    if (this.qqVoiceMedia) {
      this.voiceMedia = { start: (call, _session, endpoint) => this.startVoiceMedia(call, endpoint) }
    }
    this.grayTipFilters = options.grayTipFilters ?? DEFAULT_GRAY_TIP_FILTERS
  }

  private async startVoiceMedia(call: VoiceWorkerCall, endpoint: VoiceWorkerMediaEndpoint) {
    if (typeof endpoint.send !== 'function'
      || typeof endpoint.receive !== 'function'
      || typeof endpoint.close !== 'function') {
      throw new Error('worker PCM endpoint is unavailable')
    }
    if (!call.platformCallRef) throw new Error('QQ voice call reference is unavailable')
    const lease = await this.client.mediaLease(call.platformCallRef)
    try {
      return await this.qqVoiceMedia!.start(new QQBridgePcmTransport(lease.socketPath), {
        callId: call.callId,
        leaseId: lease.leaseId,
        token: lease.token,
      })
    } finally {
      // The media service consumes the token; this also covers invalid transport setup.
      lease.token.fill(0)
    }
  }

  async getAccount() {
    const status = await this.client.status()
    const userId = status.selfUid ?? status.selfUin
    if (!status.ready || !userId) throw new Error('QQNT account is not ready')
    if (!Number.isInteger(status.protocolVersion)
      || status.protocolVersion < MIN_PROTOCOL_VERSION
      || status.protocolVersion > MAX_PROTOCOL_VERSION) {
      throw new Error(`QQNT bridge protocol ${status.protocolVersion} is unsupported; supported range is ${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}`)
    }
    const user = await this.client.getUser(userId)
    if (!user) throw new Error(`QQNT current user is unavailable: ${userId}`)
    return {
      credentials: {},
      user: {
        id: user.id,
        firstName: user.name,
        username: user.numericId ?? status.selfUin,
        about: typeof user.signature === 'string' ? user.signature : undefined,
        avatar: user.avatar ? mapMedia(user.avatar) : undefined,
        metadata: user.numericId ? { qq: user.numericId } : undefined,
      },
    }
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    await this.cleanupLegacyMultiForwardDialogs(session)
    void this.ensureReactionCatalog()
    const controller = new AbortController()
    const knownLastMessageIds = new Map<string, string | undefined>()
    const inFlightMessageKeys = new Set<string>()
    const leases = globalSubscriptionLeases()
    const leaseKey = session.platformSessionId
    const predecessor = leases.get(leaseKey)
    const started = Promise.withResolvers<void>()
    let running = Promise.resolve<unknown>(undefined)
    let stopping: Promise<void> | undefined
    const lease: QQNTSubscriptionLease = {
      stop: () => stopping ??= (async () => {
        controller.abort()
        await started.promise
        await running
      })(),
    }
    // Install the replacement before stopping its predecessor. A third
    // concurrent subscribe then supersedes this lease instead of starting a
    // second WebSocket after both callers observed the same predecessor.
    leases.set(leaseKey, lease)
    if (predecessor) {
      await predecessor.stop().catch((error) => this.logger?.error(
        'Failed to stop superseded QQNT subscription session=%s error=%s',
        session.platformSessionId, formatError(error),
      ))
    }
    if (leases.get(leaseKey) !== lease || controller.signal.aborted) {
      started.resolve()
      return async () => {}
    }

    this.eventHandlers.set(session.platformSessionId, handler)
    running = Promise.all([
      this.subscribeLoop(session, handler, knownLastMessageIds, inFlightMessageKeys, controller.signal),
      this.subscribeDialogsLoop(session, handler, knownLastMessageIds, inFlightMessageKeys, controller.signal),
    ])
    started.resolve()
    return async () => {
      await lease.stop()
      if (leases.get(leaseKey) === lease) leases.delete(leaseKey)
      if (this.eventHandlers.get(session.platformSessionId) === handler) {
        this.eventHandlers.delete(session.platformSessionId)
      }
    }
  }

  private async subscribeLoop(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    knownLastMessageIds: Map<string, string | undefined>,
    inFlightMessageKeys: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const platformSessionId = session.platformSessionId
    let lastEventId: string | undefined
    try {
      const [checkpoint] = await this.database?.get('mtproto_qqnt_event_checkpoint', {
        platformSessionId,
      }) ?? []
      lastEventId = checkpoint?.lastEventId
    } catch (error) {
      this.logger?.warn(
        'Failed to load QQNT event checkpoint session=%s error=%s; starting without a cursor',
        platformSessionId, formatError(error),
      )
    }
    let attempt = 0
    let failedEventId: string | undefined
    let consecutiveEventFailures = 0
    while (!signal.aborted) {
      attempt++
      let reconnectDelayMs = WEBSOCKET_RECONNECT_BASE_DELAY_MS
      this.logger?.info(
        'WebSocket subscribe start session=%s attempt=%d endpoint=%s lastEventId=%s',
        platformSessionId, attempt, this.client.webSocketEndpoint, lastEventId ?? '<none>',
      )
      try {
        await this.client.subscribe(async (event, eventId) => {
          try {
            if (event.type === 'native-avsdk') {
              if (event.version !== 1
                || typeof event.callback !== 'string'
                || !event.callback.length
                || event.callback.length > 256
                || !Array.isArray(event.args)) return
              return
            }
            if (event.type === 'call-signal' && !isWireCallSignalEvent(event)) return
            if (event.type !== 'call-signal' && isMultiForwardConversationId(event.conversation.id)) {
              if (event.type === 'message') {
                knownLastMessageIds.set(event.conversation.id, event.message.id)
              }
              this.logger?.warn(
                'WebSocket event filtered session=%s reason=temporary-multi-forward streamEventId=%s conversation=%s',
                platformSessionId, eventId ?? '<none>', event.conversation.id,
              )
              return
            }
            const eventSummary = wireEventSummary(event)
            this.logger?.debug(
              'WebSocket event received session=%s streamEventId=%s %s',
              platformSessionId, eventId ?? '<none>', eventSummary,
            )
            if (event.type === 'message' && this.isFilteredGrayTip(event.message)) {
              knownLastMessageIds.set(event.conversation.id, event.message.id)
              this.logger?.debug(
                'WebSocket event filtered session=%s reason=gray-tip streamEventId=%s message=%s text=%s',
                platformSessionId, eventId ?? '<none>', event.message.id,
                event.message.serviceAction?.text ?? '',
              )
              return
            }
            if (event.type === 'message' && event.message.originRequestId
              && this.originSessions.get(event.message.originRequestId) === platformSessionId) {
              knownLastMessageIds.set(event.conversation.id, event.message.id)
              this.logger?.debug(
                'WebSocket event filtered session=%s reason=own-origin streamEventId=%s message=%s originRequestId=%s',
                platformSessionId, eventId ?? '<none>', event.message.id, event.message.originRequestId,
              )
              return
            }
            const mapped = this.mapEvent(event)
            this.logger?.debug(
              'WebSocket event mapped session=%s streamEventId=%s %s',
              platformSessionId, eventId ?? '<none>', event.type === 'call-signal' ? eventSummary : imEventSummary(mapped),
            )
            if (mapped.type === 'message') {
              const delivered = await this.dispatchMessage(session, handler, mapped, inFlightMessageKeys)
              if (delivered) knownLastMessageIds.set(mapped.conversation.id, mapped.message.id)
            } else {
              await handler(mapped)
            }
            this.logger?.debug(
              'WebSocket event handled session=%s streamEventId=%s %s',
              platformSessionId, eventId ?? '<none>', event.type === 'call-signal' ? eventSummary : imEventSummary(mapped),
            )
            failedEventId = undefined
            consecutiveEventFailures = 0
          } catch (error) {
            throw new QQNTEventHandlingError(eventId, wireEventSummary(event), error)
          }
        }, signal, {
          lastEventId,
          onEventId: async (eventId) => {
            // The client invokes this only after the event handler commits.
            // Persist before advancing memory so a crash or reconnect can
            // replay the event, but can never skip an uncommitted event.
            if (this.database) {
              await this.database.upsert('mtproto_qqnt_event_checkpoint', [{
                platformSessionId,
                lastEventId: eventId,
                updatedAt: new Date(),
              }])
            }
            lastEventId = eventId
          },
        })
        if (!signal.aborted) this.logger?.warn(
          'WebSocket stream ended session=%s attempt=%d lastEventId=%s; reconnecting',
          platformSessionId, attempt, lastEventId ?? '<none>',
        )
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof QQNTEventHandlingError) {
          if (failedEventId === error.eventId) consecutiveEventFailures++
          else {
            failedEventId = error.eventId
            consecutiveEventFailures = 1
          }
          reconnectDelayMs = Math.min(
            WEBSOCKET_RECONNECT_MAX_DELAY_MS,
            WEBSOCKET_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(consecutiveEventFailures - 1, 16),
          )
          this.logger?.error(
            'WebSocket event handling failed session=%s attempt=%d streamEventId=%s lastEventId=%s failures=%d retryDelayMs=%d error=%s',
            platformSessionId, attempt, error.eventId ?? '<none>', lastEventId ?? '<none>',
            consecutiveEventFailures, reconnectDelayMs, formatError(error),
          )
        } else {
          failedEventId = undefined
          consecutiveEventFailures = 0
          this.logger?.warn(
            'WebSocket stream failed session=%s attempt=%d lastEventId=%s error=%s; reconnecting',
            platformSessionId, attempt, lastEventId ?? '<none>', formatError(error),
          )
        }
      }
      await abortableDelay(reconnectDelayMs, signal)
    }
  }

  private async subscribeDialogsLoop(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    knownLastMessageIds: Map<string, string | undefined>,
    inFlightMessageKeys: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const platformSessionId = session.platformSessionId
    let hasBaseline = false
    while (!signal.aborted) {
      try {
        if (!hasBaseline) {
          // The baseline must include every page. Otherwise a conversation
          // outside the first page is misclassified as newly received when it
          // later moves to the top after a message arrives.
          let cursor: string | undefined
          const seenCursors = new Set<string>()
          do {
            const query = { cursor, limit: 100 }
            const page = await this.fetchDialogsPage(query, signal)
            await this.cachePreparedDialogPage(session, query, page)
            for (const dialog of page.dialogs) {
              knownLastMessageIds.set(dialog.conversation.id, dialog.lastMessage?.id)
            }
            cursor = page.nextCursor
            if (cursor && seenCursors.has(cursor)) break
            if (cursor) seenCursors.add(cursor)
          } while (cursor && !signal.aborted)
          hasBaseline = true
        } else {
          // Recent changes move to the first page, so subsequent polling only
          // needs that page rather than scanning hundreds of dialogs each time.
          const query = { limit: 100 }
          const page = await this.fetchDialogsPage(query, signal)
          await this.cachePreparedDialogPage(session, query, page)
          for (const dialog of page.dialogs) {
            const conversationId = dialog.conversation.id
            const previousId = knownLastMessageIds.get(conversationId)
            const known = knownLastMessageIds.has(conversationId)
            if (!dialog.lastMessage) {
              if (!known) knownLastMessageIds.set(conversationId, undefined)
              continue
            }
            if (known && previousId === dialog.lastMessage.id) continue
            const recovered = await this.recoverDialogMessages(
              session, dialog.conversation, previousId, dialog.lastMessage,
            )
            for (const message of recovered) {
              const originRequestId = message.metadata?.qqOriginRequestId
              if (typeof originRequestId === 'string'
                && this.originSessions.get(originRequestId) === platformSessionId) {
                knownLastMessageIds.set(conversationId, message.id)
                continue
              }
              const delivered = await this.dispatchMessage(session, handler, {
                type: 'message', conversation: dialog.conversation, message,
              }, inFlightMessageKeys)
              if (delivered) knownLastMessageIds.set(conversationId, message.id)
            }
          }
        }
      } catch {
        if (signal.aborted) return
      }
      await abortableDelay(DIALOGS_POLL_INTERVAL_MS, signal)
    }
  }

  private async recoverDialogMessages(
    session: PlatformSession,
    conversation: IMConversation<QQMediaLocator>,
    previousId: string | undefined,
    latest: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>[]> {
    if (!previousId) return [latest]
    try {
      const response = await this.client.getHistory(conversation.id, {
        afterId: previousId,
        limit: 100,
      })
      const messages = await Promise.all(response.messages
        .filter((message) => message.id !== previousId && !this.isFilteredGrayTip(message))
        .map((message) => this.prepareRequestedMessage(
          session, conversation, this.mapMessage(message),
        )))
      if (!messages.some((message) => message.id === latest.id)) messages.push(latest)
      return messages.sort(compareMessagesChronologically)
    } catch (error) {
      this.logger?.warn(
        'Dialog polling recovery failed conversation=%s previous=%s latest=%s error=%s; falling back to latest',
        conversation.id, previousId, latest.id, formatError(error),
      )
      return [latest]
    }
  }

  private async dispatchMessage(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    event: Extract<IMEvent<QQMediaLocator>, { type: 'message' }>,
    inFlightMessageKeys: Set<string>,
  ): Promise<boolean> {
    const key = `${event.conversation.id}\0${event.message.id}`
    if (inFlightMessageKeys.has(key)) return false
    inFlightMessageKeys.add(key)
    try {
      const message = await this.prepareInitialMessage(event.message)
      await handler({ ...event, message })
      this.scheduleInlinePreview(session, event.conversation, message, handler)
      return true
    } finally {
      inFlightMessageKeys.delete(key)
    }
  }

  async getDialogs(session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<QQMediaLocator>> {
    await this.cleanupLegacyMultiForwardDialogs(session)
    await waitAtMost(this.ensureReactionCatalog().catch(() => undefined), REACTION_CATALOG_GRACE_MS)
    const cached = this.cachedPreparedDialogPage(session, query)
    if (cached) {
      if (Date.now() - cached.cachedAt >= DIALOGS_POLL_INTERVAL_MS) {
        void this.refreshPreparedDialogPage(session, query).catch((error) => this.logger?.warn(
          'Dialog page background refresh failed session=%s error=%s',
          session.platformSessionId, formatError(error),
        ))
      }
      return cached.page
    }
    return this.refreshPreparedDialogPage(session, query)
  }

  async getConversation(
    _session: PlatformSession,
    conversationId: string,
  ): Promise<IMConversation<QQMediaLocator> | null> {
    if (isMultiForwardConversationId(conversationId)) {
      return this.conversations.get(conversationId) ?? null
    }
    return this.mapConversation(await this.client.getConversation(conversationId))
  }

  private async fetchDialogsPage(
    query: IMPageQuery = {},
    signal?: AbortSignal,
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const response = await this.client.getDialogs({
      cursor: query.cursor, afterId: query.afterId, limit: query.limit,
    }, signal)
    const conversations = response.conversations.filter((conversation) =>
      !isMultiForwardConversationId(conversation.id))
    for (const conversation of conversations) {
      if (conversation.firstUnread?.msgSeq) this.firstUnreadSeq.set(conversation.id, conversation.firstUnread.msgSeq)
      else this.firstUnreadSeq.delete(conversation.id)
    }
    return {
      dialogs: conversations.map((conversation) => ({
        conversation: this.mapConversation(conversation),
        unreadCount: conversation.unreadCount ?? 0,
        lastMessage: conversation.lastMessage
          && !this.isFilteredGrayTip(conversation.lastMessage)
          ? this.mapMessage(conversation.lastMessage)
          : undefined,
        readInboxMaxMessage: conversation.readInboxMaxMessage
          ? this.mapMessage(conversation.readInboxMaxMessage)
          : undefined,
      })),
      nextCursor: response.nextCursor,
      total: response.total,
    }
  }

  private async prepareDialogPage(
    session: PlatformSession,
    page: IMDialogPage<QQMediaLocator>,
    previous?: {
      page: IMDialogPage<QQMediaLocator>
      rawPage: IMDialogPage<QQMediaLocator>
    },
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const previousRaw = new Map(previous?.rawPage.dialogs.map((dialog) => [dialog.conversation.id, dialog]))
    const previousPrepared = new Map(previous?.page.dialogs.map((dialog) => [dialog.conversation.id, dialog]))
    const preparePreview = async (
      message: IMMessage<QQMediaLocator> | undefined,
      raw: IMMessage<QQMediaLocator> | undefined,
      prepared: IMMessage<QQMediaLocator> | undefined,
      conversation: IMConversation<QQMediaLocator>,
    ) => message && rawDialogPreviewEqual(message, raw) && prepared
      ? prepared
      : message
        ? this.prepareRequestedMessage(session, conversation, message)
        : undefined
    return {
      ...page,
      dialogs: await Promise.all(page.dialogs.map(async (dialog) => {
        const raw = previousRaw.get(dialog.conversation.id)
        const prepared = previousPrepared.get(dialog.conversation.id)
        return {
          ...dialog,
          lastMessage: await preparePreview(
            dialog.lastMessage, raw?.lastMessage, prepared?.lastMessage, dialog.conversation,
          ),
          readInboxMaxMessage: await preparePreview(
            dialog.readInboxMaxMessage,
            raw?.readInboxMaxMessage,
            prepared?.readInboxMaxMessage,
            dialog.conversation,
          ),
        }
      })),
    }
  }

  private async cachePreparedDialogPage(
    session: PlatformSession,
    query: IMPageQuery,
    page: IMDialogPage<QQMediaLocator>,
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const key = dialogPageCacheKey(session.platformSessionId, query)
    const previous = this.preparedDialogPages.get(key)
    const prepared = await this.prepareDialogPage(session, page, previous)
    this.preparedDialogPages.set(key, {
      page: prepared, rawPage: page,
      cachedAt: Date.now(),
      firstPage: !query.cursor && !query.afterId,
      platformSessionId: session.platformSessionId,
    })
    if (this.preparedDialogPages.size > 64) {
      this.preparedDialogPages.delete(this.preparedDialogPages.keys().next().value!)
    }
    return prepared
  }

  private cachedPreparedDialogPage(
    session: PlatformSession,
    query: IMPageQuery,
  ): { page: IMDialogPage<QQMediaLocator>, cachedAt: number } | undefined {
    const exact = this.preparedDialogPages.get(dialogPageCacheKey(session.platformSessionId, query))
    const cached = exact ?? (!query.cursor && !query.afterId
      ? [...this.preparedDialogPages.values()]
        .filter((entry) => entry.firstPage && entry.platformSessionId === session.platformSessionId)
        .sort((left, right) => left.cachedAt - right.cachedAt)
        .at(-1)
      : undefined)
    if (!cached) return
    const limit = query.limit ?? cached.page.dialogs.length
    return {
      cachedAt: cached.cachedAt,
      page: { ...cached.page, dialogs: cached.page.dialogs.slice(0, limit) },
    }
  }

  private refreshPreparedDialogPage(
    session: PlatformSession,
    query: IMPageQuery,
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const key = dialogPageCacheKey(session.platformSessionId, query)
    const existing = this.dialogPageRefreshes.get(key)
    if (existing) return existing
    const pending = this.fetchDialogsPage(query)
      .then((page) => this.cachePreparedDialogPage(session, query, page))
      .finally(() => {
        if (this.dialogPageRefreshes.get(key) === pending) this.dialogPageRefreshes.delete(key)
      })
    this.dialogPageRefreshes.set(key, pending)
    return pending
  }

  async getContacts(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMUserPage<QQMediaLocator>> {
    const page = await this.client.getContacts({ cursor: query.cursor, limit: query.limit })
    return {
      users: page.users.map((user) => ({
        id: user.id,
        firstName: user.name,
        username: user.numericId,
        about: typeof user.signature === 'string' ? user.signature : undefined,
        avatar: user.avatar ? mapMedia(user.avatar) : undefined,
        metadata: user.numericId ? { qq: user.numericId } : undefined,
      })),
      nextCursor: page.nextCursor,
    }
  }

  async getHistory(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<QQMediaLocator>> {
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const multiForward = this.multiForwardLocators.get(conversation.id)
    if (multiForward) {
      const messages = await this.client.getMultiForwardMessages(multiForward)
      await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
      return {
        messages: await Promise.all(messages.filter((message) => !this.isFilteredGrayTip(message))
          .slice(0, query.limit ?? messages.length).map((message) => {
            const mapped = this.rebaseMultiForwardMedia(this.mapMessage(message), multiForward)
            return this.prepareRequestedMessage(session, this.conversationFor(conversation.id), {
              ...mapped, conversationId: conversation.id,
            })
        })),
      }
    }
    if (isMultiForwardConversationId(conversation.id)) return { messages: [] }
    const response = await this.client.getHistory(conversation.id, {
      cursor: query.cursor,
      limit: query.limit,
      beforeId: query.before?.id,
      afterId: query.after?.id,
      aroundUnreadSeq: !query.cursor && !query.before && !query.after
        ? this.firstUnreadSeq.get(conversation.id)
        : undefined,
    })
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    return {
      messages: await Promise.all(response.messages.filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(session, this.conversationFor(conversation.id), this.mapMessage(message)))),
      nextCursor: response.nextCursor,
    }
  }

  async searchMessages(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMMessageSearchQuery,
  ): Promise<IMMessageSearchPage<QQMediaLocator>> {
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const response = await this.client.searchMessages(conversation.id, {
      q: query.query,
      cursor: query.cursor,
      limit: query.limit,
      fromUserId: query.fromUserId,
      minTimestamp: query.minTimestamp,
      maxTimestamp: query.maxTimestamp,
      mediaKind: query.mediaKind,
    })
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    return {
      messages: await Promise.all(response.messages.filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(session, this.conversationFor(conversation.id), this.mapMessage(message)))),
      nextCursor: response.nextCursor,
    }
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser<QQMediaLocator> | null> {
    const user = await this.client.getUser(userId)
    if (!user) return null
    return {
      id: user.id,
      firstName: user.name,
      username: user.numericId,
      about: typeof user.signature === 'string' ? user.signature : undefined,
      avatar: user.avatar ? mapMedia(user.avatar) : undefined,
      metadata: user.numericId ? { qq: user.numericId } : undefined,
    }
  }

  async getMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<QQMediaLocator> | null> {
    const message = await this.client.getMessage(conversation.id, messageId)
    return message && !this.isFilteredGrayTip(message)
      ? this.prepareRequestedMessage(session, this.conversationFor(conversation.id), this.mapMessage(message))
      : null
  }

  async clickInlineButton(
    _session: PlatformSession,
    target: { conversationId: string, messageId: string, nativeSequence?: string },
    button: Extract<import('@mtproto-relay/bridge').IMInlineKeyboardButton, { type: 'callback' }>,
  ): Promise<{ message?: string, alert?: boolean, url?: string }> {
    const metadata = button.metadata?.qqnt
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('QQNT callback button metadata is missing')
    }
    const native = metadata as Record<string, unknown>
    const result = await this.client.clickInlineKeyboard({
      conversationId: target.conversationId,
      messageId: target.messageId,
      messageSequence: target.nativeSequence,
      buttonId: String(native.id ?? ''),
      callbackData: button.data,
      botAppid: String(native.botAppid ?? ''),
    })
    return { message: result.promptText || undefined, alert: result.promptType === 1 }
  }

  async markRead(_session: PlatformSession, target: IMReadTarget): Promise<void> {
    if (isMultiForwardConversationId(target.conversationId)) return
    await this.client.markRead(target.conversationId, target.messageId)
    this.firstUnreadSeq.delete(target.conversationId)
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<QQMediaLocator>> {
    const page = await this.client.getMembers(conversation.id, { cursor: query.cursor, limit: query.limit })
    return {
      members: page.members.map((member): IMConversationMember<QQMediaLocator> => ({
        user: {
          id: member.user.id,
          firstName: member.user.name,
          username: member.user.numericId,
          avatar: member.user.avatar ? mapMedia(member.user.avatar) : undefined,
          metadata: {
            ...(member.user.numericId ? { qq: member.user.numericId } : {}),
            qqName: member.user.name,
          },
        },
        role: member.role,
        permissions: permissions(member.role),
        title: member.user.alias?.trim() || undefined,
      })),
      total: page.total,
      nextCursor: page.nextCursor,
    }
  }

  async getConversationMember(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<QQMediaLocator> | null> {
    const known = this.conversations.get(conversation.id)
    const selfRole = known?.metadata?.qqSelfRole
    if (
      userId === session.userId
      && (selfRole === 'owner' || selfRole === 'administrator' || selfRole === 'member')
    ) {
      const user = await this.getUser(session, userId)
      if (user) return { user, role: selfRole, permissions: permissions(selfRole) }
    }
    // Opening a Telegram megagroup commonly probes inputPeerSelf. Never turn a
    // temporarily missing group profile into a full QQ member-list scan.
    if (userId === session.userId) return null
    let cursor: string | undefined
    do {
      const page = await this.getConversationMembers(session, conversation, { cursor, limit: 500 })
      const found = page.members.find((member) => member.user.id === userId)
      if (found) return found
      cursor = page.nextCursor
    } while (cursor)
    return null
  }

  async sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<QQMediaLocator>> {
    const resolvedMentionUsers = new Map<string, Promise<string | undefined>>()
    const textParts: WireTextPart[] = []
    for (const part of content.parts) {
      if (part.type !== 'text') continue
      const entities: NonNullable<WireTextPart['entities']> = []
      for (const entity of part.entities ?? []) {
        if (entity.type === 'mention') {
          let numericId = entity.numericId
          if (!numericId) {
            let pending = resolvedMentionUsers.get(entity.userId)
            if (!pending) {
              pending = this.client.getUser(entity.userId)
                .then((user) => user?.numericId)
                .catch(() => undefined)
              resolvedMentionUsers.set(entity.userId, pending)
            }
            numericId = await pending
          }
          entities.push({ ...entity, numericId })
          continue
        }
        if (entity.type === 'conversation-link') continue
        if (entity.type !== 'custom-emoji') continue
        const match = /^1:(\d+)$/.exec(entity.definition.key)
        if (match) entities.push({
          type: 'qq-face', offset: entity.offset, length: entity.length,
          faceId: match[1], faceType: 1,
        })
      }
      textParts.push({ type: 'text', text: part.text, entities: entities.length ? entities : undefined })
    }
    const text = textParts.map((part) => part.text).join('\n') || undefined
    const mediaParts = content.parts.filter((part) => part.type === 'media')
    const stickerParts = content.parts.filter((part) => part.type === 'sticker')
    if (stickerParts.length > 1 || stickerParts.length && mediaParts.length) {
      throw new Error('QQNT supports either one sticker or up to nine media items per message')
    }
    const stickerPart = stickerParts[0]
    let sticker: QQStickerReference | undefined
    if (stickerPart?.type === 'sticker') {
      if (stickerPart.sticker.type !== 'native') {
        throw new Error('QQNT only accepts native QQ sticker send plans')
      }
      sticker = stickerPart.sticker.reference as unknown as QQStickerReference
    }
    if (mediaParts.length > 9) throw new Error('QQNT supports at most nine media items per message')
    const voiceParts = mediaParts.filter((part) => part.media.voice)
    if (voiceParts.length && (voiceParts.length !== 1 || mediaParts.length !== 1 || text || sticker || content.replyToId || content.replyToNativeSequence)) {
      throw new Error('QQNT voice messages must contain exactly one voice item without a reply')
    }
    const media = mediaParts.map((part, index) => ({
      kind: part.media.kind,
      name: part.media.name ?? `upload-${Date.now()}-${index}`,
      mimeType: part.media.mimeType,
      width: part.media.width,
      height: part.media.height,
      duration: part.media.duration,
      voice: part.media.voice,
      source: part.media.source,
    }))
    const originRequestId = randomUUID()
    this.originSessions.set(originRequestId, session.platformSessionId)
    try {
      let sent: WireMessage
      try {
        sent = await this.client.sendMessage(
          conversation.id, text, media.length ? media : undefined,
          options, originRequestId, sticker, textParts,
          content.replyToId, content.replyToNativeSequence,
        )
      } catch (error) {
        if (error instanceof QQNTMessageSendRejectedError) {
          throw new IMMessageSendRejectedError('permission-denied', error.message, { cause: error })
        }
        throw error
      }
      const message = await this.prepareInitialMessage(this.mapMessage(sent))
      this.scheduleInlinePreview(
        session, this.conversationFor(conversation.id), message,
        this.eventHandlers.get(session.platformSessionId),
      )
      return message
    } finally {
      const timer = setTimeout(() => this.originSessions.delete(originRequestId), 120_000)
      timer.unref()
    }
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
    options: import('@mtproto-relay/bridge').IMDeleteMessagesOptions,
  ): Promise<void> {
    await this.client.deleteMessages(conversation.id, messageIds, options.forEveryone)
  }

  async forwardMessages(
    session: PlatformSession,
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options: import('@mtproto-relay/bridge').IMForwardMessagesOptions = {},
  ): Promise<IMMessage<QQMediaLocator>[]> {
    if (!messageIds.length) return []
    if (options.dropAuthor) {
      return this.copyForwardedMessages(session, from, messageIds, to, options)
    }
    const merged = messageIds.length > 1
    try {
      const messages = await this.client.forwardMessages(from.id, messageIds, to.id, merged)
      return Promise.all(messages.map((message) => this.prepareInitialMessage(this.mapMessage(message))))
    } catch (error) {
      if (!isNativeForwardRejection(error)
        || options.sourceMessages?.length !== messageIds.length) throw error
      return this.copyForwardedMessages(session, from, messageIds, to, options)
    }
  }

  private async copyForwardedMessages(
    session: PlatformSession,
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options: import('@mtproto-relay/bridge').IMForwardMessagesOptions,
  ): Promise<IMMessage<QQMediaLocator>[]> {
    const outputs: IMMessage<QQMediaLocator>[] = []
    for (const [index, messageId] of messageIds.entries()) {
      const stored = options.sourceMessages?.[index] as IMMessage<QQMediaLocator> | undefined
      const source = stored ?? await this.client.getMessage(from.id, messageId)
        .then((wire) => {
          if (!wire) throw new Error(`QQ source message not found: ${messageId}`)
          return this.mapMessage(wire)
        })
      const parts: IMMessageInput['parts'] = source.content.parts.map((part) => {
        if (part.type === 'text') return { ...part }
        if (part.type === 'card') return { type: 'text' as const, text: messagePartText(part) }
        if (part.type === 'sticker') return {
          type: 'sticker' as const,
          sticker: {
            type: 'native' as const,
            providerId: part.sticker.providerId,
            stickerId: part.sticker.stickerId,
            packId: part.sticker.packId,
            reference: part.sticker.locator!,
          },
        }
        if (!part.media.locator) throw new Error(`QQ source media has no locator: ${part.media.id}`)
        return {
          type: 'media' as const,
          media: {
            kind: part.media.kind, name: part.media.name, mimeType: part.media.mimeType,
            size: part.media.size, width: part.media.width, height: part.media.height,
            duration: part.media.duration, voice: part.media.voice,
            source: {
              size: part.media.size,
              stream: ({ signal } = {}) => this.downloadMedia(session, part.media, { signal }),
            },
          },
        }
      })
      outputs.push(await this.sendMessage(session, to, {
        parts,
        replyToId: options.replyToId,
      }))
    }
    return outputs
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<QQMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    if (!media.locator) throw new Error(`QQ media ${media.id} has no locator`)
    if (media.locator.deferred) return
    let transferred = 0
    for await (const chunk of this.client.downloadFile(media.locator, {
      signal: options.signal, offset: options.offset, limit: options.limit,
    })) {
      transferred += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes: transferred,
        totalBytes: rangedSize(media.size, options.offset, options.limit),
      })
      yield chunk
    }
  }

  async resolveMediaUrl(
    _session: PlatformSession,
    media: IMMedia<QQMediaLocator>,
  ): Promise<IMDirectDownload | undefined> {
    const locator = media.locator
    if (!locator || locator.deferred) return
    if (media.voice) return
    return this.client.resolveFileUrlForDirectDownload(rawQQMediaLocator(locator))
  }

  async getAvailableReactions(
    _session: PlatformSession,
    target: IMReactionTarget,
  ): Promise<IMReactionContext> {
    if (!this.isGroupConversation(target.conversationId)) {
      return { available: [], reactions: [], maxSelected: 0 }
    }
    await waitAtMost(this.ensureReactionCatalog(), REACTION_CATALOG_RPC_GRACE_MS)
    return this.reactionCatalog ?? EMPTY_GROUP_REACTION_CATALOG
  }

  async getMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
  ): Promise<IMReactionContext> {
    if (!this.isGroupConversation(target.conversationId)) {
      return { available: [], reactions: [], maxSelected: 0 }
    }
    return this.withReactionCatalog(
      await this.client.getMessageReactions(
        target.conversationId, target.targetId, target.nativeSequence,
      ),
    )
  }

  async setMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
    reactionKeys: readonly string[],
  ): Promise<IMReactionContext> {
    if (!this.isGroupConversation(target.conversationId)) {
      throw new Error('QQ reactions are unavailable in direct conversations')
    }
    try {
      return this.withReactionCatalog(await this.client.setMessageReactions(
        target.conversationId, target.targetId, reactionKeys, target.nativeSequence,
      ))
    } catch (error) {
      if (error instanceof Error && /^QQNT bridge 404: QQ reaction target not found:/.test(error.message)) {
        throw new IMMessageTargetUnavailableError(error.message, { cause: error })
      }
      throw error
    }
  }

  async *downloadReactionResource(
    _session: PlatformSession,
    resource: IMReactionResource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const locator = resource.locator
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
      throw new Error('QQ reaction resource has no usable locator')
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('download aborted')
    if (isReactionResourceLocator(locator)) {
      let transferredBytes = 0
      for await (const chunk of this.client.downloadReactionResource(locator.reactionKey, {
        signal: options.signal,
        offset: options.offset,
        limit: options.limit,
        onChunk: async (size) => {
          transferredBytes += size
          await options.onProgress?.({
            phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: resource.size,
          })
        },
      })) yield chunk
      return
    }
    if (!isRemoteQQMediaLocator(locator)) throw new Error('QQ reaction resource has no cached remote asset')
    let transferredBytes = 0
    for await (const chunk of sliceStream(
      this.client.downloadFile(locator, { signal: options.signal }),
      options.offset, options.limit,
    )) {
      transferredBytes += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: resource.size,
      })
      yield chunk
    }
  }

  async resolveReactionResourceUrl(
    _session: PlatformSession,
    resource: IMReactionResource,
  ): Promise<IMDirectDownload | undefined> {
    const locator = resource.locator
    if (!isRemoteQQMediaLocator(locator)) return
    return this.client.resolveFileUrlForDirectDownload(rawQQMediaLocator(locator))
  }

  private ensureReactionCatalog(): Promise<IMReactionContext> {
    if (this.reactionCatalog) return Promise.resolve(this.reactionCatalog)
    if (this.reactionCatalogPromise) return this.reactionCatalogPromise
    if (Date.now() < this.reactionCatalogRetryAt) {
      return Promise.resolve(EMPTY_GROUP_REACTION_CATALOG)
    }
    const pending = this.loadReactionCatalog().catch((error) => {
      this.reactionCatalogRetryAt = Date.now() + REACTION_CATALOG_RETRY_DELAY_MS
      this.logger?.warn(
        'QQ reaction catalog refresh failed; serving cached/empty catalog retryAt=%s error=%s',
        new Date(this.reactionCatalogRetryAt).toISOString(), formatError(error),
      )
      return this.reactionCatalog ?? EMPTY_GROUP_REACTION_CATALOG
    })
    this.reactionCatalogPromise = pending
    return pending.finally(() => {
      if (this.reactionCatalogPromise === pending) this.reactionCatalogPromise = undefined
    })
  }

  private async loadReactionCatalog(): Promise<IMReactionContext> {
    const source = await this.client.getReactionCatalog()
    const available = await mapConcurrent(source.available, 8, async (definition) => {
      if (definition.presentation.type !== 'custom') return definition
      const { resource } = definition.presentation
      const locator = resource.locator
      if (!isReactionResourceLocator(locator) && !isRemoteQQMediaLocator(locator)) return definition
      const animated = resource.format === 'video'
      return {
        ...definition,
        presentation: {
          ...definition.presentation,
          resource: {
            ...resource,
            format: animated ? 'animated' as const : 'static' as const,
            mimeType: animated ? 'image/apng' as const : 'image/png' as const,
          },
        },
      }
    })
    const catalog: IMReactionContext = {
      available,
      reactions: [],
      maxSelected: source.maxSelected,
    }
    this.reactionCatalog = catalog
    return catalog
  }

  private async withReactionCatalog(state: WireReactionState): Promise<IMReactionContext> {
    const loading = this.ensureReactionCatalog()
    // A reaction count without its definition cannot be represented in TL:
    // ReactionRpc will omit it and therefore never register the custom emoji
    // document requested by Telegram clients. Keep reaction-free message paths
    // non-blocking, but wait for the shared catalog whenever the response
    // actually contains reactions that need projecting.
    const catalog = state.reactions.length
      ? await loading
      : this.reactionCatalog ?? EMPTY_GROUP_REACTION_CATALOG
    return { available: catalog.available, reactions: state.reactions, maxSelected: state.maxSelected }
  }

  private isGroupConversation(conversationId: string): boolean {
    const known = this.conversations.get(conversationId)
    if (known) return known.kind === 'group'
    return conversationId.startsWith('2:') || /^\d+$/.test(conversationId)
  }

  private conversationFor(conversationId: string): IMConversation<QQMediaLocator> {
    return this.conversations.get(conversationId) ?? {
      id: conversationId,
      kind: this.isGroupConversation(conversationId) ? 'group' : 'direct',
      title: conversationId,
    }
  }

  private async prepareRequestedMessage(
    session: PlatformSession,
    conversation: IMConversation<QQMediaLocator>,
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    const handler = this.eventHandlers.get(session.platformSessionId)
    const prepared = handler ? message : await this.prepareInitialMessage(message)
    this.scheduleInlinePreview(session, conversation, prepared, handler)
    // Keep history metadata-only. The patched client asks getFileUrl for the
    // original and downloads it from QQ's CDN. Inline preview work is queued
    // after this return and can only publish a later message-edit event.
    return prepared
  }

  private scheduleInlinePreview(
    session: PlatformSession,
    conversation: IMConversation<QQMediaLocator>,
    message: IMMessage<QQMediaLocator>,
    handler?: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): void {
    if (!this.mediaPreviews.enabled) return
    const keys = message.content.parts.flatMap((part) => part.type === 'media'
      && part.media.kind === 'image' && part.media.locator && !part.media.strippedThumbnail
      ? [mediaPreviewKey(part.media.locator)]
      : [])
    if (!keys.length) return
    const jobKey = `${session.platformSessionId}\0${conversation.id}\0${message.id}\0${keys.join(',')}`
    if (this.inlinePreviewPublished.has(jobKey) || this.inlinePreviewMessageJobs.has(jobKey)) return

    const pending = deferTurn().then(() => this.prepareInlinePreviewMessage(message)).then(async (updated) => {
      if (updated === message || !handler
        || this.eventHandlers.get(session.platformSessionId) !== handler) return
      await handler({
        type: 'message-edit',
        eventId: `qqnt-inline-preview:${createHash('sha256').update(jobKey).digest('hex').slice(0, 32)}`,
        conversation,
        message: updated,
      })
      rememberSet(this.inlinePreviewPublished, jobKey, 4096)
    }).catch((error) => {
      this.logger?.warn(
        'inline preview generation failed conversation=%s message=%s error=%s',
        conversation.id, message.id, formatError(error),
      )
    }).finally(() => {
      if (this.inlinePreviewMessageJobs.get(jobKey) === pending) {
        this.inlinePreviewMessageJobs.delete(jobKey)
      }
    })
    this.inlinePreviewMessageJobs.set(jobKey, pending)
  }

  private async prepareInlinePreviewMessage(
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    let changed = false
    const parts = await Promise.all(message.content.parts.map(async (part) => {
      if (part.type !== 'media' || part.media.kind !== 'image'
        || !part.media.locator || part.media.strippedThumbnail) return part
      try {
        const previewLocator = part.media.preview?.locator
        const sourceLocator = previewLocator?.kind === 'image' && previewLocator.originImageUrl
          ? { ...previewLocator, filePath: undefined, fileSize: undefined, imageSpec: 198 as const }
          : previewLocator ?? part.media.locator
        const media = await this.mediaPreviews.prepare(
          part.media,
          (signal) => this.client.downloadFile(rawQQMediaLocator(sourceLocator), { signal }),
        )
        if (media === part.media) return part
        changed = true
        return { ...part, media }
      } catch (error) {
        this.logger?.warn(
          'inline preview item failed media=%s error=%s', part.media.id, formatError(error),
        )
        return part
      }
    }))
    return changed ? { ...message, content: { ...message.content, parts } } : message
  }

  private cleanupLegacyMultiForwardDialogs(session: PlatformSession): Promise<void> {
    if (!this.database) return Promise.resolve()
    if (this.multiForwardCleanupSessions.has(session.platformSessionId)) return Promise.resolve()
    const existing = this.multiForwardCleanupJobs.get(session.platformSessionId)
    if (existing) return existing
    const pending = this.database.withTransaction(async (database) => {
      const conversations = (await database.get('mtproto_im_conversation', {
        platformSessionId: session.platformSessionId,
      })).filter((row) => isMultiForwardConversationId(row.platformConversationId))
      const platformConversationIds = conversations.map((row) => row.platformConversationId)
      if (!platformConversationIds.length) return

      const conversationIds = conversations.map((row) => row.id)
      const messages = await database.get('mtproto_im_message', {
        conversationId: { $in: conversationIds },
      })
      const messageIds = messages.map((row) => row.id)
      if (messageIds.length) {
        await database.remove('mtproto_im_message_reaction', { messageId: { $in: messageIds } })
        await database.remove('mtproto_im_media', { messageId: { $in: messageIds } })
      }
      await database.remove('mtproto_tl_message_part', { conversationId: { $in: conversationIds } })
      await database.remove('mtproto_im_message_alias', { conversationId: { $in: conversationIds } })
      await database.remove('mtproto_im_message', { conversationId: { $in: conversationIds } })
      await database.remove('mtproto_im_conversation', { id: { $in: conversationIds } })
      await database.remove('mtproto_draft', {
        platformSessionId: session.platformSessionId,
        platformConversationId: { $in: platformConversationIds },
      })
      await database.remove('mtproto_dialog_folder_peer', {
        platformSessionId: session.platformSessionId,
        platformConversationId: { $in: platformConversationIds },
      })
      await database.remove('mtproto_blocked_peer', {
        platformSessionId: session.platformSessionId,
        platformUserId: { $in: platformConversationIds },
      })

      const fakeUsers = (await database.get('mtproto_im_user', {
        platformId: session.platformId,
      })).filter((row) => isMultiForwardConversationId(row.platformUserId))
      if (fakeUsers.length) {
        const fakeUserIds = fakeUsers.map((row) => row.id)
        const referenced = new Set((await database.get('mtproto_im_message', {
          senderUserId: { $in: fakeUserIds },
        })).map((row) => row.senderUserId))
        const unused = fakeUserIds.filter((id) => !referenced.has(id))
        if (unused.length) await database.remove('mtproto_im_user', { id: { $in: unused } })
      }
      for (const id of platformConversationIds) this.conversations.delete(id)
      this.logger?.warn(
        'Removed persisted temporary merged-forward dialogs session=%s conversations=%d messages=%d',
        session.platformSessionId, conversations.length, messages.length,
      )
    }).then(() => {
      this.multiForwardCleanupSessions.add(session.platformSessionId)
    }).catch((error) => {
      this.logger?.warn(
        'Failed to remove persisted temporary merged-forward dialogs session=%s error=%s',
        session.platformSessionId, formatError(error),
      )
    }).finally(() => {
      if (this.multiForwardCleanupJobs.get(session.platformSessionId) === pending) {
        this.multiForwardCleanupJobs.delete(session.platformSessionId)
      }
    })
    this.multiForwardCleanupJobs.set(session.platformSessionId, pending)
    return pending
  }

  private mapConversation(input: WireConversation): IMConversation<QQMediaLocator> {
    const current = this.conversations.get(input.id)
    const mapped = mapConversation(input)
    const fallbackTitles = new Set([input.id, input.peerUid, input.peerUin].filter(Boolean))
    const title = current?.title && fallbackTitles.has(mapped.title) ? current.title : mapped.title
    const conversation: IMConversation<QQMediaLocator> = {
      ...current,
      ...mapped,
      title,
      avatar: mapped.avatar ?? current?.avatar,
      metadata: { ...current?.metadata, ...mapped.metadata },
    }
    this.conversations.set(conversation.id, conversation)
    return conversation
  }

  private mapEvent(input: Exclude<WireEvent, WireNativeAvsdkEvent>): IMEvent<QQMediaLocator> {
    const wireConversation = input.type === 'call-signal'
      ? {
          id: input.conversation.id,
          kind: 'direct' as const,
          title: input.conversation.title,
          peerUid: input.conversation.peerUid,
          peerUin: input.conversation.peerUin,
          chatType: 1 as const,
        }
      : input.conversation
    const conversation = this.mapConversation(wireConversation)
    if (input.type === 'message') {
      return {
        type: 'message',
        conversation,
        message: this.mapMessage(input.message),
      }
    }
    if (input.type === 'call-signal') {
      return {
        type: 'voice-call',
        callRef: input.callId,
        signal: input.signal,
        media: input.media,
        conversation,
        timestamp: input.timestamp,
      }
    }
    if (input.type === 'message-delete') return {
      type: 'message-delete',
      eventId: input.eventId,
      conversation,
      messageIds: input.messageIds,
      timestamp: input.timestamp,
    }
    return {
      type: 'message-reactions',
      eventId: input.eventId,
      conversation,
      target: input.target,
      context: {
        available: conversation.kind === 'group' ? this.reactionCatalog?.available ?? [] : [],
        reactions: input.context.reactions,
        maxSelected: conversation.kind === 'group' ? input.context.maxSelected : 0,
      },
      timestamp: input.timestamp,
    }
  }

  private isFilteredGrayTip(message: WireMessage): boolean {
    const text = message.serviceAction?.text
    return Boolean(text && this.grayTipFilters.some((filter) => filter && text.includes(filter)))
  }

  private mapMessage(input: WireMessage): IMMessage<QQMediaLocator> {
    const message = mapMessage(
      input, this.reactionCatalog, this.stickerProviderId, this.registerMultiForward,
      (media) => this.mediaPreviews.project(media),
    )
    return message
  }

  private rebaseMultiForwardMedia(
    message: IMMessage<QQMediaLocator>,
    locator: WireMultiForwardLocator,
  ): IMMessage<QQMediaLocator> {
    const outer = this.conversations.get(locator.conversationId)
    const chatType = outer?.metadata?.chatType
    const peerUid = outer?.metadata?.qqPeerUid
    if ((chatType !== 1 && chatType !== 2) || typeof peerUid !== 'string' || !peerUid) return message
    const physicalChatType: 1 | 2 = chatType === 1 ? 1 : 2

    let changed = false
    const parts = message.content.parts.map((part) => {
      if (part.type !== 'media' || !part.media.locator) return part
      changed ||= part.media.locator.chatType !== physicalChatType || part.media.locator.peerUid !== peerUid
      return {
        ...part,
        media: {
          ...part.media,
          locator: { ...part.media.locator, chatType: physicalChatType, peerUid },
        },
      }
    })
    return changed ? { ...message, content: { ...message.content, parts } } : message
  }

  private async prepareInitialMessage(
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    message = await this.prepareMultiForwardPreviews(message)
    return message
  }

  private async prepareMultiForwardPreviews(
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    let changed = false
    const parts = await Promise.all(message.content.parts.map(async (part) => {
      if (part.type !== 'text' || !part.entities?.some((entity) => entity.type === 'conversation-link')) {
        return part
      }
      const entities = await Promise.all(part.entities.map(async (entity) => {
        if (entity.type !== 'conversation-link') return entity
        const existing = entity.conversation.metadata?.qqMultiForwardPreview
        if (typeof existing === 'string' && isDetailedMultiForwardPreview(existing)) return entity
        const preview = await this.resolveMultiForwardPreview(entity.conversation)
        if (!preview) return entity
        changed = true
        const conversation = {
          ...entity.conversation,
          metadata: { ...entity.conversation.metadata, qqMultiForwardPreview: preview },
        } as IMConversation<QQMediaLocator>
        this.conversations.set(conversation.id, conversation)
        return { ...entity, conversation }
      }))
      return entities.some((entity, index) => entity !== part.entities![index])
        ? { ...part, entities }
        : part
    }))
    return changed ? { ...message, content: { ...message.content, parts } } : message
  }

  private resolveMultiForwardPreview(
    conversation: IMConversation<unknown>,
  ): Promise<string | undefined> {
    const locator = this.multiForwardLocators.get(conversation.id)
    if (!locator) return Promise.resolve(undefined)
    const existing = this.multiForwardPreviewJobs.get(conversation.id)
    if (existing) return existing
    const pending = this.client.getMultiForwardMessages(locator)
      .then((messages) => wireMultiForwardPreview(messages))
      .catch((error) => {
        this.logger?.warn(
          'merged-forward preview lookup failed conversation=%s error=%s',
          conversation.id, formatError(error),
        )
        return undefined
      })
      .finally(() => {
        if (this.multiForwardPreviewJobs.get(conversation.id) === pending) {
          this.multiForwardPreviewJobs.delete(conversation.id)
        }
      })
    this.multiForwardPreviewJobs.set(conversation.id, pending)
    return pending
  }

  private readonly registerMultiForward = (
    title: string,
    preview: string | undefined,
    locator: WireMultiForwardLocator,
  ): IMConversation<QQMediaLocator> => {
    const id = multiForwardConversationId(locator)
    const conversation: IMConversation<QQMediaLocator> = {
      id,
      kind: 'group',
      title: title || '聊天记录',
      metadata: {
        virtual: true,
        qqTemporaryMultiForward: true,
        ...(preview ? { qqMultiForwardPreview: preview } : {}),
      },
    }
    this.multiForwardLocators.set(id, locator)
    this.conversations.set(id, conversation)
    return conversation
  }
}

function isWireCallSignalEvent(event: unknown): event is WireCallSignalEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false
  const input = event as Record<string, unknown>
  if (input.type !== 'call-signal'
    || input.version !== 1
    || (input.signal !== 'incoming' && input.signal !== 'accept-requested'
      && input.signal !== 'refuse-requested' && input.signal !== 'logout-requested' && input.signal !== 'ended')
    || (input.media !== 'voice' && input.media !== 'unknown')
    || typeof input.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.callId)
    || typeof input.timestamp !== 'number' || !Number.isSafeInteger(input.timestamp)
    || input.timestamp < 1 || input.timestamp > 0x7fffffff) return false

  const conversation = input.conversation
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) return false
  const wireConversation = conversation as Record<string, unknown>
  return wireConversation.kind === 'direct'
    && wireConversation.chatType === 1
    && typeof wireConversation.id === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(wireConversation.id)
    && typeof wireConversation.peerUid === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(wireConversation.peerUid)
    && typeof wireConversation.peerUin === 'string' && /^\d{1,32}$/.test(wireConversation.peerUin)
    && typeof wireConversation.title === 'string'
    && wireConversation.title.length >= 1 && wireConversation.title.length <= 256
    && !/[\x00-\x1f\x7f]/.test(wireConversation.title)
}

function wireEventSummary(event: WireEvent): string {
  if (event.type === 'native-avsdk') return 'type=native-avsdk'
  if (event.type === 'call-signal') {
    return `type=call-signal version=${event.version} signal=${event.signal} media=${event.media} conversation=${event.conversation.id}`
  }
  if (event.type === 'message') {
    return `type=message conversation=${event.conversation.id} message=${event.message.id} sender=${event.message.senderId} outgoing=${Boolean(event.message.outgoing)} parts=${event.message.parts.length}`
  }
  if (event.type === 'message-delete') {
    return `type=message-delete conversation=${event.conversation.id} eventId=${event.eventId} messages=${event.messageIds.join(',')}`
  }
  return `type=message-reactions conversation=${event.conversation.id} eventId=${event.eventId} message=${event.target.messageId} reactions=${event.context.reactions.length}`
}

function isDetailedMultiForwardPreview(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  return !(/^(?:点击)?查看(?:[xX×\d]+条)?(?:消息的)?(?:合并)?转发(?:消息)?$/.test(compact)
    || /^(?:共)?[xX×\d]+条消息的合并转发$/.test(compact)
    || /^(?:合并转发|聊天记录)$/.test(compact))
}

function wireMultiForwardPreview(messages: readonly WireMessage[]): string | undefined {
  const lines = messages.slice(0, 4).map((message) => {
    const sender = message.sender?.alias?.trim() || message.sender?.name?.trim() || message.senderId
    const content = message.parts.map((part) => {
      if (part.type === 'text') return part.text.trim()
      if (part.type === 'media') return part.media.name?.trim()
        || (part.media.kind === 'image' ? '[图片]' : '[文件]')
      if (part.type === 'sticker') return part.sticker.title?.trim() || '[表情]'
      if (part.type === 'multi-forward') return `查看${part.title || '聊天记录'}`
      if (part.type === 'markdown') return part.content.trim()
      if (part.type === 'inline-keyboard') return part.keyboard.rows
        .flatMap((row) => row.buttons.map((button) => button.label)).join(' ')
      return part.card.title?.trim() || part.card.description?.trim() || '[卡片消息]'
    }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    return content ? `${sender}: ${content}` : ''
  }).filter(Boolean)
  return lines.join('\n') || undefined
}

function imEventSummary(event: IMEvent<QQMediaLocator>): string {
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

function mapConversation(input: WireConversation): IMConversation<QQMediaLocator> {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    avatar: input.avatar ? mapMedia(input.avatar) : undefined,
    metadata: {
      qqPeerUid: input.peerUid,
      qq: input.peerUin,
      chatType: input.chatType,
      ...(input.participantCount === undefined ? {} : { participantsCount: input.participantCount }),
      ...(input.selfRole ? { qqSelfRole: input.selfRole } : {}),
    },
  }
}

function mapMedia(input: WireMedia): IMMedia<QQMediaLocator> {
  return {
    id: `${input.id}:original-v1`,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType ?? (input.kind === 'file' ? fileVideoMimeType(input.name) : undefined),
    size: input.size,
    width: input.width,
    height: input.height,
    duration: input.duration,
    voice: input.voice,
    preview: input.preview,
    locator: input.locator,
  }
}

function fileVideoMimeType(name: string | undefined): string | undefined {
  const extension = /(?:^|\.)([^./\\]+)$/.exec(name ?? '')?.[1]?.toLowerCase()
  if (extension === 'mp4' || extension === 'm4v' || extension === 'f4v') return 'video/mp4'
  if (extension === 'avi') return 'video/x-msvideo'
  if (extension === 'wmv') return 'video/x-ms-wmv'
  if (extension === 'mkv') return 'video/x-matroska'
  if (extension === 'mov') return 'video/quicktime'
  if (extension === 'ts' || extension === 'mts' || extension === 'm2ts') return 'video/mp2t'
  if (extension === 'webm') return 'video/webm'
  if (extension === 'mpeg' || extension === 'mpg' || extension === 'mpe') return 'video/mpeg'
  if (extension === 'ogv') return 'video/ogg'
  if (extension === '3gp') return 'video/3gpp'
  if (extension === '3g2') return 'video/3gpp2'
  if (extension === 'flv') return 'video/x-flv'
  if (extension === 'asf') return 'video/x-ms-asf'
  if (extension === 'mod') return 'video/mod'
}

function mapMessage(
  input: WireMessage,
  reactionCatalog?: IMReactionContext,
  stickerProviderId = 'qqnt:stickers',
  registerMultiForward?: (
    title: string,
    preview: string | undefined,
    locator: WireMultiForwardLocator,
  ) => IMConversation<QQMediaLocator>,
  projectMedia?: (media: IMMedia<QQMediaLocator>) => IMMedia<QQMediaLocator>,
): IMMessage<QQMediaLocator> {
  return {
    id: input.id,
    sourceIds: input.sourceIds,
    conversationId: input.conversationId,
    senderId: input.senderId,
    sender: input.sender ? {
      id: input.sender.id,
      firstName: input.sender.name,
      username: input.sender.numericId,
      avatar: input.sender.avatar ? mapMedia(input.sender.avatar) : undefined,
      metadata: {
        ...(input.sender.numericId ? { qq: input.sender.numericId } : {}),
        qqName: input.sender.name,
      },
    } : undefined,
    senderTitle: input.sender?.alias?.trim() || undefined,
    timestamp: input.timestamp,
    outgoing: input.outgoing,
    replyToId: input.replyToId,
    metadata: input.msgSeq || input.originRequestId || input.telegramMessageId || input.telegramReplyToMessageId ? {
      ...(input.msgSeq ? { qqMsgSeq: input.msgSeq } : {}),
      ...(input.telegramMessageId ? { telegramMessageId: input.telegramMessageId } : {}),
      ...(input.telegramReplyToMessageId ? {
        telegramReplyToMessageId: input.telegramReplyToMessageId,
        qqReplyToMsgSeq: String(input.telegramReplyToMessageId),
      } : {}),
      ...(input.originRequestId ? { qqOriginRequestId: input.originRequestId } : {}),
    } : undefined,
    reactionContext: input.reactionContext ? {
      available: reactionCatalog?.available ?? [],
      reactions: input.reactionContext.reactions,
      maxSelected: input.reactionContext.maxSelected,
    } : undefined,
    content: {
      serviceAction: input.serviceAction,
      parts: mapParts(input, stickerProviderId, reactionCatalog, registerMultiForward, projectMedia),
      inlineKeyboard: mapInlineKeyboard(input),
    },
  }
}

function mapInlineKeyboard(
  input: WireMessage,
): import('@mtproto-relay/bridge').IMInlineKeyboard | undefined {
  const keyboard = input.parts.find((part) => part.type === 'inline-keyboard')
  if (!keyboard || keyboard.type !== 'inline-keyboard') return
  const rows = keyboard.keyboard.rows.map((row) => {
    const buttons: import('@mtproto-relay/bridge').IMInlineKeyboardButton[] = []
    for (const button of row.buttons) {
      const style = button.style === 1 ? 'primary' as const : button.style === 2 ? 'danger' as const : undefined
      if (button.type === 0 || button.type === 3) {
        buttons.push({ type: 'url', text: button.label, url: button.data, style })
        continue
      }
      if (button.type !== 1) continue
      buttons.push({
        type: 'callback',
        text: button.label,
        data: button.data,
        style,
        metadata: { qqnt: { id: button.id, botAppid: keyboard.keyboard.botAppid } },
      })
    }
    return { buttons }
  }).filter((row) => row.buttons.length)
  return rows.length ? { rows } : undefined
}

function mapParts(
  input: WireMessage,
  stickerProviderId: string,
  reactionCatalog?: IMReactionContext,
  registerMultiForward?: (
    title: string,
    preview: string | undefined,
    locator: WireMultiForwardLocator,
  ) => IMConversation<QQMediaLocator>,
  projectMedia?: (media: IMMedia<QQMediaLocator>) => IMMedia<QQMediaLocator>,
): IMMessage<QQMediaLocator>['content']['parts'] {
  const parts: IMMessage<QQMediaLocator>['content']['parts'] = []
  for (const part of input.parts) {
    if (part.type === 'text') {
      const normalized = normalizeTextPart(part, reactionCatalog)
      const previous = parts.at(-1)
      if (previous?.type === 'text') {
        const offset = previous.text.length
        previous.text += normalized.text
        previous.entities = [
          ...(previous.entities ?? []),
          ...(normalized.entities ?? []).map((entity) => ({ ...entity, offset: entity.offset + offset })),
        ]
      } else {
        parts.push(normalized)
      }
    } else if (part.type === 'markdown') {
      const normalized = parseQQMarkdown(part.content)
      if (normalized.text) parts.push(normalized)
    } else if (part.type === 'inline-keyboard') {
      continue
    } else if (part.type === 'multi-forward') {
      const conversation = registerMultiForward?.(part.title, part.preview, part.locator)
      const text = '查看聊天记录'
      parts.push({
        type: 'text', text,
        entities: conversation ? [{
          type: 'conversation-link', offset: 0, length: text.length, conversation,
        }] : undefined,
      })
    } else if (part.type === 'sticker') {
      parts.push({
              type: 'sticker' as const,
              sticker: {
                providerId: stickerProviderId,
                stickerId: part.sticker.stickerId,
                packId: part.sticker.packId,
                title: part.sticker.title,
                format: part.sticker.format,
                mimeType: part.sticker.mimeType,
                width: part.sticker.width,
                height: part.sticker.height,
                size: part.sticker.size,
                version: part.sticker.version,
                locator: part.sticker.reference as never,
              },
      })
    } else if (part.type === 'card') {
      parts.push({ type: 'card', card: { ...part.card } })
    } else {
      const media = mapMedia(part.media)
      parts.push({ type: 'media', media: projectMedia?.(media) ?? media })
    }
  }
  return parts
}

export function parseQQMarkdown(content: string): Extract<
  IMMessage<QQMediaLocator>['content']['parts'][number],
  { type: 'text' }
> {
  const text: string[] = []
  const entities: import('@mtproto-relay/bridge').IMTextEntity[] = []
  const append = (value: string) => {
    const offset = text.join('').length
    text.push(value)
    return offset
  }
  const token = /```([^\n`]*)\n([\s\S]*?)```|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^~\n]+)~~/g
  let cursor = 0
  for (const match of content.matchAll(token)) {
    const index = match.index
    append(content.slice(cursor, index))
    if (match[2] !== undefined) {
      const offset = append(match[2])
      entities.push({ type: 'pre', offset, length: match[2].length, language: match[1] || undefined })
    } else if (match[3] !== undefined) {
      const offset = append(match[3])
      entities.push({ type: 'code', offset, length: match[3].length })
    } else if (match[4] !== undefined) {
      const offset = append(match[4])
      entities.push({ type: 'text-link', offset, length: match[4].length, url: match[5] })
    } else if (match[6] !== undefined || match[7] !== undefined) {
      const value = match[6] ?? match[7]
      const offset = append(value)
      entities.push({ type: 'bold', offset, length: value.length })
    } else if (match[8] !== undefined || match[9] !== undefined) {
      const value = match[8] ?? match[9]
      const offset = append(value)
      entities.push({ type: 'italic', offset, length: value.length })
    } else if (match[10] !== undefined) {
      const offset = append(match[10])
      entities.push({ type: 'strikethrough', offset, length: match[10].length })
    }
    cursor = index + match[0].length
  }
  append(content.slice(cursor))
  const rendered = text.join('')
  return { type: 'text', text: rendered, entities: entities.length ? entities : undefined }
}

function isRemoteQQMediaLocator(value: unknown): value is QQMediaLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const locator = value as Partial<QQMediaLocator>
  return typeof locator.messageId === 'string'
    && typeof locator.elementId === 'string'
    && (locator.chatType === 1 || locator.chatType === 2)
    && typeof locator.peerUid === 'string'
    && (locator.kind === 'image' || locator.kind === 'file')
    && typeof locator.fileName === 'string'
    && Boolean(locator.originImageUrl || locator.fileUuid || locator.avatarUin)
}

function rawQQMediaLocator(locator: QQMediaLocator): QQMediaLocator {
  const { cachedPath: _cachedPath, previewKey: _previewKey, deferred: _deferred, ...raw } = locator
  return raw
}

function rememberSet<T>(set: Set<T>, value: T, limit: number): void {
  set.delete(value)
  set.add(value)
  while (set.size > limit) set.delete(set.values().next().value!)
}

function deferTurn(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 0)
    timer.unref()
  })
}

function isReactionResourceLocator(value: unknown): value is { reactionKey: string } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { reactionKey?: unknown }).reactionKey === 'string')
}

function multiForwardConversationId(locator: WireMultiForwardLocator): string {
  return `qqnt-multi-forward:${JSON.stringify([
    locator.conversationId, locator.rootMessageId, locator.parentMessageId ?? '',
  ])}`
}

function isMultiForwardConversationId(value: string): boolean {
  return value.startsWith(MULTI_FORWARD_CONVERSATION_PREFIX)
}

function normalizeTextPart(
  part: Extract<WireMessage['parts'][number], { type: 'text' }>,
  reactionCatalog?: IMReactionContext,
): Extract<IMMessage<QQMediaLocator>['content']['parts'][number], { type: 'text' }> {
  const face = part.entities?.find((entity) => entity.type === 'qq-face')
  if (face && face.offset === 0 && face.length === part.text.length) {
    const definition = reactionCatalog?.available.find((item) => item.key === `1:${face.faceId}`)
    if (definition?.presentation.type === 'emoji') {
      return { type: 'text', text: definition.presentation.emoticon }
    }
    if (definition?.presentation.type === 'custom') {
      const text = definition.presentation.alt
      return {
        type: 'text', text,
        entities: [{ type: 'custom-emoji', offset: 0, length: text.length, definition }],
      }
    }
  }
  return {
    type: 'text', text: part.text,
    entities: part.entities?.flatMap((entity) => entity.type === 'mention' ? [{ ...entity }] : []),
  }
}


function permissions(role: 'owner' | 'administrator' | 'member') {
  const administrator = role === 'owner' || role === 'administrator'
  return {
    manageConversation: administrator,
    manageMembers: administrator,
    deleteAnyMessage: administrator,
    editAnyMessage: administrator,
    pinMessages: administrator,
    inviteMembers: true,
  }
}

async function* sliceStream(
  source: AsyncIterable<Uint8Array>,
  offset = 0,
  limit?: number,
): AsyncIterable<Uint8Array> {
  let skipped = 0
  let emitted = 0
  const start = Math.max(0, Math.trunc(offset))
  const maximum = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit))
  if (!maximum) return
  for await (const chunk of source) {
    if (skipped + chunk.length <= start) {
      skipped += chunk.length
      continue
    }
    const chunkStart = Math.max(0, start - skipped)
    const accepted = chunk.subarray(chunkStart, chunkStart + maximum - emitted)
    skipped += chunk.length
    if (accepted.length) {
      emitted += accepted.length
      yield accepted
    }
    if (emitted >= maximum) return
  }
}

function rangedSize(size: number | undefined, offset = 0, limit?: number): number | undefined {
  if (size === undefined) return limit
  const available = Math.max(0, size - Math.max(0, Math.trunc(offset)))
  return limit === undefined ? available : Math.min(available, Math.max(0, Math.trunc(limit)))
}

function isNativeForwardRejection(error: unknown): boolean {
  return error instanceof Error
    && /^QQNT bridge 500: (?:forwardMsg|multiForwardMsg):/.test(error.message)
}

function dialogPageCacheKey(platformSessionId: string, query: IMPageQuery): string {
  return JSON.stringify([
    platformSessionId,
    query.cursor ?? '',
    query.afterId ?? '',
    query.limit ?? 100,
  ])
}

function rawDialogPreviewEqual(
  current: IMMessage<QQMediaLocator>,
  previous: IMMessage<QQMediaLocator> | undefined,
): boolean {
  if (!previous || current.id !== previous.id || current.timestamp !== previous.timestamp) return false
  return JSON.stringify(current) === JSON.stringify(previous)
}

function compareMessagesChronologically(left: IMMessage, right: IMMessage): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
    const leftId = BigInt(left.id)
    const rightId = BigInt(right.id)
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  }
  return left.id.localeCompare(right.id)
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

async function waitAtMost(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      output[index] = await mapper(values[index]!)
    }
  }))
  return output
}

export type { QQMediaLocator } from './protocol.js'
export { QQNTClient, type QQNTMediaLease } from './client.js'
export {
  QQBridgePcmTransport, QQBridgePcmTransportError,
  type QQBridgePcmTransportOptions,
} from './qq-bridge-pcm-transport.js'
export { QQStickerProvider } from './sticker-provider.js'
export {
  QQVoiceMedia, QQVoiceMediaClient, QQVoiceMediaClosedError, QQVoiceMediaSession, QQVoiceMediaTimeoutError,
  QQVoiceMediaTransportError,
  QQ_VOICE_PCM_FORMAT, QQ_VOICE_PCM_QUEUE_CAPACITY,
  type QQVoiceMediaConnection, type QQVoiceMediaConnectOptions, type QQVoiceMediaOperationOptions,
  type QQVoiceMediaSessionContext, type QQVoiceMediaStartOptions, type QQVoiceMediaStats,
  type QQVoiceMediaTransport, type QQVoicePcmFrame,
} from './voice-media.js'
