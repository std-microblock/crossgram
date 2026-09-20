import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'

function client() {
  const path = fileURLToPath(new URL('client/data.ts', import.meta.resolve('@cordisjs/client/package.json')))
  const code = transformSync(readFileSync(path, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  const location = { reload: vi.fn(function (this: unknown) { expect(this).toBe(location) }) }
  const module = { exports: {} as { connect: (ctx: unknown, callback: () => EventTarget) => Promise<unknown> } }
  runInNewContext(code, {
    module, exports: module.exports, require: () => ({ markRaw: (value: unknown) => value }),
    CLIENT_CONFIG: { heartbeat: { interval: 30_000, timeout: 60_000 } }, location,
    console: { log: vi.fn(), debug: vi.fn() }, setTimeout, clearTimeout,
  })
  const sockets: Array<EventTarget & { send: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn> }> = []
  const callback = () => {
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    sockets.push(socket)
    return socket
  }
  const ctx = { client: { socket: { value: undefined } }, emit: vi.fn() }
  return { ...module.exports, location, sockets, callback, ctx }
}

afterEach(() => vi.useRealTimers())

describe('Cordis browser reconnect patch', () => {
  it('calls reload with its Location receiver after a successful reconnect', async () => {
    vi.useFakeTimers()
    const c = client()
    const ready = c.connect(c.ctx, c.callback)
    c.sockets[0].dispatchEvent(new Event('open'))
    await ready
    c.sockets[0].dispatchEvent(new Event('close'))
    expect(c.ctx.client.socket.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.sockets).toHaveLength(2)
    c.sockets[1].dispatchEvent(new Event('open'))
    await Promise.resolve()
    expect(c.location.reload).toHaveBeenCalledOnce()
  })

  it('cancels heartbeat callbacks belonging to the disconnected socket', async () => {
    vi.useFakeTimers()
    const c = client()
    const ready = c.connect(c.ctx, c.callback)
    c.sockets[0].dispatchEvent(new Event('open'))
    await ready
    c.sockets[0].dispatchEvent(new MessageEvent('message', { data: '{"type":"pong"}' }))
    c.sockets[0].dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.sockets[0].send).not.toHaveBeenCalled()
    expect(c.sockets[0].close).not.toHaveBeenCalled()
    expect(c.sockets).toHaveLength(2)
  })

  it('does not reload on a failed reconnect and retries again after close', async () => {
    vi.useFakeTimers()
    const c = client()
    const ready = c.connect(c.ctx, c.callback)
    c.sockets[0].dispatchEvent(new Event('open'))
    await ready
    c.sockets[0].dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1_000)
    c.sockets[1].dispatchEvent(new Event('error'))
    c.sockets[1].dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.location.reload).not.toHaveBeenCalled()
    expect(c.sockets).toHaveLength(3)
  })
})
