import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import { RpcError, type RpcHandler, type ServerRpcContext } from '@mtproto-relay/mtproto'
import Long from 'long'
import type { ClientAuthorizationRow } from './models.js'

const DEFAULT_TTL_DAYS = 180
const OFFICIAL_API_IDS = new Set([1, 5, 6, 7, 24, 1026, 1083, 2040, 2458, 2496, 2521, 2834, 10840, 16352, 21724])

export interface ActiveSessionIdentity {
  platformSessionId: string
}

export type RevokeAuthKey = (authKeyId: Uint8Array) => Promise<unknown>

export interface ActiveSessionRpcRegistrar {
  register(method: string, handler: RpcHandler): unknown
}

export type ResolveActiveSessionIdentity = (rpc: ServerRpcContext) => Promise<ActiveSessionIdentity>

export function registerActiveSessionRpc(
  rpc: ActiveSessionRpcRegistrar,
  sessions: ActiveSessionStore,
  resolveIdentity: ResolveActiveSessionIdentity,
): void {
  rpc.register('account.getAuthorizations', async (context) =>
    sessions.list(context, await resolveIdentity(context)))
  rpc.register('account.resetAuthorization', async (context, request) => ({
    _: await sessions.reset(
      context,
      await resolveIdentity(context),
      (request as tl.account.RawResetAuthorizationRequest).hash,
    ) ? 'boolTrue' : 'boolFalse',
  }))
  rpc.register('auth.resetAuthorizations', async (context) => {
    await sessions.resetOthers(context, await resolveIdentity(context))
    return { _: 'boolTrue' }
  })
  rpc.register('account.setAuthorizationTTL', async (context, request) => {
    await sessions.setTtl(
      await resolveIdentity(context),
      (request as tl.account.RawSetAuthorizationTTLRequest).authorizationTtlDays,
    )
    return { _: 'boolTrue' }
  })
  rpc.register('account.changeAuthorizationSettings', async (context, request) => ({
    _: await sessions.changeSettings(
      context,
      await resolveIdentity(context),
      request as tl.account.RawChangeAuthorizationSettingsRequest,
    ) ? 'boolTrue' : 'boolFalse',
  }))
}

/** Durable implementation of Telegram's Settings > Active Sessions RPCs. */
export class ActiveSessionStore {
  constructor(
    private readonly _database: Database,
    private readonly _revokeAuthKey: RevokeAuthKey,
    private readonly _now: () => number = () => Date.now(),
  ) {}

  async touch(rpc: ServerRpcContext, identity: ActiveSessionIdentity): Promise<void> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const authKeyId = authKeyHex(rpc.authKeyId)
    const [stored] = await this._database.get('mtproto_client_authorization', { authKeyId })
    const now = Math.floor((rpc.lastActiveAt ?? this._now()) / 1000)
    const created = Math.floor((rpc.connectedAt ?? rpc.lastActiveAt ?? this._now()) / 1000)
    const client = rpc.clientInfo
    const ip = normalizeAddress(rpc.connection.remoteAddress)
    const row: ClientAuthorizationRow = {
      authKeyId,
      platformSessionId: identity.platformSessionId,
      apiId: client?.apiId ?? stored?.apiId ?? 0,
      deviceModel: client?.deviceModel || stored?.deviceModel || 'Unknown device',
      platform: client ? platformName(client.langPack, client.systemVersion) : stored?.platform || 'Unknown',
      systemVersion: client?.systemVersion || stored?.systemVersion || 'Unknown',
      appName: client ? applicationName(client.langPack) : stored?.appName || 'Telegram',
      appVersion: client?.appVersion || stored?.appVersion || '',
      dateCreated: stored?.dateCreated ?? created,
      dateActive: Math.max(stored?.dateActive ?? 0, now),
      ip: ip || stored?.ip || '0.0.0.0',
      country: locationName(ip || stored?.ip),
      region: stored?.region ?? '',
      encryptedRequestsDisabled: stored?.encryptedRequestsDisabled ?? false,
      callRequestsDisabled: stored?.callRequestsDisabled ?? false,
      unconfirmed: stored?.unconfirmed ?? false,
    }
    await this._database.upsert('mtproto_client_authorization', [row])
  }

  async list(rpc: ServerRpcContext, identity: ActiveSessionIdentity): Promise<tl.account.RawAuthorizations> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    await this.touch(rpc, identity)
    const currentAuthKeyId = authKeyHex(rpc.authKeyId)
    const bindings = await this._database.get('mtproto_auth_binding', {
      platformSessionId: identity.platformSessionId,
    })
    const rows = await this._database.get('mtproto_client_authorization', {
      platformSessionId: identity.platformSessionId,
    })
    const rowByAuthKey = new Map(rows.map(row => [row.authKeyId, row]))
    const authorizations = bindings
      .map(binding => rowByAuthKey.get(binding.authKeyId))
      .filter((row): row is ClientAuthorizationRow => Boolean(row))
      .sort((left, right) => {
        if (left.authKeyId === currentAuthKeyId) return -1
        if (right.authKeyId === currentAuthKeyId) return 1
        return right.dateActive - left.dateActive
      })
      .map(row => makeAuthorization(row, row.authKeyId === currentAuthKeyId))
    const [settings] = await this._database.get('mtproto_authorization_settings', {
      platformSessionId: identity.platformSessionId,
    })
    return {
      _: 'account.authorizations',
      authorizationTtlDays: settings?.ttlDays ?? DEFAULT_TTL_DAYS,
      authorizations,
    }
  }

  async reset(
    rpc: ServerRpcContext,
    identity: ActiveSessionIdentity,
    hash: Long,
  ): Promise<boolean> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const targetAuthKeyId = authKeyHexFromHash(hash)
    const currentAuthKeyId = authKeyHex(rpc.authKeyId)
    if (!targetAuthKeyId || targetAuthKeyId === currentAuthKeyId) return false
    const [binding] = await this._database.get('mtproto_auth_binding', {
      authKeyId: targetAuthKeyId,
      platformSessionId: identity.platformSessionId,
    })
    if (!binding) return false
    await this._database.remove('mtproto_auth_binding', { authKeyId: targetAuthKeyId })
    await this._database.remove('mtproto_client_authorization', { authKeyId: targetAuthKeyId })
    await this._revokeAuthKey(authKeyBytes(targetAuthKeyId))
    return true
  }

  async resetOthers(rpc: ServerRpcContext, identity: ActiveSessionIdentity): Promise<void> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const currentAuthKeyId = authKeyHex(rpc.authKeyId)
    const bindings = await this._database.get('mtproto_auth_binding', {
      platformSessionId: identity.platformSessionId,
    })
    for (const binding of bindings) {
      if (binding.authKeyId === currentAuthKeyId) continue
      await this._database.remove('mtproto_auth_binding', { authKeyId: binding.authKeyId })
      await this._database.remove('mtproto_client_authorization', { authKeyId: binding.authKeyId })
      await this._revokeAuthKey(authKeyBytes(binding.authKeyId))
    }
  }

  async setTtl(identity: ActiveSessionIdentity, ttlDays: number): Promise<void> {
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
      throw new RpcError(400, 'AUTHORIZATION_TTL_INVALID')
    }
    await this._database.upsert('mtproto_authorization_settings', [{
      platformSessionId: identity.platformSessionId,
      ttlDays,
    }])
  }

  async changeSettings(
    rpc: ServerRpcContext,
    identity: ActiveSessionIdentity,
    request: tl.account.RawChangeAuthorizationSettingsRequest,
  ): Promise<boolean> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const targetAuthKeyId = request.hash.isZero()
      ? authKeyHex(rpc.authKeyId)
      : authKeyHexFromHash(request.hash)
    if (!targetAuthKeyId) return false
    const [binding] = await this._database.get('mtproto_auth_binding', {
      authKeyId: targetAuthKeyId,
      platformSessionId: identity.platformSessionId,
    })
    if (!binding) return false
    const [stored] = await this._database.get('mtproto_client_authorization', { authKeyId: targetAuthKeyId })
    if (!stored) return false
    await this._database.set('mtproto_client_authorization', { authKeyId: targetAuthKeyId }, {
      ...(request.encryptedRequestsDisabled !== undefined
        ? { encryptedRequestsDisabled: request.encryptedRequestsDisabled }
        : {}),
      ...(request.callRequestsDisabled !== undefined
        ? { callRequestsDisabled: request.callRequestsDisabled }
        : {}),
      ...(request.confirmed ? { unconfirmed: false } : {}),
    })
    return true
  }
}

