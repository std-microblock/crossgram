import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { MtprotoClientInfo, ServerRpcContext } from '@mtproto-relay/mtproto'
import { ActiveSessionStore, authorizationHash, createAuthorizationReservationQueue } from './active-sessions.js'
import { defineModels } from './models.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

async function createDatabase() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return ctx.database
}

function authKey(value: number): Uint8Array {
  return new Uint8Array(8).fill(value)
}

function rpcContext(
  key: Uint8Array,
  clientInfo: MtprotoClientInfo,
  options: { ip?: string, connectedAt?: number, lastActiveAt?: number } = {},
): ServerRpcContext {
  return {
    connection: { remoteAddress: options.ip ?? '127.0.0.1' } as ServerRpcContext['connection'],
    apiLayer: 228,
    authKeyId: key,
    sessionId: Long.ONE,
    isAuthorized: true,
    clientInfo,
    connectedAt: options.connectedAt ?? 1_700_000_000_000,
    lastActiveAt: options.lastActiveAt ?? 1_700_000_100_000,
    sendUpdate() {},
    getPlatformData: <T>() => null as T,
    setPlatformData() {},
  }
}

const desktop: MtprotoClientInfo = {
  apiId: 2040,
  deviceModel: 'Workstation',
  systemVersion: 'Windows 11',
  appVersion: '6001000',
  systemLangCode: 'zh-CN',
  langPack: 'tdesktop',
  langCode: 'zh-CN',
}

const android: MtprotoClientInfo = {
  apiId: 6,
  deviceModel: 'Pixel 10',
  systemVersion: 'SDK 36',
  appVersion: '12.9.0',
  systemLangCode: 'en-US',
  langPack: 'android',
  langCode: 'en',
}

