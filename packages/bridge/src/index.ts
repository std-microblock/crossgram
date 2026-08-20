import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import { resolve } from 'node:path'
import Long from 'long'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { RpcError, bareVector, type ServerRpcContext } from '@mtproto-relay/mtproto'
import type { IMPlatform, PlatformSession } from './platform.js'
import { defineModels } from './models.js'
import { makeConfig, makeAppConfig, makeUser, parseEndpoint } from './synthetic.js'
import {
  DialogRpc,
  type LegacyGetForumTopicsByIdRequest, type LegacyGetForumTopicsRequest,
} from './dialogs.js'
import { startupRpcHandlers } from './startup.js'
import { androidRpcHandlers } from './android-rpc.js'
import { MessageStore } from './message-store.js'
import {
  IMPlatformService, PlatformSubscriptionManager, migrateQualifiedPlatformIds,
  sessionFromRow, type PlatformRegistry,
} from './platform-manager.js'
import { UploadManager } from './upload-manager.js'
import { UpdateManager } from './update-manager.js'
import { IMStickerService } from './sticker-provider.js'
import { StickerRpc } from './sticker-rpc.js'
import { ReactionRpc } from './reaction-rpc.js'
import { TelegramResourceService } from './resource-provider.js'
import {
  migrateLegacyVirtualPhones, PlatformAccountProvisioner, type ProvisionedPlatformAccount,
} from './platform-account.js'
import { verifyLoginCode } from './login-code.js'
import { DraftStore } from './draft-store.js'
import { NotificationSettingsStore } from './notification-settings.js'
import {
  makeCrossGramServerConfig, makePlatformAccountView, makeUnavailableAccountView,
  type PlatformAccountDashboardData,
} from './account-dashboard.js'
import { AuthTransferStore } from './auth-transfer.js'
import {
  LoginTokenStore, LoginTokenStoreFullError, LoginTokenSourceLimitError, parseTelegramLoginToken,
} from './login-token.js'
import { BlockedPeerStore, type BlockedContentMode } from './blocked-peers.js'
import { DialogFolderStore } from './dialog-folders.js'
import {
  collectStickerDashboard, setStickerPackAssignment,
  type StickerDashboardPack, type StickerDashboardSourceAccount, type StickerPackDashboardData,
} from './sticker-dashboard.js'
import { CallRegistry, type VoiceMediaStartProvider, type VoiceWorkerClient } from './voice/call-registry.js'
import type { VoiceCallMediaProvider } from './voice/media.js'
import { createBuiltInVoiceMediaProvider } from './voice/media-config.js'
import { VoiceWorkerSocketClient } from './voice/voice-worker-client.js'
import { VoiceRpc } from './voice/voice-rpc.js'
import { SystemPeerCallbackError, SystemPeerService } from './system-peer.js'
import type { BotDashboardData } from './bot-dashboard.js'
import { RequestInboxSystemPeerProvider } from './request-inbox.js'
import { ActiveSessionStore, registerActiveSessionRpc } from './active-sessions.js'
import { ConversationViewService } from './conversation-view.js'
import { MtprotoBridgeService, type BridgeSessionState } from './bridge-service.js'
import { BridgeManagementError, BridgeManagementService } from './management-service.js'
import { registerGroupFilesMiniApp } from './group-files-miniapp.js'

export * from './platform.js'
export { defineModels } from './models.js'
export { stableId } from './dialogs.js'
export * from './message-store.js'
export * from './message-actions.js'
export * from './platform-manager.js'
export * from './upload-manager.js'
export * from './update-manager.js'
export * from './sticker-provider.js'
export * from './sticker-rpc.js'
export * from './reaction-rpc.js'
export * from './resource-provider.js'
export * from './login-code.js'
export * from './draft-store.js'
export * from './platform-account.js'
export * from './account-dashboard.js'
export * from './auth-transfer.js'
export * from './login-token.js'
export * from './blocked-peers.js'
export * from './dialog-folders.js'
export * from './voice/call-registry.js'
export * from './voice/media.js'
export * from './voice/voice-worker-client.js'
export * from './voice/voice-rpc.js'
export * from './system-peer.js'
export * from './conversation-view.js'
export * from './bridge-service.js'
export * from './stripped-thumbnail.js'
export * from './image-dimensions.js'
export * from './sticker-outline.js'
export * from './sticker-dashboard.js'
export * from './active-sessions.js'
export * from './management-service.js'
export * from './bot-dashboard.js'

export const name = 'mtproto-bridge'
export const inject = ['mtproto', 'database', 'model', 'server', 'webui', 'updateStore']
export const provide = [
  'imPlatform', 'imSticker', 'telegramResource', 'systemPeer', 'conversationView', 'mtprotoBridge', 'bridgeManagement',
]

export interface BridgeConfig {
  dcId?: number
  serverHost?: string
  serverPort?: number
  altEndpoints?: string[]
  /** HTTP prefix for platform account assets (default: /api). */
  apiPrefix?: string
  /** Telegram attachment-menu Mini App for browsing platform-native group files. */
  groupFilesMiniApp?: {
    enabled?: boolean
    path?: string
    publicUrl?: string
    secret?: string
    tokenTtlSeconds?: number
  }
  uploadPath?: string
  /** Mute group chats by default unless the Telegram user explicitly enables them. */
  autoMuteGroupChats?: boolean
  /** Visibility policy for users blocked through Telegram. */
  blockedContentMode?: BlockedContentMode
  /** Optional native worker; it must expose public status/material only. */
  voiceWorker?: VoiceWorkerClient
  /** Local Rust voice-worker Unix socket; an empty path leaves calls unavailable. */
  voiceWorkerSocketPath?: string
  /** Per-request Unix socket timeout for the voice worker. */
  voiceWorkerTimeoutMs?: number
  /** Call-scoped real relay config source; without it voice media fails closed. */
  voiceMediaStartProvider?: VoiceMediaStartProvider
  /** Allow direct ICE only when the configured MTProto host is loopback or private LAN. */
  voiceDirectIce?: boolean
  /** Public TURN host advertised to both Telegram and the native worker. */
  voiceTurnHost?: string
  voiceTurnPort?: number
  /** Coturn REST-auth shared secret; only derived call-scoped credentials leave this process. */
  voiceTurnSharedSecret?: string
  voiceTurnTtlSeconds?: number
  onTransferProgress?: (session: PlatformSession, progress: import('./platform.js').IMTransferProgress) => void | Promise<void>
}

export const Config = z.object({
  dcId: z.natural().min(1).max(6).default(1),
  serverHost: z.string().default('127.0.0.1'),
  serverPort: z.natural().min(1).max(65_535).default(4430),
  altEndpoints: z.array(z.transform(z.string(), (endpoint) => {
    try {
      parseEndpoint(endpoint)
      return endpoint
    } catch (error) {
      throw new z.ValidationError(`invalid altEndpoints endpoint: ${(error as Error).message}`, {
        path: ['altEndpoints'],
      })
    }
  })).default([]),
  apiPrefix: z.string().default('/api'),
  groupFilesMiniApp: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default('/group-files'),
    publicUrl: z.string().default(''),
    secret: z.string().role('secret').default(''),
    tokenTtlSeconds: z.natural().min(60).max(3_600).default(600),
  }).default({
    enabled: true,
    path: '/group-files',
    publicUrl: '',
    secret: '',
    tokenTtlSeconds: 600,
  }),
  uploadPath: z.string().default('data/bridge-uploads'),
  autoMuteGroupChats: z.boolean().default(true),
  blockedContentMode: z.union([
    z.const('show'), z.const('hide-user'), z.const('hide-related'),
  ]).default('hide-user'),
  voiceWorkerSocketPath: z.string().default(''),
  voiceWorkerTimeoutMs: z.natural().min(1).max(60_000).default(5_000),
  voiceDirectIce: z.boolean().default(true),
  voiceTurnHost: z.string().default(''),
  voiceTurnPort: z.natural().min(1).max(65_535).default(3478),
  voiceTurnSharedSecret: z.string().role('secret').default(''),
  voiceTurnTtlSeconds: z.natural().min(60).max(86_400).default(3_600),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

