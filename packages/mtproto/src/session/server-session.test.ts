import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlWriterMap } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { AuthKeyDataStore } from './auth-key-data-store.js'
import { ServerSession } from './server-session.js'
import { getServerReaderMap } from '../rpc/server-reader-map.js'

describe('ServerSession RPC error logging', () => {
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

function createSession(dispatch = vi.fn()): {
  session: ServerSession
  logger: { error: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn> }
} {
  const logger = {
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
  }
  const session = new ServerSession(
    {} as never,
    new NodeCryptoProvider(),
    getServerReaderMap(),
    __tlWriterMap,
    logger as unknown as Logger,
    '',
    Long.ZERO,
    { dispatch },
    new AuthKeyDataStore(),
  )
  // RPC result serialization and logging are independent of transport
  // encryption. Stub the send boundary so this unit test can exercise the
  // actual response path without establishing an auth key first.
  ;(session as unknown as { _sendEncryptedMessage: () => void })._sendEncryptedMessage = vi.fn()
  return { session, logger }
}

function sendRpcError(session: ServerSession, errorCode: number, errorMessage: string, method: string): void {
  ;(session as unknown as {
    _sendRpcResult: (id: Long, result: object, method: string) => void
  })._sendRpcResult(Long.fromString('1234', true, 16), {
    _: 'mt_rpc_error', errorCode, errorMessage,
  }, method)
}
