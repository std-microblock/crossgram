import { describe, expect, it, vi } from 'vitest'
import { Context, type Logger as CordisLogger } from 'cordis'
import { createCordisLogManager } from './cordis-logger.js'

describe('Cordis protocol logger adapter', () => {
  it('routes levels and child tags through named Cordis loggers', () => {
    const calls: Array<{ name: string, level: string, args: unknown[] }> = []
    const factory = ((name = '') => Object.fromEntries(
      ['error', 'warn', 'info', 'debug'].map((level) => [level, (...args: unknown[]) => {
        calls.push({ name, level, args })
      }]),
    ) as unknown as CordisLogger) as Context['logger']
    const manager = createCordisLogManager(factory)

    manager.info('listening on %s:%d', '127.0.0.1', 4430)
    const connection = manager.create('conn:127.0.0.1:1234')
    connection.warn('unknown key %h', Uint8Array.of(0x01, 0xab))
    connection.verbose('rpc %s', 'messages.getDialogs')

    expect(calls).toEqual([
      { name: 'mtproto', level: 'info', args: ['listening on %s:%d', '127.0.0.1', 4430] },
      { name: 'mtproto/conn:127.0.0.1:1234', level: 'warn', args: ['unknown key 01ab'] },
      { name: 'mtproto/conn:127.0.0.1:1234', level: 'debug', args: ['rpc %s', 'messages.getDialogs'] },
    ])
  })

  it('creates each named Cordis logger only once', () => {
    const logger = {
      error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    } as unknown as CordisLogger
    const factory = vi.fn(() => logger) as unknown as Context['logger']
    const manager = createCordisLogManager(factory)
    const child = manager.create('auth')

    child.debug('one')
    child.info('two')

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith('mtproto/auth')
  })

  it('publishes protocol messages to the real Cordis LoggerService buffer', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(() => {})
    await fiber
    const logging = ctx.intercept('logger', { level: 3 })
    const manager = createCordisLogManager(logging.logger)

    try {
      manager.create('transport').warn('stale auth key %h', Uint8Array.of(0xca, 0xfe))

      expect(ctx.logger.buffer.at(-1)).toMatchObject({
        name: 'mtproto/transport',
        type: 'warn',
        args: ['stale auth key cafe'],
      })
    } finally {
      await fiber.dispose()
    }
  })
})
