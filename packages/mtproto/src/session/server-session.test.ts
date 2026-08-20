import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { AuthKeyDataStore } from './auth-key-data-store.js'
import type { AuthKeyStore } from './auth-key-store.js'
import { ServerAuthKey } from './server-auth-key.js'
import { RpcDependencyRegistry, ServerSession } from './server-session.js'
import { getServerReaderMap } from '../rpc/server-reader-map.js'

describe('ServerAuthKey ID normalization', () => {
  it('copies the final eight bytes from a Buffer view into a standalone Uint8Array', () => {
    const digest = Buffer.from([0xa0, 0xa1, 0xa2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xb0])
    const view = digest.subarray(3, 12)
    const key = new ServerAuthKey(
      { sha1: vi.fn(() => view) } as any,
      { verbose: vi.fn() } as any,
      getServerReaderMap(),
    )

    key.setup(new Uint8Array(128))

    expect(key.id).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(key.id)).toBe(false)
    expect([...key.id]).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    view[8] = 0xff
    expect([...key.id]).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('ServerSession RPC error logging', () => {
  it('queues the rpc_result before running registered after-response work', async () => {
    const order: string[] = []
    const dispatch = vi.fn(async (context: { afterResponse?: (task: () => void) => void }) => {
      context.afterResponse?.(() => { order.push('after-response') })
      return { _: 'boolTrue' as const }
    })
    const { session } = createSession(dispatch)
    const internal = session as unknown as QueuedSession & {
      _apiLayer: number
      _sendEncryptedMessage: ReturnType<typeof vi.fn>
    }
    internal._apiLayer = 228
    internal._sendEncryptedMessage = vi.fn(() => { order.push('rpc-result') })

    await internal._handleRpcCall(
      Long.fromInt(8), { _: 'help.getNearestDc' } as never, Long.fromInt(9),
    )

    expect(order).toEqual(['rpc-result', 'after-response'])
  })

  it('does not run registered after-response work when dispatch returns an RPC error', async () => {
    const afterResponse = vi.fn()
    const dispatch = vi.fn(async (context: { afterResponse?: (task: () => void) => void }) => {
      context.afterResponse?.(afterResponse)
      throw new Error('dispatch failed')
    })
    const { session } = createSession(dispatch)
    const internal = session as unknown as QueuedSession & { _apiLayer: number }
    internal._apiLayer = 228

    await internal._handleRpcCall(
      Long.fromInt(8), { _: 'help.getNearestDc' } as never, Long.fromInt(9),
    )

    expect(afterResponse).not.toHaveBeenCalled()
  })

  it('logs implemented RPC failures at error level with method and wire error details', () => {
    const { session, logger } = createSession()

    sendRpcError(session, 500, 'INTERNAL: database failed', 'messages.getHistory')

    expect(logger.error).toHaveBeenCalledWith(
      '>>> rpc_error for %s (%s): %d %s',
      '1234', 'messages.getHistory', 500, 'INTERNAL: database failed',
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('keeps unimplemented-method responses at warning level', () => {
    const { session, logger } = createSession()

    sendRpcError(session, 500, 'METHOD_NOT_IMPLEMENTED: messages.search', 'messages.search')

    expect(logger.warn).toHaveBeenCalledWith(
      '>>> rpc_error for %s (%s): %d %s',
      '1234', 'messages.search', 500, 'METHOD_NOT_IMPLEMENTED: messages.search',
    )
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('ServerSession Cordis packet pipeline', () => {
  it('wraps each decoded frame in a derived context before protocol processing', async () => {
    const { session, context } = createSession()
    const data = new Uint8Array([1, 2, 3, 4])
    const order: string[] = []
    const process = vi.fn(async (_data: Uint8Array, packetCtx: Context) => {
      order.push('processor')
      expect(packetCtx.mtprotoPacket.data).toBe(data)
    })
    ;(session as unknown as { _processRawData: typeof process })._processRawData = process
    context.on('mtproto/packet', async function (packet, next) {
      order.push('middleware:before')
      expect(Context.is(this)).toBe(true)
      expect(this.mtprotoConnection.id).toBe('test')
      expect(this.mtprotoPacket).toBe(packet)
      expect(packet.sequence).toBe(1)
      await next()
      order.push('middleware:after')
    })

    await (session as unknown as { _onRawData(data: Uint8Array): Promise<void> })._onRawData(data)

    expect(process).toHaveBeenCalledOnce()
    expect(order).toEqual(['middleware:before', 'processor', 'middleware:after'])
  })

  it('serializes queued frames and applies socket read backpressure at the high watermark', async () => {
    const { session, connection } = createSession()
    const internal = session as unknown as {
      _enqueueRawFrame(data: Uint8Array): void
      _onRawData: ReturnType<typeof vi.fn>
    }
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    internal._onRawData = vi.fn(async (data: Uint8Array) => {
      if (data[0] === 0) {
        markFirstStarted()
        await firstGate
      }
    })

    internal._enqueueRawFrame(Uint8Array.of(0))
    await firstStarted
    for (let index = 1; index <= 40; index++) internal._enqueueRawFrame(Uint8Array.of(index))

    expect(internal._onRawData).toHaveBeenCalledTimes(1)
    expect(connection.pauseReading).toHaveBeenCalledOnce()
    releaseFirst()
    await vi.waitFor(() => expect(internal._onRawData).toHaveBeenCalledTimes(41))
    expect(connection.resumeReading).toHaveBeenCalledOnce()
  })

  it('routes follow-up handshake frames around the serialized frame backlog', () => {
    const { session, connection } = createSession()
    const handler = vi.fn()
    const ingress = {
      pending: [] as Uint8Array[],
      handler: handler as ((data: Uint8Array) => void) | null,
    }
    const internal = session as unknown as {
      _handshakeIngress: typeof ingress | null
      _frameQueue: Uint8Array[]
      _enqueueRawFrame(data: Uint8Array): void
    }
    internal._handshakeIngress = ingress

    const handled = Uint8Array.of(1, 2, 3)
    internal._enqueueRawFrame(handled)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0]).toEqual(handled)
    expect(handler.mock.calls[0][0]).not.toBe(handled)
    expect(internal._frameQueue).toEqual([])

    ingress.handler = null
    const pending = Uint8Array.of(4, 5, 6)
    internal._enqueueRawFrame(pending)

    expect(ingress.pending).toHaveLength(1)
    expect(ingress.pending[0]).toEqual(pending)
    expect(ingress.pending[0]).not.toBe(pending)
    expect(connection.pauseReading).not.toHaveBeenCalled()
  })

  it('closes a connection whose decoded-frame backlog exceeds the hard cap', async () => {
    const { session, connection } = createSession()
    const internal = session as unknown as {
      _enqueueRawFrame(data: Uint8Array): void
      _onRawData: ReturnType<typeof vi.fn>
    }
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    internal._onRawData = vi.fn(async (data: Uint8Array) => {
      if (data[0] === 0) {
        markFirstStarted()
        await firstGate
      }
    })

    internal._enqueueRawFrame(Uint8Array.of(0))
    await firstStarted
    for (let index = 0; index < 129; index++) internal._enqueueRawFrame(Uint8Array.of(1))

    expect(connection.close).toHaveBeenCalledOnce()
    releaseFirst()
  })

  it('coalesces concurrent stored-key lookup and adoption for the same connection', async () => {
    let releaseLookup!: () => void
    const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
    const stored = { key: new Uint8Array(256) }
    const keyStore: AuthKeyStore = {
      get: vi.fn(async () => {
        await lookupGate
        return stored
      }),
      save: vi.fn(),
      delete: vi.fn(),
    }
    const { session } = createSession(vi.fn(), keyStore)
    const internal = session as unknown as {
      _resumeStoredAuthKey(id: Uint8Array): Promise<boolean>
      _adoptStoredAuthKey: ReturnType<typeof vi.fn>
    }
    internal._adoptStoredAuthKey = vi.fn().mockResolvedValue(true)
    const id = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)

    const first = internal._resumeStoredAuthKey(id)
    const second = internal._resumeStoredAuthKey(new Uint8Array(id))
    await Promise.resolve()
    expect(keyStore.get).toHaveBeenCalledOnce()
    releaseLookup()

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(internal._adoptStoredAuthKey).toHaveBeenCalledOnce()
  })

  it('admits only one pre-auth frame into async packet middleware at a time', async () => {
    const { session, context } = createSession()
    const internal = session as unknown as {
      _onRawData(data: Uint8Array): Promise<void>
      _processRawData(data: Uint8Array, context: Context): Promise<void>
    }
    const first = new Uint8Array(20)
    const second = new Uint8Array(20)
    second[19] = 2
    const processed: Uint8Array[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let markFirstEntered!: () => void
    const firstEntered = new Promise<void>(resolve => { markFirstEntered = resolve })
    let activeMiddleware = 0
    let maxActiveMiddleware = 0

    internal._processRawData = vi.fn(async (data) => {
      processed.push(data)
    })
    context.on('mtproto/packet', async function (packet, next) {
      activeMiddleware++
      maxActiveMiddleware = Math.max(maxActiveMiddleware, activeMiddleware)
      try {
        if (packet.data === first) {
          markFirstEntered()
          await firstGate
        }
        await next()
      } finally {
        activeMiddleware--
      }
    })

    const firstProcessing = internal._onRawData(first)
    await firstEntered
    await internal._onRawData(second)

    expect(processed).toEqual([])
    expect(maxActiveMiddleware).toBe(1)

    releaseFirst()
    await firstProcessing
    await vi.waitFor(() => expect(processed).toEqual([first, second]))
    expect(maxActiveMiddleware).toBe(1)
  })
})

describe('ServerSession msg_container isolation', () => {
  it('returns an error for one invalid inner request and still dispatches the following RPC', async () => {
    const dispatch = vi.fn().mockResolvedValue({ _: 'boolTrue' })
    const { session, logger } = createSession(dispatch)
    ;(session as unknown as { _apiLayer: number })._apiLayer = 228

    const invalid = TlBinaryWriter.manual(4)
    invalid.uint(0xdeadbeef)
    const valid = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getNearestDc' })
    const container = TlBinaryWriter.manual(8 + 16 + invalid.result().length + 16 + valid.length)
    container.uint(0x73f1f8dc)
    container.uint(2)
    container.long(Long.fromInt(100))
    container.uint(1)
    container.uint(invalid.result().length)
    container.raw(invalid.result())
    container.long(Long.fromInt(104))
    container.uint(3)
    container.uint(valid.length)
    container.raw(valid)

    await (session as unknown as {
      _processDecryptedMessage: (id: Long, seqNo: number, reader: TlBinaryReader, sessionId: Long) => Promise<void>
    })._processDecryptedMessage(
      Long.fromInt(96),
      1,
      new TlBinaryReader(getServerReaderMap(), container.result()),
      Long.fromInt(1),
    )

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ apiLayer: 228 }),
      { _: 'help.getNearestDc' },
    )
    expect(logger.error).toHaveBeenCalledWith(
      'error handling container message %s (constructor=%s, seq=%d): %s',
      '64', '0xdeadbeef', 1, expect.stringContaining('Unknown object id'),
    )
  })

  it('uses the inner ping message id in a pong emitted from a container', async () => {
    const { session } = createSession()
    const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
      _: 'mt_ping', pingId: Long.fromInt(41),
    } as { _: string })
    const container = TlBinaryWriter.manual(8 + 16 + ping.length)
    const innerMessageId = Long.fromInt(104)
    container.uint(0x73f1f8dc)
    container.uint(1)
    container.long(innerMessageId)
    container.uint(0)
    container.uint(ping.length)
    container.raw(ping)

    await (session as unknown as QueuedSession)._processDecryptedMessage(
      Long.fromInt(96),
      0,
      new TlBinaryReader(getServerReaderMap(), container.result()),
      Long.fromInt(1),
    )

    const send = (session as unknown as {
      _sendEncryptedMessage: ReturnType<typeof vi.fn>
    })._sendEncryptedMessage
    const pong = send.mock.calls.find((call) => call[2]?._ === 'mt_pong')?.[2]
    expect(pong?._).toBe('mt_pong')
    expect(pong?.msgId.eq(innerMessageId)).toBe(true)
    expect(pong?.pingId.eq(Long.fromInt(41))).toBe(true)
    expect(send.mock.calls.find((call) => call[2]?._ === 'mt_pong')?.[3].eq(Long.fromInt(1))).toBe(true)
  })
})

type QueuedSession = {
  _enqueueRpcCall: (msgId: Long, request: never, clientSessionId: Long) => Promise<void>
  _handleRpcCall: (msgId: Long, request: never, clientSessionId: Long) => Promise<void>
  _processDecryptedMessage: (msgId: Long, seqNo: number, reader: TlBinaryReader, sessionId: Long) => Promise<void>
  _sessionId: Long
}

describe('ServerSession decrypted RPC queue', () => {
  it('acknowledges a slow RPC before its handler completes', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const dispatch = vi.fn(async () => {
      markStarted()
      await gate
      return { _: 'boolTrue' }
    })
    const { session } = createSession(dispatch)
    const internal = session as unknown as QueuedSession & { _apiLayer: number }
    internal._apiLayer = 228
    const request = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getNearestDc' })

    const processing = internal._processDecryptedMessage(
      Long.fromInt(100), 1, new TlBinaryReader(getServerReaderMap(), request), Long.fromInt(7),
    )
    await started
    await Promise.resolve()

    const send = (session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage
    expect(send.mock.calls.some((call) => call[1] === false && call[2] === undefined)).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()

    release()
    await processing
  })

  it('coalesces an in-flight RPC and replays its serialized result across connections', async () => {
    const registry = new RpcDependencyRegistry()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const dispatch = vi.fn(async () => {
      markStarted()
      await gate
      return { _: 'boolTrue' }
    })
    const first = createSession(dispatch, undefined, registry)
    const second = createSession(dispatch, undefined, registry)
    const key = Uint8Array.from({ length: 256 }, (_, index) => index)
    for (const session of [first.session, second.session]) {
      const state = session as unknown as { _permAuthKey: ServerAuthKey, _apiLayer: number }
      state._permAuthKey.setup(key)
      state._apiLayer = 228
    }
    const messageId = Long.fromInt(120)
    const request = { _: 'help.getNearestDc' } as never

    const original = (first.session as unknown as QueuedSession)._handleRpcCall(
      messageId, request, Long.fromInt(1),
    )
    await started
    const duplicate = (second.session as unknown as QueuedSession)._handleRpcCall(
      messageId, request, Long.fromInt(2),
    )
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledOnce()

    release()
    await Promise.all([original, duplicate])
    expect(dispatch).toHaveBeenCalledOnce()
    const firstSend = (first.session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage
    const secondSend = (second.session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage
    expect(firstSend).toHaveBeenCalledOnce()
    expect(secondSend).toHaveBeenCalledOnce()
    expect(firstSend.mock.calls[0]![0]).toEqual(secondSend.mock.calls[0]![0])

    await (second.session as unknown as QueuedSession)._handleRpcCall(
      messageId, request, Long.fromInt(3),
    )
    expect(dispatch).toHaveBeenCalledOnce()
    expect(secondSend).toHaveBeenCalledTimes(2)
  })

  it('bounds per-connection RPC work and returns SERVER_BUSY after the pending queue fills', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dispatch = vi.fn(async () => {
      await gate
      return { _: 'boolTrue' }
    })
    const { session, connection } = createSession(dispatch)
    const internal = session as unknown as QueuedSession & { _apiLayer: number }
    internal._apiLayer = 228
    const calls = Array.from({ length: 81 }, (_, index) => internal._handleRpcCall(
      Long.fromInt(1_000 + index),
      { _: 'help.getNearestDc' } as never,
      Long.fromInt(9),
    ))

    await vi.waitFor(() => {
      const send = (session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage
      expect(send).toHaveBeenCalledOnce()
    })
    expect(dispatch).toHaveBeenCalledTimes(16)
    expect(connection.pauseReading).toHaveBeenCalledOnce()
    const send = (session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage
    expect(decodeRpcReply(send.mock.calls[0]![0]).result).toEqual({
      _: 'mt_rpc_error', errorCode: 500, errorMessage: 'SERVER_BUSY',
    })

    release()
    await Promise.all(calls)
    expect(dispatch).toHaveBeenCalledTimes(80)
    expect(connection.resumeReading).toHaveBeenCalledOnce()
  })

  it('drops a queued RPC when its connection closes while waiting for dependencies', async () => {
    const dispatch = vi.fn().mockResolvedValue({ _: 'boolTrue' })
    const { session, connection } = createSession(dispatch)
    const internal = session as unknown as QueuedSession & {
      _apiLayer: number
      _waitForRpcDependencies: ReturnType<typeof vi.fn>
    }
    internal._apiLayer = 228
    let release!: () => void
    const waiting = new Promise<boolean>((resolve) => { release = () => resolve(true) })
    internal._waitForRpcDependencies = vi.fn(() => waiting)

    const pending = internal._handleRpcCall(
      Long.fromInt(12),
      { _: 'invokeAfterMsg', msgId: Long.fromInt(8), query: { _: 'help.getConfig' } } as never,
      Long.fromInt(13),
    )
    await vi.waitFor(() => expect(internal._waitForRpcDependencies).toHaveBeenCalledOnce())
    connection.closed = true
    release()
    await pending

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes a wrapped auth.bindTempAuthKey to MTProto key handling instead of RPC dispatch', async () => {
    const dispatch = vi.fn()
    const { session } = createSession(dispatch)
    const internal = session as unknown as QueuedSession & {
      _apiLayer: number
      _handleBindTempAuthKey: ReturnType<typeof vi.fn>
    }
    internal._apiLayer = 227
    internal._handleBindTempAuthKey = vi.fn().mockResolvedValue({ _: 'boolTrue' })
    const messageId = Long.fromInt(12)
    const sessionId = Long.fromInt(13)
    const bindRequest = {
      _: 'auth.bindTempAuthKey',
      permAuthKeyId: Long.fromInt(1),
      nonce: Long.fromInt(2),
      expiresAt: 3,
      encryptedMessage: new Uint8Array([4]),
    }

    await internal._handleRpcCall(messageId, {
      _: 'invokeWithLayer',
      layer: 227,
      query: {
        _: 'initConnection',
        query: bindRequest,
      },
    } as never, sessionId)

    expect(internal._handleBindTempAuthKey).toHaveBeenCalledWith(messageId, bindRequest, sessionId, 227)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('commits asynchronous authorization state before a dependent RPC starts', async () => {
    const { session } = createSession()
    const internal = session as unknown as QueuedSession
    const authImportMessage = Long.fromInt(1)
    const dependentRpcMessage = Long.fromInt(2)
    const authImportSession = Long.fromInt(0x11111111)
    const dependentRpcSession = Long.fromInt(0x22222222)
    const bindings = new Set<string>()
    const observedSessions: string[] = []
    let releaseAuthImport!: () => void
    const authImportWrite = new Promise<void>(resolve => { releaseAuthImport = resolve })
    let authImportStarted!: () => void
    const startedAuthImport = new Promise<void>(resolve => { authImportStarted = resolve })
    let dependentStarted = false
    let completeDependent!: () => void
    const dependentCompleted = new Promise<void>(resolve => { completeDependent = resolve })

    internal._handleRpcCall = async (msgId, _request, clientSessionId) => {
      observedSessions.push(clientSessionId.toString(16))
      if (msgId.eq(authImportMessage)) {
        authImportStarted()
        await authImportWrite
        bindings.add('imported-auth-key')
        return
      }
      dependentStarted = true
      completeDependent()
    }

    try {
      const first = internal._enqueueRpcCall(
        authImportMessage,
        { _: 'auth.importAuthorization' } as never,
        authImportSession,
      )
      await startedAuthImport
      const second = internal._enqueueRpcCall(
        dependentRpcMessage,
        { _: 'help.getConfig' } as never,
        dependentRpcSession,
      )

      await Promise.resolve()
      expect(dependentStarted).toBe(false)

      releaseAuthImport()
      await Promise.all([first, second])
      expect(bindings.has('imported-auth-key')).toBe(true)
      expect(observedSessions).toEqual([
        authImportSession.toString(16),
        dependentRpcSession.toString(16),
      ])
    } finally {
      releaseAuthImport()
    }
  })

  it('serializes export and import QR login transitions', async () => {
    const { session } = createSession()
    const internal = session as unknown as QueuedSession
    const exported = Long.fromInt(20)
    const imported = Long.fromInt(21)
    let releaseExport!: () => void
    const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
    let markExportStarted!: () => void
    const exportStarted = new Promise<void>(resolve => { markExportStarted = resolve })
    let importStarted = false

    internal._handleRpcCall = async (messageId) => {
      if (messageId.eq(exported)) {
        markExportStarted()
        await exportGate
      } else if (messageId.eq(imported)) {
        importStarted = true
      }
    }

    try {
      const first = internal._enqueueRpcCall(
        exported, { _: 'auth.exportLoginToken' } as never, Long.fromInt(1),
      )
      await exportStarted
      const second = internal._enqueueRpcCall(
        imported, { _: 'auth.importLoginToken' } as never, Long.fromInt(1),
      )
      await Promise.resolve()
      expect(importStarted).toBe(false)
      releaseExport()
      await Promise.all([first, second])
      expect(importStarted).toBe(true)
    } finally {
      releaseExport()
    }
  })

  it('does not hold an independent RPC behind a slow ordinary handler', async () => {
    const { session } = createSession()
    const internal = session as unknown as QueuedSession
    const slowMessage = Long.fromInt(10)
    const fastMessage = Long.fromInt(11)
    let releaseSlow!: () => void
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })
    let markSlowStarted!: () => void
    const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve })
    let markFastCompleted!: () => void
    const fastCompleted = new Promise<void>(resolve => { markFastCompleted = resolve })

    internal._handleRpcCall = async (msgId) => {
      if (msgId.eq(slowMessage)) {
        markSlowStarted()
        await slowGate
      } else if (msgId.eq(fastMessage)) {
        markFastCompleted()
      }
    }

    try {
      const slow = internal._enqueueRpcCall(
        slowMessage,
        { _: 'messages.getHistory' } as never,
        Long.fromInt(1),
      )
      await slowStarted
      const fast = internal._enqueueRpcCall(
        fastMessage,
        { _: 'messages.sendMessage' } as never,
        Long.fromInt(1),
      )

      await expect(Promise.race([
        fastCompleted.then(() => 'completed'),
        new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 100)),
      ])).resolves.toBe('completed')

      releaseSlow()
      await Promise.all([slow, fast])
    } finally {
      releaseSlow()
    }
  })

  it('keeps raw MTProto service frames out of the RPC queue', async () => {
    const { session } = createSession()
    const internal = session as unknown as QueuedSession
    let releaseRpc!: () => void
    const rpcBlocked = new Promise<void>(resolve => { releaseRpc = resolve })
    let rpcStarted!: () => void
    const startedRpc = new Promise<void>(resolve => { rpcStarted = resolve })
    internal._handleRpcCall = async () => {
      rpcStarted()
      await rpcBlocked
    }

    const queued = internal._enqueueRpcCall(
      Long.fromInt(1),
      { _: 'messages.getHistory' } as never,
      Long.fromInt(1),
    )
    await startedRpc
    const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
      _: 'mt_ping', pingId: Long.ONE,
    } as { _: string })
    const pingMessageId = Long.fromInt(2)
    await internal._processDecryptedMessage(
      pingMessageId, 0, new TlBinaryReader(getServerReaderMap(), ping), Long.fromInt(2),
    )
    expect((session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage)
      .toHaveBeenCalledWith(
        expect.any(Uint8Array),
        true,
        expect.objectContaining({ _: 'mt_pong', msgId: pingMessageId, pingId: Long.ONE }),
        Long.fromInt(2),
      )

    releaseRpc()
    await queued
  })

  it('echoes ping_delay_disconnect message id without entering the RPC queue', async () => {
    const { session } = createSession()
    const internal = session as unknown as QueuedSession
    const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
      _: 'mt_ping_delay_disconnect', pingId: Long.fromInt(42), disconnectDelay: 10,
    } as { _: string })
    const pingMessageId = Long.fromInt(8)

    await internal._processDecryptedMessage(
      pingMessageId, 0, new TlBinaryReader(getServerReaderMap(), ping), Long.fromInt(3),
    )

    expect((session as unknown as { _sendEncryptedMessage: ReturnType<typeof vi.fn> })._sendEncryptedMessage)
      .toHaveBeenCalledWith(
        expect.any(Uint8Array),
        true,
        expect.objectContaining({ _: 'mt_pong', msgId: pingMessageId, pingId: Long.fromInt(42) }),
        Long.fromInt(3),
      )
  })

  it('continues processing after an RPC handler throws', async () => {
    const { session, logger } = createSession()
    const internal = session as unknown as QueuedSession
    const failedMessage = Long.fromInt(3)
    let completeNext!: () => void
    const nextCompleted = new Promise<void>(resolve => { completeNext = resolve })

    internal._handleRpcCall = async (msgId) => {
      if (msgId.eq(failedMessage)) throw new Error('state write failed')
      completeNext()
    }

    const failed = internal._enqueueRpcCall(
      failedMessage,
      { _: 'auth.importAuthorization' } as never,
      Long.fromInt(3),
    )
    const next = internal._enqueueRpcCall(
      Long.fromInt(4),
      { _: 'help.getConfig' } as never,
      Long.fromInt(4),
    )

    await expect(failed).rejects.toThrow('state write failed')
    await nextCompleted
    await next
    expect(logger.error).toHaveBeenCalledWith(
      'error handling RPC message %s: %s', failedMessage.toString(16), expect.any(Error),
    )
  })
})