export function authorizationHash(authKeyId: Uint8Array): Long {
  return Long.fromBytesLE([...authKeyId], false)
}

export function authKeyHexFromHash(hash: Long): string | undefined {
  if (hash.isZero()) return
  return Buffer.from(hash.toBytesLE()).toString('hex')
}

function makeAuthorization(row: ClientAuthorizationRow, current: boolean): tl.RawAuthorization {
  return {
    _: 'authorization',
    ...(current ? { current: true } : {}),
    ...(OFFICIAL_API_IDS.has(row.apiId) ? { officialApp: true } : {}),
    ...(row.encryptedRequestsDisabled ? { encryptedRequestsDisabled: true } : {}),
    ...(row.callRequestsDisabled ? { callRequestsDisabled: true } : {}),
    ...(row.unconfirmed ? { unconfirmed: true } : {}),
    hash: current ? Long.ZERO : authorizationHash(authKeyBytes(row.authKeyId)),
    deviceModel: row.deviceModel,
    platform: row.platform,
    systemVersion: row.systemVersion,
    apiId: row.apiId,
    appName: row.appName,
    appVersion: row.appVersion,
    dateCreated: row.dateCreated,
    dateActive: row.dateActive,
    ip: row.ip,
    country: row.country,
    region: row.region,
  }
}

function authKeyHex(authKeyId: Uint8Array): string {
  return Buffer.from(authKeyId).toString('hex')
}

function authKeyBytes(authKeyId: string): Uint8Array {
  return new Uint8Array(Buffer.from(authKeyId, 'hex'))
}

function normalizeAddress(address?: string): string {
  if (!address) return ''
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

function locationName(address?: string): string {
  if (!address) return 'Unknown'
  if (address === '::1' || address.startsWith('127.') || address.startsWith('10.')
    || address.startsWith('192.168.') || address.startsWith('172.')) return 'Local network'
  return 'Unknown'
}

function applicationName(langPack: string): string {
  const normalized = langPack.toLowerCase()
  if (normalized.includes('tdesktop')) return 'Telegram Desktop'
  if (normalized.includes('android')) return 'Telegram for Android'
  if (normalized.includes('ios')) return 'Telegram for iOS'
  if (normalized.includes('macos')) return 'Telegram for macOS'
  return 'Telegram'
}

function platformName(langPack: string, systemVersion: string): string {
  const normalized = langPack.toLowerCase()
  const system = systemVersion.toLowerCase()
  if (normalized.includes('android')) return 'Android'
  if (normalized.includes('ios')) return 'iOS'
  if (normalized.includes('macos')) return 'macOS'
  if (normalized.includes('tdesktop')) {
    if (system.includes('windows')) return 'Windows'
    if (system.includes('mac')) return 'macOS'
    return 'Linux'
  }
  return langPack || 'Unknown'
}
