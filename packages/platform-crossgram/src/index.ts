import type { Context, Logger } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import {
  IMMediaUnavailableError, IMMessageSendRejectedError, IMMessageTargetUnavailableError,
  messagePartText, peerTlSeed, resolvePlatformPluginId, serviceActionText, stableId,
  type IMConversation, type IMConversationMember, type IMConversationMemberPage, type IMConversationRef, type IMDialogPage, type IMGroupFilePage,
  type IMDirectDownload, type IMDownloadOptions, type IMEvent, type IMHistoryPage, type IMHistoryQuery, type IMMedia, type IMMessage, type IMMessageInput, type IMMessageTarget,
  type IMMediaInput, type IMMediaUploadPreparation, type IMMediaUploadProbe,
  type IMMessageBundle, type IMMessageSnapshot, type JsonObject, type JsonValue,
  type IMPageQuery, type IMPlatform, type IMReactionActorPage, type IMReactionActorPageRequest, type IMReactionContext, type IMReactionResource, type IMReactionTarget, type IMReadTarget, type IMRequest, type IMRequestAction, type IMRequestPage, type IMRequestQuery, type IMSticker, type IMTextEntity, type IMTransferOptions,
  type IMUser, type IMUserPage, type PlatformCapabilities, type PlatformSession, type Unsubscribe,
  type VoiceCallMediaProvider, type VoiceWorkerCall, type VoiceWorkerMediaEndpoint,
} from '@mtproto-relay/bridge'
import {
  QQNTClient, QQNTMessageSendRejectedError, qqAvatarUrl,
  type QQNTClientOptions, type QQOutboundMedia, type QQSendPart,
} from './client.js'
import { defineQQNTEventCheckpointModel } from './event-checkpoint.js'
import { QQStickerProvider } from './sticker-provider.js'
import { QQVoiceMedia } from './voice-media.js'
import { QQBridgePcmTransport } from './qq-bridge-pcm-transport.js'
import { defineLegacyQQMediaSchema } from './legacy-media-schema.js'
import { defineQQMediaPreviewModel, mediaPreviewKey, QQMediaPreviewer } from './media-preview.js'
import { extractRemoteVideoFrame, type RemoteVideoFrameExtractor } from './video-frame.js'
import { migrateLegacyQQMessageMedia } from './raw-media-migration.js'
import { migrateLegacyQQGroupAliasUsers } from './user-name-migration.js'
import {
  sanitizeWireConversation, sanitizeWireEvent, sanitizeWireMessage, sanitizeWireRequest, sanitizeWireUser,
} from './sanitize.js'
import type {
  QQMediaLocator, QQStickerReference, WireCallSignalEvent, WireCard, WireConversation, WireEvent, WireGroupFilePage, WireMedia, WireMessage,
  WireMultiForwardLocator, WireNativeAvsdkEvent, WireReactionState, WireRequest, WireTextPart,
} from './protocol.js'


/** 支持的最低 qqnt-bridge 协议版本；更高版本的增量能力在各自调用处按需检查。 */
const MIN_PROTOCOL_VERSION = 19
/** /history 支持 beforeSeq 与 sequenceRange 的最低 bridge 协议版本。 */
export const SEQUENCE_HISTORY_PROTOCOL_VERSION = 36
const PROTOCOL_PROBE_TTL_MS = 5 * 60_000
/** 单次戳一戳请求的最大连击数。 */
const QQ_POKE_MAX_COUNT = 10

