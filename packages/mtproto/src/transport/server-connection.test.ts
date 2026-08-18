import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { LogManager } from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import type { Socket } from 'node:net'
import { ServerConnection, type TransportTrafficSample } from './server-connection.js'

const crypto = new NodeCryptoProvider()
const log = new LogManager('test', new NodePlatform()).create('test')

beforeAll(async () => {
  await crypto.initialize?.()
})

afterEach(() => {
  vi.useRealTimers()
})

function mockSocket(overrides: Partial<Record<'write' | 'end' | 'destroy' | 'writableLength' | 'remoteAddress' | 'remotePort', unknown>> = {}): Socket {
  const socket = new EventEmitter() as unknown as Socket
  ;(socket as unknown as { write: unknown }).write = overrides.write ?? vi.fn(() => true)
  ;(socket as unknown as { end: unknown }).end = overrides.end ?? vi.fn()
  ;(socket as unknown as { destroy: unknown }).destroy = overrides.destroy ?? vi.fn()
  Object.defineProperty(socket, 'writableLength', {
    get: () => (overrides.writableLength as number) ?? 0,
  })
  Object.defineProperty(socket, 'remoteAddress', {
    get: () => (overrides.remoteAddress as string) ?? '127.0.0.1',
  })
  Object.defineProperty(socket, 'remotePort', {
    get: () => (overrides.remotePort as number) ?? 12345,
  })
  ;(socket as unknown as { off: unknown }).off = vi.fn()
  return socket
}

/** Build a connection whose transport was already detected (abridged). */
function makeConnection(socket: Socket, onTraffic?: (sample: TransportTrafficSample) => void): ServerConnection {
  const connection = new ServerConnection(socket, crypto, log, onTraffic)
  socket.emit('data', Buffer.from([0xef])) // abridged tag byte
  return connection
}

describe('ServerConnection stall tracking', () => {
  it('reports real socket bytes at the transport boundary', () => {
    const samples: TransportTrafficSample[] = []
    const connection = makeConnection(mockSocket(), sample => samples.push(sample))
    connection.send(Buffer.from('hello'))

    expect(samples[0]).toMatchObject({ direction: 'received', bytes: 1 })
    expect(samples[1]).toMatchObject({ direction: 'sent' })
    expect(samples[1]!.bytes).toBeGreaterThan(5)
    expect(samples.every(sample => Number.isFinite(sample.timestamp))).toBe(true)
  })

  it('reports healthy while the socket accepts writes without backpressure', () => {
    const write = vi.fn(() => true)
    const connection = makeConnection(mockSocket({ write }))
    connection.send(Buffer.from('hello'))
    expect(write).toHaveBeenCalledOnce()
    expect(connection.stalledForMs).toBe(0)
  })

  it('starts counting once socket.write reports backpressure and clears on drain', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const write = vi.fn(() => false)
    const socket = mockSocket({ write })
    const connection = makeConnection(socket)

    connection.send(Buffer.from('frame'))
    expect(write).toHaveBeenCalledOnce()
    expect(connection.stalledForMs).toBeGreaterThanOrEqual(0)

    vi.setSystemTime(1_000_000 + 5_000)
    expect(connection.stalledForMs).toBe(5_000)

    // The peer drains the socket: the stall counter must reset to zero.
    socket.emit('drain')
    expect(connection.stalledForMs).toBe(0)
  })

  it('exposes buffered bytes and a peer label for diagnostics', () => {
    const connection = makeConnection(mockSocket({ writableLength: 4096 }))
    expect(connection.bufferedBytes).toBe(4096)
    expect(connection.label).toBe('127.0.0.1:12345')
  })

  it('stops counting after close and detaches the drain listener', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const socket = mockSocket({ write: () => false })
    const connection = makeConnection(socket)
    connection.send(Buffer.from('frame'))
    expect(connection.closed).toBe(false)

    connection.close()
    expect(connection.closed).toBe(true)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect((socket as unknown as { off: ReturnType<typeof vi.fn> }).off).toHaveBeenCalledWith('drain', expect.any(Function))
    expect(connection.stalledForMs).toBe(0)
  })
})
