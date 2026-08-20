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
export type BeginAuthKeyRevocation = (
  authKeyId: Uint8Array,
  originConnection?: ServerRpcContext['connection'],
) => Promise<void>
export type FinishAuthKeyRevocation = (authKeyId: Uint8Array) => Promise<unknown>
export type IsAuthKeyRegistered = (authKeyId: Uint8Array) => Promise<boolean>

export interface ActiveSessionRpcRegistrar {
  register(method: string, handler: RpcHandler): unknown
}

export type ResolveActiveSessionIdentity = (rpc: ServerRpcContext) => Promise<ActiveSessionIdentity>

export interface AuthorizationReservation {
  wait(): Promise<void>
  release(): void
}

export type ReserveAuthorization = (authKeyId: string, terminal?: boolean) => AuthorizationReservation

/** Serialize authorization transitions and fence a logged-out key until revocation completes. */
export function createAuthorizationReservationQueue(): ReserveAuthorization {
  const authorizationLocks = new Map<string, { tail: Promise<void>, terminal: boolean }>()
  return (authKeyId, terminal = false) => {
    const previous = authorizationLocks.get(authKeyId)
    if (previous?.terminal) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    let resolve!: () => void
    const tail = new Promise<void>((release) => { resolve = release })
    authorizationLocks.set(authKeyId, { tail, terminal })
    let released = false
    return {
      wait: () => previous?.tail ?? Promise.resolve(),
      release: () => {
        if (released) return
        released = true
        resolve()
        if (authorizationLocks.get(authKeyId)?.tail === tail) authorizationLocks.delete(authKeyId)
      },
    }
  }
}

export function registerActiveSessionRpc(
  rpc: ActiveSessionRpcRegistrar,
  sessions: ActiveSessionStore,
  resolveIdentity: ResolveActiveSessionIdentity,
  reserveAuthorization: ReserveAuthorization,
): void {
  rpc.register('account.getAuthorizations', async (context) =>
    sessions.list(context, await resolveIdentity(context)))
  rpc.register('auth.logOut', async (context) => {
    if (!context.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    if (!context.afterResponseSettled) throw new RpcError(500, 'INTERNAL')
    const reservation = reserveAuthorization(authKeyHex(context.authKeyId), true)
    try {
      await reservation.wait()
      await sessions.beginLogout(context)
    } catch (error) {
      reservation.release()
      throw error
    }
    context.afterResponseSettled(async () => {
      try {
        const databaseErrors = await sessions.logout(context)
        let revokeError: unknown
        try {
          await sessions.finishLogout(context)
        } catch (error) {
          revokeError = error
        }
        if (databaseErrors.length || revokeError) {
          throw new AggregateError([...databaseErrors, ...(revokeError ? [revokeError] : [])], 'logout cleanup failed')
        }
      } finally {
        reservation.release()
      }
    })
    return { _: context.apiLayer !== null && context.apiLayer < 135 ? 'boolTrue' : 'auth.loggedOut' }
  })
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
  private readonly _touchLocks = new Map<string, Promise<void>>()
  private readonly _finishAuthKeyRevocation: FinishAuthKeyRevocation

  constructor(
    private readonly _database: Database,
    private readonly _revokeAuthKey: RevokeAuthKey,
    private readonly _now: () => number = () => Date.now(),
    private readonly _isAuthKeyRegistered: IsAuthKeyRegistered = async () => true,
    private readonly _beginAuthKeyRevocation: BeginAuthKeyRevocation = async () => {},
    finishAuthKeyRevocation?: FinishAuthKeyRevocation,
  ) {
    this._finishAuthKeyRevocation = finishAuthKeyRevocation ?? (authKeyId => this._revokeAuthKey(authKeyId))
  }

  private async _withTouchLock<T>(authKeyId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this._touchLocks.get(authKeyId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this._touchLocks.set(authKeyId, current)
    await previous
    try {
      return await callback()
    } finally {
      release()
      if (this._touchLocks.get(authKeyId) === current) this._touchLocks.delete(authKeyId)
    }
  }

  async touch(rpc: ServerRpcContext, identity: ActiveSessionIdentity): Promise<void> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const authKey = new Uint8Array(rpc.authKeyId)
    const authKeyId = authKeyHex(authKey)
    await this._withTouchLock(authKeyId, async () => {
      if (!await this._isAuthKeyRegistered(authKey)) return
      const [binding] = await this._database.get('mtproto_auth_binding', {
        authKeyId, platformSessionId: identity.platformSessionId,
      })
      if (!binding) return
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
    })
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
    const revoked = new Set<string>()
    const authKeyIds = [...new Set([...bindings.map(binding => binding.authKeyId), ...rows.map(row => row.authKeyId)])]
    for (let offset = 0; offset < authKeyIds.length; offset += 16) {
      const batch = authKeyIds.slice(offset, offset + 16)
      const active = await Promise.all(batch.map(async (authKeyId) => {
        try {
          return await this._isAuthKeyRegistered(authKeyBytes(authKeyId))
        } catch {
          return false
        }
      }))
      for (let index = 0; index < batch.length; index++) {
        if (active[index]) continue
        const authKeyId = batch[index]!
        revoked.add(authKeyId)
        void Promise.allSettled([
          this._database.remove('mtproto_auth_binding', { authKeyId }),
          this._database.remove('mtproto_client_authorization', { authKeyId }),
        ])
      }
    }
    const rowByAuthKey = new Map(rows
      .filter(row => !revoked.has(row.authKeyId))
      .map(row => [row.authKeyId, row]))
    const authorizations = bindings
      .filter(binding => !revoked.has(binding.authKeyId))
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

  async beginLogout(rpc: ServerRpcContext): Promise<void> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    await this._beginAuthKeyRevocation(new Uint8Array(rpc.authKeyId), rpc.connection)
  }

  async logout(rpc: ServerRpcContext): Promise<unknown[]> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const authKeyId = authKeyHex(rpc.authKeyId)
    return this._withTouchLock(authKeyId, async () => {
      rpc.setPlatformData(null)
      const results = await Promise.allSettled([
        this._database.remove('mtproto_auth_binding', { authKeyId }),
        this._database.remove('mtproto_client_authorization', { authKeyId }),
      ])
      return results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    })
  }

  async finishLogout(rpc: ServerRpcContext): Promise<void> {
    if (!rpc.authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    await this._finishAuthKeyRevocation(new Uint8Array(rpc.authKeyId))
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
