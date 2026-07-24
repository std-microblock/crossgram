import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import Long from 'long'
import z from 'schemastery'
import { RpcError, bareVector, type ServerRpcContext } from '@mtproto-relay/mtproto'
import type { IMPlatform, PlatformSession } from './platform.js'
import { defineModels } from './models.js'
import { makeConfig, makeAppConfig, makeUser } from './synthetic.js'
import { DialogRpc, stableId } from './dialogs.js'
import { startupRpcHandlers } from './startup.js'
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
import {
  makePlatformAccountView, makeUnavailableAccountView,
  type PlatformAccountDashboardData,
} from './account-dashboard.js'

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
export * from './platform-account.js'
export * from './account-dashboard.js'

export const name = 'mtproto-bridge'
export const inject = ['mtproto', 'database', 'model', 'server', 'webui']

export interface BridgeConfig {
  /** Account route exposed to the MTProto service (default: bridge:default). */
  routeId?: string
  dcId?: number
  serverHost?: string
  serverPort?: number
  /** HTTP prefix for platform account assets (default: /api). */
  apiPrefix?: string
  uploadPath?: string
  onTransferProgress?: (session: PlatformSession, progress: import('./platform.js').IMTransferProgress) => void | Promise<void>
}

export const Config = z.object({
  routeId: z.string().default('bridge:default')
    .description('Account route exposed to the MTProto service.'),
  dcId: z.natural().min(1).max(6).default(1)
    .description('Telegram data-center ID advertised by the bridge.'),
  serverHost: z.string().default('127.0.0.1')
    .description('Public MTProto host advertised to Telegram clients.'),
  serverPort: z.natural().min(1).max(65_535).default(4430)
    .description('Public MTProto port advertised to Telegram clients.'),
  apiPrefix: z.string().default('/api')
    .description('HTTP prefix used for platform account assets.'),
  uploadPath: z.string().default('data/bridge-uploads')
    .description('Directory used to store uploads received from Telegram clients.'),
})

interface BridgeSessionState {
  generation: object
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
  const routeId = config.routeId ?? 'bridge:default'
  const rpc = ctx.mtproto.route(routeId)
  const dcId = config.dcId ?? 1
  const apiPrefix = (config.apiPrefix ?? '/api').replace(/\/$/, '')
  const bridgeLogger = ctx.logger('bridge')