describe('ServerSession auth.bindTempAuthKey', () => {
  it('rejects a forged wrapped binding without replacing identity, API layer, or saving the temp key', async () => {
    const keyStore: AuthKeyStore = {
      get: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    }
    const { session, logger } = createSession(vi.fn(), keyStore)
    const crypto = new NodeCryptoProvider()
    const internal = session as unknown as {
      _permAuthKey: ServerAuthKey
      _tempAuthKey: ServerAuthKey | null
      _apiLayer: number | null
      _handleRpcCall: (msgId: Long, request: never, clientSessionId: Long) => Promise<void>
      _sendEncryptedMessage: ReturnType<typeof vi.fn>
    }
    const currentKey = Uint8Array.from({ length: 256 }, (_, index) => index)
    const victimKey = Uint8Array.from({ length: 256 }, (_, index) => (index + 1) & 0xff)
    const tempKey = Uint8Array.from({ length: 256 }, (_, index) => (index + 2) & 0xff)
    const victimId = new Uint8Array(crypto.sha1(victimKey).subarray(-8))
    const originalId = new Uint8Array(crypto.sha1(currentKey).subarray(-8))
    internal._permAuthKey.setup(currentKey)
    internal._tempAuthKey = new ServerAuthKey(crypto, logger as unknown as Logger, getServerReaderMap())
    internal._tempAuthKey.setup(tempKey)
    internal._apiLayer = null
    const storedGet = keyStore.get as ReturnType<typeof vi.fn>
    const storedSave = keyStore.save as ReturnType<typeof vi.fn>
    storedGet.mockResolvedValue({ key: victimKey, apiLayer: 220 })
    const messageId = Long.fromInt(10)
    const sessionId = Long.fromInt(11)

    await internal._handleRpcCall(
      messageId,
      wrappedBindRequest(Long.fromBytesLE(Array.from(victimId)), new Uint8Array(40)),
      sessionId,
    )

    expect(storedGet).toHaveBeenCalledWith(victimId)
    expect(storedSave).not.toHaveBeenCalled()
    expect(Array.from(internal._permAuthKey.id)).toEqual(Array.from(originalId))
    expect(internal._apiLayer).toBeNull()
    const [body, contentRelated, payload, sentSessionId] = internal._sendEncryptedMessage.mock.calls[0]!
    expect(contentRelated).toBe(true)
    expect(payload).toMatchObject({ _: 'rpc_result', result: {
      _: 'mt_rpc_error', errorCode: 400, errorMessage: 'ENCRYPTED_MESSAGE_INVALID',
    } })
    expect(sentSessionId).toEqual(sessionId)
    const reply = decodeRpcReply(body)
    expect(reply.requestMessageId.toString()).toBe(messageId.toString())
    expect(reply.result).toEqual({
      _: 'mt_rpc_error', errorCode: 400, errorMessage: 'ENCRYPTED_MESSAGE_INVALID',
    })
  })

  it('returns INTERNAL without changing identity or API layer when the permanent-key lookup fails', async () => {
    const keyStore: AuthKeyStore = {
      get: vi.fn().mockRejectedValue(new Error('store unavailable')),
      save: vi.fn(),
      delete: vi.fn(),
    }
    const { session, logger } = createSession(vi.fn(), keyStore)
    const crypto = new NodeCryptoProvider()
    const internal = session as unknown as {
      _permAuthKey: ServerAuthKey
      _tempAuthKey: ServerAuthKey | null
      _apiLayer: number | null
      _handleRpcCall: (msgId: Long, request: never, clientSessionId: Long) => Promise<void>
      _sendEncryptedMessage: ReturnType<typeof vi.fn>
    }
    const currentKey = Uint8Array.from({ length: 256 }, (_, index) => index)
    const requestedKey = Uint8Array.from({ length: 256 }, (_, index) => (index + 1) & 0xff)
    const originalId = new Uint8Array(crypto.sha1(currentKey).subarray(-8))
    internal._permAuthKey.setup(currentKey)
    internal._tempAuthKey = new ServerAuthKey(crypto, logger as unknown as Logger, getServerReaderMap())
    internal._tempAuthKey.setup(Uint8Array.from({ length: 256 }, (_, index) => (index + 2) & 0xff))
    const messageId = Long.fromInt(20)
    const sessionId = Long.fromInt(21)

    await internal._handleRpcCall(
      messageId,
      wrappedBindRequest(Long.fromBytesLE(Array.from(crypto.sha1(requestedKey).subarray(-8))), new Uint8Array(40)),
      sessionId,
    )

    expect(keyStore.save).not.toHaveBeenCalled()
    expect(Array.from(internal._permAuthKey.id)).toEqual(Array.from(originalId))
    expect(internal._apiLayer).toBeNull()
    const [body, contentRelated, payload, sentSessionId] = internal._sendEncryptedMessage.mock.calls[0]!
    expect(contentRelated).toBe(true)
    expect(payload).toMatchObject({ _: 'rpc_result', result: {
      _: 'mt_rpc_error', errorCode: 500, errorMessage: 'INTERNAL',
    } })
    expect(sentSessionId).toEqual(sessionId)
    expect(decodeRpcReply(body).result).toEqual({
      _: 'mt_rpc_error', errorCode: 500, errorMessage: 'INTERNAL',
    })
  })

  it('returns INTERNAL without committing a candidate identity when temp-key persistence fails', async () => {
    const crypto = new NodeCryptoProvider()
    const currentKey = Uint8Array.from({ length: 256 }, (_, index) => index)
    const candidateKey = Uint8Array.from({ length: 256 }, (_, index) => (index + 1) & 0xff)
    const candidateId = new Uint8Array(crypto.sha1(candidateKey).subarray(-8))
    const keyStore: AuthKeyStore = {
      get: vi.fn().mockResolvedValue({ key: candidateKey, apiLayer: 220 }),
      save: vi.fn().mockRejectedValue(new Error('store unavailable')),
      delete: vi.fn(),
    }
    const { session, logger } = createSession(vi.fn(), keyStore)
    const internal = session as unknown as {
      _permAuthKey: ServerAuthKey
      _tempAuthKey: ServerAuthKey | null
      _apiLayer: number | null
      _verifyBindInner: ReturnType<typeof vi.fn>
      _handleRpcCall: (msgId: Long, request: never, clientSessionId: Long) => Promise<void>
      _sendEncryptedMessage: ReturnType<typeof vi.fn>
    }
    const originalId = new Uint8Array(crypto.sha1(currentKey).subarray(-8))
    internal._permAuthKey.setup(currentKey)
    internal._tempAuthKey = new ServerAuthKey(crypto, logger as unknown as Logger, getServerReaderMap())
    internal._tempAuthKey.setup(Uint8Array.from({ length: 256 }, (_, index) => (index + 2) & 0xff))
    internal._verifyBindInner = vi.fn().mockReturnValue(true)
    const messageId = Long.fromInt(30)
    const sessionId = Long.fromInt(31)

    await internal._handleRpcCall(
      messageId,
      wrappedBindRequest(Long.fromBytesLE(Array.from(candidateId)), new Uint8Array(40)),
      sessionId,
    )

    expect(keyStore.save).toHaveBeenCalledOnce()
    expect(Array.from(internal._permAuthKey.id)).toEqual(Array.from(originalId))
    expect(internal._apiLayer).toBeNull()
    const [body, contentRelated, payload, sentSessionId] = internal._sendEncryptedMessage.mock.calls[0]!
    expect(contentRelated).toBe(true)
    expect(payload).toMatchObject({ _: 'rpc_result', result: {
      _: 'mt_rpc_error', errorCode: 500, errorMessage: 'INTERNAL',
    } })
    expect(sentSessionId).toEqual(sessionId)
    expect(decodeRpcReply(body).result).toEqual({
      _: 'mt_rpc_error', errorCode: 500, errorMessage: 'INTERNAL',
    })
  })

  it('serializes competing binds before a following RPC observes the final identity', async () => {
    const crypto = new NodeCryptoProvider()
    const currentKey = Uint8Array.from({ length: 256 }, (_, index) => index)
    const firstKey = Uint8Array.from({ length: 256 }, (_, index) => (index + 1) & 0xff)
    const secondKey = Uint8Array.from({ length: 256 }, (_, index) => (index + 2) & 0xff)
    const firstId = new Uint8Array(crypto.sha1(firstKey).subarray(-8))
    const secondId = new Uint8Array(crypto.sha1(secondKey).subarray(-8))
    const saved: Array<{ id: Uint8Array, permanentKeyId: Uint8Array | undefined }> = []
    let releaseFirstSave!: () => void
    const firstSave = new Promise<void>((resolve) => { releaseFirstSave = resolve })
    let markFirstSave!: () => void
    const firstSaveStarted = new Promise<void>((resolve) => { markFirstSave = resolve })
    const keyStore: AuthKeyStore = {
      get: vi.fn((id: Uint8Array) => {
        if (Array.from(id).join() === Array.from(firstId).join()) return { key: firstKey }
        if (Array.from(id).join() === Array.from(secondId).join()) return { key: secondKey }
        return undefined
      }),
      save: vi.fn((id, record) => {
        saved.push({ id: new Uint8Array(id), permanentKeyId: record.permanentKeyId })
        if (saved.length === 1) {
          markFirstSave()
          return firstSave
        }
      }),
      delete: vi.fn(),
    }
    const dispatch = vi.fn().mockResolvedValue({ _: 'boolTrue' })
    const { session, logger } = createSession(dispatch, keyStore)
    const internal = session as unknown as {
      _permAuthKey: ServerAuthKey
      _tempAuthKey: ServerAuthKey | null
      _apiLayer: number | null
      _verifyBindInner: ReturnType<typeof vi.fn>
      _enqueueRpcCall: (msgId: Long, request: never, clientSessionId: Long) => Promise<void>
    }
    internal._permAuthKey.setup(currentKey)
    internal._tempAuthKey = new ServerAuthKey(crypto, logger as unknown as Logger, getServerReaderMap())
    internal._tempAuthKey.setup(Uint8Array.from({ length: 256 }, (_, index) => (index + 3) & 0xff))
    internal._apiLayer = 220
    internal._verifyBindInner = vi.fn().mockReturnValue(true)
    const sessionId = Long.fromInt(40)
    const bind = (id: Uint8Array) => ({
      _: 'auth.bindTempAuthKey',
      permAuthKeyId: Long.fromBytesLE(Array.from(id)),
      nonce: Long.fromInt(41),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      encryptedMessage: new Uint8Array(40),
    } as never)

    const firstBind = internal._enqueueRpcCall(Long.fromInt(42), bind(firstId), sessionId)
    await firstSaveStarted
    const secondBind = internal._enqueueRpcCall(Long.fromInt(43), bind(secondId), sessionId)
    const followingRpc = internal._enqueueRpcCall(Long.fromInt(44), { _: 'help.getConfig' } as never, sessionId)

    await Promise.resolve()
    expect(dispatch).not.toHaveBeenCalled()
    expect(keyStore.get).toHaveBeenCalledTimes(1)

    releaseFirstSave()
    await Promise.all([firstBind, secondBind, followingRpc])

    expect(saved).toHaveLength(2)
    expect(Array.from(saved[0].permanentKeyId!)).toEqual(Array.from(firstId))
    expect(Array.from(saved[1].permanentKeyId!)).toEqual(Array.from(secondId))
    expect(Array.from(internal._permAuthKey.id)).toEqual(Array.from(secondId))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ authKeyId: secondId }),
      { _: 'help.getConfig' },
    )
  })
})

