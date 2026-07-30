import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import Long from 'long'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { RpcError, bareVector, type ServerRpcContext } from '@mtproto-relay/mtproto'
import type { IMPlatform, PlatformSession } from './platform.js'
import { defineModels } from './models.js'
import { makeConfig, makeAppConfig, makeUser } from './synthetic.js'
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
import { PlatformAccountProvisioner, type ProvisionedPlatformAccount } from './platform-account.js'
import { verifyLoginCode } from './login-code.js'
import { DraftStore } from './draft-store.js'
import { NotificationSettingsStore } from './notification-settings.js'
import {
  makePlatformAccountView, makeUnavailableAccountView,
  type PlatformAccountDashboardData,
} from './account-dashboard.js'
import { AuthTransferStore } from './auth-transfer.js'
import { BlockedPeerStore, type BlockedContentMode } from './blocked-peers.js'
import { DialogFolderStore } from './dialog-folders.js'
import {
  collectStickerDashboard, setStickerPackAssignment,
  type StickerDashboardPack, type StickerDashboardSourceAccount, type StickerPackDashboardData,
} from './sticker-dashboard.js'

export * from './platform.js'
export * from './message-store.js'
export * from './message-actions.js'
export * from './platform-manager.js'
export * from './upload-manager.js'
export * from './update-manager.js'
export * from './update-journal.js'
export * from './sticker-provider.js'
export * from './sticker-rpc.js'
export * from './reaction-rpc.js'
export * from './resource-provider.js'
export * from './login-code.js'
export * from './draft-store.js'
export * from './platform-account.js'
export * from './account-dashboard.js'
export * from './auth-transfer.js'
export * from './blocked-peers.js'
export * from './dialog-folders.js'
export * from './stripped-thumbnail.js'
export * from './sticker-outline.js'
export * from './sticker-dashboard.js'

export const name = 'mtproto-bridge'
export const inject = ['mtproto', 'database', 'model', 'server', 'webui']

export interface BridgeConfig {
  dcId?: number
  serverHost?: string
  serverPort?: number
  /** HTTP prefix for platform account assets (default: /api). */
  apiPrefix?: string
  uploadPath?: string
  /** Mute group chats by default unless the Telegram user explicitly enables them. */
  autoMuteGroupChats?: boolean
  /** Visibility policy for users blocked through Telegram. */
  blockedContentMode?: BlockedContentMode
  onTransferProgress?: (session: PlatformSession, progress: import('./platform.js').IMTransferProgress) => void | Promise<void>
}

