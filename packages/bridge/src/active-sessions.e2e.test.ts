import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter, type TlWriterMap } from '@mtcute/tl-runtime'
import Long from 'long'
import {
  isBareVector, type MtprotoClientInfo, type RpcResult, type ServerRpcContext,
} from '@mtproto-relay/mtproto'
import { getApiLayerReaderMap, getApiLayerWriterMap } from '../../mtproto/src/rpc/api-layer.js'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import {
  ActiveSessionStore, authorizationHash, createAuthorizationReservationQueue, registerActiveSessionRpc, type ReserveAuthorization,
} from './active-sessions.js'
import { defineModels } from './models.js'
import { createCordisRpcTestHarness } from './rpc-test-harness.js'

const RPC_RESULT_ID = 0xf35c6d01
const VECTOR_ID = 0x1cb5c415
const BOOL_TRUE_ID = 0x997275b5
const BOOL_FALSE_ID = 0xbc799737
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

async function setup(
  reserveAuthorization: ReserveAuthorization = () => ({
    wait: () => Promise.resolve(),
    release: () => {},
  }),
  revokeAuthKey: (authKeyId: Uint8Array) => Promise<unknown> = async () => true,
  beginAuthKeyRevocation: (authKeyId: Uint8Array) => Promise<void> = async () => {},
) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const revoke = vi.fn(revokeAuthKey)
  const beginRevocation = vi.fn(beginAuthKeyRevocation)
  const sessions = new ActiveSessionStore(
    ctx.database, revoke, undefined, async () => true, beginRevocation, revoke,
  )
  const rpc = createCordisRpcTestHarness()
  registerActiveSessionRpc(rpc, sessions, async () => ({ platformSessionId: 'account' }), reserveAuthorization)
  return { ctx, sessions, rpc, revoke, beginRevocation }
}

function authKey(value: number): Uint8Array {
  return new Uint8Array(8).fill(value)
}

const client: MtprotoClientInfo = {
  apiId: 2040, deviceModel: 'Desktop', systemVersion: 'Windows 11', appVersion: '6001000',
  systemLangCode: 'en', langPack: 'tdesktop', langCode: 'en',
}

function context(
  key: Uint8Array,
  info: MtprotoClientInfo = client,
  apiLayer: number | null = 228,
): ServerRpcContext {
  return {
    connection: { remoteAddress: '127.0.0.1' } as ServerRpcContext['connection'],
    apiLayer, authKeyId: key, sessionId: Long.ONE, isAuthorized: true,
    clientInfo: info, connectedAt: 1_700_000_000_000, lastActiveAt: 1_700_000_100_000,
    sendUpdate() {}, getPlatformData: <T>() => null as T, setPlatformData() {},
  }
}

async function roundTripRpc(
  rpc: ReturnType<typeof createCordisRpcTestHarness>,
  source: ServerRpcContext,
  query: tl.RpcMethod,
): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(
    getApiLayerWriterMap(__tlWriterMap, source.apiLayer),
    query,
  )
  const request = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpc.dispatch(source, request)
  const writerMap = getApiLayerWriterMap(__tlWriterMap, source.apiLayer)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result, writerMap), source.apiLayer)
}

function encodeRpcResult(requestId: Long, result: RpcResult, writerMap: TlWriterMap): Uint8Array {
  let body: Uint8Array
  if (result._ === 'boolTrue' || result._ === 'boolFalse') {
    const writer = TlBinaryWriter.manual(4)
    writer.uint(result._ === 'boolTrue' ? BOOL_TRUE_ID : BOOL_FALSE_ID)
    body = writer.result()
  } else if (isBareVector(result)) {
    const items = result.items.map(item => TlBinaryWriter.serializeObject(writerMap, item))
    const writer = TlBinaryWriter.manual(8 + items.reduce((size, item) => size + item.length, 0))
    writer.uint(VECTOR_ID)
    writer.uint(items.length)
    for (const item of items) writer.raw(item)
    body = writer.result()
  } else {
    body = TlBinaryWriter.serializeObject(writerMap, result)
  }
  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(requestId)
  writer.raw(body)
  return writer.result()
}

