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

export * from './platform.js'
export * from './message-store.js'
export * from './platform-manager.js'
export * from './upload-manager.js'
export * from './update-manager.js'

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
  session: PlatformSession
  dialogs: DialogRpc
}

/**
 * Bridge backend — a native cordis plugin. Translates MTProto RPC to an IM
 * platform. Auth is out-of-band: an HTTP endpoint mints a virtual phone + login
 * code (stored via minato), which the client enters to log in.
 */
export function apply(ctx: Context, config: BridgeConfig = {}): void {
  const platforms = new IMPlatformService(ctx)
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
    ctx, registry, store, subscriptions, uploads, config.onTransferProgress, dcId,
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
    rpc.setPlatformData({
      session,
      dialogs: new DialogRpc(platform, session, store, uploads, config.onTransferProgress, dcId),
    } satisfies BridgeSessionState)
    await subscriptions.ensure(session)

    const user = makeUser({
      id: stableId(`self:${ps.id}`),
      self: true,
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
  ctx.mtproto.register('messages.getPinnedDialogs', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getPinnedDialogs())
  ctx.mtproto.register('messages.sendMessage', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMessage(req as tl.messages.RawSendMessageRequest))
  ctx.mtproto.register('messages.sendMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMedia(req as tl.messages.RawSendMediaRequest))
  ctx.mtproto.register('messages.sendMultiMedia', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.sendMultiMedia(req as tl.messages.RawSendMultiMediaRequest))
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

  // ── Contacts / users ──
  ctx.mtproto.register('contacts.getContacts', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getContacts())
  ctx.mtproto.register('users.getUsers', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getUsers(req as tl.users.RawGetUsersRequest)))
  ctx.mtproto.register('users.getFullUser', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullUser(req as tl.users.RawGetFullUserRequest))

  // ── Updates ──
  ctx.mtproto.register('updates.getState', async (rpc) =>
    updates.getState((await requireBridgeSession(rpc)).session.platformSessionId))

  ctx.mtproto.register('updates.getDifference', async (rpc) => {
    const state = await updates.getState((await requireBridgeSession(rpc)).session.platformSessionId)
    return { _: 'updates.differenceEmpty', date: state.date, seq: state.seq } as unknown as tl.TlObject
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
  store: MessageStore,
  subscriptions: PlatformSubscriptionManager,
  uploads: UploadManager,
  onTransferProgress?: BridgeConfig['onTransferProgress'],
  dcId = 1,
) {
  const loading = new Map<string, Promise<BridgeSessionState>>()

  return async (rpc: ServerRpcContext): Promise<BridgeSessionState> => {
    const cached = rpc.getPlatformData<BridgeSessionState | null>()
    if (cached) return cached
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
        return { session, dialogs: new DialogRpc(platform, session, store, uploads, onTransferProgress, dcId) }
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
