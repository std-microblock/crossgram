import type { Context, Logger } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import {
  IMMediaUnavailableError, IMMessageSendRejectedError, IMMessageTargetUnavailableError,
  messagePartText, resolvePlatformPluginId, stableId,
  type IMConversation, type IMConversationMember, type IMConversationMemberPage, type IMConversationRef, type IMDialogPage, type IMGroupFilePage,
  type IMDirectDownload, type IMDownloadOptions, type IMEvent, type IMHistoryPage, type IMHistoryQuery, type IMMedia, type IMMessage, type IMMessageInput, type IMMessageTarget,
  type IMMediaInput, type IMMediaUploadPreparation, type IMMediaUploadProbe,
  type IMMessageBundle, type IMMessageSnapshot, type JsonValue,
  type IMMessageSearchPage, type IMMessageSearchQuery, type IMPageQuery, type IMPlatform, type IMReactionActorPage, type IMReactionActorPageRequest, type IMReactionContext, type IMReactionResource, type IMReactionTarget, type IMReadTarget, type IMRequest, type IMRequestAction, type IMRequestPage, type IMRequestQuery, type IMTransferOptions,
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
  QQMediaLocator, QQStickerReference, WireCallSignalEvent, WireConversation, WireEvent, WireGroupFilePage, WireMedia, WireMessage,
  WireMultiForwardLocator, WireNativeAvsdkEvent, WireReactionState, WireRequest, WireTextPart,
} from './protocol.js'

type QQOutboundMedia = NonNullable<Parameters<QQNTClient['sendMessage']>[2]>[number]