function createSession(
  dispatch = vi.fn(),
  keyStore?: AuthKeyStore,
  dependencyRegistry?: RpcDependencyRegistry,
): {
  session: ServerSession
  context: Context
  connection: {
    closed: boolean
    close: ReturnType<typeof vi.fn>
    pauseReading: ReturnType<typeof vi.fn>
    resumeReading: ReturnType<typeof vi.fn>
  }
  logger: { error: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn> }
} {
  const logger = {
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
  }
  const connection = {
    closed: false,
    close: vi.fn(),
    pauseReading: vi.fn(),
    resumeReading: vi.fn(),
  }
  connection.close.mockImplementation(() => { connection.closed = true })
  const connectionScope = {
    id: 'test', connection, session: undefined as never,
  }
  const context = new Context().extend({ mtprotoConnection: connectionScope })
  const session = new ServerSession(
    context,
    connection as never,
    new NodeCryptoProvider(),
    getServerReaderMap(),
    __tlWriterMap,
    logger as unknown as Logger,
    '',
    Long.ZERO,
    dispatch,
    new AuthKeyDataStore(),
    keyStore,
    undefined,
    undefined,
    undefined,
    dependencyRegistry,
  )
  connectionScope.session = session as never
  // RPC result serialization and logging are independent of transport
  // encryption. Stub the send boundary so this unit test can exercise the
  // actual response path without establishing an auth key first.
  ;(session as unknown as { _sendEncryptedMessage: () => void })._sendEncryptedMessage = vi.fn()
  return { session, context, connection, logger }
}

