import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError, type ServerRpcContext } from '@mtproto-relay/mtproto'
import { StaticDemoPlatform, type IMPlatform, type PlatformSession } from './platform.js'
import { defineModels } from './models.js'
import { makeConfig, makeAppConfig, makeUser } from './synthetic.js'

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

/**
 * Bridge backend — a native cordis plugin. Translates MTProto RPC to an IM
 * platform. Auth is out-of-band: an HTTP endpoint mints a virtual phone + login
 * code (stored via minato), which the client enters to log in.
 */
export function apply(ctx: Context, config: BridgeConfig = {}): void {
  const platform = config.platform ?? new StaticDemoPlatform()
  const dcId = config.dcId ?? 1
  const apiPrefix = config.apiPrefix ?? '/api'

  defineModels(ctx)

  // Per-connection resolved platform session (keyed by the RPC context object).
  const sessions = new WeakMap<ServerRpcContext, PlatformSession>()

  // ── HTTP auth: mint a virtual phone + login code for a platform identity ──
  ctx.server.post(`${apiPrefix}/auth/:platform/complete`, async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as {
      credentials?: unknown
      metadata?: { firstName?: string, lastName?: string, username?: string, userId?: string }
    }
    const platformId = (req.params as { platform: string }).platform
    if (!body.credentials) {
      res.status = 400
      return res.json({ error: 'credentials required' })
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
    const virtualPhone = `+999${platformCode}${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`
    const loginCode = String(Math.floor(100000 + Math.random() * 900000))
    await ctx.database.create('mtproto_auth_session', {
      id: randomHex(16),
      virtualPhone,
      loginCode,
      platformId,
      platformSessionId: sessionId,
      used: false,
    })

    return res.json({ sessionId, virtualPhone, loginCode, platform: platformId, userId })
  })

  // ── Synthetic / config ──
  ctx.mtproto.register('help.getConfig', async () => makeConfig(dcId, config.serverHost, config.serverPort))
  ctx.mtproto.register('help.getAppConfig', async () => makeAppConfig())
  ctx.mtproto.register('help.getNearestDc', async () => ({
    _: 'nearestDc', country: 'US', thisDc: dcId, nearestDc: dcId,
  } as unknown as tl.TlObject))

  // ── Auth ──
  ctx.mtproto.register('auth.sendCode', async (_rpc, req) => {
    const phone = (req as unknown as { phoneNumber: string }).phoneNumber
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
    const [auth] = await ctx.database.get('mtproto_auth_session', { virtualPhone: phoneNumber })
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
    sessions.set(rpc, session)
    await platform.subscribe(session, () => {})

    const user = makeUser({
      id: parseInt(ps.userId, 36) || 1,
      self: true,
      firstName: (ps.metadata.firstName as string) ?? 'Bridge',
      phone: phoneNumber,
    })
    return { _: 'auth.authorization', flags: 0, setupPasswordRequired: false, user } as unknown as tl.TlObject
  })

  // ── Messages (dialogs stub — fleshed out with real TL next) ──
  ctx.mtproto.register('messages.getDialogs', async () => ({
    _: 'messages.dialogs', dialogs: [], messages: [], chats: [], users: [],
  } as unknown as tl.TlObject))

  // ── Updates ──
  ctx.mtproto.register('updates.getState', async () => ({
    _: 'updates.state',
    pts: 1, qts: 0, date: Math.floor(Date.now() / 1000), seq: 0, unreadCount: 0,
  } as unknown as tl.TlObject))

  ctx.logger('bridge').info('bridge backend registered (platform: %s)', platform.id)
}

function randomHex(bytes: number): string {
  let s = ''
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return s
}