/**
 * Bridge backend — a native cordis plugin. Translates MTProto RPC to an IM
 * platform. Each adapter supplies its own current-user profile; bridge assigns
 * one stable virtual phone and a 30-second login code to the Cordis entry.
 */
export function apply(ctx: Context, config: BridgeConfig = {}): void {
  const generation = {}
  const platforms = new IMPlatformService(ctx)
  const stickerProviders = new IMStickerService(ctx)
  const resources = new TelegramResourceService(ctx)
  const systemPeers = new SystemPeerService(ctx)
  const conversationViews = new ConversationViewService(ctx)
  const management = new BridgeManagementService(ctx)
  const registry = platforms.registry
  const rpc = ctx.mtproto
  const dcId = config.dcId ?? 1
  const apiPrefix = (config.apiPrefix ?? '/api').replace(/\/$/, '')
  const bridgeLogger = ctx.logger('bridge')
  const historyTrace = (format: string, ...args: unknown[]) => {
    if (format.startsWith('slow dialogs rpc profile')) bridgeLogger.info(format, ...args)
    else bridgeLogger.debug(format, ...args)
  }
  const authTransfers = new AuthTransferStore()
  const loginTokens = new LoginTokenStore()

  defineModels(ctx)
  const activeSessions = new ActiveSessionStore(
    ctx.database,
    authKeyId => ctx.mtproto.revokeAuthKey(authKeyId),
  )
  const store = new MessageStore(ctx.database, undefined, ctx.updateStore, historyTrace)
  const drafts = new DraftStore(ctx.database)
  const notificationSettings = new NotificationSettingsStore(
    ctx.database, config.autoMuteGroupChats ?? true,
  )
  const blockedPeers = new BlockedPeerStore(
    ctx.database, config.blockedContentMode ?? 'hide-user',
  )
  const dialogFolders = new DialogFolderStore(ctx.database)
  const uploads = new UploadManager(resolve(config.uploadPath ?? 'data/bridge-uploads'))
  const stickerRpcs = new Map<string, { platform: IMPlatform, rpc: StickerRpc }>()
  const reactionRpcs = new Map<string, { platform: IMPlatform, rpc: ReactionRpc }>()
  const stickerRpcFor = (platform: IMPlatform, session: PlatformSession): StickerRpc => {
    const key = `${session.platformId}\u0000${session.platformSessionId}`
    const cached = stickerRpcs.get(key)
    if (cached?.platform === platform) return cached.rpc
    const rpc = new StickerRpc(ctx.database, stickerProviders.registry, platform, session, dcId)
    stickerRpcs.set(key, { platform, rpc })
    return rpc
  }
  const reactionRpcFor = (platform: IMPlatform, session: PlatformSession): ReactionRpc => {
    const key = `${session.platformId}\u0000${session.platformSessionId}`
    const cached = reactionRpcs.get(key)
    if (cached?.platform === platform) return cached.rpc
    const rpc = new ReactionRpc(platform, session, dcId, ctx.database)
    reactionRpcs.set(key, { platform, rpc })
    return rpc
  }
  const updates = new UpdateManager(
    ctx.database, registry, store,
    (authKeyId, update, excludeConnection) =>
      ctx.mtproto.sendUpdateToAuthKey(authKeyId, update, excludeConnection),
    dcId,
    (format, ...args) => bridgeLogger.debug(format, ...args),
    (session, sticker) => stickerRpcFor(registry.require(session.platformId), session)
      .makeMessageMedia(sticker),
    blockedPeers,
    (session, message) => reactionRpcFor(registry.require(session.platformId), session)
      .registerContext(message.conversationId, message.reactionContext),
    conversationViews,
  )
  const builtInMediaProvider = createBuiltInVoiceMediaProvider({
    serverHost: config.serverHost,
    directIce: config.voiceDirectIce,
    workerTimeoutMs: config.voiceWorkerTimeoutMs,
    turn: {
      host: config.voiceTurnHost,
      port: config.voiceTurnPort,
      sharedSecret: config.voiceTurnSharedSecret,
      ttlSeconds: config.voiceTurnTtlSeconds,
    },
    envTurnSharedSecret: process.env.CROSSGRAM_TURN_SHARED_SECRET,
  })
  const socketWorker = !config.voiceWorker && config.voiceWorkerSocketPath
    ? new VoiceWorkerSocketClient({
        socketPath: config.voiceWorkerSocketPath,
        timeoutMs: config.voiceWorkerTimeoutMs,
        onDiagnostic: (phase, code) => bridgeLogger.warn(
          'voice worker media lifecycle phase=%s code=%s', phase, code,
        ),
      })
    : undefined
  const voiceWorker = config.voiceWorker ?? socketWorker
  const voiceMedia: VoiceCallMediaProvider = {
    async start(call, session, endpoint) {
      const platform = registry.get(session.platformId)
      if (!platform?.voiceMedia) throw new Error('platform voice media is unavailable')
      return platform.voiceMedia.start(call, session, endpoint)
    },
  }
  const calls = new CallRegistry({
    worker: voiceWorker,
    media: voiceMedia,
    mediaStartProvider: config.voiceMediaStartProvider ?? builtInMediaProvider,
    onMediaDiagnostic: (phase, code) => bridgeLogger.warn(
      'voice media attachment terminal phase=%s code=%s', phase, code,
    ),
    publish: async ({ session, update, excludeAuthKeyId }) => {
      const delivered = await updates.publishPhoneCall(session, update, excludeAuthKeyId)
      bridgeLogger.info('voice phone call update state=%s delivered=%d', update.phoneCall._, delivered)
      return delivered
    },
    publishSignaling: (session, update) => updates.publishPhoneSignaling(session, update),
    replay: async (session, update, authKeyId) => {
      const delivered = await updates.replayPhoneCall(session, update, authKeyId)
      bridgeLogger.info('voice phone call update state=%s delivered=%d replay=true', update.phoneCall._, delivered)
      return delivered
    },
  })
  const voice = new VoiceRpc(calls, store)
  socketWorker?.setEventHandler((call, event) => calls.handleWorkerEvent(call, event))
  ctx.effect(() => {
    const timer = setInterval(() => {
      void calls.expire().catch(() => bridgeLogger.warn('voice call expiry failed'))
    }, 1_000)
    return () => {
      clearInterval(timer)
      socketWorker?.close()
    }
  }, 'mtproto-bridge.voice-calls')
  const subscriptions = new PlatformSubscriptionManager(
    ctx.database,
    registry,
    store,
    (error, session) => bridgeLogger.warn(
      'platform subscription failed platform=%s session=%s error=%s',
      session?.platformId ?? 'unknown', session?.platformSessionId ?? 'unknown',
      error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error),
    ),
    async (session, event, options) => {
      if (event.event.type === 'voice-call') {
        const platform = registry.get(session.platformId)
        if (voiceWorker && platform?.platformKind === 'qq' && event.event.media === 'voice') {
          const callRef = event.event.callRef
          if (event.event.signal === 'incoming' && platform.voiceCalls) {
            await voice.receiveIncoming(
              session,
              event.event.conversation.id,
              callRef,
              { control: (operation) => platform.voiceCalls!.control(session, callRef, operation) },
            )
          } else if (event.event.signal === 'ended') {
            await voice.platformEnded(session, callRef)
          }
        }
        return
      }
      return updates.publish(session, event, options)
    },
    (format, ...args) => bridgeLogger.debug(format, ...args),
    ctx,
  )
  platforms.attachLocalMessageIngress(
    (session, conversation, message) => subscriptions.ingestLocalEvent(session, { type: 'message', conversation, message }),
  )
  systemPeers.attach(
    (session, event, options) => subscriptions.ingestLocalEvent(session, event, options),
  )
  const unregisterRequestInbox = systemPeers.register(new RequestInboxSystemPeerProvider(
    store,
    async (session, requestId, action) => {
      const resolveRequest = registry.require(session.platformId).resolveRequest
      if (!resolveRequest) throw new SystemPeerCallbackError('REQUEST_RESOLVE_UNAVAILABLE')
      return resolveRequest(session, requestId, action)
    },
    async (session, request) => {
      await subscriptions.ingestLocalEvent(session, { type: 'request', request, delivery: 'recovery' })
    },
  ))
  ctx.effect(() => unregisterRequestInbox, 'mtproto-bridge.request-inbox')
  platforms.onSessionChange((event, binding) => {
    if (event === 'deactivate') {
      const key = `${binding.session.platformId} ${binding.session.platformSessionId}`
      stickerRpcs.delete(key)
      reactionRpcs.delete(key)
      stickerProviders.releaseSession(binding.session.platformSessionId)
      return
    }
    void systemPeers.bootstrap(binding.session).catch((error) => {
      bridgeLogger.warn('system peer bootstrap failed: %s', String(error))
    })
  })
  const requireBridgeSession = createSessionResolver(
    ctx, registry, stickerRpcFor, reactionRpcFor, resources, store, drafts, notificationSettings, blockedPeers,
    dialogFolders,
    subscriptions, uploads, systemPeers, generation,
    (localSession, update, excludeAuthKeyId) => updates.publishDraft(
      localSession, update, excludeAuthKeyId,
    ),
    config.onTransferProgress, dcId, historyTrace,
    async (session, authKeyId, rpcContext) => {
      await activeSessions.touch(rpcContext, session)
      await calls.replay(session, authKeyId)
    },
    conversationViews,
  )
  registerActiveSessionRpc(rpc, activeSessions, async rpcContext =>
    (await requireBridgeSession(rpcContext)).session)
  new MtprotoBridgeService(ctx, requireBridgeSession)
  registerGroupFilesMiniApp(ctx, platforms, requireBridgeSession, config.groupFilesMiniApp)

  const authorizationLocks = new Map<string, Promise<void>>()
  const withAuthorizationLock = async <T>(authKeyId: string, callback: () => Promise<T>): Promise<T> => {
    const previous = authorizationLocks.get(authKeyId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    authorizationLocks.set(authKeyId, current)
    await previous
    try {
      return await callback()
    } finally {
      release()
      if (authorizationLocks.get(authKeyId) === current) authorizationLocks.delete(authKeyId)
    }
  }

  const authorizePlatformSession = async (
    rpc: ServerRpcContext,
    identity: { platformId: string, platformSessionId: string },
  ): Promise<tl.TlObject> => {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const [platformSession] = await ctx.database.get('mtproto_platform_session', {
      id: identity.platformSessionId,
      platformId: identity.platformId,
      active: true,
    })
    if (!platformSession) throw new RpcError(401, 'PLATFORM_SESSION_REVOKED')
    const [authSession] = await ctx.database.get('mtproto_auth_session', identity)
    if (!authSession) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    if (!registry.get(identity.platformId)) throw new RpcError(500, 'PLATFORM_NOT_AVAILABLE')

    const authKeyId = authKeyHex(rpc.authKeyId)
    return withAuthorizationLock(authKeyId, async () => {
      const [binding] = await ctx.database.get('mtproto_auth_binding', { authKeyId })
      if (
        binding
        && (binding.platformId !== identity.platformId || binding.platformSessionId !== identity.platformSessionId)
      ) throw new RpcError(400, 'AUTH_KEY_ALREADY_BOUND')

      const created = !binding
      const state = created
        ? await requireBridgeSession(rpc, identity, false)
        : await requireBridgeSession(rpc)
      const metadata = platformSession.metadata
      const selfRow = await store.getUser(state.session.platformId, state.session.userId)
        ?? await store.upsertUser(state.session, {
          id: state.session.userId,
          firstName: (metadata.firstName as string) ?? 'Bridge',
          lastName: metadata.lastName as string | undefined,
          username: metadata.username as string | undefined,
          metadata,
        })
      if (created) {
        await finalizeAuthorizedSession(
          rpc,
          state,
          () => ctx.database.upsert('mtproto_auth_binding', [{ authKeyId, ...identity }]),
          requireBridgeSession,
        )
        void updates.retryPending(state.session.platformSessionId).catch((error) => bridgeLogger.warn(
          'pending update retry failed session=%s error=%s', state.session.platformSessionId, String(error),
        ))
      }
      const user = makeUser({
        id: selfRow.id,
        self: true,
        premium: true,
        firstName: (metadata.firstName as string) ?? 'Bridge',
        lastName: metadata.lastName as string | undefined,
        username: metadata.username as string | undefined,
        phone: authSession.virtualPhone,
      })
      return { _: 'auth.authorization', flags: 0, setupPasswordRequired: false, user } as unknown as tl.TlObject
    })
  }

  const accountProvisioner = new PlatformAccountProvisioner(ctx.database)
  const legacyPhoneMigration = ctx.database.prepared().then(async () => {
    const migrated = await migrateLegacyVirtualPhones(ctx.database)
    if (migrated) bridgeLogger.info('migrated %d non-888 virtual phones to +888', migrated)
  })
  const provisionedAccounts = new Map<string, ProvisionedPlatformAccount>()
  const accountErrors = new Map<string, unknown>()
  let publishedStickerPacks: StickerDashboardPack[] = []
  const dashboard: PlatformAccountDashboardData & StickerPackDashboardData & BotDashboardData = {
    accounts: [],
    serverConfig: makeCrossGramServerConfig(
      config.serverHost ?? '127.0.0.1', config.serverPort ?? 4430, ctx.mtproto.rsaKey.publicKeyPem,
    ),
    loginTokenApprovalUrl: `${apiPrefix}/login-tokens`,
    updatedAt: Date.now(),
    stickerAccounts: [],
    stickerPacks: [],
    stickerUpdatedAt: Date.now(),
    bots: [],
    botUpdatedAt: Date.now(),
    async refresh() {
      await ctx.database.prepared()
      await Promise.allSettled(registry.ids.map(platformId => provision(platformId)))
      publishAccounts()
      await publishStickerPacks()
      await publishBots()
    },
    async refreshStickerPacks() {
      await ctx.database.prepared()
      await publishStickerPacks()
    },
    async refreshBots() {
      await publishBots()
    },
    async setStickerPackAssigned(platformSessionId, providerId, packId, assigned) {
      const pack = publishedStickerPacks.find((item) =>
        item.providerId === providerId && item.packId === packId)
      if (!pack) throw new Error('表情包不存在，请刷新后重试。')
      const assignment = pack.assignments.find((item) => item.platformSessionId === platformSessionId)
      if (!assignment) throw new Error('目标账号不存在，请刷新后重试。')
      if (!assigned && assignment.automatic) throw new Error('账号固有表情包不能取消关联。')
      await setStickerPackAssignment(ctx.database, platformSessionId, providerId, packId, assigned)
      await publishStickerPacks()
    },
  }
  const dashboardEntry = ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/platform-accounts', '/sticker-packs', '/bots'],
  }, dashboard)

  const currentAccounts = (now = Date.now()) => registry.ids.sort().map((platformId) => {
    const platform = registry.require(platformId)
    const kind = platform.platformKind ?? platformId
    const account = provisionedAccounts.get(platformId)
    if (account) return makePlatformAccountView(platformId, kind, account, apiPrefix, now)
    if (!platform.getAccount) return makeUnavailableAccountView(platformId, kind, 'unsupported')
    const error = accountErrors.get(platformId)
    return makeUnavailableAccountView(platformId, kind, error ? 'error' : 'loading', error)
  })

  const publishAccounts = (now = Date.now()) => {
    dashboardEntry.mutate((value) => {
      value.updatedAt = now
      value.accounts = currentAccounts(now)
    })
  }

  const stickerSourceAccounts = (): StickerDashboardSourceAccount[] => [...provisionedAccounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([platformId, account]) => {
      const platform = registry.require(platformId)
      const displayName = [account.profile.firstName, account.profile.lastName].filter(Boolean).join(' ')
        || account.profile.username || account.profile.id
      return {
        session: account.session,
        view: {
          platformId,
          platformSessionId: account.session.platformSessionId,
          platformKind: platform.platformKind ?? platformId,
          displayName,
          username: account.profile.username,
          userId: account.profile.id,
        },
      }
    })

  const publishStickerPacks = async (now = Date.now()) => {
    const snapshot = await collectStickerDashboard(ctx.database, stickerProviders.registry, stickerSourceAccounts())
    publishedStickerPacks = snapshot.packs
    dashboardEntry.mutate((value) => {
      value.stickerUpdatedAt = now
      value.stickerAccounts = snapshot.accounts
      value.stickerPacks = snapshot.packs
    })
  }

  const publishBots = async (now = Date.now()) => {
    const bots = await systemPeers.listBots()
    dashboardEntry.mutate((value) => {
      value.botUpdatedAt = now
      value.bots = bots
    })
  }

  const stopBotDashboardRefresh = systemPeers.onChanged(() => {
    void publishBots().catch((error) => bridgeLogger.warn('bot dashboard refresh failed: %s', String(error)))
  })
  ctx.effect(() => stopBotDashboardRefresh, 'mtproto-bridge.bot-dashboard')

  const provision = async (platformId: string) => {
    await legacyPhoneMigration
    const platform = registry.get(platformId)
    if (!platform?.getAccount) return
    try {
      const provisioned = await accountProvisioner.provision(platformId, platform)
      if (!provisioned) return
      provisionedAccounts.set(platformId, provisioned)
      accountErrors.delete(platformId)
      publishAccounts()
      await subscriptions.ensure(provisioned.session)
      platforms.activateSession(platformId, platform, provisioned.session)
    } catch (error) {
      platforms.deactivateSession(platformId, platform)
      provisionedAccounts.delete(platformId)
      accountErrors.set(platformId, error)
      publishAccounts()
      throw error
    }
  }

  const approveLoginToken = (platformId: string, token: string) => {
    const parsed = parseTelegramLoginToken(token)
    if (!parsed) throw new BridgeManagementError('AUTH_TOKEN_INVALID')
    const account = provisionedAccounts.get(platformId)
    if (!account) throw new BridgeManagementError('PLATFORM_ACCOUNT_UNAVAILABLE')
    if (!loginTokens.approve(parsed, {
      platformId: account.session.platformId,
      platformSessionId: account.session.platformSessionId,
    })) throw new BridgeManagementError('AUTH_TOKEN_INVALID')
  }

  management.attach({
    serverConfig: () => dashboard.serverConfig,
    accounts: currentAccounts,
    registeredPlatformIds: () => registry.ids,
    activeSessions: () => platforms.sessions.map(binding => binding.session),
    refresh: () => dashboard.refresh(),
    approveLoginToken,
    stickers: () => ({
      accounts: dashboard.stickerAccounts,
      packs: dashboard.stickerPacks,
      updatedAt: dashboard.stickerUpdatedAt,
    }),
    refreshStickers: () => dashboard.refreshStickerPacks(),
    setStickerPackAssigned: async (platformSessionId, providerId, packId, assigned) => {
      const pack = publishedStickerPacks.find(item => item.providerId === providerId && item.packId === packId)
      if (!pack) throw new BridgeManagementError('STICKER_PACK_NOT_FOUND', '表情包不存在，请刷新后重试。')
      const assignment = pack.assignments.find(item => item.platformSessionId === platformSessionId)
      if (!assignment) throw new BridgeManagementError('STICKER_ACCOUNT_NOT_FOUND', '目标账号不存在，请刷新后重试。')
      if (!assigned && assignment.automatic) {
        throw new BridgeManagementError('STICKER_ASSIGNMENT_AUTOMATIC', '账号固有表情包不能取消关联。')
      }
      await setStickerPackAssignment(ctx.database, platformSessionId, providerId, packId, assigned)
      await publishStickerPacks()
    },
  })

  ctx.effect(() => {
    const timer = setInterval(() => publishAccounts(), 1_000)
    return () => clearInterval(timer)
  }, 'mtproto-bridge.account-codes')

  // Security: intentionally public, matching the anonymously subscribable account-list entry boundary.
  ctx.server.post(`${apiPrefix}/login-tokens/:platform/approve`, async (req, res) => {
    const declaredLength = Number(req.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > 256) {
      res.status = 413
      res.json({ error: 'REQUEST_TOO_LARGE' })
      return
    }
    let token: unknown
    try {
      const reader = req.body?.getReader()
      if (!reader) throw new Error('request body missing')
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 256) {
          await reader.cancel()
          res.status = 413
          res.json({ error: 'REQUEST_TOO_LARGE' })
          return
        }
        chunks.push(Buffer.from(value))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: unknown }
      token = body?.token
    } catch {
      res.status = 400
      res.json({ error: 'INVALID_REQUEST' })
      return
    }
    try {
      if (typeof token !== 'string') throw new BridgeManagementError('AUTH_TOKEN_INVALID')
      approveLoginToken(req.params.platform, token)
    } catch (error) {
      if (!(error instanceof BridgeManagementError)) throw error
      res.status = error.code === 'PLATFORM_ACCOUNT_UNAVAILABLE' ? 404 : 400
      res.json({ error: error.code })
      return
    }
    res.json({ ok: true })
  })

  ctx.server.get(`${apiPrefix}/platforms/:platform/avatar`, async (req, res) => {
    const platformId = (req.params as { platform: string }).platform
    const account = provisionedAccounts.get(platformId)
    const platform = registry.get(platformId)
    const avatar = account?.profile.avatar
    if (!account || !platform?.downloadMedia || !avatar) {
      res.status = 404
      res.json({ error: 'platform avatar not available' })
      return
    }
    const maxBytes = 8 * 1024 * 1024
    if (avatar.size && avatar.size > maxBytes) {
      res.status = 413
      res.json({ error: 'platform avatar is too large' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of platform.downloadMedia(account.session, avatar, { limit: maxBytes })) {
      size += chunk.length
      if (size > maxBytes) {
        res.status = 413
        res.json({ error: 'platform avatar is too large' })
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    res.headers.set('content-type', avatar.mimeType ?? 'application/octet-stream')
    res.headers.set('cache-control', 'private, max-age=30')
    res.body = Buffer.concat(chunks)
  })

  platforms.onChange((event, platformId, platform) => {
    if (event === 'register') {
      ctx.logger('bridge').info('IM platform registered: %s', platformId)
      void ctx.database.prepared()
        .then(async () => {
          const migrated = await migrateQualifiedPlatformIds(ctx.database, platformId)
          if (migrated) ctx.logger('bridge').info('migrated %d qualified platform sessions to %s', migrated, platformId)
          await provision(platformId)
          await publishStickerPacks()
          await subscriptions.startActiveSessions(platformId)
        })
        .catch((error) => ctx.logger('bridge').warn(
          'failed to start platform sessions (%s): %s', platformId, String(error),
        ))
    } else {
      ctx.logger('bridge').info('IM platform unregistered: %s', platformId)
      platforms.deactivateSession(platformId, platform)
      provisionedAccounts.delete(platformId)
      accountErrors.delete(platformId)
      publishAccounts()
      void publishStickerPacks().catch((error) => ctx.logger('bridge').warn(
        'failed to refresh sticker dashboard: %s', String(error),
      ))
      void subscriptions.stopPlatform(platformId).catch((error) => ctx.logger('bridge').warn(
        'failed to stop platform sessions (%s): %s', platformId, String(error),
      ))
    }
  })

  ctx.effect(async () => {
    await ctx.database.prepared()
    await legacyPhoneMigration
    // Delivery rows from pre-memory-journal versions are no longer used.
    await ctx.database.remove('mtproto_update_delivery', {})
    await Promise.all(registry.ids.map(platformId => provision(platformId)))
    await publishStickerPacks()
    await subscriptions.startActiveSessions()
    return () => subscriptions.stop()
  })

  // ── Synthetic / config ──
  ctx.mtproto.register('help.getConfig', async () => makeConfig(
    dcId, config.serverHost, config.serverPort, config.altEndpoints,
  ))
  ctx.mtproto.register('help.getAppConfig', async () => makeAppConfig())
  ctx.mtproto.register('help.getNearestDc', async () => ({
    _: 'nearestDc', country: 'US', thisDc: dcId, nearestDc: dcId,
  } as unknown as tl.TlObject))

  // ── Auth ──
  rpc.register('auth.sendCode', async (_rpc, req) => {
    const phone = normPhone((req as unknown as { phoneNumber: string }).phoneNumber)
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: phone })
    if (!auth) throw new RpcError(400, 'PHONE_NUMBER_UNOCCUPIED')
    return {
      _: 'auth.sentCode',
      flags: 0,
      type: { _: 'auth.sentCodeTypeApp', length: 6 },
      phoneCodeHash: `hash_${auth.id}`,
    } as unknown as tl.TlObject
  })

  rpc.register('auth.signIn', async (rpc, req) => {
    const { phoneNumber, phoneCode } = req as unknown as { phoneNumber: string, phoneCode: string }
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: normPhone(phoneNumber) })
    if (!auth) throw new RpcError(400, 'PHONE_NUMBER_UNOCCUPIED')
    if (!verifyLoginCode(auth.totpSecret, phoneCode)) throw new RpcError(400, 'PHONE_CODE_INVALID')
    return authorizePlatformSession(rpc, {
      platformId: auth.platformId,
      platformSessionId: auth.platformSessionId,
    })
  })

  rpc.register('auth.exportAuthorization', async (rpc, req) => {
    const request = req as tl.auth.RawExportAuthorizationRequest
    if (!Number.isInteger(request.dcId) || request.dcId < 1 || request.dcId > 6) {
      throw new RpcError(400, 'DC_ID_INVALID')
    }
    const { session } = await requireBridgeSession(rpc)
    const exported = authTransfers.issue({
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
    }, request.dcId)
    return { _: 'auth.exportedAuthorization', ...exported } as tl.auth.RawExportedAuthorization
  })

  rpc.register('auth.importAuthorization', async (rpc, req) => {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const request = req as tl.auth.RawImportAuthorizationRequest
    const identity = authTransfers.take(request.id, request.bytes)
    if (!identity) throw new RpcError(400, 'AUTH_BYTES_INVALID')
    return authorizePlatformSession(rpc, identity)
  })

  // ── Messages ──
  rpc.register('messages.getDialogs', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getDialogs(req as tl.messages.RawGetDialogsRequest))
  rpc.register('messages.getPeerDialogs', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getPeerDialogs(req as tl.messages.RawGetPeerDialogsRequest))
  rpc.register('messages.saveDraft', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.saveDraft(req as tl.messages.RawSaveDraftRequest))
  rpc.register('messages.getAllDrafts', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getAllDrafts())
  rpc.register('messages.getHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getHistory(req as tl.messages.RawGetHistoryRequest))
  rpc.register('messages.getMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessages(req as tl.messages.RawGetMessagesRequest))
  rpc.register('channels.getMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelMessages(req as tl.channels.RawGetMessagesRequest))
  rpc.register('messages.search', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.search(req as tl.messages.RawSearchRequest))
  rpc.register('messages.getSearchCounters', async (rpc, req) => bareVector(
    await (await requireBridgeSession(rpc)).dialogs.getSearchCounters(
      req as tl.messages.RawGetSearchCountersRequest,
    ),
  ))
  rpc.register('messages.getUnreadMentions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getUnreadMentions(
      req as tl.messages.RawGetUnreadMentionsRequest,
    ))
  rpc.register('messages.readMentions', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return state.dialogs.readMentions(
      req as tl.messages.RawReadMentionsRequest,
      rpc.connection,
      (session, conversation, tlMessageIds, topMsgId, excludeConnection) => updates.publishMentionRead(
        session, conversation, tlMessageIds, topMsgId, excludeConnection,
      ),
    )
  })
  rpc.register('messages.readHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.readHistory(
      req as tl.messages.RawReadHistoryRequest, rpc.connection,
    ))
  rpc.register('messages.getScheduledHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getScheduledHistory(req as tl.messages.RawGetScheduledHistoryRequest))
  rpc.register('messages.getPinnedDialogs', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getPinnedDialogs())
  rpc.register('messages.sendMessage', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMessage(
      req as tl.messages.RawSendMessageRequest, rpc.connection,
    ))
  rpc.register('messages.getBotCallbackAnswer', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getBotCallbackAnswer(
      req as tl.messages.RawGetBotCallbackAnswerRequest,
    ))
  rpc.register('messages.sendMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMedia(
      req as tl.messages.RawSendMediaRequest, rpc.connection,
    ))
  rpc.register('messages.sendMultiMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMultiMedia(
      req as tl.messages.RawSendMultiMediaRequest, rpc.connection,
    ))
  rpc.register('messages.deleteMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.deleteMessages(req as tl.messages.RawDeleteMessagesRequest))
  rpc.register('channels.deleteMessages', async (rpc, req) => {
    const request = req as tl.channels.RawDeleteMessagesRequest
    return (await requireBridgeSession(rpc)).dialogs.deleteMessages(request, request.channel)
  })
  rpc.register('messages.editMessage', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.editMessage(
      req as tl.messages.RawEditMessageRequest, rpc.connection,
    ))
  rpc.register('messages.forwardMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.forwardMessages(
      req as tl.messages.RawForwardMessagesRequest, rpc.connection,
    ))
  rpc.register('messages.setTyping', async (rpc) => {
    await requireBridgeSession(rpc)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  rpc.register('messages.uploadMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.uploadMedia(req as tl.messages.RawUploadMediaRequest))
  rpc.register('upload.saveFilePart', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const input = req as tl.upload.RawSaveFilePartRequest
    await uploads.savePart(state.session.platformSessionId, input.fileId.toString(), input.filePart, input.bytes)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  rpc.register('upload.saveBigFilePart', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const input = req as tl.upload.RawSaveBigFilePartRequest
    await uploads.savePart(state.session.platformSessionId, input.fileId.toString(), input.filePart, input.bytes)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  rpc.register('upload.getFile', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFile(req as tl.upload.RawGetFileRequest))
  rpc.register('crossgram.getFileUrl', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFileUrl(
      (req as unknown as { location: tl.TypeInputFileLocation }).location,
    ))
  rpc.register('crossgram.prepareMediaUpload', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.prepareMediaUpload(
      req as unknown as import('./dialogs.js').PrepareMediaUploadRequest,
    ))
  rpc.register('upload.getFileHashes', async () => bareVector([]))

  rpc.register('messages.getAllStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getAllStickers(req as tl.messages.RawGetAllStickersRequest))
  rpc.register('messages.getStickerSet', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return await state.dialogs.getReactionStickerSet(req as tl.messages.RawGetStickerSetRequest)
      ?? state.stickers.getStickerSet(req as tl.messages.RawGetStickerSetRequest)
  })
  rpc.register('messages.getStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getStickers(req as tl.messages.RawGetStickersRequest))
  rpc.register('messages.getRecentStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getRecentStickers(req as tl.messages.RawGetRecentStickersRequest))
  rpc.register('messages.saveRecentSticker', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.saveRecentSticker(req as tl.messages.RawSaveRecentStickerRequest))
  rpc.register('messages.clearRecentStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.clearRecentStickers(req as tl.messages.RawClearRecentStickersRequest))
  rpc.register('messages.getFavedStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getFavedStickers(req as tl.messages.RawGetFavedStickersRequest))
  rpc.register('messages.faveSticker', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.faveSticker(req as tl.messages.RawFaveStickerRequest))
  rpc.register('messages.installStickerSet', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.installStickerSet(req as tl.messages.RawInstallStickerSetRequest))
  rpc.register('messages.uninstallStickerSet', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.uninstallStickerSet(
      req as tl.messages.RawUninstallStickerSetRequest,
    ))
  rpc.register('messages.reorderStickerSets', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.reorderStickerSets(
      req as tl.messages.RawReorderStickerSetsRequest,
    ))
  rpc.register('messages.toggleStickerSets', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.toggleStickerSets(req as tl.messages.RawToggleStickerSetsRequest))
  rpc.register('messages.getAvailableReactions', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getAvailableReactions())
  rpc.register('messages.getAvailableEffects', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getAvailableEffects())
  rpc.register('messages.getTopReactions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(
      (req as tl.messages.RawGetTopReactionsRequest).limit,
    ))
  rpc.register('messages.getRecentReactions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getRecentReactions(
      (req as tl.messages.RawGetRecentReactionsRequest).limit,
    ))
  rpc.register('messages.getDefaultTagReactions', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(100))
  rpc.register('messages.clearRecentReactions', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.clearRecentReactions())
  rpc.register('messages.getEmojiStickers', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getEmojiStickers())
  rpc.register('messages.getCustomEmojiDocuments', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getCustomEmojiDocuments(
      req as tl.messages.RawGetCustomEmojiDocumentsRequest,
    )))
  rpc.register('messages.sendReaction', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendReaction(req as tl.messages.RawSendReactionRequest))
  rpc.register('messages.getMessagesReactions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessagesReactions(req as tl.messages.RawGetMessagesReactionsRequest))
  rpc.register('messages.getMessageReactionsList', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessageReactionsList(
      req as tl.messages.RawGetMessageReactionsListRequest,
    ))

  // ── Contacts / users ──
  rpc.register('contacts.block', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const change = await state.dialogs.blockPeer(req as tl.contacts.RawBlockRequest)
    if (change?.changed) {
      await updates.publishPeerBlocked(
        state.session, change.userId, true, change.row?.blockedAt ?? new Date(),
      )
    }
    return { _: 'boolTrue' }
  })
  rpc.register('contacts.unblock', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const change = await state.dialogs.unblockPeer(req as tl.contacts.RawUnblockRequest)
    if (change?.changed) {
      await updates.publishPeerBlocked(
        state.session, change.userId, false, change.row?.blockedAt ?? new Date(),
      )
    }
    return { _: 'boolTrue' }
  })
  rpc.register('contacts.getBlocked', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getBlocked(req as tl.contacts.RawGetBlockedRequest))
  rpc.register('contacts.getContacts', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getContacts())
  rpc.register('contacts.search', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.searchContacts(req as tl.contacts.RawSearchRequest))
  rpc.register('contacts.resolveUsername', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.resolveUsername(req as tl.contacts.RawResolveUsernameRequest))
  rpc.register('users.getUsers', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getUsers(req as tl.users.RawGetUsersRequest)))
  rpc.register('users.getFullUser', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullUser(req as tl.users.RawGetFullUserRequest))
  rpc.register('messages.getPeerSettings', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getPeerSettings(req as tl.messages.RawGetPeerSettingsRequest))
  rpc.register('channels.getFullChannel', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullChannel(req as tl.channels.RawGetFullChannelRequest))
  rpc.register('channels.getChannels', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannels(req as tl.channels.RawGetChannelsRequest))
  rpc.register('channels.readHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.readChannelHistory(
      req as tl.channels.RawReadHistoryRequest, rpc.connection,
    ))
  rpc.register('channels.readMessageContents', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return state.dialogs.readChannelMessageContents(
      req as tl.channels.RawReadMessageContentsRequest,
      rpc.connection,
      (session, conversation, tlMessageIds, topMsgId, excludeConnection) => updates.publishMentionRead(
        session, conversation, tlMessageIds, topMsgId, excludeConnection,
      ),
    )
  })
  rpc.register('channels.getParticipant', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelParticipant(req as tl.channels.RawGetParticipantRequest))
  rpc.register('channels.getParticipants', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelParticipants(req as tl.channels.RawGetParticipantsRequest))
  rpc.register('channels.editAdmin', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.editChannelAdmin(req as tl.channels.RawEditAdminRequest))
  rpc.register('channels.getSendAs', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getSendAs(req as tl.channels.RawGetSendAsRequest))
  rpc.register('messages.getForumTopics', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getForumTopics(req as tl.messages.RawGetForumTopicsRequest))
  rpc.register('messages.getForumTopicsByID', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getForumTopics(req as tl.messages.RawGetForumTopicsByIDRequest))
  rpc.register('channels.getForumTopics', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getLegacyForumTopics(req as LegacyGetForumTopicsRequest))
  rpc.register('channels.getForumTopicsByID', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getLegacyForumTopics(req as LegacyGetForumTopicsByIdRequest))
  rpc.register('messages.getReplies', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getReplies(req as tl.messages.RawGetRepliesRequest))
  rpc.register('channels.toggleViewForumAsMessages', async () => ({
    _: 'updates', updates: [], users: [], chats: [], date: Math.floor(Date.now() / 1000), seq: 0,
  } as tl.RawUpdates))

  // ── Voice calls (transient; never journaled) ──
  rpc.register('messages.getDhConfig', async (rpc, req) => {
    await requireBridgeSession(rpc)
    return voice.getDhConfig(req as tl.messages.RawGetDhConfigRequest)
  })
  rpc.register('phone.getCallConfig', async (rpc) => {
    await requireBridgeSession(rpc)
    return voice.getCallConfig()
  })
  rpc.register('phone.requestCall', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return voice.request(
      state.platform, state.session, req as tl.phone.RawRequestCallRequest,
      rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
  })
  rpc.register('phone.receivedCall', async (rpc, req) => {
    bridgeLogger.info('phone.receivedCall reached')
    const state = await requireBridgeSession(rpc)
    return voice.received(
      state.session, req as tl.phone.RawReceivedCallRequest,
      rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
  })
  rpc.register('phone.acceptCall', async (rpc, req) => {
    bridgeLogger.info('phone.acceptCall reached')
    const state = await requireBridgeSession(rpc)
    return voice.accept(
      state.session, req as tl.phone.RawAcceptCallRequest,
      rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
      rpc.afterResponse,
    )
  })
  rpc.register('phone.confirmCall', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return voice.confirm(
      state.session, req as tl.phone.RawConfirmCallRequest,
      rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
  })
  rpc.register('phone.discardCall', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return voice.discard(
      state.session, req as tl.phone.RawDiscardCallRequest,
      rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
  })
  rpc.register('phone.sendSignalingData', async (rpc, req) =>
    voice.sendSignalingData((await requireBridgeSession(rpc)).session, req as tl.phone.RawSendSignalingDataRequest))
  rpc.register('phone.saveCallDebug', async (rpc, req) =>
    voice.saveCallDebug((await requireBridgeSession(rpc)).session, req as tl.phone.RawSaveCallDebugRequest))

  // ── Updates ──
  rpc.register('updates.getState', async (rpc) =>
    updates.getState((await requireBridgeSession(rpc)).session.platformSessionId))

  rpc.register('updates.getDifference', async (rpc, req) =>
    updates.getDifference(
      (await requireBridgeSession(rpc)).session.platformSessionId,
      req as tl.updates.RawGetDifferenceRequest,
    ))
  rpc.register('updates.getChannelDifference', async (rpc, req) =>
    updates.getChannelDifference(
      (await requireBridgeSession(rpc)).session.platformSessionId,
      req as tl.updates.RawGetChannelDifferenceRequest,
    ))

  // ── Post-login misc (keep the client's initial sync from stalling) ──
  // Official Telegram Android still sends the parameterless #800fd57d form.
  // An empty remote list preserves the app's bundled language packs.
  rpc.register('langpack.getLanguages', async () => bareVector([]))
  // Both the public and Android-internal registerDevice forms are advisory for
  // this bridge; accepting them prevents push registration probes from stalling
  // the rest of an Android msg_container.
  rpc.register('account.registerDevice', async (rpc) => {
    await requireBridgeSession(rpc)
    return { _: 'boolTrue' }
  })
  rpc.register('account.updateStatus', async () => ({ _: 'boolTrue' } as unknown as tl.TlObject))
  rpc.register('account.getNotifySettings', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getNotifySettings(
      req as tl.account.RawGetNotifySettingsRequest,
    ))
  rpc.register('account.updateNotifySettings', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const changed = await state.dialogs.updateNotifySettings(
      req as tl.account.RawUpdateNotifySettingsRequest,
    )
    await updates.publishNotification(state.session, [{
      _: 'updateNotifySettings', peer: changed.peer, notifySettings: changed.settings,
    }], rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined)
    return { _: 'boolTrue' }
  })
  rpc.register('account.resetNotifySettings', async (rpc) => {
    const state = await requireBridgeSession(rpc)
    const changed = await state.dialogs.resetNotifySettings()
    await updates.publishNotification(
      state.session, changed, rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
    return { _: 'boolTrue' }
  })
  rpc.register('account.getNotifyExceptions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getNotifyExceptions(
      req as tl.account.RawGetNotifyExceptionsRequest,
    ))
  rpc.register('help.getCountriesList', async () => ({
    _: 'help.countriesList', countries: [], hash: 0,
  } as unknown as tl.TlObject))
  rpc.register('messages.getDialogFilters', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getDialogFilters())
  rpc.register('messages.getSuggestedDialogFilters', async (rpc) => {
    await requireBridgeSession(rpc)
    return bareVector([])
  })
  rpc.register('messages.updateDialogFilter', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const update = await state.dialogs.updateDialogFilter(
      req as tl.messages.RawUpdateDialogFilterRequest,
    )
    await updates.publishAccountUpdates(
      state.session, [update], rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
    return { _: 'boolTrue' }
  })
  rpc.register('messages.updateDialogFiltersOrder', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const update = await state.dialogs.updateDialogFiltersOrder(
      req as tl.messages.RawUpdateDialogFiltersOrderRequest,
    )
    await updates.publishAccountUpdates(
      state.session, [update], rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
    return { _: 'boolTrue' }
  })
  rpc.register('folders.editPeerFolders', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const result = await state.dialogs.editPeerFolders(req as tl.folders.RawEditPeerFoldersRequest)
    await updates.publishAccountUpdates(
      state.session, result.updates, rpc.authKeyId ? authKeyHex(rpc.authKeyId) : undefined,
    )
    return result
  })
  rpc.register('auth.resendCode', async (_rpc, req) => {
    const phone = normPhone((req as unknown as { phoneNumber: string }).phoneNumber)
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: phone })
    if (!auth) throw new RpcError(400, 'PHONE_NUMBER_UNOCCUPIED')
    return {
      _: 'auth.sentCode', flags: 0,
      type: { _: 'auth.sentCodeTypeApp', length: 6 },
      phoneCodeHash: `hash_${auth.id}`,
    } as unknown as tl.TlObject
  })
  // A QR token belongs to the permanent auth key that requested it. An SSO
  // account-list user can approve it once; the Desktop poll then receives login success.
  rpc.register('auth.exportLoginToken', async (rpc) => {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const claim = loginTokens.claimApprovedForAuthKey(rpc.authKeyId)
    if (claim) {
      try {
        const authorization = await authorizePlatformSession(rpc, claim.identity)
        loginTokens.commit(claim)
        return { _: 'auth.loginTokenSuccess', authorization } as unknown as tl.TlObject
      } catch (error) {
        loginTokens.rollback(claim)
        throw error
      }
    }
    try {
      const token = loginTokens.issue(rpc.authKeyId, undefined, rpc.connection.remoteAddress)
      return {
        _: 'auth.loginToken',
        expires: Math.floor(Date.now() / 1000) + 60,
        token,
      } as unknown as tl.TlObject
    } catch (error) {
      if (error instanceof LoginTokenSourceLimitError) throw new RpcError(420, 'FLOOD_WAIT_60')
      if (error instanceof LoginTokenStoreFullError) throw new RpcError(500, 'AUTH_TOKEN_RETRY')
      throw error
    }
  })
  rpc.register('auth.importLoginToken', async (rpc, req) => {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const token = (req as unknown as { token: Uint8Array }).token
    const claim = loginTokens.claim(token, rpc.authKeyId)
    if (!claim) throw new RpcError(400, 'AUTH_TOKEN_INVALID')
    try {
      const authorization = await authorizePlatformSession(rpc, claim.identity)
      loginTokens.commit(claim)
      return { _: 'auth.loginTokenSuccess', authorization } as unknown as tl.TlObject
    } catch (error) {
      loginTokens.rollback(claim)
      throw error
    }
  })

  for (const [method, handler] of Object.entries(startupRpcHandlers)) {
    rpc.register(method, async () => handler())
  }
  for (const [method, handler] of Object.entries(androidRpcHandlers)) {
    rpc.register(method, async (rpc, request) => {
      await requireBridgeSession(rpc)
      return handler(request)
    })
  }

  ctx.mtproto.broadcastUpdate({
    _: 'updateShort', update: { _: 'updateConfig' }, date: Math.floor(Date.now() / 1000),
  })
  ctx.logger('bridge').info('bridge backend registered (platforms: %s)', registry.ids.join(', '))
}

