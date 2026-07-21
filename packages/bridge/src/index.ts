import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import Long from 'long'
import { RpcError, bareVector, type ServerRpcContext } from '@mtproto-relay/mtproto'
import type { JsonValue, PlatformSession } from './platform.js'
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

export * from './platform.js'
export * from './message-store.js'
export * from './platform-manager.js'
export * from './upload-manager.js'
export * from './update-manager.js'
export * from './sticker-provider.js'
export * from './sticker-rpc.js'
export * from './reaction-rpc.js'

export const name = 'mtproto-bridge'
export const inject = ['mtproto', 'database', 'model', 'server']

export interface BridgeConfig {
  dcId?: number
  serverHost?: string
  serverPort?: number
  /** HTTP path prefix for the auth API (default: /api). */
  apiPrefix?: string
  uploadPath?: string
  onTransferProgress?: (session: PlatformSession, progress: import('./platform.js').IMTransferProgress) => void | Promise<void>
}

interface BridgeSessionState {
  generation: object
  session: PlatformSession
  dialogs: DialogRpc
  stickers: StickerRpc
}

/**
 * Bridge backend — a native cordis plugin. Translates MTProto RPC to an IM
 * platform. Auth is out-of-band: an HTTP endpoint mints a virtual phone + login
 * code (stored via minato), which the client enters to log in.
 */
