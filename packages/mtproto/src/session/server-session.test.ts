import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import Long from 'long'
import { AuthKeyDataStore } from './auth-key-data-store.js'
import { ServerSession } from './server-session.js'

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

function createSession(): {
  session: ServerSession
  logger: { error: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn> }
} {
  const logger = {
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
  }
  const session = new ServerSession(
    {} as never,
    new NodeCryptoProvider(),
    __tlReaderMap,
    __tlWriterMap,
    logger as unknown as Logger,
    '',
    Long.ZERO,
    { dispatch: vi.fn() },
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
