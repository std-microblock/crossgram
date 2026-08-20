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

function mockSocket(overrides: Partial<Record<
  'write' | 'end' | 'destroy' | 'pause' | 'resume' | 'writableLength' | 'remoteAddress' | 'remotePort', unknown
>> = {}): Socket {
  const socket = new EventEmitter() as unknown as Socket
  ;(socket as unknown as { write: unknown }).write = overrides.write ?? vi.fn(() => true)
  ;(socket as unknown as { end: unknown }).end = overrides.end ?? vi.fn()
  ;(socket as unknown as { destroy: unknown }).destroy = overrides.destroy ?? vi.fn()
  ;(socket as unknown as { pause: unknown }).pause = overrides.pause ?? vi.fn(() => socket)
  ;(socket as unknown as { resume: unknown }).resume = overrides.resume ?? vi.fn(() => socket)
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

  it('pauses and resumes socket reads idempotently for bounded session queues', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const connection = makeConnection(mockSocket({ pause, resume }))

    connection.pauseReading()
    connection.pauseReading()
    expect(pause).toHaveBeenCalledOnce()

    connection.resumeReading()
    connection.resumeReading()
    expect(resume).toHaveBeenCalledOnce()
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

  it('delivers owned frames that survive receive-buffer reuse', async () => {
    const socket = mockSocket()
    const connection = makeConnection(socket)
    const frames: Uint8Array[] = []
    connection.listen(frame => frames.push(frame))

    socket.emit('data', Buffer.from([1, 1, 2, 3, 4]))
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    socket.emit('data', Buffer.from([1, 9, 8, 7, 6]))
    await vi.waitFor(() => expect(frames).toHaveLength(2))

    expect(frames[0]).toEqual(Uint8Array.of(1, 2, 3, 4))
    expect(frames[1]).toEqual(Uint8Array.of(9, 8, 7, 6))
  })

  it('serializes asynchronous codec drains across socket data events', async () => {
    const socket = mockSocket()
    const connection = makeConnection(socket)
    const frames: Uint8Array[] = []
    const releases: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const codec = {
      tag: () => new Uint8Array(),
      reset: () => {},
      encode: () => {},
      decode(reader: import('@fuman/io').Bytes) {
        if (reader.available === 0) return null
        const value = reader.readSync(1)[0]
        active++
        maxActive = Math.max(maxActive, active)
        return new Promise<Uint8Array>((resolve) => {
          releases.push(() => {
            active--
            resolve(Uint8Array.of(value))
          })
        })
      },
    }
    ;(connection as unknown as { _codec: typeof codec })._codec = codec
    connection.listen(frame => frames.push(frame))

    socket.emit('data', Buffer.from([11]))
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    socket.emit('data', Buffer.from([22]))
    expect(releases).toHaveLength(1)
    expect(maxActive).toBe(1)

    releases.shift()!()
    await vi.waitFor(() => expect(frames).toEqual([Uint8Array.of(11)]))
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases.shift()!()
    await vi.waitFor(() => expect(frames).toEqual([Uint8Array.of(11), Uint8Array.of(22)]))
    expect(maxActive).toBe(1)
  })

  it('serializes asynchronous stateful encoding and preserves socket write order', async () => {
    const writes: Uint8Array[] = []
    const write = vi.fn((data: Uint8Array) => {
      writes.push(new Uint8Array(data))
      return true
    })
    const socket = mockSocket({ write })
    const connection = makeConnection(socket)
    const releases: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const codec = {
      tag: () => new Uint8Array(),
      reset: () => {},
      decode: () => null,
      encode(data: Uint8Array, writable: import('@fuman/io').Bytes) {
        const value = data[0]
        active++
        maxActive = Math.max(maxActive, active)
        return new Promise<void>((resolve) => {
          releases.push(() => {
            const target = writable.writeSync(1)
            target[0] = value
            writable.disposeWriteSync(1)
            active--
            resolve()
          })
        })
      },
    }
    ;(connection as unknown as { _codec: typeof codec })._codec = codec

    connection.send(Uint8Array.of(11))
    connection.send(Uint8Array.of(22))
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    expect(maxActive).toBe(1)
    expect(write).not.toHaveBeenCalled()

    releases.shift()!()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(writes[0]).toEqual(Uint8Array.of(11))
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    expect(maxActive).toBe(1)

    releases.shift()!()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(writes[1]).toEqual(Uint8Array.of(22))
  })
})