function decodeRpcResult(bytes: Uint8Array, apiLayer: number | null): any {
  const reader = new TlBinaryReader(getApiLayerReaderMap(apiLayer ?? 0) ?? __tlReaderMap, bytes)
  expect(reader.uint()).toBe(RPC_RESULT_ID)
  reader.long(true)
  const constructor = reader.uint()
  if (constructor === BOOL_TRUE_ID) return { _: 'boolTrue' }
  if (constructor === BOOL_FALSE_ID) return { _: 'boolFalse' }
  if (constructor === VECTOR_ID) return reader.vector(reader.object, true)
  reader.pos -= 4
  return reader.object()
}

describe('active sessions RPC e2e', () => {
  it('round-trips device metadata, TTL and authorization flags through TL', async () => {
    const { ctx, sessions, rpc } = await setup()
    const current = authKey(1)
    const other = authKey(2)
    await ctx.database.upsert('mtproto_auth_binding', [
      { authKeyId: Buffer.from(current).toString('hex'), platformId: 'test', platformSessionId: 'account' },
      { authKeyId: Buffer.from(other).toString('hex'), platformId: 'test', platformSessionId: 'account' },
    ])
    await sessions.touch(context(other, {
      apiId: 6, deviceModel: 'Pixel', systemVersion: 'SDK 36', appVersion: '12.9.0',
      systemLangCode: 'en', langPack: 'android', langCode: 'en',
    }), { platformSessionId: 'account' })
    const currentContext = context(current)

    await expect(roundTripRpc(rpc, currentContext, {
      _: 'account.setAuthorizationTTL', authorizationTtlDays: 30,
    })).resolves.toEqual({ _: 'boolTrue' })
    await expect(roundTripRpc(rpc, currentContext, {
      _: 'account.changeAuthorizationSettings', hash: authorizationHash(other),
      callRequestsDisabled: true, encryptedRequestsDisabled: true,
    })).resolves.toEqual({ _: 'boolTrue' })
    const result = await roundTripRpc(rpc, currentContext, { _: 'account.getAuthorizations' })

    expect(result).toMatchObject({
      _: 'account.authorizations', authorizationTtlDays: 30,
      authorizations: [
        { _: 'authorization', current: true, hash: Long.ZERO, deviceModel: 'Desktop', platform: 'Windows' },
        {
          _: 'authorization', hash: authorizationHash(other), deviceModel: 'Pixel', platform: 'Android',
          callRequestsDisabled: true, encryptedRequestsDisabled: true,
        },
      ],
    })
  })

  it('terminates one or all other sessions and revokes their auth keys', async () => {
    const { ctx, sessions, rpc, revoke } = await setup()
    const current = authKey(1)
    const second = authKey(2)
    const third = authKey(3)
    await ctx.database.upsert('mtproto_auth_binding', [current, second, third].map(key => ({
      authKeyId: Buffer.from(key).toString('hex'), platformId: 'test', platformSessionId: 'account',
    })))
    await sessions.touch(context(current), { platformSessionId: 'account' })
    await sessions.touch(context(second), { platformSessionId: 'account' })
    await sessions.touch(context(third), { platformSessionId: 'account' })
    const currentContext = context(current)

    await expect(roundTripRpc(rpc, currentContext, {
      _: 'account.resetAuthorization', hash: authorizationHash(second),
    })).resolves.toEqual({ _: 'boolTrue' })
    await expect(roundTripRpc(rpc, currentContext, {
      _: 'auth.resetAuthorizations',
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(revoke.mock.calls.map(([key]) => key)).toEqual([second, third])
    await expect(roundTripRpc(rpc, currentContext, { _: 'account.getAuthorizations' }))
      .resolves.toMatchObject({ authorizations: [{ current: true }] })
  })

  it('returns Bool at layer 134 and auth.loggedOut at layer 135', async () => {
    const { rpc } = await setup()
    const legacy = context(authKey(1), client, 134)
    legacy.afterResponseSettled = () => {}
    const current = context(authKey(2), client, 135)
    current.afterResponseSettled = () => {}

    await expect(roundTripRpc(rpc, legacy, { _: 'auth.logOut' })).resolves.toEqual({ _: 'boolTrue' })
    await expect(roundTripRpc(rpc, current, { _: 'auth.logOut' })).resolves.toEqual({ _: 'auth.loggedOut' })
  })

  it('returns an RPC error and releases its reservation when durable tombstone creation fails', async () => {
    const reserve = createAuthorizationReservationQueue()
    const { rpc, beginRevocation } = await setup(
      reserve,
      async () => true,
      async () => { throw new Error('tombstone write failed') },
    )
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    const logoutContext = context(current)
    const afterResponseSettled = vi.fn()
    logoutContext.afterResponseSettled = afterResponseSettled

    await expect(rpc.dispatch(logoutContext, { _: 'auth.logOut' } as never)).resolves.toMatchObject({
      _: 'mt_rpc_error', errorCode: 500,
    })

    expect(beginRevocation).toHaveBeenCalledExactlyOnceWith(current, logoutContext.connection)
    expect(afterResponseSettled).not.toHaveBeenCalled()
    const afterFailure = reserve(authKeyId)
    await expect(afterFailure.wait()).resolves.toBeUndefined()
    afterFailure.release()
  })

  it('fences a same-key authorization callback while logout waits behind its predecessor', async () => {
    const queue = createAuthorizationReservationQueue()
    let markLogoutQueued!: () => void
    const logoutQueued = new Promise<void>(resolve => { markLogoutQueued = resolve })
    const reserve: ReserveAuthorization = (authKeyId, terminal) => {
      const reservation = queue(authKeyId, terminal)
      if (terminal) markLogoutQueued()
      return reservation
    }
    const { ctx, rpc } = await setup(reserve)
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    const predecessor = reserve(authKeyId)
    const afterResponseSettled: Array<() => void | Promise<void>> = []
    const logoutContext = context(current)
    logoutContext.afterResponseSettled = task => { afterResponseSettled.push(task) }

    const logout = roundTripRpc(rpc, logoutContext, { _: 'auth.logOut' })
    await logoutQueued
    const authorizePlatformSession = async () => {
      const reservation = reserve(authKeyId)
      await reservation.wait()
      try {
        await ctx.database.upsert('mtproto_auth_binding', [{
          authKeyId, platformId: 'test', platformSessionId: 'recreated-account',
        }])
      } finally {
        reservation.release()
      }
    }

    await expect(authorizePlatformSession()).rejects.toMatchObject({
      code: 401,
      text: 'AUTH_KEY_UNREGISTERED',
    })
    await expect(ctx.database.get('mtproto_auth_binding', { authKeyId })).resolves.toEqual([])
    expect(afterResponseSettled).toEqual([])

    predecessor.release()
    await expect(logout).resolves.toEqual({ _: 'auth.loggedOut' })
    expect(afterResponseSettled).toHaveLength(1)
    await afterResponseSettled[0]!()
    const afterSuccessfulRevoke = queue(authKeyId)
    await expect(afterSuccessfulRevoke.wait()).resolves.toBeUndefined()
    afterSuccessfulRevoke.release()
  })

  it('releases the terminal reservation when physical revocation fails', async () => {
    const reserve = createAuthorizationReservationQueue()
    const { rpc } = await setup(reserve, async () => { throw new Error('revoke failed') })
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    const afterResponseSettled: Array<() => void | Promise<void>> = []
    const logoutContext = context(current)
    logoutContext.afterResponseSettled = task => { afterResponseSettled.push(task) }

    await expect(roundTripRpc(rpc, logoutContext, { _: 'auth.logOut' }))
      .resolves.toEqual({ _: 'auth.loggedOut' })
    await expect(afterResponseSettled[0]!()).rejects.toThrow('logout cleanup failed')

    const afterCleanup = reserve(authKeyId)
    await expect(afterCleanup.wait()).resolves.toBeUndefined()
    afterCleanup.release()
  })

  it('attempts both logout database deletes and releases its reservation when one delete fails', async () => {
    const reserve = createAuthorizationReservationQueue()
    const { ctx, rpc, revoke } = await setup(reserve)
    const current = authKey(1)
    const authKeyId = Buffer.from(current).toString('hex')
    const afterResponseSettled: Array<() => void | Promise<void>> = []
    const logoutContext = context(current)
    logoutContext.afterResponseSettled = task => { afterResponseSettled.push(task) }
    const originalRemove = ctx.database.remove.bind(ctx.database) as (...args: any[]) => Promise<unknown>
    const remove = vi.spyOn(ctx.database, 'remove').mockImplementation(async (table, query) => {
      if (table === 'mtproto_auth_binding') throw new Error('binding delete failed')
      return originalRemove(table, query) as never
    })

    await expect(roundTripRpc(rpc, logoutContext, { _: 'auth.logOut' }))
      .resolves.toEqual({ _: 'auth.loggedOut' })
    await expect(afterResponseSettled[0]!()).rejects.toThrow('logout cleanup failed')

    expect(remove.mock.calls.map(([table]) => table)).toEqual([
      'mtproto_auth_binding',
      'mtproto_client_authorization',
    ])
    expect(revoke).toHaveBeenCalledExactlyOnceWith(current)
    const afterCleanup = reserve(authKeyId)
    await expect(afterCleanup.wait()).resolves.toBeUndefined()
    afterCleanup.release()
    remove.mockRestore()
  })

  it('sends the logout response before clearing only the current device state', async () => {
    const reservedAuthKeyIds: string[] = []
    const { ctx, sessions, rpc, revoke } = await setup((authKeyId) => {
      reservedAuthKeyIds.push(authKeyId)
      return { wait: () => Promise.resolve(), release: () => {} }
    })
    const current = authKey(1)
    const other = authKey(2)
    const currentAuthKeyId = Buffer.from(current).toString('hex')
    const otherAuthKeyId = Buffer.from(other).toString('hex')
    const afterResponseSettled: Array<() => void> = []
    await ctx.database.create('mtproto_platform_session', {
      id: 'account', platformId: 'test', userId: 'user', credentials: {}, metadata: {}, active: true,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    })
    await ctx.database.create('mtproto_auth_session', {
      id: 'auth-session', virtualPhone: '15550000000', totpSecret: 'secret',
      platformId: 'test', platformSessionId: 'account',
    })
    await ctx.database.upsert('mtproto_auth_binding', [current, other].map(key => ({
      authKeyId: Buffer.from(key).toString('hex'), platformId: 'test', platformSessionId: 'account',
    })))
    const currentContext = context(current)
    const setPlatformData = vi.fn()
    currentContext.setPlatformData = setPlatformData
    currentContext.afterResponseSettled = task => { afterResponseSettled.push(task) }
    await sessions.touch(currentContext, { platformSessionId: 'account' })
    await sessions.touch(context(other, {
      apiId: 6, deviceModel: 'Pixel', systemVersion: 'SDK 36', appVersion: '12.9.0',
      systemLangCode: 'en', langPack: 'android', langCode: 'en',
    }), { platformSessionId: 'account' })

    await expect(roundTripRpc(rpc, currentContext, { _: 'auth.logOut' }))
      .resolves.toEqual({ _: 'auth.loggedOut' })

    expect(afterResponseSettled).toHaveLength(1)
    expect(reservedAuthKeyIds).toEqual([currentAuthKeyId])
    expect(setPlatformData).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    await expect(ctx.database.get('mtproto_auth_binding', { authKeyId: currentAuthKeyId })).resolves.toHaveLength(1)
    await afterResponseSettled[0]!()

    expect(reservedAuthKeyIds).toEqual([currentAuthKeyId])
    expect(setPlatformData).toHaveBeenCalledExactlyOnceWith(null)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(current)
    await expect(ctx.database.get('mtproto_auth_binding', { authKeyId: currentAuthKeyId })).resolves.toEqual([])
    await expect(ctx.database.get('mtproto_client_authorization', { authKeyId: currentAuthKeyId })).resolves.toEqual([])
    await expect(ctx.database.get('mtproto_platform_session', { id: 'account' })).resolves.toHaveLength(1)
    await expect(ctx.database.get('mtproto_auth_session', { id: 'auth-session' })).resolves.toHaveLength(1)
    await expect(ctx.database.get('mtproto_client_authorization', { authKeyId: otherAuthKeyId })).resolves.toMatchObject([
      { authKeyId: otherAuthKeyId, deviceModel: 'Pixel', platform: 'Android' },
    ])
    await expect(sessions.list(context(other, {
      apiId: 6, deviceModel: 'Pixel', systemVersion: 'SDK 36', appVersion: '12.9.0',
      systemLangCode: 'en', langPack: 'android', langCode: 'en',
    }), { platformSessionId: 'account' })).resolves.toMatchObject({
      authorizations: [{ current: true, deviceModel: 'Pixel' }],
    })
    await expect(ctx.database.get('mtproto_auth_binding', { authKeyId: otherAuthKeyId })).resolves.toHaveLength(1)
  })
})