describe('ActiveSessionStore', () => {
  it('persists client metadata and returns current plus other authorizations in activity order', async () => {
    const database = await createDatabase()
    const revoke = vi.fn(async (_authKeyId: Uint8Array) => true)
    const store = new ActiveSessionStore(database, revoke)
    const current = authKey(1)
    const other = authKey(2)
    await database.upsert('mtproto_auth_binding', [
      { authKeyId: Buffer.from(current).toString('hex'), platformId: 'test', platformSessionId: 'account' },
      { authKeyId: Buffer.from(other).toString('hex'), platformId: 'test', platformSessionId: 'account' },
    ])
    await store.touch(rpcContext(other, android, {
      ip: '203.0.113.20', connectedAt: 1_699_000_000_000, lastActiveAt: 1_699_000_100_000,
    }), { platformSessionId: 'account' })
    const currentRpc = rpcContext(current, desktop)

    const result = await store.list(currentRpc, { platformSessionId: 'account' })

    expect(result.authorizationTtlDays).toBe(180)
    expect(result.authorizations).toHaveLength(2)
    expect(result.authorizations[0]).toMatchObject({
      current: true, hash: Long.ZERO, deviceModel: 'Workstation', platform: 'Windows',
      appName: 'Telegram Desktop', officialApp: true, ip: '127.0.0.1', country: 'Local network',
    })
    expect(result.authorizations[1]).toMatchObject({
      hash: authorizationHash(other), deviceModel: 'Pixel 10', platform: 'Android',
      appName: 'Telegram for Android', ip: '203.0.113.20', country: 'Unknown',
    })
    const resumed = new ActiveSessionStore(database, revoke)
    await expect(resumed.list(currentRpc, { platformSessionId: 'account' }))
      .resolves.toMatchObject({ authorizations: [{ current: true }, { deviceModel: 'Pixel 10' }] })
  })

  it('revokes only another authorization belonging to the same bridged account', async () => {
    const database = await createDatabase()
    const revoke = vi.fn(async (_authKeyId: Uint8Array) => true)
    const store = new ActiveSessionStore(database, revoke)
    const current = authKey(1)
    const target = authKey(2)
    const outsider = authKey(3)
    await database.upsert('mtproto_auth_binding', [
      { authKeyId: Buffer.from(current).toString('hex'), platformId: 'test', platformSessionId: 'account' },
      { authKeyId: Buffer.from(target).toString('hex'), platformId: 'test', platformSessionId: 'account' },
      { authKeyId: Buffer.from(outsider).toString('hex'), platformId: 'test', platformSessionId: 'other-account' },
    ])
    const currentRpc = rpcContext(current, desktop)
    await store.touch(currentRpc, { platformSessionId: 'account' })
    await store.touch(rpcContext(target, android), { platformSessionId: 'account' })

    await expect(store.reset(currentRpc, { platformSessionId: 'account' }, Long.ZERO)).resolves.toBe(false)
    await expect(store.reset(
      currentRpc, { platformSessionId: 'account' }, authorizationHash(outsider),
    )).resolves.toBe(false)
    await expect(store.reset(
      currentRpc, { platformSessionId: 'account' }, authorizationHash(target),
    )).resolves.toBe(true)
    expect(revoke).toHaveBeenCalledOnce()
    expect(revoke.mock.calls[0][0]).toEqual(target)
    expect(await database.get('mtproto_auth_binding', {
      authKeyId: Buffer.from(target).toString('hex'),
    })).toEqual([])
    expect(await database.get('mtproto_auth_binding', {
      authKeyId: Buffer.from(outsider).toString('hex'),
    })).toHaveLength(1)
  })

  it('removes only the current device authorization while preserving its account and other device', async () => {
    const database = await createDatabase()
    const revoke = vi.fn(async (_authKeyId: Uint8Array) => true)
    const store = new ActiveSessionStore(database, revoke)
    const current = authKey(1)
    const other = authKey(2)
    const currentAuthKeyId = Buffer.from(current).toString('hex')
    const otherAuthKeyId = Buffer.from(other).toString('hex')
    await database.create('mtproto_platform_session', {
      id: 'account', platformId: 'test', userId: 'user', credentials: {}, metadata: {}, active: true,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    })
    await database.create('mtproto_auth_session', {
      id: 'auth-session', virtualPhone: '15550000000', totpSecret: 'secret',
      platformId: 'test', platformSessionId: 'account',
    })
    await database.upsert('mtproto_auth_binding', [current, other].map(key => ({
      authKeyId: Buffer.from(key).toString('hex'), platformId: 'test', platformSessionId: 'account',
    })))
    const currentRpc = rpcContext(current, desktop)
    const setPlatformData = vi.fn()
    currentRpc.setPlatformData = setPlatformData
    await store.touch(currentRpc, { platformSessionId: 'account' })
    await store.touch(rpcContext(other, android), { platformSessionId: 'account' })

    await store.logout(currentRpc)
    await store.finishLogout(currentRpc)

    expect(setPlatformData).toHaveBeenCalledExactlyOnceWith(null)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(current)
    await expect(database.get('mtproto_auth_binding', { authKeyId: currentAuthKeyId })).resolves.toEqual([])
    await expect(database.get('mtproto_client_authorization', { authKeyId: currentAuthKeyId })).resolves.toEqual([])
    await store.touch(currentRpc, { platformSessionId: 'account' })
    await expect(database.get('mtproto_client_authorization', { authKeyId: currentAuthKeyId })).resolves.toEqual([])
    await expect(database.get('mtproto_platform_session', { id: 'account' })).resolves.toHaveLength(1)
    await expect(database.get('mtproto_auth_session', { id: 'auth-session' })).resolves.toHaveLength(1)
    await expect(database.get('mtproto_client_authorization', { authKeyId: otherAuthKeyId })).resolves.toMatchObject([
      { authKeyId: otherAuthKeyId, deviceModel: 'Pixel 10', platform: 'Android' },
    ])
    await expect(store.list(rpcContext(other, android), { platformSessionId: 'account' }))
      .resolves.toMatchObject({ authorizations: [{ hash: Long.ZERO, deviceModel: 'Pixel 10' }] })
    await expect(database.get('mtproto_auth_binding', { authKeyId: otherAuthKeyId })).resolves.toHaveLength(1)
  })

  it('does not restore the current authorization when touch held before its upsert races logout', async () => {
    const database = await createDatabase()
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    let registered = true
    const revoke = vi.fn(async () => { registered = false })
    const store = new ActiveSessionStore(database, revoke, undefined, async () => registered)
    await database.upsert('mtproto_auth_binding', [{
      authKeyId, platformId: 'test', platformSessionId: 'account',
    }])
    let allowUpsert!: () => void
    const upsertGate = new Promise<void>(resolve => { allowUpsert = resolve })
    let markUpsertStarted!: () => void
    const upsertStarted = new Promise<void>(resolve => { markUpsertStarted = resolve })
    const originalUpsert = database.upsert.bind(database) as (...args: any[]) => Promise<unknown>
    const upsert = vi.spyOn(database, 'upsert').mockImplementation(async (table, rows) => {
      if (table === 'mtproto_client_authorization') {
        markUpsertStarted()
        await upsertGate
      }
      return originalUpsert(table, rows) as never
    })

    const touching = store.touch(rpcContext(current, desktop), { platformSessionId: 'account' })
    await upsertStarted
    const logoutRpc = rpcContext(current, desktop)
    await store.beginLogout(logoutRpc)
    const loggingOut = store.logout(logoutRpc)
    expect(revoke).not.toHaveBeenCalled()
    allowUpsert()
    await Promise.all([touching, loggingOut])
    await store.finishLogout(logoutRpc)

    expect(revoke).toHaveBeenCalledExactlyOnceWith(current)
    await expect(database.get('mtproto_client_authorization', { authKeyId })).resolves.toEqual([])
    upsert.mockRestore()
  })

  it('does not restore the current authorization when logout holds the key before touch starts', async () => {
    const database = await createDatabase()
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    let registered = true
    let releaseRevoke!: () => void
    const revokeGate = new Promise<void>(resolve => { releaseRevoke = resolve })
    let markRevokeStarted!: () => void
    const revokeStarted = new Promise<void>(resolve => { markRevokeStarted = resolve })
    const revoke = vi.fn(async () => {
      markRevokeStarted()
      await revokeGate
      registered = false
    })
    const store = new ActiveSessionStore(database, revoke, undefined, async () => registered)
    await database.upsert('mtproto_auth_binding', [{
      authKeyId, platformId: 'test', platformSessionId: 'account',
    }])
    const upsert = vi.spyOn(database, 'upsert')

    const logoutRpc = rpcContext(current, desktop)
    await store.beginLogout(logoutRpc)
    await store.logout(logoutRpc)
    const finishing = store.finishLogout(logoutRpc)
    await revokeStarted
    const touching = store.touch(rpcContext(current, desktop), { platformSessionId: 'account' })
    expect(upsert).not.toHaveBeenCalled()
    releaseRevoke()
    await Promise.all([finishing, touching])

    expect(upsert).not.toHaveBeenCalled()
    await expect(database.get('mtproto_client_authorization', { authKeyId })).resolves.toEqual([])
    upsert.mockRestore()
  })

  it('revokes the current key and clears cached platform state when a logout delete fails', async () => {
    const database = await createDatabase()
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    let registered = true
    const revoke = vi.fn(async (_authKeyId: Uint8Array) => {
      registered = false
      return true
    })
    const store = new ActiveSessionStore(database, revoke, undefined, async () => registered)
    await database.upsert('mtproto_auth_binding', [{
      authKeyId, platformId: 'test', platformSessionId: 'account',
    }])
    const rpc = rpcContext(current, desktop)
    rpc.setPlatformData = vi.fn()
    const remove = vi.spyOn(database, 'remove').mockImplementation(async (table, query) => {
      if (table === 'mtproto_auth_binding' && (query as { authKeyId?: string }).authKeyId === authKeyId) {
        throw new Error('delete failed')
      }
      return [] as never
    })

    const databaseErrors = await store.logout(rpc)
    await store.finishLogout(rpc)

    expect(databaseErrors).toHaveLength(1)
    expect(databaseErrors[0]).toMatchObject({ message: 'delete failed' })
    expect(rpc.setPlatformData).toHaveBeenCalledExactlyOnceWith(null)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(current)
    await store.touch(rpc, { platformSessionId: 'account' })
    await expect(database.get('mtproto_client_authorization', { authKeyId })).resolves.toEqual([])
    remove.mockRestore()
  })

  it('hides a revoked ghost device when both logout deletes and opportunistic cleanup fail', async () => {
    const database = await createDatabase()
    const current = authKey(1)
    const other = authKey(2)
    const currentAuthKeyId = Buffer.from(current).toString('hex')
    const otherAuthKeyId = Buffer.from(other).toString('hex')
    const registered = new Set([currentAuthKeyId, otherAuthKeyId])
    const revoke = vi.fn(async (authKeyId: Uint8Array) => { registered.delete(Buffer.from(authKeyId).toString('hex')) })
    const store = new ActiveSessionStore(
      database,
      revoke,
      undefined,
      async authKeyId => registered.has(Buffer.from(authKeyId).toString('hex')),
    )
    await database.upsert('mtproto_auth_binding', [current, other].map(key => ({
      authKeyId: Buffer.from(key).toString('hex'), platformId: 'test', platformSessionId: 'account',
    })))
    const currentRpc = rpcContext(current, desktop)
    await store.touch(currentRpc, { platformSessionId: 'account' })
    await store.touch(rpcContext(other, android), { platformSessionId: 'account' })
    const remove = vi.spyOn(database, 'remove').mockImplementation(async (table, query) => {
      if ((query as { authKeyId?: string }).authKeyId === currentAuthKeyId) {
        throw new Error(`cannot remove ${table}`)
      }
      return [] as never
    })

    await expect(store.logout(currentRpc)).resolves.toHaveLength(2)
    await store.finishLogout(currentRpc)
    await expect(store.list(rpcContext(other, android), { platformSessionId: 'account' }))
      .resolves.toMatchObject({ authorizations: [{ current: true, deviceModel: 'Pixel 10' }] })
    await expect(store.list(rpcContext(other, android), { platformSessionId: 'account' }))
      .resolves.toMatchObject({ authorizations: [{ deviceModel: 'Pixel 10' }] })
    await expect(database.get('mtproto_auth_binding', { authKeyId: currentAuthKeyId })).resolves.toHaveLength(1)
    await expect(database.get('mtproto_client_authorization', { authKeyId: currentAuthKeyId })).resolves.toHaveLength(1)
    remove.mockRestore()
  })

  it('unblocks a later authorization reservation when a non-terminal reservation is cancelled', async () => {
    const reserve = createAuthorizationReservationQueue()
    const first = reserve('auth-key')
    const second = reserve('auth-key')
    let secondFinished = false
    const waitForSecond = second.wait().then(() => { secondFinished = true })

    await Promise.resolve()
    expect(secondFinished).toBe(false)
    first.release()
    await waitForSecond

    expect(secondFinished).toBe(true)
    second.release()
    await expect(reserve('auth-key').wait()).resolves.toBeUndefined()
  })

  it('rejects an authorization queued after a terminal logout reservation until cleanup releases it', async () => {
    const reserve = createAuthorizationReservationQueue()
    const predecessor = reserve('auth-key')
    const logout = reserve('auth-key', true)
    let logoutStarted = false
    const waitForLogout = logout.wait().then(() => { logoutStarted = true })

    await Promise.resolve()
    expect(logoutStarted).toBe(false)
    let bindingRecreated = false
    const signIn = async () => {
      const reservation = reserve('auth-key')
      await reservation.wait()
      bindingRecreated = true
      reservation.release()
    }
    await expect(signIn()).rejects.toMatchObject({ code: 401, text: 'AUTH_KEY_UNREGISTERED' })
    expect(bindingRecreated).toBe(false)

    predecessor.release()
    await waitForLogout
    expect(logoutStarted).toBe(true)
    logout.release()
    const afterCleanup = reserve('auth-key')
    await expect(afterCleanup.wait()).resolves.toBeUndefined()
    afterCleanup.release()
  })

  it('stores TTL and per-authorization call/encryption settings', async () => {
    const database = await createDatabase()
    const store = new ActiveSessionStore(database, async () => true)
    const current = authKey(1)
    const currentRpc = rpcContext(current, desktop)
    await database.upsert('mtproto_auth_binding', [{
      authKeyId: Buffer.from(current).toString('hex'), platformId: 'test', platformSessionId: 'account',
    }])
    await store.touch(currentRpc, { platformSessionId: 'account' })

    await expect(store.setTtl({ platformSessionId: 'account' }, 30)).resolves.toBeUndefined()
    await expect(store.setTtl({ platformSessionId: 'account' }, 0)).rejects.toMatchObject({
      text: 'AUTHORIZATION_TTL_INVALID',
    })
    await expect(store.changeSettings(currentRpc, { platformSessionId: 'account' }, {
      _: 'account.changeAuthorizationSettings', hash: Long.ZERO,
      encryptedRequestsDisabled: true, callRequestsDisabled: true,
    })).resolves.toBe(true)
    await expect(store.list(currentRpc, { platformSessionId: 'account' })).resolves.toMatchObject({
      authorizationTtlDays: 30,
      authorizations: [{ encryptedRequestsDisabled: true, callRequestsDisabled: true }],
    })
  })
})
