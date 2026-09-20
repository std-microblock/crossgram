import { afterEach, describe, expect, it, vi } from 'vitest'
import Long from 'long'
import { RpcDependencyRegistry } from './server-session.js'

const key = Uint8Array.of(1)
const reply = () => Promise.resolve({ reqMsgId: Long.ONE, body: new Uint8Array(1024), resultKind: 'test' })
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

describe('idle RPC replay retention', () => {
  afterEach(() => vi.useRealTimers())

  it('expires completed replies without requiring another RPC', async () => {
    vi.useFakeTimers()
    const registry = new RpcDependencyRegistry()
    const execute = vi.fn(reply)
    await registry.execute(key, Long.ONE, 'a', execute)
    await tick()
    expect([...registry.inFlightAuthKeyIds]).toEqual([])
    vi.advanceTimersByTime(120_001)
    registry.prune()
    await registry.execute(key, Long.ONE, 'a', execute)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('expires an old replay even after a hit moves it behind newer entries', async () => {
    vi.useFakeTimers()
    const registry = new RpcDependencyRegistry()
    const execute = vi.fn(reply)
    await registry.execute(key, Long.ONE, 'a', execute)
    vi.advanceTimersByTime(60_000)
    await registry.execute(key, Long.fromInt(2), 'b', reply)
    await registry.execute(key, Long.ONE, 'a', execute)
    vi.advanceTimersByTime(60_001)
    registry.prune()
    await registry.execute(key, Long.ONE, 'a', execute)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('still enforces the byte limit before the next TTL deadline', async () => {
    vi.useFakeTimers()
    const registry = new RpcDependencyRegistry()
    const execute = vi.fn(async () => ({
      reqMsgId: Long.ONE, body: new Uint8Array(33 * 1024 * 1024), resultKind: 'test',
    }))
    await registry.execute(key, Long.ONE, 'large', execute)
    await registry.execute(key, Long.ONE, 'large', execute)
    expect(execute).toHaveBeenCalledTimes(2)
    registry.clear()
    expect([...registry.inFlightAuthKeyIds]).toEqual([])
  })

  it('pins disconnected in-flight devices and never evicts their unfinished replies', async () => {
    vi.useFakeTimers()
    const registry = new RpcDependencyRegistry()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async () => { await gate; return reply() })
    const pending = registry.execute(key, Long.ONE, 'a', execute)
    expect([...registry.inFlightAuthKeyIds]).toEqual(['01'])
    vi.advanceTimersByTime(600_000)
    registry.prune()
    expect(registry.execute(key, Long.ONE, 'a', execute)).toBe(pending)
    release()
    await pending
    await tick()
    expect([...registry.inFlightAuthKeyIds]).toEqual([])
    expect(execute).toHaveBeenCalledOnce()
  })
})
