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
      _processDecryptedMessage: (id: Long, seqNo: number, reader: TlBinaryReader) => Promise<void>
    })._processDecryptedMessage(
      Long.fromInt(96),
      1,
      new TlBinaryReader(getServerReaderMap(), container.result()),
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
