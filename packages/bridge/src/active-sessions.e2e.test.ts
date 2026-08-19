import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import {
  isBareVector, type MtprotoClientInfo, type RpcResult, type ServerRpcContext,
} from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import {
  ActiveSessionStore, authorizationHash, registerActiveSessionRpc,
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

async function setup() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const revoke = vi.fn(async (_authKeyId: Uint8Array) => true)
  const sessions = new ActiveSessionStore(ctx.database, revoke)
  const rpc = createCordisRpcTestHarness()
  registerActiveSessionRpc(rpc, sessions, async () => ({ platformSessionId: 'account' }))
  return { ctx, sessions, rpc, revoke }
}

function authKey(value: number): Uint8Array {
  return new Uint8Array(8).fill(value)
}

const client: MtprotoClientInfo = {
  apiId: 2040, deviceModel: 'Desktop', systemVersion: 'Windows 11', appVersion: '6001000',
  systemLangCode: 'en', langPack: 'tdesktop', langCode: 'en',
}

function context(key: Uint8Array, info: MtprotoClientInfo = client): ServerRpcContext {
  return {
    connection: { remoteAddress: '127.0.0.1' } as ServerRpcContext['connection'],
    apiLayer: 228, authKeyId: key, sessionId: Long.ONE, isAuthorized: true,
    clientInfo: info, connectedAt: 1_700_000_000_000, lastActiveAt: 1_700_000_100_000,
    sendUpdate() {}, getPlatformData: <T>() => null as T, setPlatformData() {},
  }
}

async function roundTripRpc(
  rpc: ReturnType<typeof createCordisRpcTestHarness>,
  source: ServerRpcContext,
  query: tl.RpcMethod,
): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const request = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpc.dispatch(source, request)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

function encodeRpcResult(requestId: Long, result: RpcResult): Uint8Array {
  let body: Uint8Array
  if (result._ === 'boolTrue' || result._ === 'boolFalse') {
    const writer = TlBinaryWriter.manual(4)
    writer.uint(result._ === 'boolTrue' ? BOOL_TRUE_ID : BOOL_FALSE_ID)
    body = writer.result()
  } else if (isBareVector(result)) {
    const items = result.items.map(item => TlBinaryWriter.serializeObject(__tlWriterMap, item))
    const writer = TlBinaryWriter.manual(8 + items.reduce((size, item) => size + item.length, 0))
    writer.uint(VECTOR_ID)
    writer.uint(items.length)
    for (const item of items) writer.raw(item)
    body = writer.result()
  } else {
    body = TlBinaryWriter.serializeObject(__tlWriterMap, result)
  }
  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(requestId)
  writer.raw(body)
  return writer.result()
}

function decodeRpcResult(bytes: Uint8Array): any {
  const reader = new TlBinaryReader(__tlReaderMap, bytes)
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
})