export interface Config extends QQNTClientOptions {
  /** 隐藏包含任一配置关键词的 QQ 灰条提示。 */
  grayTipFilters?: string[]
  /** 在消息投递后异步生成 `photoStrippedSize` 内联缩略图。 */
  generatePreviews?: boolean
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
/** 补已读边界时读取的未读窗口大小：够覆盖首条未读前后即可。 */
const READ_MARKER_WINDOW = 4
/** 同时补多少个会话的已读边界。 */
const READ_MARKER_CONCURRENCY = 3
const REACTION_CATALOG_GRACE_MS = 10
const REACTION_CATALOG_RPC_GRACE_MS = 250
const REACTION_CATALOG_RETRY_DELAY_MS = 60_000
const REACTION_RESOURCE_SIZE_TIMEOUT_MS = 5_000
const REACTION_RESOURCE_META_TTL_MS = 10 * 60_000
const STICKER_ASSET_META_TTL_MS = 10 * 60_000
const AVATAR_DIRECT_URL_TTL_MS = 10 * 60_000
const WEBSOCKET_RECONNECT_BASE_DELAY_MS = 1_000
const WEBSOCKET_RECONNECT_MAX_DELAY_MS = 60_000
const MULTI_FORWARD_CACHE_LIMIT = 256
const SPLIT_OUTGOING_MESSAGE_CACHE_LIMIT = 4_096
const INVALID_ZERO_PEER_CONVERSATION_ID = '0'
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
  const voiceMedia = new QQVoiceMedia(ctx.isolate('qqntVoiceMedia'))
  ctx.effect(() => () => voiceMedia.close())
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
  ctx.on('bridge/speech/transcribe', async (input, next) => {
    if (input.platform !== platform || !input.media.voice || !input.media.locator) return next()
    const result = await platform.client.transcribeVoice(
      rawQQMediaLocator(input.media.locator as QQMediaLocator), input.signal,
    )
    return { text: result.transcript, provider: id }
  })
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
    // 群聊 msgSeq 连续；协议 36 起 /history 支持 beforeSeq 并返回原始 sequenceRange。
    sequenceHistory: 'group',
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 20_000,
      maxMedia: 9,
    },
    conversations: { groups: true, channels: false, subchannels: false },
    members: { list: true, administrators: true, permissions: false, updateRoles: true },
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
    poke: { maxCount: QQ_POKE_MAX_COUNT },
    stickers: { native: true, upload: false, formats: ['static', 'animated', 'video'] },
  }

  readonly client: QQNTClient
  private readonly flashTransferProvider = {
    prepareUpload: async (
      session: PlatformSession,
      media: IMMediaUploadProbe,
    ) => this.client.prepareFlashTransferUpload(
      await this.flashTransferUploadConversationId(), media,
    ),
    create: (
      _session: PlatformSession,
      media: readonly import('@mtproto-relay/bridge').IMMediaInput[],
      options?: { name?: string, signal?: AbortSignal },
    ) => this.client.createFlashTransfer(media, options),
  }
  get flashTransfer() {
    return this.flashTransferProvider
  }
  readonly voiceMedia?: VoiceCallMediaProvider
  readonly voiceCalls = {
    control: (
      _session: PlatformSession,
      callRef: string,
      operation: 'accept' | 'reject' | 'hangup',
    ) => this.client.controlCall(callRef, operation),
  }
  readonly messageBundles = {
    load: (session: PlatformSession, locator: JsonValue) =>
      this.loadMessageBundle(session, parseMultiForwardLocator(locator)),
    avatar: (session: PlatformSession, locator: JsonValue) =>
      this.loadMessageBundleAvatar(session, parseMultiForwardLocator(locator)),
  }
  private readonly database?: Database
  private readonly qqVoiceMedia?: QQVoiceMedia
  private readonly conversations = new Map<string, IMConversation<QQMediaLocator>>()
  private readonly savedMessagesConversationIds = new Map<string, string>()
  private readonly firstUnreadSeq = new Map<string, string>()
  /** 已读边界（首条未读之前的一条消息），按「会话 + 首条未读游标」缓存：QQ 只在按需拉取未读窗口时才给出它。 */
  private readonly readMarkers = new Map<string, { seq: string, message?: IMMessage<QQMediaLocator> }>()
  private readonly readMarkerLoads = new Map<string, Promise<void>>()
  private readMarkerInFlight = 0
  private readonly readMarkerWaiters: Array<() => void> = []
  private reactionCatalog?: IMReactionContext
  private reactionCatalogPromise?: Promise<IMReactionContext>
  private reactionCatalogRetryAt = 0
  private readonly reactionResourceMeta = new Map<string, ResolvedReactionResourceMeta>()
  private readonly reactionResourceMetaPending = new Map<string, Promise<ResolvedReactionResourceMeta | undefined>>()
  private readonly stickerAssetMeta = new Map<string, ResolvedStickerAssetMeta>()
  private readonly stickerAssetMetaPending = new Map<string, Promise<ResolvedStickerAssetMeta | undefined>>()
  private reactionResourceWarmup?: Promise<void>
  private readonly grayTipFilters: readonly string[]
  private readonly originSessions = new Map<string, string>()
  private readonly splitOutgoingMessages = new Map<string, WireMessage>()
  private readonly multiForwardMessages = new Map<string, Promise<WireMessage[]>>()
  private readonly multiForwardPreviewJobs = new Map<string, Promise<string | undefined>>()
  private readonly legacyDialogCleanupJobs = new Map<string, Promise<void>>()
  private readonly legacyDialogCleanupSessions = new Set<string>()
  private readonly eventHandlers = new Map<
    string,
    (event: IMEvent<QQMediaLocator>) => void | Promise<void>
  >()
  private readonly inlinePreviewMessageJobs = new Map<string, Promise<void>>()
  private readonly inlinePreviewPublished = new Set<string>()
  videoFrameReader: RemoteVideoFrameExtractor = (url, signal) => extractRemoteVideoFrame(url, signal)

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
      lease.token.fill(0)
    }
  }

  async getAccount() {
    const status = await this.client.status()
    const userId = status.selfUid ?? status.selfUin
    if (!status.ready || !userId) throw new Error('QQNT account is not ready')
    if (!Number.isInteger(status.protocolVersion)
      || status.protocolVersion < MIN_PROTOCOL_VERSION) {
      throw new Error(`QQNT bridge protocol ${status.protocolVersion} is unsupported; protocol ${MIN_PROTOCOL_VERSION} or newer is required`)
    }
    const profile = await this.client.getUser(userId)
    if (!profile) throw new Error(`QQNT current user is unavailable: ${userId}`)
    const user = sanitizeWireUser(profile)
    const qq = typeof status.selfUin === 'string' && /^\d+$/.test(status.selfUin)
      ? status.selfUin
      : typeof user.numericId === 'string' && /^\d+$/.test(user.numericId)
        ? user.numericId
        : undefined
    if (!qq) throw new Error('QQNT current account must provide a numeric selfUin or user.numericId')
    return {
      credentials: {},
      user: {
        id: user.id,
        firstName: user.name,
        username: qq,
        about: typeof user.signature === 'string' ? user.signature : undefined,
        avatar: user.avatar ? mapMedia(user.avatar) : undefined,
        metadata: { qq },
      },
    }
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    await this.cleanupLegacyDialogs(session)
    // 启动 WebSocket 前先预热回应表情目录，避免首帧回应事件因 `available` 为空被误判为清空回应。
    await this.ensureReactionCatalog().catch((error) => {
      this.logger?.warn(
        'QQ reaction catalog warmup failed before subscription error=%s',
        formatError(error),
      )
    })
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
    // 先占位再停止旧租约，防止并发 `subscribe` 看到同一个旧租约而重复建连。
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
    let consecutiveStreamFailures = 0
    while (!signal.aborted) {
      attempt++
      let reconnectDelayMs = WEBSOCKET_RECONNECT_BASE_DELAY_MS
      this.logger?.info(
        'WebSocket subscribe start session=%s attempt=%d endpoint=%s lastEventId=%s',
        platformSessionId, attempt, this.client.webSocketEndpoint, lastEventId ?? '<none>',
      )
      try {
        await this.client.subscribe(async (rawEvent, eventId) => {
          // Cleaned before any step of the stream reads the event: the
          // checkpoint persists the event only after the handler commits, so
          // one string PostgreSQL cannot store would stall every later event.
          const event = sanitizeWireEvent(rawEvent)
          consecutiveStreamFailures = 0
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
            if (event.type !== 'call-signal' && event.type !== 'request'
              && isFilteredConversationId(event.conversation.id)) {
              if (event.type === 'message') {
                knownLastMessageIds.set(event.conversation.id, event.message.id)
              }
              const reason = isInvalidZeroPeerConversationId(event.conversation.id)
                ? 'invalid-zero-peer'
                : 'temporary-multi-forward'
              this.logger?.warn(
                'WebSocket event filtered session=%s reason=%s streamEventId=%s conversation=%s',
                platformSessionId, reason, eventId ?? '<none>', event.conversation.id,
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
                serviceActionText(event.message.serviceAction),
              )
              return
            }
            if ((event.type === 'message' || event.type === 'message-edit') && event.message.originRequestId
              && this.originSessions.get(event.message.originRequestId) === platformSessionId) {
              if (event.type === 'message') knownLastMessageIds.set(event.conversation.id, event.message.id)
              this.logger?.debug(
                'WebSocket event filtered session=%s reason=own-origin streamEventId=%s message=%s originRequestId=%s',
                platformSessionId, eventId ?? '<none>', event.message.id, event.message.originRequestId,
              )
              return
            }
            const mapped = this.mapEvent(event, session)
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
            // 先落库再推进内存游标，保证崩溃重连宁可重放也不会漏事件。
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
        if (!signal.aborted) {
          reconnectDelayMs = reconnectBackoffDelay(++consecutiveStreamFailures)
          this.logger?.warn(
            'WebSocket stream ended session=%s attempt=%d lastEventId=%s failures=%d retryDelayMs=%d; reconnecting',
            platformSessionId, attempt, lastEventId ?? '<none>',
            consecutiveStreamFailures, reconnectDelayMs,
          )
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof QQNTEventHandlingError) {
          if (failedEventId === error.eventId) consecutiveEventFailures++
          else {
            failedEventId = error.eventId
            consecutiveEventFailures = 1
          }
          reconnectDelayMs = reconnectBackoffDelay(consecutiveEventFailures)
          this.logger?.error(
            'WebSocket event handling failed session=%s attempt=%d streamEventId=%s lastEventId=%s failures=%d retryDelayMs=%d error=%s',
            platformSessionId, attempt, error.eventId ?? '<none>', lastEventId ?? '<none>',
            consecutiveEventFailures, reconnectDelayMs, formatError(error),
          )
        } else {
          failedEventId = undefined
          consecutiveEventFailures = 0
          reconnectDelayMs = reconnectBackoffDelay(++consecutiveStreamFailures)
          this.logger?.warn(
            'WebSocket stream failed session=%s attempt=%d lastEventId=%s failures=%d retryDelayMs=%d error=%s; reconnecting',
            platformSessionId, attempt, lastEventId ?? '<none>',
            consecutiveStreamFailures, reconnectDelayMs, formatError(error),
          )
          if (await this.pauseSubscriptionWhileKernelNotReady(platformSessionId, signal)) {
            consecutiveStreamFailures = 0
            continue
          }
        }
      }
      await abortableDelay(reconnectDelayMs, signal)
    }
  }

  private async pauseSubscriptionWhileKernelNotReady(
    platformSessionId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let observedNotReady = false
    let failures = 0
    while (!signal.aborted) {
      try {
        const status = await this.client.status()
        if (status.ready) return observedNotReady
        observedNotReady = true
      } catch (error) {
        if (!observedNotReady) return false
        this.logger?.warn(
          'QQNT readiness check failed session=%s failures=%d error=%s; subscription remains paused',
          platformSessionId, failures + 1, formatError(error),
        )
      }
      const retryDelayMs = reconnectBackoffDelay(++failures)
      this.logger?.warn(
        'QQNT kernel is not ready session=%s failures=%d retryDelayMs=%d; WebSocket subscription paused',
        platformSessionId, failures, retryDelayMs,
      )
      await abortableDelay(retryDelayMs, signal)
    }
    return observedNotReady
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
          // 基线必须扫描全部会话页，否则首页之外的旧会话后续升到顶部时会被误判为新消息。
          let cursor: string | undefined
          const seenCursors = new Set<string>()
          do {
            const query = { cursor, limit: 100 }
            const page = await this.prepareDialogPage(
              session, await this.fetchDialogsPage(session, query, signal),
            )
            for (const dialog of page.dialogs) {
              knownLastMessageIds.set(dialog.conversation.id, dialog.lastMessage?.id)
            }
            cursor = page.nextCursor
            if (cursor && seenCursors.has(cursor)) break
            if (cursor) seenCursors.add(cursor)
          } while (cursor && !signal.aborted)
          hasBaseline = true
        } else {
          // 新消息会把会话顶到第一页，后续轮询只需拉取首页。
          const query = { limit: 100 }
          const page = await this.prepareDialogPage(
            session, await this.fetchDialogsPage(session, query, signal),
          )
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
      const response = await this.client.getHistory(
        await this.wireConversationId(session, conversation.id), {
        afterId: previousId,
        limit: 100,
      })
      const messages = await Promise.all(this.collapseSplitOutgoingMessages(response.messages)
        .filter((message) => message.id !== previousId && !this.isFilteredGrayTip(message))
        .map((message) => this.prepareRequestedMessage(
          session, conversation, this.mapMessage(message, conversation.id),
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
    await this.cleanupLegacyDialogs(session)
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    return this.prepareDialogPage(session, await this.fetchDialogsPage(session, query, undefined, reactionWarmup))
  }

  async getConversation(
    _session: PlatformSession,
    conversationId: string,
  ): Promise<IMConversation<QQMediaLocator> | null> {
    if (isInvalidZeroPeerConversationId(conversationId)) return null
    const wireId = await this.wireConversationId(_session, conversationId)
    return this.mapConversation(await this.client.getConversation(wireId), _session)
  }

  private async fetchDialogsPage(
    session: PlatformSession,
    query: IMPageQuery = {},
    signal?: AbortSignal,
    reactionWarmup?: Promise<unknown>,
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const afterId = query.afterId === undefined
      ? undefined
      : await this.wireConversationId(session, query.afterId)
    const response = await this.client.getDialogs({
      cursor: query.cursor, afterId, limit: query.limit,
    }, signal)
    if (reactionWarmup && response.conversations.some((conversation) =>
      wireMessageHasQQFace(conversation.lastMessage) || wireMessageHasQQFace(conversation.readInboxMaxMessage))) {
      await reactionWarmup
    }
    const selectedSaved = this.selectSavedMessagesConversation(session, response.conversations)
    const conversations = response.conversations.filter((conversation) =>
      !isFilteredConversationId(conversation.id)
      && (!isDeviceConversation(conversation) || conversation.id === selectedSaved))
    return {
      dialogs: conversations.map((conversation) => {
        const mappedConversation = this.mapConversation(conversation, session)
        if (conversation.firstUnread?.msgSeq) {
          this.firstUnreadSeq.set(mappedConversation.id, conversation.firstUnread.msgSeq)
        } else {
          this.firstUnreadSeq.delete(mappedConversation.id)
        }
        return {
          conversation: mappedConversation,
          unreadCount: conversation.unreadCount ?? 0,
          lastMessage: conversation.lastMessage
            && !this.isFilteredGrayTip(conversation.lastMessage)
            ? this.mapMessage(conversation.lastMessage, mappedConversation.id)
            : undefined,
          readInboxMaxMessage: conversation.readInboxMaxMessage
            ? this.mapMessage(conversation.readInboxMaxMessage, mappedConversation.id)
            : this.ensureReadMarker(session, conversation, mappedConversation.id),
        }
      }),
      nextCursor: response.nextCursor,
      total: response.total,
    }
  }

  /**
   * QQ 的会话只给「首条未读」游标，已读边界要额外拉一次未读窗口才知道。缺边界时会话会被当成
   * 「一条都没读」（`read_inbox_max_id = 0`），客户端的分隔线与打开会话时的定位都会错乱，
   * 因此这里补出边界并缓存：游标不变就不再重复拉取。
   */
  private ensureReadMarker(
    session: PlatformSession,
    conversation: WireConversation,
    conversationId: string,
  ): IMMessage<QQMediaLocator> | undefined {
    const seq = conversation.firstUnread?.msgSeq
    if (!seq || !(conversation.unreadCount ?? 0)) return undefined
    const cached = this.readMarkers.get(conversationId)
    if (cached?.seq === seq) return cached.message
    if (cached?.seq !== seq) this.readMarkers.set(conversationId, { seq })
    if (!this.readMarkerLoads.has(conversationId)) {
      const load = this.queueReadMarker(() =>
        this.loadReadMarker(session, conversation.id, conversationId, seq))
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (this.readMarkerLoads.get(conversationId) === load) this.readMarkerLoads.delete(conversationId)
        })
      this.readMarkerLoads.set(conversationId, load)
    }
    return undefined
  }

  /** 一页对话可能带上几十个未读会话，补边界要限流，避免同时打满 relay。 */
  private async queueReadMarker<T>(run: () => Promise<T>): Promise<T> {
    while (this.readMarkerInFlight >= READ_MARKER_CONCURRENCY) {
      await new Promise<void>((resolve) => this.readMarkerWaiters.push(resolve))
    }
    this.readMarkerInFlight++
    try {
      return await run()
    } finally {
      this.readMarkerInFlight--
      this.readMarkerWaiters.shift()?.()
    }
  }

  private async loadReadMarker(
    session: PlatformSession,
    wireConversationId: string,
    conversationId: string,
    seq: string,
  ): Promise<void> {
    const firstUnread = numericSequence(seq)
    if (firstUnread === undefined) return
    const response = await this.client.getHistory(
      await this.wireConversationId(session, wireConversationId),
      { aroundUnreadSeq: seq, limit: READ_MARKER_WINDOW },
    )
    let boundary: WireMessage | undefined
    let boundarySequence: bigint | undefined
    for (const message of response.messages) {
      const sequence = numericSequence(message.msgSeq)
      if (sequence === undefined || sequence >= firstUnread) continue
      if (boundarySequence !== undefined && sequence <= boundarySequence) continue
      boundary = message
      boundarySequence = sequence
    }
    if (this.readMarkers.get(conversationId)?.seq !== seq) return
    if (!boundary) return
    this.readMarkers.set(conversationId, {
      seq,
      message: this.mapMessage(boundary, conversationId),
    })
  }

  private async prepareDialogPage(
    session: PlatformSession,
    page: IMDialogPage<QQMediaLocator>,
  ): Promise<IMDialogPage<QQMediaLocator>> {
    return {
      ...page,
      dialogs: await Promise.all(page.dialogs.map(async (dialog) => ({
        ...dialog,
        lastMessage: dialog.lastMessage
          ? await this.prepareRequestedMessage(session, dialog.conversation, dialog.lastMessage)
          : undefined,
        readInboxMaxMessage: dialog.readInboxMaxMessage
          ? await this.prepareRequestedMessage(session, dialog.conversation, dialog.readInboxMaxMessage)
          : undefined,
      }))),
    }
  }

  async getContacts(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMUserPage<QQMediaLocator>> {
    const page = await this.client.getContacts({ cursor: query.cursor, limit: query.limit })
    return {
      users: page.users.map((wireUser) => {
        const user = sanitizeWireUser(wireUser)
        return {
          id: user.id,
          firstName: user.name,
          username: user.numericId,
          about: typeof user.signature === 'string' ? user.signature : undefined,
          avatar: user.avatar ? mapMedia(user.avatar) : undefined,
          metadata: qqUserMetadata(user),
        }
      }),
      nextCursor: page.nextCursor,
    }
  }

  async getRequests(
    _session: PlatformSession,
    query: IMRequestQuery = {},
  ): Promise<IMRequestPage<QQMediaLocator>> {
    const page = await this.client.getRequests({
      kind: query.kind,
      cursor: query.cursor,
      limit: query.limit,
    })
    return {
      requests: page.requests.map(mapRequest),
      nextCursor: page.nextCursor,
    }
  }

  async resolveRequest(
    _session: PlatformSession,
    id: string,
    action: IMRequestAction,
  ): Promise<IMRequest<QQMediaLocator>> {
    return mapRequest(await this.client.resolveRequest(id, action))
  }

  async getHistory(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<QQMediaLocator>> {
    if (query.beforeSequence !== undefined) return this.getHistoryBySequence(session, conversation, query)
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    if (isFilteredConversationId(conversation.id)) return { messages: [] }
    const response = await this.client.getHistory(
      await this.wireConversationId(session, conversation.id), {
      cursor: query.cursor,
      limit: query.limit,
      beforeId: query.before?.id,
      afterId: query.after?.id,
      aroundUnreadSeq: !query.cursor && !query.before && !query.after && !query.latest
        ? this.firstUnreadSeq.get(conversation.id)
        : undefined,
      latest: query.latest && !query.cursor && !query.before && !query.after ? 1 : undefined,
    })
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    if (response.messages.some(wireMessageHasQQFace)) await reactionWarmup
    return {
      messages: await Promise.all(this.collapseSplitOutgoingMessages(response.messages)
        .filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(
          session, this.conversationFor(conversation.id), this.mapMessage(message, conversation.id),
        ))),
      nextCursor: response.nextCursor,
    }
  }

  private protocolProbe?: { version: number, checkedAt: number }

  /** 读取并短暂缓存 bridge 协议版本，用于按版本启用新增的历史接口。 */
  async bridgeProtocolVersion(): Promise<number> {
    const cached = this.protocolProbe
    if (cached && Date.now() - cached.checkedAt < PROTOCOL_PROBE_TTL_MS) return cached.version
    const status = await this.client.status()
    const version = Number.isInteger(status.protocolVersion) ? status.protocolVersion : 0
    this.protocolProbe = { version, checkedAt: Date.now() }
    return version
  }

  /**
   * 按 msgSeq 向更早方向读取一页，供服务端回填历史空洞。
   * 旧版 bridge 会忽略 beforeSeq 并返回最新一页，因此先校验协议版本，不满足时直接报错而不是返回错误的数据。
   */
  private async getHistoryBySequence(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery,
  ): Promise<IMHistoryPage<QQMediaLocator>> {
    if (!/^\d+$/.test(query.beforeSequence ?? '') || query.beforeSequence === '0') {
      throw new Error(`invalid beforeSequence: ${query.beforeSequence}`)
    }
    if (isFilteredConversationId(conversation.id)) return { messages: [] }
    const version = await this.bridgeProtocolVersion()
    if (version < SEQUENCE_HISTORY_PROTOCOL_VERSION) {
      throw new Error(`QQNT bridge protocol ${version} does not support sequence history; protocol ${SEQUENCE_HISTORY_PROTOCOL_VERSION} is required`)
    }
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const response = await this.client.getHistory(await this.wireConversationId(session, conversation.id), {
      beforeSeq: query.beforeSequence,
      limit: query.limit,
    })
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    if (response.messages.some(wireMessageHasQQFace)) await reactionWarmup
    const range = response.sequenceRange
    return {
      messages: await Promise.all(this.collapseSplitOutgoingMessages(response.messages)
        .filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
          this.prepareRequestedMessage(
            session, this.conversationFor(conversation.id), this.mapMessage(message, conversation.id),
          ))),
      ...(range && /^\d+$/.test(range.min) && /^\d+$/.test(range.max)
        ? { coverage: { minSequence: range.min, maxSequence: range.max } }
        : {}),
    }
  }

  async listGroupFiles(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: { folderId?: string, cursor?: string, limit?: number } = {},
  ): Promise<IMGroupFilePage<QQMediaLocator>> {
    if (!this.isGroupConversation(conversation.id)) return { items: [] }
    const response: WireGroupFilePage = await this.client.getGroupFiles(conversation.id, query)
    return {
      items: response.items.map((item) => item.type === 'folder' ? { ...item } : {
        type: 'file' as const,
        id: item.id,
        parentId: item.parentId,
        name: item.name,
        size: item.size,
        uploadTime: item.uploadTime,
        modifyTime: item.modifyTime,
        expiresAt: item.expiresAt,
        downloadCount: item.downloadCount,
        uploaderId: item.uploaderId,
        uploaderName: item.uploaderName,
        media: mapMedia(item.media),
      }),
      nextCursor: response.nextCursor,
      total: response.total,
    }
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser<QQMediaLocator> | null> {
    const wireUser = await this.client.getUser(userId)
    if (!wireUser) return null
    const user = sanitizeWireUser(wireUser)
    return {
      id: user.id,
      firstName: user.name,
      username: user.numericId,
      about: typeof user.signature === 'string' ? user.signature : undefined,
      avatar: user.avatar ? mapMedia(user.avatar) : undefined,
      metadata: qqUserMetadata(user),
    }
  }

  async getMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<QQMediaLocator> | null> {
    if (isFilteredConversationId(conversation.id)) return null
    // 链接直开消息不会经过 `getHistory()`，需先确保 QQ 表情目录就绪，否则自定义表情会退化为纯文本。
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const message = await this.client.getMessage(
      await this.wireConversationId(session, conversation.id), messageId,
    )
    if (message && wireMessageHasQQFace(message)) await reactionWarmup
    return message && !this.isFilteredGrayTip(message)
      ? this.prepareRequestedMessage(
          session, this.conversationFor(conversation.id), this.mapMessage(message, conversation.id),
        )
      : null
  }

  async clickInlineButton(
    _session: PlatformSession,
    target: { conversationId: string, messageId: string, nativeSequence?: string },
    button: Extract<import('@mtproto-relay/bridge').IMInlineKeyboardButton, { type: 'callback' }>,
  ): Promise<{ message?: string, alert?: boolean, url?: string, refresh?: true }> {
    if (button.data.startsWith('group-invite:')) {
      const [, groupCode, msgSeq] = button.data.split(':')
      if (groupCode && msgSeq) {
        try {
          await this.client.acceptGroupInvite({ groupCode, msgSeq })
          return { message: '已接受邀请；若群开启了入群审核，还需管理员通过', refresh: true as const }
        } catch {
          return { message: '同意失败，请稍后重试或在 QQ 客户端处理该邀请', alert: true }
        }
      }
    }
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

  async markRead(session: PlatformSession, target: IMReadTarget): Promise<void> {
    if (isFilteredConversationId(target.conversationId)) return
    await this.client.markRead(
      await this.wireConversationId(session, target.conversationId), target.messageId,
    )
    this.firstUnreadSeq.delete(target.conversationId)
  }

  async setConversationNotificationMask(
    _session: PlatformSession,
    conversationId: string,
    mask: number,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return
    const chatType = conversation.metadata?.chatType
    const peerUin = conversation.metadata?.qq
    if (typeof chatType !== 'number' || typeof peerUin !== 'string' || !peerUin) return
    await this.client.setNotificationMask(chatType, peerUin, mask)
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<QQMediaLocator>> {
    if (isFilteredConversationId(conversation.id)) return { members: [], total: 0 }
    const page = await this.client.getMembers(conversation.id, { cursor: query.cursor, limit: query.limit })
    return {
      members: page.members.map((member): IMConversationMember<QQMediaLocator> => {
        const user = sanitizeWireUser(member.user)
        return {
          user: {
            id: user.id,
            firstName: user.name,
            username: user.numericId,
            avatar: user.avatar ? mapMedia(user.avatar) : undefined,
            metadata: { ...qqUserMetadata(user), qqName: user.name },
          },
          role: member.role,
          permissions: permissions(member.role),
          title: user.alias?.trim() || undefined,
        }
      }),
      total: page.total,
      nextCursor: page.nextCursor,
    }
  }

  async sendPoke(
    session: PlatformSession,
    conversation: IMConversationRef,
    target: { userId: string },
    count: number,
  ): Promise<IMMessage<QQMediaLocator> | undefined> {
    const response = await this.client.sendPoke(
      await this.wireConversationId(session, conversation.id),
      target.userId,
      count,
    )
    const notice = response?.message
    return notice ? this.mapMessage(notice, conversation.id) : undefined
  }

  async setConversationMemberRole(
    _session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
    role: 'administrator' | 'member',
  ): Promise<void> {
    await this.client.setMemberRole(conversation.id, userId, role)
  }

  async moderateConversationMember(
    _session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
    action: import('@mtproto-relay/bridge').IMConversationMemberModeration,
  ): Promise<void> {
    await this.client.moderateMember(conversation.id, userId, action)
  }

  async blockUser(
    _session: PlatformSession,
    userId: string,
    blocked: boolean,
  ): Promise<void> {
    await this.client.setUserBlocked(userId, blocked)
  }

  async getConversationMember(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<QQMediaLocator> | null> {
    const known = this.conversations.get(conversation.id)
    const selfRole = known?.selfRole ?? known?.metadata?.qqSelfRole
    if (
      userId === session.userId
      && (selfRole === 'owner' || selfRole === 'administrator' || selfRole === 'member')
    ) {
      const user = await this.getUser(session, userId)
      if (user) return { user, role: selfRole, permissions: permissions(selfRole) }
    }
    // 客户端打开超级群时会探测 `inputPeerSelf`；群资料暂缺时直接返回 null，避免触发全量群成员扫描。
    if (userId === session.userId) return null
    let cursor: string | undefined
    do {
      const page = await this.getConversationMembers(session, conversation, { cursor, limit: 500 })
      // Satori 侧以 QQ 号（`username`）寻址成员，因此同时匹配 UID 与 QQ 号。
      const found = page.members.find((member) => member.user.id === userId || member.user.username === userId)
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
    const text = textParts.map((part) => part.text).join('\n') || undefined
    const voiceParts = mediaParts.filter((part) => part.media.voice)
    if (voiceParts.length && (voiceParts.length !== 1 || mediaParts.length !== 1 || text || sticker || content.replyToNativeSequence)) {
      throw new Error('QQNT voice messages must contain exactly one voice item')
    }
    const media: QQOutboundMedia[] = mediaParts.map((part, index) => ({
      kind: part.media.kind,
      name: part.media.name ?? `upload-${Date.now()}-${index}`,
      mimeType: part.media.mimeType,
      width: part.media.width,
      height: part.media.height,
      duration: part.media.duration,
      voice: part.media.voice,
      source: part.media.source,
    }))
    let textCursor = 0
    let mediaCursor = 0
    const parts: QQSendPart[] = content.parts.flatMap((part): QQSendPart[] => part.type === 'text'
      ? [textParts[textCursor++]!]
      : part.type === 'media' ? [{ type: 'media', media: media[mediaCursor++]! }] : [])
    const originRequestId = randomUUID()
    this.originSessions.set(originRequestId, session.platformSessionId)
    try {
      let sent: WireMessage
      try {
        sent = await this.sendWireMessage(
          await this.wireConversationId(session, conversation.id), parts,
          options, originRequestId, sticker,
          content.replyToId, content.replyToNativeSequence,
        )
      } catch (error) {
        if (error instanceof QQNTMessageSendRejectedError) {
          throw new IMMessageSendRejectedError(
            /^QQNT bridge 403:/u.test(error.message) ? 'permission-denied' : 'platform-rejected',
            error.message,
            { cause: error },
          )
        }
        throw error
      }
      const message = await this.prepareInitialMessage(this.mapMessage(sent, conversation.id))
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

  private async sendWireMessage(
    conversationId: string,
    parts: QQSendPart[],
    options: IMTransferOptions,
    originRequestId: string,
    sticker: QQStickerReference | undefined,
    replyToId: string | undefined,
    replyToSequence: string | undefined,
  ): Promise<WireMessage> {
    const textParts = parts.flatMap((part) => part.type === 'text' ? [part] : [])
    const media = parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
    const text = textParts.length ? textParts.map((part) => part.text).join('\n') : undefined
    if (!media.some(isOrdinaryQQFile)) {
      return this.client.sendMessage(conversationId, parts, options, {
        originRequestId, sticker, replyToId, replyToSequence,
      })
    }

    type SendPlan = {
      media: Array<{ item: QQOutboundMedia, index: number }>
      includeText?: boolean
      includeReply?: boolean
    }
    const plans: SendPlan[] = []
    const hasText = Boolean(text || textParts.length)
    const firstIsFile = isOrdinaryQQFile(media[0]!)
    if (hasText && firstIsFile) plans.push({ media: [], includeText: true, includeReply: true })
    let richMedia: SendPlan['media'] = []
    const flushRichMedia = () => {
      if (!richMedia.length) return
      plans.push({ media: richMedia })
      richMedia = []
    }
    for (const [index, item] of media.entries()) {
      if (isOrdinaryQQFile(item)) {
        flushRichMedia()
        plans.push({ media: [{ item, index }] })
      } else {
        richMedia.push({ item, index })
      }
    }
    flushRichMedia()
    if (!hasText || !firstIsFile) {
      const contextual = plans.find((plan) => plan.media.some(({ item }) => !isOrdinaryQQFile(item)))
      if (contextual) {
        contextual.includeText = hasText
        contextual.includeReply = true
      }
    }

    const sentMessages: WireMessage[] = []
    const sentMedia = new Array<Extract<WireMessage['parts'][number], { type: 'media' }> | undefined>(media.length)
    const mediaSourceIds = new Array<string | undefined>(media.length)
    for (const plan of plans) {
      const planOptions: IMTransferOptions = options.onProgress
        ? {
            ...options,
            onProgress: (progress) => {
              const globalIndex = plan.media[progress.mediaIndex]?.index
              return options.onProgress!({
                ...progress,
                mediaIndex: globalIndex ?? progress.mediaIndex,
              })
            },
          }
        : options
      const planParts = parts.filter((part) => part.type === 'text'
        ? plan.includeText
        : plan.media.some(({ item }) => item === part.media))
      const sent = await this.client.sendMessage(conversationId, planParts, planOptions, {
        originRequestId,
        replyToId: plan.includeReply ? replyToId : undefined,
        replyToSequence: plan.includeReply ? replyToSequence : undefined,
      })
      sentMessages.push(sent)
      const outputMedia = sent.parts.filter((part) => part.type === 'media')
      if (outputMedia.length !== plan.media.length) {
        throw new Error(`QQNT returned ${outputMedia.length} media items for a ${plan.media.length}-item send`)
      }
      for (const [localIndex, { index }] of plan.media.entries()) {
        sentMedia[index] = outputMedia[localIndex]!
        mediaSourceIds[index] = sent.id
      }
    }

    const primary = sentMessages[0]
    if (!primary) throw new Error('QQNT produced no message for a non-empty send plan')
    const orderedMedia = sentMedia.map((part) => {
      if (!part) throw new Error('QQNT omitted media from a split send')
      return part
    })
    const orderedSourceIds = mediaSourceIds.map((id) => {
      if (!id) throw new Error('QQNT omitted a physical message ID from a split send')
      return id
    })
    let sentMediaCursor = 0
    const logicalMessage: WireMessage = {
      ...primary,
      sourceIds: orderedSourceIds,
      originRequestId,
      replyToId: primary.replyToId ?? replyToId,
      parts: parts.map((part) => part.type === 'text' ? part : orderedMedia[sentMediaCursor++]!),
    }
    for (const sent of sentMessages) this.splitOutgoingMessages.set(sent.id, logicalMessage)
    while (this.splitOutgoingMessages.size > SPLIT_OUTGOING_MESSAGE_CACHE_LIMIT) {
      this.splitOutgoingMessages.delete(this.splitOutgoingMessages.keys().next().value!)
    }
    return logicalMessage
  }

  async prepareMediaUpload(
    _session: PlatformSession,
    conversation: IMConversationRef,
    media: IMMediaUploadProbe,
  ): Promise<IMMediaUploadPreparation | undefined> {
    if (conversation.id === _session.userId
      && await this.wireConversationId(_session, conversation.id) !== conversation.id) return
    return this.client.prepareFastUpload(conversation.id, media)
  }

  async deleteMessages(
    session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
    options: import('@mtproto-relay/bridge').IMDeleteMessagesOptions,
  ): Promise<void> {
    await this.client.deleteMessages(
      await this.wireConversationId(session, conversation.id), messageIds, options.forEveryone,
    )
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
    const originRequestId = randomUUID()
    this.originSessions.set(originRequestId, session.platformSessionId)
    try {
      try {
        const messages = await this.client.forwardMessages(
          await this.wireConversationId(session, from.id), messageIds,
          await this.wireConversationId(session, to.id), merged, originRequestId,
        )
        return Promise.all(messages.map((message) =>
          this.prepareInitialMessage(this.mapMessage(message, to.id))))
      } catch (error) {
        if (!isNativeForwardRejection(error)
          || options.sourceMessages?.length !== messageIds.length) throw error
        return this.copyForwardedMessages(session, from, messageIds, to, options)
      }
    } finally {
      const timer = setTimeout(() => this.originSessions.delete(originRequestId), 120_000)
      timer.unref()
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
      const source = stored ?? await this.client.getMessage(
        await this.wireConversationId(session, from.id), messageId,
      )
        .then((wire) => {
          if (!wire) throw new Error(`QQ source message not found: ${messageId}`)
          return this.mapMessage(wire)
        })
      const parts: IMMessageInput['parts'] = source.content.parts.map((part) => {
        if (part.type === 'text') return { ...part }
        if (part.type === 'card') return { type: 'text' as const, text: messagePartText(part) }
        if (part.type === 'message-bundle') return { type: 'text' as const, text: part.bundle.title }
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
    let locator = media.locator
    if (needsUserAvatarRefresh(media, locator)) {
      const refreshed = await this.client.getUser(locator.peerUid).catch(() => null)
      locator = refreshed?.avatar?.locator ?? locator
    }
    let transferred = 0
    try {
      for await (const chunk of this.client.downloadFile(locator, {
        signal: options.signal, offset: options.offset, limit: options.limit,
      })) {
        transferred += chunk.length
        await options.onProgress?.({
          phase: 'download', mediaIndex: 0, transferredBytes: transferred,
          totalBytes: rangedSize(media.size, options.offset, options.limit),
        })
        yield chunk
      }
    } catch (error) {
      // Telegram 会继续请求下一分片以探测 EOF；QQNT 对越界 Range 返回 HTTP 400 而非空响应。
      if ((options.offset ?? 0) > 0 && isQQNTDownloadPastEnd(error)) return
      if (isQQNTMediaUnavailable(error)) {
        throw new IMMediaUnavailableError(error instanceof Error ? error.message : String(error), {
          cause: error,
        })
      }
      throw error
    }
  }

  async resolveMediaUrl(
    _session: PlatformSession,
    media: IMMedia<QQMediaLocator>,
  ): Promise<IMDirectDownload | undefined> {
    let locator = media.locator
    if (!locator || locator.deferred) return
    if (media.id.startsWith('avatar:')) {
      if (needsUserAvatarRefresh(media, locator)) {
        const refreshed = await this.client.getUser(locator.peerUid).catch(() => null)
        locator = refreshed?.avatar?.locator ?? locator
      }
      const url = qqAvatarUrl(locator)
      return url ? { url, expiresAt: Date.now() + AVATAR_DIRECT_URL_TTL_MS, supportsRange: true } : undefined
    }
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
    target: IMMessageTarget,
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

  async getMessageReactionActors(
    _session: PlatformSession,
    target: IMMessageTarget,
    request: IMReactionActorPageRequest,
  ): Promise<IMReactionActorPage> {
    if (!this.isGroupConversation(target.conversationId)) {
      return { context: { available: [], reactions: [], maxSelected: 0 }, actors: [] }
    }
    const page = await this.client.getMessageReactionActors(
      target.conversationId,
      target.targetId,
      request.reactionKey,
      request.offset,
      request.limit,
      target.nativeSequence,
    )
    return {
      context: await this.withReactionCatalog(page.state),
      actors: page.actors,
      nextOffset: page.nextOffset,
    }
  }

  async setMessageReactions(
    _session: PlatformSession,
    target: IMMessageTarget,
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
    // 含有回应计数时必须等待目录加载完成，否则 `ReactionRpc` 会丢弃未知定义且不会注册对应的自定义表情文档。
    const catalog = state.reactions.length
      ? await loading
      : this.reactionCatalog ?? EMPTY_GROUP_REACTION_CATALOG
    return { available: catalog.available, reactions: state.reactions, maxSelected: state.maxSelected }
  }

  private isGroupConversation(conversationId: string): boolean {
    if (isInvalidZeroPeerConversationId(conversationId)) return false
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
    // 历史刷新会覆写落库消息，需同样补齐合并转发预览，避免被 QQ 空摘要覆盖。
    const withFaceSizes = await this.hydrateReactionResourceSizes(
      session, await this.prepareInitialMessage(message),
    )
    const prepared = await this.hydrateStickerAssetSizes(session, withFaceSizes)
    this.scheduleInlinePreview(session, conversation, prepared, handler)
    return prepared
  }

  /**
   * 补齐消息内联表情与回应表情的精确字节大小和版本。
   * 客户端依赖 `Document.size` 调度下载并按版本派生的文档 ID 缓存，两者必须与实际返回的字节一致。
   */
  private async hydrateReactionResourceSizes(
    session: PlatformSession,
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    const targets = new Map<string, IMReactionResource>()
    const collect = (resource: IMReactionResource): void => {
      const key = reactionResourceLocatorKey(resource)
      if (!key || targets.has(key)) return
      targets.set(key, resource)
    }
    for (const part of message.content.parts) {
      if (part.type !== 'text') continue
      for (const entity of part.entities ?? []) {
        if (entity.type !== 'custom-emoji' || entity.definition.presentation.type !== 'custom') continue
        collect(entity.definition.presentation.resource)
      }
    }
    const referenced = new Set((message.reactionContext?.reactions ?? []).map((reaction) => reaction.key))
    if (referenced.size) {
      for (const definition of message.reactionContext?.available ?? []) {
        if (!referenced.has(definition.key)) continue
        if (definition.presentation.type !== 'custom') continue
        collect(definition.presentation.resource)
      }
    }
    this.scheduleReactionResourceWarmup(session)
    if (!targets.size) return message
    const resolved = await this.resolveReactionResourceMetas(session, targets)

    let changed = false
    const parts = message.content.parts.map((part) => {
      if (part.type !== 'text' || !part.entities?.length) return part
      let partChanged = false
      const entities = part.entities.map((entity) => {
        if (entity.type !== 'custom-emoji' || entity.definition.presentation.type !== 'custom') return entity
        const resource = entity.definition.presentation.resource
        const next = applyReactionResourceMeta(resource, resolved, this.reactionResourceMeta)
        if (!next) return entity
        partChanged = true
        return {
          ...entity,
          definition: {
            ...entity.definition,
            presentation: { ...entity.definition.presentation, resource: next },
          },
        }
      })
      if (!partChanged) return part
      changed = true
      return { ...part, entities }
    })
    const reactionContext = this.applyReactionResourceMetas(message.reactionContext, resolved)
    if (!changed && reactionContext === message.reactionContext) return message
    const prepared: IMMessage<QQMediaLocator> = { ...message, content: { ...message.content, parts } }
    if (reactionContext !== message.reactionContext) prepared.reactionContext = reactionContext
    return prepared
  }

  private applyReactionResourceMetas(
    context: IMReactionContext | undefined,
    resolved: ReadonlyMap<string, ResolvedReactionResourceMeta>,
  ): IMReactionContext | undefined {
    if (!context?.available.length) return context
    let changed = false
    const available = context.available.map((definition) => {
      if (definition.presentation.type !== 'custom') return definition
      const resource = definition.presentation.resource
      const next = applyReactionResourceMeta(resource, resolved, this.reactionResourceMeta)
      if (!next) return definition
      changed = true
      return {
        ...definition,
        presentation: { ...definition.presentation, resource: next },
      }
    })
    return changed ? { ...context, available } : context
  }

  private async resolveReactionResourceMetas(
    session: PlatformSession,
    targets: ReadonlyMap<string, IMReactionResource>,
  ): Promise<Map<string, ResolvedReactionResourceMeta>> {
    const resolved = new Map<string, ResolvedReactionResourceMeta>()
    await Promise.all([...targets.entries()].map(async ([key, resource]) => {
      const meta = await this.resolveReactionResourceMeta(session, key, resource).catch(() => undefined)
      if (meta) resolved.set(key, meta)
    }))
    return resolved
  }

  private async resolveReactionResourceMeta(
    session: PlatformSession,
    reactionKey: string,
    resource: IMReactionResource,
  ): Promise<ResolvedReactionResourceMeta | undefined> {
    const cached = this.reactionResourceMeta.get(reactionKey)
    if (cached && Date.now() - cached.resolvedAt <= REACTION_RESOURCE_META_TTL_MS) return cached
    const pending = this.reactionResourceMetaPending.get(reactionKey)
    if (pending) return pending
    let lookup!: Promise<ResolvedReactionResourceMeta | undefined>
    lookup = this.lookupReactionResourceMeta(session, reactionKey, resource).finally(() => {
      if (this.reactionResourceMetaPending.get(reactionKey) === lookup) {
        this.reactionResourceMetaPending.delete(reactionKey)
      }
    })
    this.reactionResourceMetaPending.set(reactionKey, lookup)
    return lookup
  }

  private async lookupReactionResourceMeta(
    session: PlatformSession,
    reactionKey: string,
    resource: IMReactionResource,
  ): Promise<ResolvedReactionResourceMeta | undefined> {
    try {
      const meta = await this.client.getReactionAssetMeta(reactionKey)
      if (meta && meta.size > 0) {
        const entry: ResolvedReactionResourceMeta = {
          size: meta.size,
          version: typeof meta.version === 'number' ? meta.version : undefined,
          width: positiveDimension(meta.width),
          height: positiveDimension(meta.height),
          source: meta.source === 'path' ? 'path' : 'bundle',
          resolvedAt: Date.now(),
        }
        this.reactionResourceMeta.set(reactionKey, entry)
        return entry
      }
    } catch {
      // bridge 元数据接口不可用时回退为流式测量字节数。
    }
    const measured = await this.measureReactionResourceSize(session, resource)
    if (!measured) return undefined
    const entry: ResolvedReactionResourceMeta = { size: measured, resolvedAt: Date.now() }
    this.reactionResourceMeta.set(reactionKey, entry)
    return entry
  }

  private async measureReactionResourceSize(
    session: PlatformSession,
    resource: IMReactionResource,
  ): Promise<number | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REACTION_RESOURCE_SIZE_TIMEOUT_MS)
    try {
      let size = 0
      for await (const chunk of this.downloadReactionResource(session, resource, { signal: controller.signal })) {
        size += chunk.length
      }
      return size > 0 ? size : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** 补齐 QQ 系统大表情（ZIP 打包图片）解包后的精确字节大小、版本与 MIME 类型。 */
  private async hydrateStickerAssetSizes(
    _session: PlatformSession,
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    const targets = new Map<string, IMSticker>()
    for (const part of message.content.parts) {
      if (part.type !== 'sticker') continue
      if (!isQQFaceSticker(part.sticker)) continue
      if (!targets.has(part.sticker.stickerId)) targets.set(part.sticker.stickerId, part.sticker)
    }
    if (!targets.size) return message
    const resolved = await this.resolveStickerAssetMetas(targets)
    if (!resolved.size) return message
    let changed = false
    const parts = message.content.parts.map((part) => {
      if (part.type !== 'sticker') return part
      const meta = resolved.get(part.sticker.stickerId)
      if (!meta) return part
      const next = applyStickerAssetMeta(part.sticker, meta)
      if (!next) return part
      changed = true
      return { ...part, sticker: next }
    })
    return changed ? { ...message, content: { ...message.content, parts } } : message
  }

  private async resolveStickerAssetMetas(
    targets: ReadonlyMap<string, IMSticker>,
  ): Promise<Map<string, ResolvedStickerAssetMeta>> {
    const resolved = new Map<string, ResolvedStickerAssetMeta>()
    await Promise.all([...targets.entries()].map(async ([stickerId, sticker]) => {
      const meta = await this.resolveStickerAssetMeta(stickerId, sticker).catch(() => undefined)
      if (meta) resolved.set(stickerId, meta)
    }))
    return resolved
  }

  private async resolveStickerAssetMeta(
    stickerId: string,
    sticker: IMSticker,
  ): Promise<ResolvedStickerAssetMeta | undefined> {
    const cached = this.stickerAssetMeta.get(stickerId)
    if (cached && Date.now() - cached.resolvedAt <= STICKER_ASSET_META_TTL_MS) return cached
    const pending = this.stickerAssetMetaPending.get(stickerId)
    if (pending) return pending
    let lookup!: Promise<ResolvedStickerAssetMeta | undefined>
    lookup = this.lookupStickerAssetMeta(sticker).finally(() => {
      if (this.stickerAssetMetaPending.get(stickerId) === lookup) {
        this.stickerAssetMetaPending.delete(stickerId)
      }
    })
    this.stickerAssetMetaPending.set(stickerId, lookup)
    return lookup
  }

  private async lookupStickerAssetMeta(sticker: IMSticker): Promise<ResolvedStickerAssetMeta | undefined> {
    try {
      const meta = await this.client.resolveStickerAssetMeta(sticker.locator as QQStickerReference)
      if (meta && meta.size > 0) {
        const entry: ResolvedStickerAssetMeta = {
          size: meta.size,
          version: typeof meta.version === 'number' ? meta.version : undefined,
          mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : undefined,
          ...(meta.width === undefined ? {} : { width: meta.width }),
          ...(meta.height === undefined ? {} : { height: meta.height }),
          source: meta.source === 'path' ? 'path' : 'bundle',
          resolvedAt: Date.now(),
        }
        this.stickerAssetMeta.set(sticker.stickerId, entry)
        return entry
      }
    } catch {
      // bridge 重启或旧版本不支持该接口时保留消息自带元数据。
    }
    return undefined
  }

  private scheduleReactionResourceWarmup(session: PlatformSession): void {
    const catalog = this.reactionCatalog
    if (!catalog || this.reactionResourceWarmup) return
    const targets = catalog.available.filter((definition) => definition.presentation.type === 'custom'
      && definition.presentation.resource.size === undefined
      && reactionResourceLocatorKey(definition.presentation.resource))
    this.reactionResourceWarmup = mapConcurrent(targets, 4, async (definition) => {
      if (definition.presentation.type !== 'custom') return
      const resource = definition.presentation.resource
      const key = reactionResourceLocatorKey(resource)
      if (!key) return
      try {
        const meta = await this.resolveReactionResourceMeta(session, key, resource)
        if (!meta) return
        if (resource.size !== meta.size) resource.size = meta.size
        if (meta.version !== undefined && resource.version !== meta.version) resource.version = meta.version
        if (meta.width !== undefined && resource.width !== meta.width) resource.width = meta.width
        if (meta.height !== undefined && resource.height !== meta.height) resource.height = meta.height
      } catch {
        // 忽略单次预热失败，后续消息按需重试。
      }
    }).then(() => undefined)
    void this.reactionResourceWarmup.catch(() => undefined)
  }

  private scheduleInlinePreview(
    session: PlatformSession,
    conversation: IMConversation<QQMediaLocator>,
    message: IMMessage<QQMediaLocator>,
    handler?: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): void {
    if (!this.mediaPreviews.enabled) return
    const keys = message.content.parts.flatMap((part) => part.type === 'media'
      && part.media.locator
      && (part.media.kind === 'image' || isVideoFramePreviewCandidate(part.media)
        || (isVideoMime(part.media.mimeType) && part.media.preview))
      && !part.media.strippedThumbnail
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
      if (part.type !== 'media' || !part.media.locator || part.media.strippedThumbnail
        || (part.media.kind !== 'image' && !isVideoMime(part.media.mimeType))) return part
      try {
        if (part.media.kind === 'file' && !part.media.preview) {
          if (!isVideoFramePreviewCandidate(part.media)) return part
          // 文件形式的视频没有原生缩略图，直接从 QQ CDN 解码首帧。
          const locator = rawQQMediaLocator(part.media.locator)
          const media = await this.mediaPreviews.prepareVideoFrame(
            part.media,
            async (signal) => (await this.client.resolveFileUrl(locator, signal)).url,
            this.videoFrameReader,
          )
          if (media === part.media) return part
          changed = true
          return { ...part, media }
        }
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

  private cleanupLegacyDialogs(session: PlatformSession): Promise<void> {
    if (!this.database) return Promise.resolve()
    if (this.legacyDialogCleanupSessions.has(session.platformSessionId)) return Promise.resolve()
    const existing = this.legacyDialogCleanupJobs.get(session.platformSessionId)
    if (existing) return existing
    const pending = this.database.withTransaction(async (database) => {
      const conversations = (await database.get('mtproto_im_conversation', {
        platformSessionId: session.platformSessionId,
      })).filter((row) => isFilteredConversationId(row.platformConversationId))
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
        await database.remove('mtproto_message_mention', { messageId: { $in: messageIds } })
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

      const channelIds = platformConversationIds.map((id) => String(stableId(peerTlSeed(session.platformSessionId, id))))
      await database.remove('mtproto_channel_update_state', {
        platformSessionId: session.platformSessionId,
        channelId: { $in: channelIds },
      })
      const notificationSettings = await database.get('mtproto_notification_settings', {
        platformSessionId: session.platformSessionId,
      })
      const notificationSettingIds = notificationSettings.filter((row) =>
        platformConversationIds.some((id) => row.scope === `peer:${id}` || row.scope.startsWith(`topic:${id}:`)))
        .map((row) => row.id)
      if (notificationSettingIds.length) {
        await database.remove('mtproto_notification_settings', { id: { $in: notificationSettingIds } })
      }

      for (const id of platformConversationIds) {
        this.conversations.delete(id)
        this.firstUnreadSeq.delete(id)
      }
      this.logger?.warn(
        'Removed persisted filtered QQ dialogs session=%s conversations=%d messages=%d zeroPeers=%d',
        session.platformSessionId, conversations.length, messages.length,
        platformConversationIds.filter(isInvalidZeroPeerConversationId).length,
      )
    }).then(() => {
      this.legacyDialogCleanupSessions.add(session.platformSessionId)
    }).catch((error) => {
      this.logger?.warn(
        'Failed to remove persisted filtered QQ dialogs session=%s error=%s',
        session.platformSessionId, formatError(error),
      )
    }).finally(() => {
      if (this.legacyDialogCleanupJobs.get(session.platformSessionId) === pending) {
        this.legacyDialogCleanupJobs.delete(session.platformSessionId)
      }
    })
    this.legacyDialogCleanupJobs.set(session.platformSessionId, pending)
    return pending
  }

  private selectSavedMessagesConversation(
    session: PlatformSession,
    conversations: readonly WireConversation[],
  ): string | undefined {
    const current = this.savedMessagesConversationIds.get(session.platformSessionId)
    if (current) return current
    const selected = conversations.find(isDeviceConversation)
    if (!selected) return
    this.savedMessagesConversationIds.set(session.platformSessionId, selected.id)
    return selected.id
  }

  private async wireConversationId(session: PlatformSession, conversationId: string): Promise<string> {
    const known = this.conversations.get(conversationId)?.metadata?.qqConversationId
    if (typeof known === 'string' && known) return known
    if (conversationId !== session.userId) return conversationId
    return this.savedMessagesConversationIds.get(session.platformSessionId)
      ?? await this.discoverSavedMessagesConversation(session)
      ?? conversationId
  }

  /** 挑选一个真实好友或群会话供闪传借道申请 CDN 上传参数（不会实际发消息）。 */
  private async flashTransferUploadConversationId(): Promise<string> {
    const known = [...this.conversations.values()].filter((conversation) => {
      const chatType = conversation.metadata?.chatType
      return chatType === 1 || chatType === 2
    })
    const preferred = known.find((conversation) => conversation.metadata?.chatType === 1) ?? known[0]
    const knownWireId = preferred?.metadata?.qqConversationId
    if (typeof knownWireId === 'string' && knownWireId) return knownWireId
    if (preferred) return preferred.id

    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.client.getDialogs({ cursor, limit: 100 })
      const selected = page.conversations.find((conversation) => conversation.chatType === 1)
        ?? page.conversations.find((conversation) => conversation.chatType === 2)
      if (selected) return selected.id
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) break
      if (cursor) seen.add(cursor)
    } while (cursor)
    throw new Error('QQ Flash Transfer upload requires a QQ friend or group conversation for CDN negotiation')
  }

  private async discoverSavedMessagesConversation(session: PlatformSession): Promise<string | undefined> {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.client.getDialogs({ cursor, limit: 100 })
      const selected = this.selectSavedMessagesConversation(session, page.conversations)
      if (selected) return selected
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) break
      if (cursor) seen.add(cursor)
    } while (cursor)
  }

  private mapConversation(input: WireConversation, session?: PlatformSession): IMConversation<QQMediaLocator> {
    input = sanitizeWireConversation(input)
    const id = session && this.savedMessagesConversationIds.get(session.platformSessionId) === input.id
      ? session.userId
      : input.id
    const current = this.conversations.get(id)
    const mapped = mapConversation({ ...input, id })
    const fallbackTitles = new Set([input.id, input.peerUid, input.peerUin].filter(Boolean))
    const title = current?.title && fallbackTitles.has(mapped.title) ? current.title : mapped.title
    const conversation: IMConversation<QQMediaLocator> = {
      ...current,
      ...mapped,
      title,
      avatar: mapped.avatar ?? current?.avatar,
      metadata: { ...current?.metadata, ...mapped.metadata, qqConversationId: input.id },
    }
    this.conversations.set(conversation.id, conversation)
    return conversation
  }

  private mapEvent(
    input: Exclude<WireEvent, WireNativeAvsdkEvent>,
    session: PlatformSession,
  ): IMEvent<QQMediaLocator> {
    if (input.type === 'request') return { type: 'request', request: mapRequest(input.request) }
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
    if (isDeviceConversation(wireConversation)) {
      this.savedMessagesConversationIds.set(session.platformSessionId, wireConversation.id)
    }
    const conversation = this.mapConversation(wireConversation, session)
    if (input.type === 'message') {
      return {
        type: 'message',
        conversation,
        message: this.mapMessage(input.message, conversation.id),
      }
    }
    if (input.type === 'message-edit') {
      return {
        type: 'message-edit',
        eventId: input.eventId,
        conversation,
        message: this.mapMessage(input.message, conversation.id),
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
    if (input.type === 'voice-transcript') {
      return {
        type: 'voice-transcript',
        eventId: input.eventId,
        conversation,
        messageId: input.messageId,
        transcript: input.transcript,
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
    const text = serviceActionText(message.serviceAction)
    return Boolean(text && this.grayTipFilters.some((filter) => filter && text.includes(filter)))
  }

  private mapMessage(input: WireMessage, conversationId?: string): IMMessage<QQMediaLocator> {
    input = sanitizeWireMessage(this.splitOutgoingMessages.get(input.id) ?? input)
    const message = mapMessage(
      conversationId ? { ...input, conversationId } : input,
      this.reactionCatalog, this.stickerProviderId,
      (media) => this.mediaPreviews.project(media),
    )
    return message
  }

  private collapseSplitOutgoingMessages(messages: readonly WireMessage[]): WireMessage[] {
    const seen = new Set<string>()
    const output: WireMessage[] = []
    for (const message of messages) {
      const logical = this.splitOutgoingMessages.get(message.id) ?? message
      if (seen.has(logical.id)) continue
      seen.add(logical.id)
      output.push(logical)
    }
    return output
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
      if (part.type !== 'message-bundle') return part
      if (part.bundle.preview && isDetailedMultiForwardPreview(part.bundle.preview)) return part
      const preview = await this.resolveMultiForwardPreview(part.bundle)
      if (!preview) return part
      changed = true
      return { ...part, bundle: { ...part.bundle, preview } }
    }))
    return changed ? { ...message, content: { ...message.content, parts } } : message
  }

  private resolveMultiForwardPreview(
    bundle: IMMessageBundle,
  ): Promise<string | undefined> {
    const locator = parseMultiForwardLocator(bundle.locator)
    const existing = this.multiForwardPreviewJobs.get(bundle.id)
    if (existing) return existing
    const pending = this.loadMultiForwardMessages(locator)
      .then((messages) => wireMultiForwardPreview(messages))
      .catch((error) => {
        this.logger?.warn(
          'merged-forward preview lookup failed bundle=%s error=%s',
          bundle.id, formatError(error),
        )
        return undefined
      })
      .finally(() => {
        if (this.multiForwardPreviewJobs.get(bundle.id) === pending) {
          this.multiForwardPreviewJobs.delete(bundle.id)
        }
      })
    this.multiForwardPreviewJobs.set(bundle.id, pending)
    return pending
  }

  /** 读取合并转发归属会话（群或私聊联系人）的头像。 */
  private async loadMessageBundleAvatar(
    session: PlatformSession,
    locator: WireMultiForwardLocator,
  ): Promise<IMMedia<QQMediaLocator> | undefined> {
    const known = [...this.conversations.values()].find((conversation) =>
      conversation.id === locator.conversationId
      || conversation.metadata?.qqConversationId === locator.conversationId)
    if (known?.avatar) return known.avatar
    const conversation = await this.getConversation(session, locator.conversationId)
      .catch(() => null)
    return conversation?.avatar ?? known?.avatar
  }

  private loadMultiForwardMessages(locator: WireMultiForwardLocator): Promise<WireMessage[]> {
    const key = multiForwardBundleId(locator)
    const existing = this.multiForwardMessages.get(key)
    if (existing) return existing
    const pending = this.client.getMultiForwardMessages(locator).catch((error) => {
      if (this.multiForwardMessages.get(key) === pending) this.multiForwardMessages.delete(key)
      throw error
    })
    this.multiForwardMessages.set(key, pending)
    while (this.multiForwardMessages.size > MULTI_FORWARD_CACHE_LIMIT) {
      this.multiForwardMessages.delete(this.multiForwardMessages.keys().next().value!)
    }
    return pending
  }

  private async loadMessageBundle(
    session: PlatformSession,
    locator: WireMultiForwardLocator,
  ): Promise<IMMessageSnapshot<QQMediaLocator>[]> {
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const messages = (await this.loadMultiForwardMessages(locator))
      .filter((message) => !this.isFilteredGrayTip(message))
    const senders = new Map<string, Promise<IMUser<QQMediaLocator> | null>>()
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    if (messages.some(wireMessageHasQQFace)) await reactionWarmup
    return Promise.all(messages.map(async (message) => {
      let mapped = this.rebaseMultiForwardMedia(this.mapMessage(message), locator)
      if (!mapped.sender) {
        let pending = senders.get(message.senderId)
        if (!pending) {
          pending = this.getUser(session, message.senderId).catch(() => null)
          senders.set(message.senderId, pending)
        }
        mapped = { ...mapped, sender: (await pending) ?? undefined }
      }
      mapped = await this.prepareMultiForwardPreviews(mapped)
      const { conversationId: _conversationId, ...snapshot } = mapped
      return snapshot
    }))
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
  if (event.type === 'voice-transcript') {
    return `type=voice-transcript conversation=${event.conversation.id} message=${event.messageId}`
  }
  if (event.type === 'message' || event.type === 'message-edit') {
    return `type=${event.type} conversation=${event.conversation.id} message=${event.message.id} sender=${event.message.senderId} outgoing=${Boolean(event.message.outgoing)} parts=${event.message.parts.length}`
  }
  if (event.type === 'request') return `type=request request=${event.request.id} kind=${event.request.kind}`
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
      if (part.type === 'markdown') return parseQQMarkdown(part.content).text
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
  if (event.type === 'request') return `type=request request=${event.request.id} kind=${event.request.kind}`
  return `type=conversation conversation=${event.conversation.id}`
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.stack ?? `${error.name}: ${error.message}`
}

function mapConversation(input: WireConversation): IMConversation<QQMediaLocator> {
  const selfPermissions = input.selfRole ? permissions(input.selfRole) : undefined
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    avatar: input.avatar ? mapMedia(input.avatar) : undefined,
    selfRole: input.selfRole,
    selfPermissions,
    metadata: {
      qqPeerUid: input.peerUid,
      qq: input.peerUin,
      chatType: input.chatType,
      ...(input.groupMsgMask === undefined ? {} : { qqGroupMsgMask: input.groupMsgMask }),
      ...(input.participantCount === undefined ? {} : { participantsCount: input.participantCount }),
      ...(input.selfRole ? { qqSelfRole: input.selfRole } : {}),
    },
  }
}

function mapRequest(input: WireRequest): IMRequest<QQMediaLocator> {
  input = sanitizeWireRequest(input)
  return {
    id: input.id,
    kind: input.kind,
    state: input.status,
    requester: {
      id: input.requester.id,
      firstName: input.requester.name ?? input.requester.id,
    },
    group: input.group ? {
      id: input.group.id,
      kind: 'group',
      title: input.group.name ?? input.group.id,
    } : undefined,
    message: input.message,
    createdAt: input.timestamp,
    ...(input.source || input.reason ? {
      metadata: {
        ...(input.source ? { qqRequestSource: input.source } : {}),
        ...(input.reason ? { qqRequestReason: input.reason } : {}),
      },
    } : {}),
  }
}

function qqUserMetadata(user: { numericId?: string, bot?: true }): JsonObject {
  return {
    ...(user.numericId ? { qq: user.numericId } : {}),
    ...(user.bot ? { bot: true } : {}),
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
    transcript: input.transcript,
    preview: input.preview,
    locator: input.locator,
  }
}

function isVideoMime(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase().startsWith('video/') === true
}

function isVideoFramePreviewCandidate(media: IMMedia<QQMediaLocator>): boolean {
  return media.kind === 'file' && !media.preview && !media.voice && isVideoMime(media.mimeType)
    && Boolean(media.locator?.fileUuid) && !media.locator?.deferred
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

function isOrdinaryQQFile(media: Pick<QQOutboundMedia, 'kind' | 'name' | 'mimeType'>): boolean {
  return media.kind === 'file'
    && !media.mimeType?.toLowerCase().startsWith('video/')
    && !fileVideoMimeType(media.name)
}

function mapMessage(
  input: WireMessage,
  reactionCatalog?: IMReactionContext,
  stickerProviderId = 'qqnt:stickers',
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
      metadata: { ...qqUserMetadata(input.sender), qqName: input.sender.name },
    } : undefined,
    senderTitle: input.sender?.alias?.trim() || undefined,
    timestamp: input.timestamp,
    outgoing: input.outgoing,
    recalled: input.recalled,
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
      parts: mapParts(input, stickerProviderId, reactionCatalog, projectMedia),
      inlineKeyboard: mapInlineKeyboard(input),
      richMarkdown: qqRichMarkdown(input),
    },
  }
}


/**
 * QQ bot frameworks open a markdown body with an empty-label link carrying
 * template metadata such as `[](%7B%22version%22%3A2%7D)`; QQ draws nothing for
 * it, and neither may the rich message the body becomes.
 */
const QQ_TEMPLATE_LINK = /\[\]\([^)\s]*\)/gu

/**
 * The markdown body of a QQ bot message, which the relay renders into a
 * Telegram rich message.
 *
 * Only a `markdown` part is markdown; a plain-text message has none, so it is
 * neither parsed nor upgraded. The text parts stay the message text.
 */
function qqRichMarkdown(input: WireMessage): string | undefined {
  const markdown = input.parts
    .flatMap((part) => part.type === 'markdown' ? [part.content] : [])
    .join('\n')
    .replace(QQ_TEMPLATE_LINK, '')
    .trim()
  return markdown || undefined
}

function mapInlineKeyboard(
  input: WireMessage,
): import('@mtproto-relay/bridge').IMInlineKeyboard | undefined {
  const keyboard = input.parts.find((part) => part.type === 'inline-keyboard')
  if (!keyboard || keyboard.type !== 'inline-keyboard') {
    // Official group invites carry no bot keyboard; render an accept button
    // whose data the adapter routes back to the bridge on click.
    const invite = input.parts.find((part): part is { type: 'card', card: WireCard } => part.type === 'card')
      ?.card.groupInvite
    if (!invite) return
    return {
      rows: [{
        buttons: [{
          type: 'callback',
          text: '同意加群',
          data: `group-invite:${invite.groupCode}:${invite.msgSeq}`,
          style: 'success',
        }],
      }],
    }
  }
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
  projectMedia?: (media: IMMedia<QQMediaLocator>) => IMMedia<QQMediaLocator>,
): IMMessage<QQMediaLocator>['content']['parts'] {
  const parts: IMMessage<QQMediaLocator>['content']['parts'] = []
  // QQ 机器人消息常在 Markdown 旁附带纯文本回退段；通过 renditionKey 归一化比对后跳过重复的回退文本
  const markdownKey = input.parts
    .flatMap((part) => part.type === 'markdown' ? [renditionKey(parseQQMarkdown(part.content).text)] : [])
    .join('')
  for (const part of input.parts) {
    if (part.type === 'text') {
      if (markdownKey && !part.entities?.length && markdownKey.includes(renditionKey(part.text))) continue
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
      parts.push({
        type: 'message-bundle',
        bundle: {
          id: multiForwardBundleId(part.locator),
          title: part.title || '聊天记录',
          preview: part.preview && isDetailedMultiForwardPreview(part.preview) ? part.preview : undefined,
          locator: { ...part.locator },
        },
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

/** The marker opening a QQ markdown blockquote line, with its optional space. */
const QQ_BLOCKQUOTE_LINE = /^[ \t]{0,3}>[ \t]?/

/** The marker of an unordered list item, which Telegram has no entity for. */
const QQ_BULLET_LINE = /^([ \t]*)[-*+][ \t]+/

/** A fence line: no quote, list item or table opens inside code. */
const QQ_FENCE_LINE = /^[ \t]{0,3}(?:```|~~~)/

/** The bullet an unordered list item gets, since Telegram has no list entity. */
const QQ_BULLET = '•'

/**
 * Everything QQ's markdown writes as layout: `> ` quote markers, `- ` / `1. `
 * list markers (the bullet above included) and table pipes.
 *
 * QQ attaches the body's plain-text rendition beside the markdown body for
 * clients without markdown support, and which of these its rendition keeps is
 * its business. Comparing the two with all of them dropped recognizes that
 * duplicate either way, so a relayed message never carries the body twice.
 */
const QQ_RENDITION_MARKERS = /^[ \t]*(?:>[ \t]*)?(?:[-*+]|\d{1,3}[.)]|•)[ \t]+|^[ \t]{0,3}>[ \t]?|\|/gm

/**
 * A body reduced to what the parsed markdown and QQ's rendition have in common:
 * the text with the layout markers and all whitespace gone. Only ever used to
 * compare the two, never as message text.
 *
 * QQ's rendition is a rendering, not a copy — the template link of a recorded
 * production menu message is gone from its fallback (`bot-markdown.e2e.test.ts`)
 * — so the inline markup needs no handling here; only the layout markers differ.
 */
function renditionKey(value: string): string {
  return value.replace(QQ_RENDITION_MARKERS, '').replace(/\s+/g, '')
}

/**
 * QQ bot markdown inline markup, one alternative per construct the platform
 * documents (`bot.q.qq.com` → Markdown 消息): escapes, fenced and inline code,
 * images, links, autolinks, bold italic, bold, italic, strikethrough and
 * headings. Order matters: `***x***` before `**x**`, a fence before a backtick.
 */
const QQ_INLINE_TOKEN = /\\([\\`*_{}[\]()#+\-.!>~|])|```([^\n`]*)\n([\s\S]*?)```|`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]*)\)|\[([^\]\n]*)\]\(([^)\s]*)\)|<(https?:\/\/[^\s>]+)>|\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^~\n]+)~~|^#{1,6}[ \t]+([^\n]+)$/gm

/** QQ markdown inline markup, rendered into text and the entities Telegram draws. */
function parseQQInline(source: string): { text: string, entities: IMTextEntity[] } {
  const chunks: string[] = []
  const entities: IMTextEntity[] = []
  const push = (value: string) => {
    const offset = chunks.join('').length
    chunks.push(value)
    return offset
  }
  /**
   * A label with its target. An empty label renders nothing unless `fallback`
   * says what to show instead: QQ's own template links carry their metadata in
   * the target and draw nothing at all, while an image without alt text still
   * points somewhere worth reaching.
   */
  const pushLink = (label: string, target: string, fallback?: string) => {
    const text = label || fallback || ''
    if (!text) return
    const offset = push(text)
    if (/^https?:\/\//i.test(target)) {
      entities.push({ type: 'text-link', offset, length: text.length, url: target })
    }
  }
  let cursor = 0
  for (const match of source.matchAll(QQ_INLINE_TOKEN)) {
    const index = match.index
    push(source.slice(cursor, index))
    if (match[1] !== undefined) {
      push(match[1])
    } else if (match[3] !== undefined) {
      const offset = push(match[3])
      entities.push({ type: 'pre', offset, length: match[3].length, language: match[2] || undefined })
    } else if (match[4] !== undefined) {
      const offset = push(match[4])
      entities.push({ type: 'code', offset, length: match[4].length })
    } else if (match[5] !== undefined) {
      // An image cannot ride a Telegram message body, so its target becomes a
      // link on the alt text, with QQ's `#618px #249px` size hints stripped.
      const target = match[6]!
      pushLink(
        match[5].replace(/(?:\s*#\d+px)+\s*$/u, ''),
        target,
        /^https?:\/\//i.test(target) ? target : undefined,
      )
    } else if (match[7] !== undefined) {
      // QQ bot frameworks prepend an empty-label link carrying template
      // metadata such as `[](%7B%22version%22%3A2%7D)`; QQ renders nothing.
      pushLink(match[7], match[8]!)
    } else if (match[9] !== undefined) {
      // `<https://…>` is QQ's autolink: the target is also what it reads as.
      pushLink(match[9], match[9])
    } else if (match[10] !== undefined) {
      // `***x***` is bold italic: Telegram represents it as both entities.
      const offset = push(match[10])
      entities.push({ type: 'bold', offset, length: match[10].length })
      entities.push({ type: 'italic', offset, length: match[10].length })
    } else if (match[11] !== undefined || match[12] !== undefined) {
      const value = match[11] ?? match[12]
      const offset = push(value)
      entities.push({ type: 'bold', offset, length: value.length })
      // QQ documents `__x__` as underlined bold and draws it that way.
      if (match[12] !== undefined) entities.push({ type: 'underline', offset, length: value.length })
    } else if (match[13] !== undefined || match[14] !== undefined) {
      const value = match[13] ?? match[14]
      const offset = push(value)
      entities.push({ type: 'italic', offset, length: value.length })
    } else if (match[15] !== undefined) {
      const offset = push(match[15])
      entities.push({ type: 'strikethrough', offset, length: match[15].length })
    } else if (match[16] !== undefined) {
      // Telegram messages have no heading entity; QQ's headings read as bold.
      const value = match[16].trim()
      const offset = push(value)
      if (value) entities.push({ type: 'bold', offset, length: value.length })
    }
    cursor = index + match[0].length
  }
  push(source.slice(cursor))
  return { text: chunks.join(''), entities }
}

/** One line of a body, with QQ's quote marker taken off when it has one. */
function qqBodyLine(line: string): { quoted: boolean, text: string } {
  const marker = QQ_BLOCKQUOTE_LINE.exec(line)
  return { quoted: Boolean(marker), text: marker ? line.slice(marker[0].length) : line }
}

/** One row of a QQ markdown table, or nothing when the line is not one. */
function qqTableRow(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return undefined
  const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
  return cells.length > 1 ? cells : undefined
}

/**
 * A table: a header row, a `--- | ---` delimiter row, then body rows — all of
 * them quoted or all of them bare, since a `>` line and a plain one are not the
 * same block.
 */
function matchQQTable(
  lines: readonly string[],
  start: number,
  quoted: boolean,
): { rows: string[][], end: number } | undefined {
  const row = (index: number) => {
    const line = qqBodyLine(lines[index] ?? '')
    return line.quoted === quoted ? qqTableRow(line.text) : undefined
  }
  const header = row(start)
  const delimiter = row(start + 1)
  if (!header || !delimiter || header.length !== delimiter.length) return undefined
  if (!delimiter.every((cell) => /^:?-+:?$/.test(cell))) return undefined
  const rows = [header]
  let end = start + 2
  while (end < lines.length) {
    const next = row(end)
    if (!next) break
    rows.push(next)
    end += 1
  }
  return { rows, end }
}

/** How many columns a person counts in a monospace line: wide glyphs take two. */
function qqDisplayWidth(value: string): number {
  let width = 0
  for (const char of value) {
    const code = char.codePointAt(0)!
    width += code >= 0x1100 && (
      code <= 0x115f
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    ) ? 2 : 1
  }
  return width
}

/**
 * A table as the monospace block Telegram can show.
 *
 * Telegram message entities have no table, and a table left as text keeps its
 * pipes and its `--- | ---` delimiter row, which reads as markdown source. The
 * rows therefore lose the delimiter, keep ` | ` between cells and are padded to
 * equal column widths for a monospace client, inside one `pre` entity. Inline
 * markup in a cell is rendered away rather than kept: inside code the reader
 * must not see `**` either.
 */
function renderQQTable(rows: readonly string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length))
  const cells = rows.map((row) => Array.from(
    { length: columns },
    (_cell, column) => parseQQInline(row[column] ?? '').text,
  ))
  const widths = cells[0]!.map((_cell, column) => Math.max(...cells.map((row) => qqDisplayWidth(row[column]!))))
  return cells.map((row) => row
    // The last cell needs no padding: nothing follows it on the line.
    .map((cell, column) => column + 1 === columns
      ? cell
      : cell + ' '.repeat(Math.max(0, widths[column]! - qqDisplayWidth(cell))))
    .join(' | ')).join('\n')
}

/** One run of a QQ markdown body: quoted lines, other lines, or a table. */
type QQMarkdownBlock =
  | { kind: 'text', quoted: boolean, text: string }
  | { kind: 'table', quoted: boolean, rows: string[][] }

/**
 * QQ bot frameworks write QQ's reply box as a markdown blockquote, one line
 * `> 名字：被引用的那句话`, because a native `message_reference` on a markdown
 * message makes QQ attach the body twice. QQ's markdown renderer draws those
 * lines as one quoted block, and Telegram carries the same thing as a
 * `blockquote` entity — a client handed the markers instead draws the markdown
 * source (`> 名字：…`), which is what the group reported.
 *
 * The body is therefore split into runs: quoted lines (markers dropped, inner
 * newlines kept) and everything else, tables kept apart because Telegram can
 * only show them as monospace. Unordered list items lose their marker for the
 * same reason — Telegram has no list entity, QQ draws a bullet. A `>` or a
 * marker inside a fence is code and stays as it is.
 */
function splitQQMarkdown(content: string): QQMarkdownBlock[] {
  const blocks: QQMarkdownBlock[] = []
  const lines = content.split('\n')
  const push = (quoted: boolean, text: string) => {
    const previous = blocks.at(-1)
    // The newline belongs to the line before it, so a run keeps its inner ones.
    if (previous?.kind === 'text' && previous.quoted === quoted) previous.text += `\n${text}`
    else blocks.push({ kind: 'text', quoted, text })
  }
  const pushLine = (quoted: boolean, line: string) => {
    const bullet = QQ_BULLET_LINE.exec(line)
    push(quoted, bullet ? `${bullet[1]}${QQ_BULLET} ${line.slice(bullet[0].length)}` : line)
  }
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    // A fence line only toggles code state; its own text stays as it is.
    if (QQ_FENCE_LINE.test(line)) fence = !fence
    const body = fence ? { quoted: false, text: line } : qqBodyLine(line)
    if (!fence) {
      const table = matchQQTable(lines, index, body.quoted)
      if (table) {
        blocks.push({ kind: 'table', quoted: body.quoted, rows: table.rows })
        index = table.end - 1
        continue
      }
    }
    pushLine(body.quoted, body.text)
  }
  return blocks
}

/**
 * QQ bot markdown, rendered into the text and entities Telegram draws.
 *
 * Everything a markdown part carries is converted here in one pass: the whole
 * body is markdown, so every construct in it — quote, lists, table, headings,
 * inline markup — is rendered, rather than the parts the relay happens to know.
 */
export function parseQQMarkdown(content: string): Extract<
  IMMessage<QQMediaLocator>['content']['parts'][number],
  { type: 'text' }
> {
  const text: string[] = []
  const entities: IMTextEntity[] = []
  const append = (value: string) => {
    const offset = text.join('').length
    text.push(value)
    return offset
  }
  for (const [index, block] of splitQQMarkdown(content).entries()) {
    if (index) append('\n')
    if (block.kind === 'table') {
      const rendered = renderQQTable(block.rows)
      const start = append(rendered)
      if (!rendered) continue
      if (block.quoted) {
        entities.push({ type: 'blockquote', offset: start, length: rendered.length })
      }
      entities.push({ type: 'pre', offset: start, length: rendered.length })
      continue
    }
    const inline = parseQQInline(block.text)
    const start = append(inline.text)
    if (block.quoted) {
      entities.push({ type: 'blockquote', offset: start, length: inline.text.length })
    }
    for (const entity of inline.entities) entities.push({ ...entity, offset: entity.offset + start })
  }
  const joined = text.join('')
  const rendered = joined.trim()
  const lead = joined.length - joined.trimStart().length
  const trimmed = entities.flatMap((entity) => {
    const start = Math.max(0, entity.offset - lead)
    const end = Math.min(rendered.length, entity.offset + entity.length - lead)
    return end > start ? [{ ...entity, offset: start, length: end - start }] : []
  })
  return { type: 'text', text: rendered, entities: trimmed.length ? trimmed : undefined }
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

interface ResolvedStickerAssetMeta {
  size: number
  version?: number
  mimeType?: string
  width?: number
  height?: number
  source?: 'path' | 'bundle'
  resolvedAt: number
}

function isQQFaceSticker(sticker: IMSticker): boolean {
  const locator = sticker.locator as { kind?: unknown } | undefined
  return Boolean(locator && typeof locator === 'object' && locator.kind === 'sysface')
}

function applyStickerAssetMeta(
  sticker: IMSticker,
  meta: ResolvedStickerAssetMeta,
): IMSticker | undefined {
  const mimeType = isStickerImageMimeType(meta.mimeType) ? meta.mimeType : sticker.mimeType
  const format: IMSticker['format'] = mimeType === 'image/apng' || mimeType === 'image/gif'
    ? 'animated'
    : 'static'
  const width = meta.width ?? sticker.width
  const height = meta.height ?? sticker.height
  if (sticker.size === meta.size
    && (meta.version === undefined || sticker.version === meta.version)
    && sticker.mimeType === mimeType
    && sticker.format === format
    && sticker.width === width
    && sticker.height === height) return undefined
  return {
    ...sticker,
    size: meta.size,
    ...(meta.version === undefined ? {} : { version: meta.version }),
    mimeType,
    format,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}

function isStickerImageMimeType(value: string | undefined): boolean {
  return value === 'image/png' || value === 'image/apng'
    || value === 'image/gif' || value === 'image/webp'
}

interface ResolvedReactionResourceMeta {
  size: number
  version?: number
  width?: number
  height?: number
  source?: 'path' | 'bundle' | 'payload'
  resolvedAt: number
}

function reactionResourceLocatorKey(resource: IMReactionResource): string | undefined {
  const locator = resource.locator
  return isReactionResourceLocator(locator) ? locator.reactionKey : undefined
}

function positiveDimension(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function applyReactionResourceMeta(
  resource: IMReactionResource,
  resolved: ReadonlyMap<string, ResolvedReactionResourceMeta>,
  cache: ReadonlyMap<string, ResolvedReactionResourceMeta>,
): IMReactionResource | undefined {
  if (!resource.locator) return undefined
  const key = reactionResourceLocatorKey(resource)
  if (!key) return undefined
  const meta = resolved.get(key) ?? cache.get(key)
  if (!meta) return undefined
  const version = meta.version ?? resource.version
  const width = meta.width ?? resource.width
  const height = meta.height ?? resource.height
  if (resource.size === meta.size && resource.version === version
    && resource.width === width && resource.height === height) return undefined
  return { ...resource, size: meta.size, version, width, height }
}

function multiForwardBundleId(locator: WireMultiForwardLocator): string {
  return `qqnt-message-bundle:${JSON.stringify([
    locator.conversationId, locator.rootMessageId, locator.parentMessageId ?? '',
  ])}`
}

function parseMultiForwardLocator(value: JsonValue): WireMultiForwardLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid QQ merged-forward locator')
  }
  const { conversationId, rootMessageId, parentMessageId } = value
  if (typeof conversationId !== 'string' || typeof rootMessageId !== 'string'
    || (parentMessageId !== undefined && typeof parentMessageId !== 'string')) {
    throw new TypeError('invalid QQ merged-forward locator')
  }
  return {
    conversationId,
    rootMessageId,
    ...(typeof parentMessageId === 'string' && parentMessageId ? { parentMessageId } : {}),
  }
}

function isInvalidZeroPeerConversationId(value: string): boolean {
  return value === INVALID_ZERO_PEER_CONVERSATION_ID
}

function isDeviceConversation(conversation: WireConversation): boolean {
  return conversation.chatType === 8 || conversation.chatType === 134
}

function wireMessageHasQQFace(message: WireMessage | undefined): boolean {
  return Boolean(message?.parts.some((part) =>
    part.type === 'text' && part.entities?.some((entity) => entity.type === 'qq-face')))
}

function isFilteredConversationId(value: string): boolean {
  return isInvalidZeroPeerConversationId(value)
}

/** QQ 的 `msgSeq` 是十进制字符串，可能超出 Number 的安全范围，比较时才用 BigInt。 */
function numericSequence(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  return BigInt(value)
}

function normalizeTextPart(
  part: Extract<WireMessage['parts'][number], { type: 'text' }>,
  reactionCatalog?: IMReactionContext,
): Extract<IMMessage<QQMediaLocator>['content']['parts'][number], { type: 'text' }> {
  const sourceFaces = part.entities?.filter((entity) => entity.type === 'qq-face') ?? []
  const mentions = part.entities?.filter((entity) => entity.type === 'mention') ?? []
  if (!sourceFaces.length) {
    return {
      type: 'text', text: part.text,
      entities: mentions.length ? mentions.map((entity) => ({ ...entity })) : undefined,
    }
  }

  // 将文本中的 QQ 表情占位符（如 `[微笑]`、`/续标识`）替换为 emoji 或自定义表情，并重算后续实体的偏移。
  const faces = [...sourceFaces].sort((a, b) => a.offset - b.offset)
  const replacements: Array<{ sourceOffset: number, sourceLength: number, outputOffset: number, outputLength: number }> = []
  const customEmojiEntities: import('@mtproto-relay/bridge').IMTextEntity[] = []
  let output = ''
  let cursor = 0
  for (const face of faces) {
    if (face.offset < cursor || face.offset < 0 || face.length <= 0 || face.offset + face.length > part.text.length) continue
    output += part.text.slice(cursor, face.offset)
    const outputOffset = output.length
    const definition = reactionCatalog?.available.find((item) => item.key === `1:${face.faceId}`)
    const sourceText = part.text.slice(face.offset, face.offset + face.length)
    let replacement = sourceText
    if (definition?.presentation.type === 'emoji') replacement = definition.presentation.emoticon
    else if (definition?.presentation.type === 'custom') {
      replacement = definition.presentation.alt
      customEmojiEntities.push({ type: 'custom-emoji', offset: outputOffset, length: replacement.length, definition })
    } else if (sourceText.startsWith('/')) {
      // 本地资源包尚未收录的新系统表情以 `/xxx` 占位，替换为默认 emoji 以免被客户端当成斜杠命令。
      replacement = '🙂'
    }
    output += replacement
    replacements.push({
      sourceOffset: face.offset, sourceLength: face.length,
      outputOffset, outputLength: replacement.length,
    })
    cursor = face.offset + face.length
  }
  output += part.text.slice(cursor)

  const mappedMentions = mentions.map((mention) => {
    let offset = mention.offset
    for (const replacement of replacements) {
      if (replacement.sourceOffset + replacement.sourceLength <= mention.offset) {
        offset += replacement.outputLength - replacement.sourceLength
      }
    }
    return { ...mention, offset }
  })
  const entities = [...mappedMentions, ...customEmojiEntities]
    .sort((a, b) => a.offset - b.offset)
  return { type: 'text', text: output, entities: entities.length ? entities : undefined }
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
    manageAdministrators: role === 'owner',
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

function isQQNTDownloadPastEnd(error: unknown): boolean {
  return error instanceof Error && (
    /"retcode"\s*:\s*-5503008/u.test(error.message)
    || /download range out of filesize/iu.test(error.message)
    || /^QQNT (?:bridge|native media) 416: Range Not Satisfiable$/iu.test(error.message)
  )
}

function isQQNTMediaUnavailable(error: unknown): boolean {
  return error instanceof Error && (
    /"retcode"\s*:\s*-(?:5503001|5503042)\b/u.test(error.message)
    || /\b(?:illegal request|file has expired)\b/iu.test(error.message)
    || /QQNT media locator has no remote direct-link identity/iu.test(error.message)
    || /^QQNT native media 404: Not Found$/iu.test(error.message)
  )
}

function needsUserAvatarRefresh(media: IMMedia<QQMediaLocator>, locator: QQMediaLocator): boolean {
  return media.id.startsWith('avatar:')
    && locator.chatType === 1
    && !locator.avatarUrl
    && !locator.filePath
    && !locator.fileUuid
    && !locator.originImageUrl
    && !locator.avatarUin
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

function reconnectBackoffDelay(failures: number): number {
  return Math.min(
    WEBSOCKET_RECONNECT_MAX_DELAY_MS,
    WEBSOCKET_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(Math.max(0, failures - 1), 16),
  )
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