  defineModels(ctx)
  const store = new MessageStore(ctx.database)
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
    (authKeyId, update) => ctx.mtproto.sendUpdateToAuthKey(authKeyId, update),
    dcId,
    (format, ...args) => bridgeLogger.info(format, ...args),
    (session, sticker) => stickerRpcFor(registry.require(session.platformId), session)
      .makeMessageMedia(sticker),
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
    (session, event) => updates.publish(session, event),
    (format, ...args) => bridgeLogger.info(format, ...args),
  )
  const requireBridgeSession = createSessionResolver(
    ctx, registry, stickerRpcFor, resources, store, subscriptions, uploads, generation,
    config.onTransferProgress, dcId,
  )

  const accountProvisioner = new PlatformAccountProvisioner(ctx.database)
  const provisionedAccounts = new Map<string, ProvisionedPlatformAccount>()
  const accountErrors = new Map<string, unknown>()
  const dashboard: PlatformAccountDashboardData = {
    accounts: [],
    updatedAt: Date.now(),
    async refresh() {
      await ctx.database.prepared()
      await Promise.allSettled(registry.ids.map(platformId => provision(platformId)))
      publishAccounts()
    },
  }
  const dashboardEntry = ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/platform-accounts'],
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

  ctx.mtproto.resolveRoute(async (requestContext, request) => {
    if (requestContext.authKeyId) {
      const [binding] = await ctx.database.get('mtproto_route_binding', {
        authKeyId: authKeyHex(requestContext.authKeyId),
      })
      if (binding) return binding.routeId
    }
    if (request._ !== 'auth.sendCode' && request._ !== 'auth.signIn') return
    const phoneNumber = (request as unknown as { phoneNumber?: string }).phoneNumber
    if (!phoneNumber) return
    const [auth] = await ctx.database.get('mtproto_auth_session', {
      virtualPhone: normPhone(phoneNumber),
    })
    return auth ? routeId : undefined
  })

  platforms.onChange((event, platformId) => {
    if (event === 'register') {
      ctx.logger('bridge').info('IM platform registered: %s', platformId)
      void ctx.database.prepared()
        .then(async () => {
          const migrated = await migrateQualifiedPlatformIds(ctx.database, platformId)
          if (migrated) ctx.logger('bridge').info('migrated %d qualified platform sessions to %s', migrated, platformId)
          await provision(platformId)
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
      void subscriptions.stopPlatform(platformId).catch((error) => ctx.logger('bridge').warn(
        'failed to stop platform sessions (%s): %s', platformId, String(error),
      ))
    }
  })

  ctx.effect(async () => {
    await ctx.database.prepared()
    // Delivery rows from pre-memory-journal versions are no longer used.
    await ctx.database.remove('mtproto_update_delivery', {})
    await Promise.all(registry.ids.map(platformId => provision(platformId)))
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
    await ctx.database.upsert('mtproto_route_binding', [{
      authKeyId: authKeyHex(rpc.authKeyId),
      routeId,
      createdAt: new Date(),
    }])
    ctx.mtproto.bindRoute(rpc.authKeyId, routeId)
    const state: BridgeSessionState = {
      generation, session,
      stickers: stickerRpcFor(platform, session),
      dialogs: undefined as never,
    }
    state.dialogs = new DialogRpc(
      platform, session, store, uploads, config.onTransferProgress, dcId, state.stickers,
      new ReactionRpc(platform, session, dcId),
      resources,
    )
    rpc.setPlatformData(state)
    await subscriptions.ensure(session)

    const user = makeUser({
      id: stableId(`self:${ps.id}`),
      self: true,
      premium: true,
      firstName: (ps.metadata.firstName as string) ?? 'Bridge',
      lastName: ps.metadata.lastName as string | undefined,
      username: ps.metadata.username as string | undefined,
      phone: phoneNumber,
    })
    return { _: 'auth.authorization', flags: 0, setupPasswordRequired: false, user } as unknown as tl.TlObject
  })

  // ── Messages ──
  rpc.register('messages.getDialogs', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getDialogs(req as tl.messages.RawGetDialogsRequest))
  rpc.register('messages.getHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getHistory(req as tl.messages.RawGetHistoryRequest))
  rpc.register('messages.getMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessages(req as tl.messages.RawGetMessagesRequest))
  rpc.register('messages.search', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.search(req as tl.messages.RawSearchRequest))
  rpc.register('messages.readHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.readHistory(req as tl.messages.RawReadHistoryRequest))
  rpc.register('messages.getScheduledHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getScheduledHistory(req as tl.messages.RawGetScheduledHistoryRequest))
  rpc.register('messages.getPinnedDialogs', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getPinnedDialogs())
  rpc.register('messages.sendMessage', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMessage(req as tl.messages.RawSendMessageRequest))
  rpc.register('messages.sendMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMedia(req as tl.messages.RawSendMediaRequest))
  rpc.register('messages.sendMultiMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMultiMedia(req as tl.messages.RawSendMultiMediaRequest))
  rpc.register('messages.deleteMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.deleteMessages(req as tl.messages.RawDeleteMessagesRequest))
  rpc.register('channels.deleteMessages', async (rpc, req) => {
    const request = req as tl.channels.RawDeleteMessagesRequest
    return (await requireBridgeSession(rpc)).dialogs.deleteMessages(request, request.channel)
  })
  rpc.register('messages.editMessage', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.editMessage(req as tl.messages.RawEditMessageRequest))
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
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(
      (req as tl.messages.RawGetRecentReactionsRequest).limit,
    ))
  rpc.register('messages.getDefaultTagReactions', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(100))
  rpc.register('messages.clearRecentReactions', async (rpc) => {
    await requireBridgeSession(rpc)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
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
  rpc.register('account.updateStatus', async () => ({ _: 'boolTrue' } as unknown as tl.TlObject))
  rpc.register('account.getNotifySettings', async () => ({
    _: 'peerNotifySettings',
  } as unknown as tl.TlObject))
  rpc.register('help.getCountriesList', async () => ({
    _: 'help.countriesList', countries: [], hash: 0,
  } as unknown as tl.TlObject))
  rpc.register('messages.getDialogFilters', async () => ({
    _: 'messages.dialogFilters', flags: 0, filters: [],
  } as unknown as tl.TlObject))
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
  subscriptions: PlatformSubscriptionManager,
  uploads: UploadManager,
  generation: object,
  onTransferProgress?: BridgeConfig['onTransferProgress'],
  dcId = 1,
) {
  const loading = new Map<string, Promise<BridgeSessionState>>()

  return async (rpc: ServerRpcContext): Promise<BridgeSessionState> => {
    const cached = rpc.getPlatformData<BridgeSessionState | null>()
    if (cached?.generation === generation) return cached
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')

    const authKeyId = authKeyHex(rpc.authKeyId)
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
        await subscriptions.ensure(session)
        const state: BridgeSessionState = {
          generation, session,
          stickers: stickerRpcFor(platform, session),
          dialogs: undefined as never,
        }
        state.dialogs = new DialogRpc(
          platform, session, store, uploads, onTransferProgress, dcId, state.stickers,
          new ReactionRpc(platform, session, dcId),
          resources,
        )
        return state
      })()
      loading.set(authKeyId, pending)
      pending.finally(() => loading.delete(authKeyId)).catch(() => {})
    }

    const session = await pending
    rpc.setPlatformData(session)
    return session
  }
}

function authKeyHex(authKeyId: Uint8Array): string {
  let result = ''
  for (const byte of authKeyId) result += byte.toString(16).padStart(2, '0')
  return result
}
