import { describe, expect, it, vi } from 'vitest'
import { LarkEventPump } from './events.js'

const { wsClientOptions } = vi.hoisted(() => ({
  wsClientOptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    constructor(options: Record<string, unknown>) {
      wsClientOptions.push(options)
    }
    start = vi.fn(async () => {})
    close = () => {}
  },
  EventDispatcher: class {
    register() {
      return {}
    }
  },
  LoggerLevel: { warn: 2 },
}))

describe('LarkEventPump', () => {
  it('passes handshakeTimeoutMs so a black-holed WS handshake cannot stall the reconnect loop', async () => {
    wsClientOptions.length = 0
    const pump = new LarkEventPump({
      onMessage: async () => {},
      onRecalled: async () => {},
    }, {
      appId: 'cli_test',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn',
    })
    await pump.start()
    expect(wsClientOptions.at(-1)!.handshakeTimeoutMs).toBe(15_000)
    await pump.close()
  })
})
