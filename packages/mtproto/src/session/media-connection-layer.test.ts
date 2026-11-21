/**
 * 媒体连接（`auth.exportAuthorization` 之后在新连接上 `auth.importAuthorization`）的
 * API layer 时序。
 *
 * 新连接 = 新 ServerSession，`_apiLayer` 从 null 开始；而 import 往往就是这条连接上的第一个
 * RPC。客户端只有认为该 DC 还没 init 时才会套 `invokeWithLayer(initConnection(...))`，所以
 * 这层兜底必须存在：裸 RPC 要能从“同一客户端在别的连接上协商过的层”继承，否则媒体连接会一直
 * 收 CONNECTION_NOT_INITED（Telegram Desktop 对 400 的 import 不做重发）。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import Long from 'long'
import { TlBinaryReader } from '@mtcute/tl-runtime'
import { AuthKeyDataStore } from './auth-key-data-store.js'
import { ServerSession } from './server-session.js'
import { getServerReaderMap } from '../rpc/server-reader-map.js'

interface Harness {
  session: ServerSession
  internals: {
    _handleRpcCall: (msgId: Long, request: unknown, clientSessionId: Long) => Promise<void>
    _apiLayer: number | null
    _sendEncryptedMessage: ReturnType<typeof vi.fn>
  }
  replies: Array<{ requestMessageId: Long, result: any }>
}

function createSession(
  dispatch = vi.fn(async () => ({ _: 'boolTrue' as const })),
  getApiLayer?: (authKeyId: Uint8Array) => number | undefined,
): Harness {
  const logger = {
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
  }
  const connection = {
    closed: false,
    close: vi.fn(() => { connection.closed = true }),
    pauseReading: vi.fn(),
    resumeReading: vi.fn(),
  }
  const context = new Context().extend({
    mtprotoConnection: { id: 'probe', connection, session: undefined as never },
  })
  const session = new ServerSession(
    context,
    connection as never,
    new NodeCryptoProvider(),
    getServerReaderMap(),
    __tlWriterMap,
    logger as unknown as Logger,
    '',
    Long.ZERO,
    dispatch as never,
    new AuthKeyDataStore(),
    undefined, // keyStore
    undefined, // debug
    undefined, // onApiLayer
    getApiLayer,
    undefined,
    undefined,
  )
  const replies: Harness['replies'] = []
  const internals = session as unknown as Harness['internals']
  internals._sendEncryptedMessage = vi.fn((body: Uint8Array) => {
    // rpc_result#f35c6d01 req_msg_id:long result:Object
    const reader = new TlBinaryReader(__tlReaderMap, body)
    const kind = reader.uint()
    if (kind !== 0xf35c6d01) return
    const requestMessageId = reader.long(true)
    const resultId = reader.uint()
    const result = resultId === 0x2144ca19
      ? { _: 'mt_rpc_error', errorCode: reader.int(), errorMessage: reader.string() }
      : resultId === 0x997275b5
        ? { _: 'boolTrue' }
        : { _: `unknown:${resultId.toString(16)}` }
    replies.push({ requestMessageId, result })
  })
  return { session, internals, replies }
}

/** invokeWithLayer(layer, initConnection(query: req)) — what a client sends on a new connection. */
function wrapped(request: unknown, layer = 228): unknown {
  return {
    _: 'invokeWithLayer',
    layer,
    query: {
      _: 'initConnection',
      flags: 0,
      apiId: 2040,
      deviceModel: 'Probe',
      systemVersion: 'linux',
      appVersion: 'probe 1.0',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query: request,
    },
  }
}

const importRequest = () => ({
  _: 'auth.importAuthorization', id: 12345, bytes: new Uint8Array(16).fill(7),
})

describe('media connection API layer', () => {
  it('rejects a bare auth.importAuthorization on a fresh connection with CONNECTION_NOT_INITED', async () => {
    const dispatch = vi.fn(async () => ({ _: 'auth.authorization' as const }))
    const { internals, replies } = createSession(dispatch as never)

    await internals._handleRpcCall(Long.fromInt(10), importRequest(), Long.fromInt(1))

    expect(replies[0]?.result).toMatchObject({
      _: 'mt_rpc_error', errorCode: 400, errorMessage: 'CONNECTION_NOT_INITED',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('lets the same request through once it carries invokeWithLayer(initConnection(...))', async () => {
    const dispatch = vi.fn(async () => ({ _: 'boolTrue' as const }))
    const { internals, replies } = createSession(dispatch as never)

    await internals._handleRpcCall(Long.fromInt(11), wrapped(importRequest()), Long.fromInt(1))

    expect(internals._apiLayer).toBe(228)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(replies[0]?.result._).toBe('boolTrue')
  })

  it('inherits the layer the same client negotiated on another connection', async () => {
    // 这个客户端在主连接上协商过 228；媒体连接是新的 auth key，服务端按客户端指纹把层给它，
    // 于是 import 不需要再吃一次 CONNECTION_NOT_INITED。
    const dispatch = vi.fn(async () => ({ _: 'boolTrue' as const }))
    const { session, internals, replies } = createSession(
      dispatch as never,
      () => 228,
    )
    ;(session as unknown as { _permAuthKey: unknown })._permAuthKey = {
      ready: true, id: new Uint8Array(8).fill(1),
    }

    await internals._handleRpcCall(Long.fromInt(12), { _: 'help.getConfig' } as never, Long.fromInt(1))

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(replies[0]?.result._).toBe('boolTrue')
  })
})