export function apply(ctx: Context, config: BridgeConfig = {}): void {
  const generation = {}
  const platforms = new IMPlatformService(ctx)
  const stickerProviders = new IMStickerService(ctx)
  const registry = platforms.registry
  const dcId = config.dcId ?? 1
  const apiPrefix = config.apiPrefix ?? '/api'

  defineModels(ctx)
  const store = new MessageStore(ctx.database)
  const uploads = new UploadManager(resolve(config.uploadPath ?? 'data/bridge-uploads'))
  const updates = new UpdateManager(
    ctx.database, registry, store,
    (authKeyId, update) => ctx.mtproto.sendUpdateToAuthKey(authKeyId, update),
    dcId,
  )
  const subscriptions = new PlatformSubscriptionManager(
    ctx.database,
    registry,
    store,
    (error, session) => ctx.logger('bridge').warn(
      'platform subscription failed (%s): %s', session?.platformId ?? 'unknown', String(error),
    ),
    (session, event) => updates.publish(session, event),
  )
  const requireBridgeSession = createSessionResolver(
    ctx, registry, stickerProviders.registry,
    store, subscriptions, uploads, generation, config.onTransferProgress, dcId,
  )

  platforms.onChange((event, platformId) => {
    if (event === 'register') {
      ctx.logger('bridge').info('IM platform registered: %s', platformId)
      void ctx.database.prepared()
        .then(async () => {
          const migrated = await migrateQualifiedPlatformIds(ctx.database, platformId)
          if (migrated) ctx.logger('bridge').info('migrated %d qualified platform sessions to %s', migrated, platformId)
          await subscriptions.startActiveSessions(platformId)
        })
        .catch((error) => ctx.logger('bridge').warn(
          'failed to start platform sessions (%s): %s', platformId, String(error),
        ))
    } else {
      ctx.logger('bridge').info('IM platform unregistered: %s', platformId)
      void subscriptions.stopPlatform(platformId).catch((error) => ctx.logger('bridge').warn(
        'failed to stop platform sessions (%s): %s', platformId, String(error),
      ))
    }
  })

  ctx.effect(async () => {
    await ctx.database.prepared()
    await subscriptions.startActiveSessions()
    return () => subscriptions.stop()
  })

  // ── HTTP auth: mint a virtual phone + login code for a platform identity ──
  ctx.server.post(`${apiPrefix}/auth/:platform/complete`, async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as {
      credentials?: JsonValue
      metadata?: { firstName?: string, lastName?: string, username?: string, userId?: string }
    }
    const platformId = (req.params as { platform: string }).platform
    if (!registry.get(platformId)) {
      res.status = 404
      res.json({ error: 'platform not available' })
      return
    }
    if (!body.credentials) {
      res.status = 400
      res.json({ error: 'credentials required' })
      return
    }

    const sessionId = randomHex(16)
    const userId = body.metadata?.userId ?? randomHex(8)
    await ctx.database.create('mtproto_platform_session', {
      id: sessionId,
      platformId,
      userId,
      credentials: body.credentials,
      metadata: {
        firstName: body.metadata?.firstName ?? 'User',
        lastName: body.metadata?.lastName,
        username: body.metadata?.username,
      },
      active: true,
      createdAt: new Date(),
    })

    const platformCode = String(platformId.length % 100).padStart(2, '0')
    // Store digits only — clients send the phone with '+' for sendCode but
    // WITHOUT '+' for signIn, so we normalize to digits everywhere.
    const virtualPhone = `999${platformCode}${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`
    const loginCode = String(Math.floor(100000 + Math.random() * 900000))
    await ctx.database.create('mtproto_auth_session', {
      id: randomHex(16),
      virtualPhone,
      loginCode,
      platformId,
      platformSessionId: sessionId,
      used: false,
    })

    res.json({ sessionId, virtualPhone: `+${virtualPhone}`, loginCode, platform: platformId, userId })
  })

  // ── Synthetic / config ──
  ctx.mtproto.register('help.getConfig', async () => makeConfig(dcId, config.serverHost, config.serverPort))
  ctx.mtproto.register('help.getAppConfig', async () => makeAppConfig())
  ctx.mtproto.register('help.getNearestDc', async () => ({
    _: 'nearestDc', country: 'US', thisDc: dcId, nearestDc: dcId,
  } as unknown as tl.TlObject))

  // ── Auth ──
  ctx.mtproto.register('auth.sendCode', async (_rpc, req) => {
    const phone = normPhone((req as unknown as { phoneNumber: string }).phoneNumber)
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: phone })
    if (!auth) throw new RpcError(400, 'PHONE_NUMBER_UNOCCUPIED')
    if (auth.used) throw new RpcError(400, 'AUTH_KEY_ALREADY_REGISTERED')
    return {
      _: 'auth.sentCode',
      flags: 0,
      type: { _: 'auth.sentCodeTypeApp', length: 6 },
      phoneCodeHash: `hash_${auth.id}`,
    } as unknown as tl.TlObject
  })

  ctx.mtproto.register('auth.signIn', async (rpc, req) => {
    const { phoneNumber, phoneCode } = req as unknown as { phoneNumber: string, phoneCode: string }
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: normPhone(phoneNumber) })
    if (!auth) throw new RpcError(400, 'PHONE_NUMBER_UNOCCUPIED')
    if (auth.loginCode !== phoneCode) throw new RpcError(400, 'PHONE_CODE_INVALID')

    await ctx.database.set('mtproto_auth_session', { id: auth.id }, { used: true })
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
    const state: BridgeSessionState = {
      generation, session,
      stickers: new StickerRpc(ctx.database, stickerProviders.registry, platform, session, dcId),
      dialogs: undefined as never,
    }
    state.dialogs = new DialogRpc(
      platform, session, store, uploads, config.onTransferProgress, dcId, state.stickers,
      new ReactionRpc(platform, session, dcId),
    )
    rpc.setPlatformData(state)
    await subscriptions.ensure(session)

    const user = makeUser({
      id: stableId(`self:${ps.id}`),
      self: true,
      premium: true,
      firstName: (ps.metadata.firstName as string) ?? 'Bridge',
      phone: phoneNumber,
    })
    return { _: 'auth.authorization', flags: 0, setupPasswordRequired: false, user } as unknown as tl.TlObject
  })

  // ── Messages ──
  ctx.mtproto.register('messages.getDialogs', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getDialogs(req as tl.messages.RawGetDialogsRequest))
  ctx.mtproto.register('messages.getHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getHistory(req as tl.messages.RawGetHistoryRequest))
  ctx.mtproto.register('messages.getMessages', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessages(req as tl.messages.RawGetMessagesRequest))
  ctx.mtproto.register('messages.search', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.search(req as tl.messages.RawSearchRequest))
  ctx.mtproto.register('messages.readHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.readHistory(req as tl.messages.RawReadHistoryRequest))
  ctx.mtproto.register('messages.getScheduledHistory', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getScheduledHistory(req as tl.messages.RawGetScheduledHistoryRequest))
  ctx.mtproto.register('messages.getPinnedDialogs', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getPinnedDialogs())
  ctx.mtproto.register('messages.sendMessage', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMessage(req as tl.messages.RawSendMessageRequest))
  ctx.mtproto.register('messages.sendMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMedia(req as tl.messages.RawSendMediaRequest))
  ctx.mtproto.register('messages.sendMultiMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMultiMedia(req as tl.messages.RawSendMultiMediaRequest))
  ctx.mtproto.register('messages.setTyping', async (rpc) => {
    await requireBridgeSession(rpc)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  ctx.mtproto.register('messages.uploadMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.uploadMedia(req as tl.messages.RawUploadMediaRequest))
  ctx.mtproto.register('upload.saveFilePart', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const input = req as tl.upload.RawSaveFilePartRequest
    await uploads.savePart(state.session.platformSessionId, input.fileId.toString(), input.filePart, input.bytes)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  ctx.mtproto.register('upload.saveBigFilePart', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    const input = req as tl.upload.RawSaveBigFilePartRequest
    await uploads.savePart(state.session.platformSessionId, input.fileId.toString(), input.filePart, input.bytes)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  ctx.mtproto.register('upload.getFile', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFile(req as tl.upload.RawGetFileRequest))
  ctx.mtproto.register('upload.getFileHashes', async () => bareVector([]))

  ctx.mtproto.register('messages.getAllStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getAllStickers(req as tl.messages.RawGetAllStickersRequest))
  ctx.mtproto.register('messages.getStickerSet', async (rpc, req) => {
    const state = await requireBridgeSession(rpc)
    return await state.dialogs.getReactionStickerSet(req as tl.messages.RawGetStickerSetRequest)
      ?? state.stickers.getStickerSet(req as tl.messages.RawGetStickerSetRequest)
  })
  ctx.mtproto.register('messages.getStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getStickers(req as tl.messages.RawGetStickersRequest))
  ctx.mtproto.register('messages.getRecentStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getRecentStickers(req as tl.messages.RawGetRecentStickersRequest))
  ctx.mtproto.register('messages.saveRecentSticker', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.saveRecentSticker(req as tl.messages.RawSaveRecentStickerRequest))
  ctx.mtproto.register('messages.clearRecentStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.clearRecentStickers(req as tl.messages.RawClearRecentStickersRequest))
  ctx.mtproto.register('messages.getFavedStickers', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.getFavedStickers(req as tl.messages.RawGetFavedStickersRequest))
  ctx.mtproto.register('messages.faveSticker', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.faveSticker(req as tl.messages.RawFaveStickerRequest))
  ctx.mtproto.register('messages.installStickerSet', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.installStickerSet(req as tl.messages.RawInstallStickerSetRequest))
  ctx.mtproto.register('messages.uninstallStickerSet', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.uninstallStickerSet(
      req as tl.messages.RawUninstallStickerSetRequest,
    ))
  ctx.mtproto.register('messages.reorderStickerSets', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.reorderStickerSets(
      req as tl.messages.RawReorderStickerSetsRequest,
    ))
  ctx.mtproto.register('messages.toggleStickerSets', async (rpc, req) =>
    (await requireBridgeSession(rpc)).stickers.toggleStickerSets(req as tl.messages.RawToggleStickerSetsRequest))
  ctx.mtproto.register('messages.getAvailableReactions', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getAvailableReactions())
  ctx.mtproto.register('messages.getTopReactions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(
      (req as tl.messages.RawGetTopReactionsRequest).limit,
    ))
  ctx.mtproto.register('messages.getRecentReactions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(
      (req as tl.messages.RawGetRecentReactionsRequest).limit,
    ))
  ctx.mtproto.register('messages.getDefaultTagReactions', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getTopReactions(100))
  ctx.mtproto.register('messages.clearRecentReactions', async (rpc) => {
    await requireBridgeSession(rpc)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  ctx.mtproto.register('messages.getEmojiStickers', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getEmojiStickers())
  ctx.mtproto.register('messages.getCustomEmojiDocuments', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getCustomEmojiDocuments(
      req as tl.messages.RawGetCustomEmojiDocumentsRequest,
    )))
  ctx.mtproto.register('messages.sendReaction', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendReaction(req as tl.messages.RawSendReactionRequest))
  ctx.mtproto.register('messages.getMessagesReactions', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessagesReactions(req as tl.messages.RawGetMessagesReactionsRequest))
  ctx.mtproto.register('messages.getMessageReactionsList', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getMessageReactionsList(
      req as tl.messages.RawGetMessageReactionsListRequest,
    ))

  // ── Contacts / users ──
  ctx.mtproto.register('contacts.getContacts', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getContacts())
  ctx.mtproto.register('users.getUsers', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getUsers(req as tl.users.RawGetUsersRequest)))
  ctx.mtproto.register('users.getFullUser', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullUser(req as tl.users.RawGetFullUserRequest))
  ctx.mtproto.register('messages.getPeerSettings', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getPeerSettings(req as tl.messages.RawGetPeerSettingsRequest))
  ctx.mtproto.register('messages.getFullChat', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullChat(req as tl.messages.RawGetFullChatRequest))
  ctx.mtproto.register('channels.getFullChannel', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullChannel(req as tl.channels.RawGetFullChannelRequest))
  ctx.mtproto.register('channels.getParticipant', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelParticipant(req as tl.channels.RawGetParticipantRequest))
  ctx.mtproto.register('channels.getParticipants', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getChannelParticipants(req as tl.channels.RawGetParticipantsRequest))
  ctx.mtproto.register('channels.getSendAs', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getSendAs(req as tl.channels.RawGetSendAsRequest))
  ctx.mtproto.register('messages.getForumTopics', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getForumTopics(req as tl.messages.RawGetForumTopicsRequest))
  ctx.mtproto.register('messages.getForumTopicsByID', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getForumTopics(req as tl.messages.RawGetForumTopicsByIDRequest))
  ctx.mtproto.register('messages.getReplies', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getReplies(req as tl.messages.RawGetRepliesRequest))
  ctx.mtproto.register('channels.toggleViewForumAsMessages', async () => ({
    _: 'updates', updates: [], users: [], chats: [], date: Math.floor(Date.now() / 1000), seq: 0,
  } as tl.RawUpdates))

  // ── Updates ──
  ctx.mtproto.register('updates.getState', async (rpc) =>
    updates.getState((await requireBridgeSession(rpc)).session.platformSessionId))

  ctx.mtproto.register('updates.getDifference', async (rpc, req) =>
    updates.getDifference(
      (await requireBridgeSession(rpc)).session.platformSessionId,
      req as tl.updates.RawGetDifferenceRequest,
    ))
  ctx.mtproto.register('updates.getChannelDifference', async (rpc) => {
    const state = await updates.getState((await requireBridgeSession(rpc)).session.platformSessionId)
    return { _: 'updates.channelDifferenceEmpty', final: true, pts: state.pts } as tl.updates.RawChannelDifferenceEmpty
  })

  // ── Post-login misc (keep the client's initial sync from stalling) ──
  ctx.mtproto.register('account.updateStatus', async () => ({ _: 'boolTrue' } as unknown as tl.TlObject))
  ctx.mtproto.register('account.getNotifySettings', async () => ({
    _: 'peerNotifySettings',
  } as unknown as tl.TlObject))
  ctx.mtproto.register('help.getCountriesList', async () => ({
    _: 'help.countriesList', countries: [], hash: 0,
  } as unknown as tl.TlObject))
  ctx.mtproto.register('messages.getDialogFilters', async () => ({
    _: 'messages.dialogFilters', flags: 0, filters: [],
  } as unknown as tl.TlObject))
  ctx.mtproto.register('auth.resendCode', async (_rpc, req) => {
    const phone = normPhone((req as unknown as { phoneNumber: string }).phoneNumber)
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: phone })
    if (!auth) throw new RpcError(400, 'PHONE_NUMBER_UNOCCUPIED')
    return {
      _: 'auth.sentCode', flags: 0,
      type: { _: 'auth.sentCodeTypeApp', length: 6 },
      phoneCodeHash: `hash_${auth.id}`,
    } as unknown as tl.TlObject
  })
  ctx.mtproto.register('auth.exportLoginToken', async () => ({
    _: 'auth.loginToken',
    expires: Math.floor(Date.now() / 1000) + 60,
    token: randomBytes(32),
  } as unknown as tl.TlObject))

  for (const [method, handler] of Object.entries(startupRpcHandlers)) {
    ctx.mtproto.register(method, async () => handler())
  }

  ctx.mtproto.broadcastUpdate({
    _: 'updateShort', update: { _: 'updateConfig' }, date: Math.floor(Date.now() / 1000),
  })
  ctx.logger('bridge').info('bridge backend registered (platforms: %s)', registry.ids.join(', '))
}

function randomHex(bytes: number): string {
  let s = ''
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return s
}

/** Normalize a phone to digits only — clients send '+' for sendCode but not for signIn. */
function normPhone(p: string): string {
  return p.replace(/\D/g, '')
}

function createSessionResolver(
  ctx: Context,
  registry: PlatformRegistry,
  stickerProviders: import('./sticker-provider.js').StickerProviderRegistry,
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
          stickers: new StickerRpc(ctx.database, stickerProviders, platform, session, dcId),
          dialogs: undefined as never,
        }
        state.dialogs = new DialogRpc(
          platform, session, store, uploads, onTransferProgress, dcId, state.stickers,
          new ReactionRpc(platform, session, dcId),
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