/** Normalize a phone to digits only — clients send '+' for sendCode but not for signIn. */
function normPhone(p: string): string {
  return p.replace(/\D/g, '')
}

/** Completes a new authorization only after its binding can receive transient replays. */
export async function finalizeAuthorizedSession(
  rpc: ServerRpcContext,
  state: BridgeSessionState,
  persistBinding: () => Promise<unknown>,
  resolveSession: (rpc: ServerRpcContext) => Promise<BridgeSessionState>,
): Promise<void> {
  await persistBinding()
  rpc.setPlatformData(state)
  await resolveSession(rpc)
}

export function createSessionResolver(
  ctx: Context,
  registry: PlatformRegistry,
  stickerRpcFor: (platform: IMPlatform, session: PlatformSession) => StickerRpc,
  reactionRpcFor: (platform: IMPlatform, session: PlatformSession) => ReactionRpc,
  resources: TelegramResourceService,
  store: MessageStore,
  drafts: DraftStore,
  notificationSettings: NotificationSettingsStore,
  blockedPeers: BlockedPeerStore,
  dialogFolders: DialogFolderStore,
  subscriptions: PlatformSubscriptionManager,
  uploads: UploadManager,
  systemPeers: SystemPeerService,
  generation: object,
  onDraftUpdate: (
    session: PlatformSession,
    update: tl.RawUpdateDraftMessage,
    excludeAuthKeyId?: string,
  ) => Promise<void>,
  onTransferProgress?: BridgeConfig['onTransferProgress'],
  dcId = 1,
  historyTrace?: (format: string, ...args: unknown[]) => void,
  onAuthorizedSession?: (
    session: PlatformSession,
    authKeyId: string,
    rpc: ServerRpcContext,
  ) => void | Promise<void>,
  conversationViews?: ConversationViewService,
) {
  const loading = new Map<string, Promise<BridgeSessionState>>()
  const authorizedConnections = new WeakSet<object>()
  const authorizingConnections = new WeakMap<object, Promise<void>>()
  const notifyAuthorizedSession = async (session: PlatformSession, rpc: ServerRpcContext): Promise<void> => {
    if (!onAuthorizedSession || !rpc.authKeyId || authorizedConnections.has(rpc.connection)) return
    const pending = authorizingConnections.get(rpc.connection)
    if (pending) return pending
    const authorizing = (async () => {
      await onAuthorizedSession(session, authKeyHex(rpc.authKeyId), rpc)
      authorizedConnections.add(rpc.connection)
    })()
    authorizingConnections.set(rpc.connection, authorizing)
    try {
      await authorizing
    } finally {
      if (authorizingConnections.get(rpc.connection) === authorizing) authorizingConnections.delete(rpc.connection)
    }
  }

  return async (
    rpc: ServerRpcContext,
    provisionalIdentity?: { platformId: string, platformSessionId: string },
    cache = true,
  ): Promise<BridgeSessionState> => {
    const cached = cache ? rpc.getPlatformData<BridgeSessionState | null>() : undefined
    if (
      cached?.generation === generation
      && registry.get(cached.session.platformId) === cached.platform
    ) {
      await notifyAuthorizedSession(cached.session, rpc)
      return cached
    }
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')

    const authKeyId = authKeyHex(rpc.authKeyId)
    const makeState = async (
      identity: { platformId: string, platformSessionId: string },
      notify = true,
    ) => {
      const platform = registry.get(identity.platformId)
      if (!platform) throw new RpcError(500, 'PLATFORM_NOT_AVAILABLE')
      const [row] = await ctx.database.get('mtproto_platform_session', {
        id: identity.platformSessionId,
        active: true,
      })
      if (!row) throw new RpcError(401, 'PLATFORM_SESSION_REVOKED')
      const [auth] = await ctx.database.get('mtproto_auth_session', {
        platformId: identity.platformId, platformSessionId: identity.platformSessionId,
      })
      if (!auth) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
      const session = sessionFromRow(row, auth.virtualPhone)
      const selfRow = await store.getUser(session.platformId, session.userId)
        ?? await store.upsertUser(session, {
          id: session.userId,
          firstName: (row.metadata.firstName as string) ?? 'Bridge',
          lastName: row.metadata.lastName as string | undefined,
          username: row.metadata.username as string | undefined,
          metadata: row.metadata,
        })
      await subscriptions.ensure(session)
      if (notify) await notifyAuthorizedSession(session, rpc)
      const state: BridgeSessionState = {
        generation, platform, session,
        stickers: stickerRpcFor(platform, session),
        dialogs: undefined as never,
      }
      state.dialogs = new DialogRpc(
        platform, session, store, uploads, onTransferProgress, dcId, state.stickers,
        reactionRpcFor(platform, session),
        resources,
        (localSession, event, options) => subscriptions.ingestLocalEvent(localSession, event, options),
        authKeyId,
        historyTrace,
        drafts,
        onDraftUpdate,
        notificationSettings,
        selfRow.id,
        blockedPeers,
        dialogFolders,
        systemPeers,
        conversationViews,
      )
      return state
    }

    if (!cache) {
      if (!provisionalIdentity) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
      return makeState(provisionalIdentity, false)
    }

    while (true) {
      let pending = loading.get(authKeyId)
      if (!pending) {
        pending = (async () => {
          const [binding] = await ctx.database.get('mtproto_auth_binding', { authKeyId })
          if (!binding) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
          return makeState(binding)
        })()
        loading.set(authKeyId, pending)
        pending.finally(() => {
          if (loading.get(authKeyId) === pending) loading.delete(authKeyId)
        }).catch(() => {})
      }

      const state = await pending
      if (registry.get(state.session.platformId) !== state.platform) {
        if (loading.get(authKeyId) === pending) loading.delete(authKeyId)
        continue
      }
      rpc.setPlatformData(state)
      await notifyAuthorizedSession(state.session, rpc)
      return state
    }
  }
}

function authKeyHex(authKeyId: Uint8Array): string {
  let result = ''
  for (const byte of authKeyId) result += byte.toString(16).padStart(2, '0')
  return result
}