const MIN_PROTOCOL_VERSION = 19
const MAX_PROTOCOL_VERSION = 30

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
  }
  private readonly database?: Database
  private readonly qqVoiceMedia?: QQVoiceMedia
  private readonly conversations = new Map<string, IMConversation<QQMediaLocator>>()
  private readonly savedMessagesConversationIds = new Map<string, string>()
  private readonly firstUnreadSeq = new Map<string, string>()
  private reactionCatalog?: IMReactionContext
  private reactionCatalogPromise?: Promise<IMReactionContext>
  private reactionCatalogRetryAt = 0
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
    let consecutiveStreamFailures = 0
    while (!signal.aborted) {
      attempt++
      let reconnectDelayMs = WEBSOCKET_RECONNECT_BASE_DELAY_MS
      this.logger?.info(
        'WebSocket subscribe start session=%s attempt=%d endpoint=%s lastEventId=%s',
        platformSessionId, attempt, this.client.webSocketEndpoint, lastEventId ?? '<none>',
      )
      try {
        await this.client.subscribe(async (event, eventId) => {
          // Receiving any frame proves that the transport is healthy. Future
          // connection failures start a fresh backoff sequence instead of
          // inheriting an outage that has already recovered.
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
                event.message.serviceAction?.text ?? '',
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
          // The baseline must include every page. Otherwise a conversation
          // outside the first page is misclassified as newly received when it
          // later moves to the top after a message arrives.
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
          // Recent changes move to the first page, so subsequent polling only
          // needs that page rather than scanning hundreds of dialogs each time.
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
    await waitAtMost(this.ensureReactionCatalog().catch(() => undefined), REACTION_CATALOG_GRACE_MS)
    return this.prepareDialogPage(session, await this.fetchDialogsPage(session, query))
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
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const response = await this.client.getDialogs({
      cursor: query.cursor, afterId: query.afterId, limit: query.limit,
    }, signal)
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
            : undefined,
        }
      }),
      nextCursor: response.nextCursor,
      total: response.total,
    }
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
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    if (isFilteredConversationId(conversation.id)) return { messages: [] }
    const response = await this.client.getHistory(
      await this.wireConversationId(session, conversation.id), {
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
      messages: await Promise.all(this.collapseSplitOutgoingMessages(response.messages)
        .filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(
          session, this.conversationFor(conversation.id), this.mapMessage(message, conversation.id),
        ))),
      nextCursor: response.nextCursor,
    }
  }

  async searchMessages(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMMessageSearchQuery,
  ): Promise<IMMessageSearchPage<QQMediaLocator>> {
    if (isFilteredConversationId(conversation.id)) return { messages: [] }
    if (isFilteredConversationId(conversation.id)) return { messages: [] }
    if (query.mediaKind === 'file' && this.isGroupConversation(conversation.id)) {
      const page = await this.listGroupFiles(session, conversation, {
        cursor: query.cursor,
        limit: query.limit,
      })
      const normalized = query.query.trim().toLocaleLowerCase()
      const files = page.items.filter((item) => item.type === 'file').filter((file) => {
        if (normalized && !file.name.toLocaleLowerCase().includes(normalized)) return false
        if (query.fromUserId && file.uploaderId !== query.fromUserId) return false
        if (query.minTimestamp && file.uploadTime <= query.minTimestamp) return false
        if (query.maxTimestamp && file.uploadTime >= query.maxTimestamp) return false
        return true
      })
      return {
        messages: files.map((file) => ({
          id: `qq-group-file:${file.id}`,
          conversationId: conversation.id,
          senderId: file.uploaderId || session.userId,
          sender: {
            id: file.uploaderId || session.userId,
            firstName: file.uploaderName || file.uploaderId || 'QQ',
            username: file.uploaderId || undefined,
          },
          timestamp: file.uploadTime,
          outgoing: false,
          metadata: { qqGroupFileId: file.id, qqGroupFileParentId: file.parentId },
          content: {
            parts: [
              { type: 'text' as const, text: file.name },
              { type: 'media' as const, media: file.media },
            ],
          },
        })),
        nextCursor: page.nextCursor,
        total: page.total,
      }
    }
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const response = await this.client.searchMessages(
      await this.wireConversationId(session, conversation.id), {
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
      messages: await Promise.all(this.collapseSplitOutgoingMessages(response.messages)
        .filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(
          session, this.conversationFor(conversation.id), this.mapMessage(message, conversation.id),
        ))),
      nextCursor: response.nextCursor,
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
    if (isFilteredConversationId(conversation.id)) return null
    const message = await this.client.getMessage(
      await this.wireConversationId(session, conversation.id), messageId,
    )
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
    // The QQNT bridge notification-mask route is keyed by chatType + peerUin
    // (the numeric group code), stored on the conversation metadata as `qq`.
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

  async setConversationMemberRole(
    _session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
    role: 'administrator' | 'member',
  ): Promise<void> {
    await this.client.setMemberRole(conversation.id, userId, role)
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
    const originRequestId = randomUUID()
    this.originSessions.set(originRequestId, session.platformSessionId)
    try {
      let sent: WireMessage
      try {
        sent = await this.sendWireMessage(
          await this.wireConversationId(session, conversation.id), text, media,
          options, originRequestId, sticker, textParts,
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
    text: string | undefined,
    media: QQOutboundMedia[],
    options: IMTransferOptions,
    originRequestId: string,
    sticker: QQStickerReference | undefined,
    textParts: WireTextPart[],
    replyToId: string | undefined,
    replyToSequence: string | undefined,
  ): Promise<WireMessage> {
    if (!media.some(isOrdinaryQQFile)) {
      return this.client.sendMessage(
        conversationId, text, media.length ? media : undefined, options,
        originRequestId, sticker, textParts, replyToId, replyToSequence,
      )
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
      const sent = await this.client.sendMessage(
        conversationId,
        plan.includeText ? text : undefined,
        plan.media.length ? plan.media.map(({ item }) => item) : undefined,
        planOptions,
        originRequestId,
        undefined,
        plan.includeText ? textParts : undefined,
        plan.includeReply ? replyToId : undefined,
        plan.includeReply ? replyToSequence : undefined,
      )
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
    const logicalMessage: WireMessage = {
      ...primary,
      sourceIds: orderedSourceIds,
      originRequestId,
      replyToId: primary.replyToId ?? replyToId,
      parts: [
        ...textParts,
        ...orderedMedia,
      ],
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
      // Telegram probes the next chunk to learn EOF. QQNT reports this normal
      // ranged-read terminator as HTTP 400 instead of an empty response.
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

      const channelIds = platformConversationIds.map((id) => String(stableId(`peer:${id}`)))
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

  /** Select a real QQ C2C/group target for CDN negotiation without sending it a message. */
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

  private mapMessage(input: WireMessage, conversationId?: string): IMMessage<QQMediaLocator> {
    input = this.splitOutgoingMessages.get(input.id) ?? input
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
      parts: mapParts(input, stickerProviderId, reactionCatalog, projectMedia),
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
      parts.push({
        type: 'message-bundle',
        bundle: {
          id: multiForwardBundleId(part.locator),
          title: part.title || '聊天记录',
          preview: part.preview,
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

function isFilteredConversationId(value: string): boolean {
  return isInvalidZeroPeerConversationId(value)
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
