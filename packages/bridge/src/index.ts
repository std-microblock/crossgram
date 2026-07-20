import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import { randomBytes } from 'node:crypto'
import Long from 'long'
import { RpcError, bareVector, type ServerRpcContext } from '@mtproto-relay/mtproto'
import { StaticDemoPlatform, type IMPlatform, type JsonValue, type PlatformSession } from './platform.js'
import { defineModels } from './models.js'
import { makeConfig, makeAppConfig, makeUser } from './synthetic.js'
import { DialogRpc, stableId } from './dialogs.js'
import { startupRpcHandlers } from './startup.js'

export * from './platform.js'
export * from './message-store.js'

export const name = 'mtproto-bridge'
export const inject = ['mtproto', 'database', 'model', 'server']

export interface BridgeConfig {
  /** IM platform adapter (default: StaticDemoPlatform). */
  platform?: IMPlatform
  dcId?: number
  serverHost?: string
  serverPort?: number
  /** HTTP path prefix for the auth API (default: /api). */
  apiPrefix?: string
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
  const platform = config.platform ?? new StaticDemoPlatform()
  const dcId = config.dcId ?? 1
  const apiPrefix = config.apiPrefix ?? '/api'
  const requireBridgeSession = createSessionResolver(ctx, platform)

  defineModels(ctx)

  // ── HTTP auth: mint a virtual phone + login code for a platform identity ──
  ctx.server.post(`${apiPrefix}/auth/:platform/complete`, async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as {
      credentials?: JsonValue
      metadata?: { firstName?: string, lastName?: string, username?: string, userId?: string }
    }
    const platformId = (req.params as { platform: string }).platform
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

    const session: PlatformSession = {
      platformSessionId: ps.id,
      platformId: ps.platformId,
      userId: ps.userId,
      credentials: ps.credentials,
      metadata: ps.metadata,
    }
    if (ps.platformId !== platform.id) throw new RpcError(500, 'PLATFORM_NOT_AVAILABLE')
    if (!rpc.authKeyId) throw new RpcError(500, 'AUTH_KEY_ID_MISSING')
    await ctx.database.upsert('mtproto_auth_binding', [{
      authKeyId: authKeyHex(rpc.authKeyId),
      platformId: ps.platformId,
      platformSessionId: ps.id,
    }])
    rpc.setPlatformData({ session, dialogs: new DialogRpc(platform, session) } satisfies BridgeSessionState)
    await platform.subscribe(session, () => {})

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

  // ── Contacts / users ──
  ctx.mtproto.register('contacts.getContacts', async (rpc) =>
    (await requireBridgeSession(rpc)).dialogs.getContacts())
  ctx.mtproto.register('users.getUsers', async (rpc, req) =>
    bareVector(await (await requireBridgeSession(rpc)).dialogs.getUsers(req as tl.users.RawGetUsersRequest)))
  ctx.mtproto.register('users.getFullUser', async (rpc, req) =>
    (await requireBridgeSession(rpc)).dialogs.getFullUser(req as tl.users.RawGetFullUserRequest))

  // ── Updates ──
  ctx.mtproto.register('updates.getState', async () => ({
    _: 'updates.state',
    pts: 1, qts: 0, date: Math.floor(Date.now() / 1000), seq: 0, unreadCount: 0,
  } as unknown as tl.TlObject))

  ctx.mtproto.register('updates.getDifference', async () => ({
    _: 'updates.differenceEmpty', date: Math.floor(Date.now() / 1000), seq: 0,
  } as unknown as tl.TlObject))

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

  ctx.logger('bridge').info('bridge backend registered (platform: %s)', platform.id)
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

function createSessionResolver(ctx: Context, platform: IMPlatform) {
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
        if (binding.platformId !== platform.id) throw new RpcError(500, 'PLATFORM_NOT_AVAILABLE')
        const [row] = await ctx.database.get('mtproto_platform_session', {
          id: binding.platformSessionId,
          active: true,
        })
        if (!row) throw new RpcError(401, 'PLATFORM_SESSION_REVOKED')
        const session: PlatformSession = {
          platformSessionId: row.id,
          platformId: row.platformId,
          userId: row.userId,
          credentials: row.credentials,
          metadata: row.metadata,
        }
        await platform.subscribe(session, () => {})
        return { session, dialogs: new DialogRpc(platform, session) }
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
