import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { MtprotoClientInfo, ServerRpcContext } from '@mtproto-relay/mtproto'
import { ActiveSessionStore, authorizationHash } from './active-sessions.js'
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