export const Config = z.object({
  dcId: z.natural().min(1).max(6).default(1),
  serverHost: z.string().default('127.0.0.1'),
  serverPort: z.natural().min(1).max(65_535).default(4430),
  apiPrefix: z.string().default('/api'),
  uploadPath: z.string().default('data/bridge-uploads'),
  autoMuteGroupChats: z.boolean().default(true),
  blockedContentMode: z.union([
    z.const('show'), z.const('hide-user'), z.const('hide-related'),
  ]).default('hide-user'),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

interface BridgeSessionState {
  generation: object
  platform: IMPlatform
  session: PlatformSession
  dialogs: DialogRpc
  stickers: StickerRpc
}

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

  defineModels(ctx)
  const store = new MessageStore(ctx.database, undefined, undefined, historyTrace)
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
  const stickerRpcFor = (platform: IMPlatform, session: PlatformSession): StickerRpc => {
    const key = `${session.platformId}\u0000${session.platformSessionId}`
    const cached = stickerRpcs.get(key)
    if (cached?.platform === platform) return cached.rpc
    const rpc = new StickerRpc(ctx.database, stickerProviders.registry, platform, session, dcId)
    stickerRpcs.set(key, { platform, rpc })
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
  )
  const subscriptions = new PlatformSubscriptionManager(
    ctx.database,
    registry,
    store,
    (error, session) => bridgeLogger.warn(
      'platform subscription failed platform=%s session=%s error=%s',
      session?.platformId ?? 'unknown', session?.platformSessionId ?? 'unknown',
      error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error),
    ),
    (session, event, options) => updates.publish(session, event, options),
    (format, ...args) => bridgeLogger.debug(format, ...args),
  )
  const requireBridgeSession = createSessionResolver(
    ctx, registry, stickerRpcFor, resources, store, drafts, notificationSettings, blockedPeers,
    dialogFolders,
    subscriptions, uploads, generation,
    (localSession, update, excludeAuthKeyId) => updates.publishDraft(
      localSession, update, excludeAuthKeyId,
    ),
    config.onTransferProgress, dcId, historyTrace,
  )

  const accountProvisioner = new PlatformAccountProvisioner(ctx.database)
  const provisionedAccounts = new Map<string, ProvisionedPlatformAccount>()
  const accountErrors = new Map<string, unknown>()
  let publishedStickerPacks: StickerDashboardPack[] = []
  const dashboard: PlatformAccountDashboardData & StickerPackDashboardData = {
    accounts: [],
    updatedAt: Date.now(),
    stickerAccounts: [],
    stickerPacks: [],
    stickerUpdatedAt: Date.now(),
    async refresh() {
      await ctx.database.prepared()
      await Promise.allSettled(registry.ids.map(platformId => provision(platformId)))
      publishAccounts()
      await publishStickerPacks()
    },
    async refreshStickerPacks() {
      await ctx.database.prepared()
      await publishStickerPacks()
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
    routes: ['/platform-accounts', '/sticker-packs'],
  }, dashboard)

  const publishAccounts = (now = Date.now()) => {
    dashboardEntry.mutate((value) => {
      value.updatedAt = now
      value.accounts = registry.ids.sort().map((platformId) => {
        const platform = registry.require(platformId)
        const kind = platform.platformKind ?? platformId
        const account = provisionedAccounts.get(platformId)
        if (account) return makePlatformAccountView(platformId, kind, account, apiPrefix, now)
        if (!platform.getAccount) return makeUnavailableAccountView(platformId, kind, 'unsupported')
        const error = accountErrors.get(platformId)
        return makeUnavailableAccountView(platformId, kind, error ? 'error' : 'loading', error)
      })
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

  const provision = async (platformId: string) => {
    const platform = registry.get(platformId)
    if (!platform?.getAccount) return
    try {
      const provisioned = await accountProvisioner.provision(platformId, platform)
      if (!provisioned) return
      provisionedAccounts.set(platformId, provisioned)
      accountErrors.delete(platformId)
      publishAccounts()
      await subscriptions.ensure(provisioned.session)
    } catch (error) {
      provisionedAccounts.delete(platformId)
      accountErrors.set(platformId, error)
      publishAccounts()
      throw error
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => publishAccounts(), 1_000)
    return () => clearInterval(timer)
  }, 'mtproto-bridge.account-codes')

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

  platforms.onChange((event, platformId) => {
    if (event === 'register') {
      ctx.logger('bridge').info('IM platform registered: %s', platformId)
      void ctx.database.prepared()
        .then(async () => {
          await store.prepareDialogCache()
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
    await store.prepareDialogCache()
    // Delivery rows from pre-memory-journal versions are no longer used.
    await ctx.database.remove('mtproto_update_delivery', {})
    await Promise.all(registry.ids.map(platformId => provision(platformId)))
    await publishStickerPacks()
    await subscriptions.startActiveSessions()
    return () => subscriptions.stop()
  })

  // ── Synthetic / config ──
  ctx.mtproto.register('help.getConfig', async () => makeConfig(dcId, config.serverHost, config.serverPort))
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
    const [ps] = await ctx.database.get('mtproto_platform_session', { id: auth.platformSessionId })
    if (!ps) throw new RpcError(500, 'PLATFORM_SESSION_NOT_FOUND')

    const session = sessionFromRow(ps)
    const platform = registry.get(ps.platformId)
    if (!platform) throw new RpcError(500, 'PLATFORM_NOT_AVAILABLE')
    if (!rpc.authKeyId) throw new RpcError(500, 'AUTH_KEY_ID_MISSING')
    await ctx.database.upsert('mtproto_auth_binding', [{
      authKeyId: authKeyHex(rpc.authKeyId),
      platformId: ps.platformId,
      platformSessionId: ps.id,
    }])
    const selfRow = await store.getUser(session.platformId, session.userId)
      ?? await store.upsertUser(session, {
        id: session.userId,
        firstName: (ps.metadata.firstName as string) ?? 'Bridge',
        lastName: ps.metadata.lastName as string | undefined,
        username: ps.metadata.username as string | undefined,
        metadata: ps.metadata,
      })
    const state: BridgeSessionState = {
      generation, platform, session,
      stickers: stickerRpcFor(platform, session),
      dialogs: undefined as never,
    }
    state.dialogs = new DialogRpc(
      platform, session, store, uploads, config.onTransferProgress, dcId, state.stickers,
      new ReactionRpc(platform, session, dcId, ctx.database),
      resources,
      (localSession, event, options) => subscriptions.ingestLocalEvent(localSession, event, options),
      authKeyHex(rpc.authKeyId),
      historyTrace,
      drafts,
      (localSession, update, excludeAuthKeyId) => updates.publishDraft(
        localSession, update, excludeAuthKeyId,
      ),
      notificationSettings,
      selfRow.id,
      blockedPeers,
      dialogFolders,
    )
    rpc.setPlatformData(state)
    await subscriptions.ensure(session)

    const user = makeUser({
      id: selfRow.id,
      self: true,
      premium: true,
      firstName: (ps.metadata.firstName as string) ?? 'Bridge',
      lastName: ps.metadata.lastName as string | undefined,
      username: ps.metadata.username as string | undefined,
      phone: phoneNumber,
    })
    return { _: 'auth.authorization', flags: 0, setupPasswordRequired: false, user } as unknown as tl.TlObject
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

    const [platformSession] = await ctx.database.get('mtproto_platform_session', {
      id: identity.platformSessionId,
      platformId: identity.platformId,
      active: true,
    })
    if (!platformSession) throw new RpcError(401, 'PLATFORM_SESSION_REVOKED')
    const [authSession] = await ctx.database.get('mtproto_auth_session', {
      platformId: identity.platformId,
      platformSessionId: identity.platformSessionId,
    })
    if (!authSession) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')

    await ctx.database.upsert('mtproto_auth_binding', [{
      authKeyId: authKeyHex(rpc.authKeyId),
      ...identity,
    }])
    const { session } = await requireBridgeSession(rpc)
    const metadata = platformSession.metadata
    const selfRow = await store.getUser(session.platformId, session.userId)
      ?? await store.upsertUser(session, {
        id: session.userId,
        firstName: (metadata.firstName as string) ?? 'Bridge',
        lastName: metadata.lastName as string | undefined,
        username: metadata.username as string | undefined,
        metadata,
      })
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
    (await requireBridgeSession(rpc)).dialogs.forwardMessages(req as tl.messages.RawForwardMessagesRequest))
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
  rpc.register('contacts.resolveUsername', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.resolveUsername(req as tl.contacts.RawResolveUsernameRequest))
  rpc.register('users.getUsers', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getUsers(req as tl.users.RawGetUsersRequest)))
  rpc.register('users.getFullUser', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullUser(req as tl.users.RawGetFullUserRequest))
  rpc.register('messages.getPeerSettings', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getPeerSettings(req as tl.messages.RawGetPeerSettingsRequest))
  rpc.register('messages.getFullChat', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullChat(req as tl.messages.RawGetFullChatRequest))
  rpc.register('channels.getFullChannel', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullChannel(req as tl.channels.RawGetFullChannelRequest))
  rpc.register('channels.getChannels', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannels(req as tl.channels.RawGetChannelsRequest))
  rpc.register('channels.readHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.readChannelHistory(
      req as tl.channels.RawReadHistoryRequest, rpc.connection,
    ))
  rpc.register('channels.readMessageContents', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.readChannelMessageContents(
      req as tl.channels.RawReadMessageContentsRequest,
    ))
  rpc.register('channels.getParticipant', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelParticipant(req as tl.channels.RawGetParticipantRequest))
  rpc.register('channels.getParticipants', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelParticipants(req as tl.channels.RawGetParticipantsRequest))
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
  // Telegram Desktop probes QR login before the user has selected a phone
  // account, so this one response remains shared until a route is bound.
  ctx.mtproto.register('auth.exportLoginToken', async () => ({
    _: 'auth.loginToken',
    expires: Math.floor(Date.now() / 1000) + 60,
    token: randomBytes(32),
  } as unknown as tl.TlObject))

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

function createSessionResolver(
  ctx: Context,
  registry: PlatformRegistry,
  stickerRpcFor: (platform: IMPlatform, session: PlatformSession) => StickerRpc,
  resources: TelegramResourceService,
  store: MessageStore,
  drafts: DraftStore,
  notificationSettings: NotificationSettingsStore,
  blockedPeers: BlockedPeerStore,
  dialogFolders: DialogFolderStore,
  subscriptions: PlatformSubscriptionManager,
  uploads: UploadManager,
  generation: object,
  onDraftUpdate: (
    session: PlatformSession,
    update: tl.RawUpdateDraftMessage,
    excludeAuthKeyId?: string,
  ) => Promise<void>,
  onTransferProgress?: BridgeConfig['onTransferProgress'],
  dcId = 1,
  historyTrace?: (format: string, ...args: unknown[]) => void,
) {
  const loading = new Map<string, Promise<BridgeSessionState>>()

  return async (rpc: ServerRpcContext): Promise<BridgeSessionState> => {
    const cached = rpc.getPlatformData<BridgeSessionState | null>()
    if (
      cached?.generation === generation
      && registry.get(cached.session.platformId) === cached.platform
    ) return cached
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')

    const authKeyId = authKeyHex(rpc.authKeyId)
    while (true) {
      let pending = loading.get(authKeyId)
      if (!pending) {
        pending = (async () => {
          const [binding] = await ctx.database.get('mtproto_auth_binding', { authKeyId })
          if (!binding) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
          const platform = registry.get(binding.platformId)
          if (!platform) throw new RpcError(500, 'PLATFORM_NOT_AVAILABLE')
          const [row] = await ctx.database.get('mtproto_platform_session', {
            id: binding.platformSessionId,
            active: true,
          })
          if (!row) throw new RpcError(401, 'PLATFORM_SESSION_REVOKED')
          const session = sessionFromRow(row)
          const selfRow = await store.getUser(session.platformId, session.userId)
            ?? await store.upsertUser(session, {
              id: session.userId,
              firstName: (row.metadata.firstName as string) ?? 'Bridge',
              lastName: row.metadata.lastName as string | undefined,
              username: row.metadata.username as string | undefined,
              metadata: row.metadata,
            })
          await subscriptions.ensure(session)
          const state: BridgeSessionState = {
            generation, platform, session,
            stickers: stickerRpcFor(platform, session),
            dialogs: undefined as never,
          }
          state.dialogs = new DialogRpc(
            platform, session, store, uploads, onTransferProgress, dcId, state.stickers,
            new ReactionRpc(platform, session, dcId, ctx.database),
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
          )
          return state
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
      return state
    }
  }
}

function authKeyHex(authKeyId: Uint8Array): string {
  let result = ''
  for (const byte of authKeyId) result += byte.toString(16).padStart(2, '0')
  return result
}