function decodeRpcReply(body: Uint8Array): { requestMessageId: Long, result: any } {
  const reader = new TlBinaryReader(__tlReaderMap, body)
  expect(reader.uint()).toBe(0xf35c6d01)
  const requestMessageId = reader.long(true)
  const resultId = reader.uint()
  if (resultId === 0x997275b5) return { requestMessageId, result: { _: 'boolTrue' } }
  if (resultId === 0xbc799737) return { requestMessageId, result: { _: 'boolFalse' } }
  reader.pos -= 4
  return { requestMessageId, result: reader.object() }
}

function sendRpcError(session: ServerSession, errorCode: number, errorMessage: string, method: string): void {
  ;(session as unknown as {
    _sendRpcResult: (id: Long, result: object, method: string) => void
  })._sendRpcResult(Long.fromString('1234', true, 16), {
    _: 'mt_rpc_error', errorCode, errorMessage,
  }, method)
}

function wrappedBindRequest(permAuthKeyId: Long, encryptedMessage: Uint8Array): never {
  return {
    _: 'invokeWithLayer',
    layer: 220,
    query: {
      _: 'initConnection',
      apiId: 1,
      deviceModel: 'test',
      systemVersion: 'test',
      appVersion: 'test',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query: {
        _: 'auth.bindTempAuthKey',
        permAuthKeyId,
        nonce: Long.fromInt(12),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        encryptedMessage,
      },
    },
  } as never
}
