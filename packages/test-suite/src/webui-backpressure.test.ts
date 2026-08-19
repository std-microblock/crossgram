import { describe, expect, it, vi } from 'vitest'
import { Client, WebUI } from '@cordisjs/plugin-webui'

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

interface FakeSocket {
  bufferedAmount: number
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  terminate?: ReturnType<typeof vi.fn>
}

function socket(bufferedAmount = 0, terminate = vi.fn()): FakeSocket {
  return { bufferedAmount, send: vi.fn(), close: vi.fn(), terminate }
}

describe('Cordis WebUI socket backpressure patch', () => {
  it('continues broadcasting to healthy clients while terminating a slow client', () => {
    const healthy = socket()
    const slow = socket(MAX_BUFFERED_BYTES - 1)
    const webui = {
      clients: {
        healthy: { socket: healthy },
        slow: { socket: slow },
      },
    }

    WebUI.prototype.broadcast.call(webui as never, 'stats:update', { sequence: 1 })

    expect(healthy.send).toHaveBeenCalledOnce()
    expect(JSON.parse(healthy.send.mock.calls[0]![0])).toEqual({
      type: 'stats:update', body: { sequence: 1 },
    })
    expect(slow.send).not.toHaveBeenCalled()
    expect(slow.terminate).toHaveBeenCalledOnce()
  })

  it('guards direct client responses and falls back to a retryable close code', () => {
    const slow = socket(MAX_BUFFERED_BYTES)
    delete slow.terminate

    Client.prototype.send.call({ socket: slow } as never, {
      type: 'rpc:response', body: { ok: true },
    })

    expect(slow.send).not.toHaveBeenCalled()
    expect(slow.close).toHaveBeenCalledWith(1013, 'WebUI client is too slow')
  })

  it('counts the pending payload itself before writing to the socket', () => {
    const almostFull = socket(MAX_BUFFERED_BYTES - 16)

    Client.prototype.send.call({ socket: almostFull } as never, {
      type: 'entry:init', body: 'payload larger than the remaining allowance',
    })

    expect(almostFull.send).not.toHaveBeenCalled()
    expect(almostFull.terminate).toHaveBeenCalledOnce()
  })

  it('keeps a permanently stalled client bounded across a sustained broadcast burst', () => {
    const stalled = socket()
    stalled.send.mockImplementation((payload: string) => {
      stalled.bufferedAmount += Buffer.byteLength(payload)
    })
    const webui = { clients: { stalled: { socket: stalled } } }

    for (let index = 0; index < 20_000; index++) {
      WebUI.prototype.broadcast.call(webui as never, 'entry:delta', {
        index, payload: 'x'.repeat(1_024),
      })
    }

    expect(stalled.bufferedAmount).toBeLessThanOrEqual(MAX_BUFFERED_BYTES)
    expect(stalled.send.mock.calls.length).toBeLessThan(20_000)
    expect(stalled.terminate).toHaveBeenCalledOnce()
  })
})
