import { EventEmitter, getEventListeners, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net, { type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  QQBridgePcmTransport, QQBridgePcmTransportError,
} from './qq-bridge-pcm-transport.js'
import {
  QQ_VOICE_PCM_FORMAT, QQVoiceMediaClosedError, type QQVoiceMediaConnectOptions,
} from './voice-media.js'

const leaseId = '0123456789abcdef0123456789abcdef'
const token = new Uint8Array(32).fill(7)

function options(overrides: Partial<QQVoiceMediaConnectOptions> = {}): QQVoiceMediaConnectOptions {
  return {
    callId: 'opaque-call-id',
    leaseId,
    token: new Uint8Array(token),
    signal: new AbortController().signal,
    ...overrides,
  }
}

function frame(type: number, payload: Uint8Array): Buffer {
  const output = Buffer.alloc(5 + payload.byteLength)
  output[0] = type
  output.writeUInt32BE(payload.byteLength, 1)
  output.set(payload, 5)
  return output
}

function pcm(value: number): Uint8Array {
  return new Uint8Array(QQ_VOICE_PCM_FORMAT.bytesPerFrame).fill(value)
}

class BackpressuredSocket extends EventEmitter {
  destroyed = false
  destroyCalls = 0
  private callback?: (error?: Error | null) => void

  constructor(private readonly completeSynchronously = false) {
    super()
  }

  write(_data: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.callback = callback
    if (this.completeSynchronously) this.complete()
    return false
  }

  connect(): void {
    this.emit('connect')
  }

  complete(error?: Error): void {
    const callback = this.callback
    this.callback = undefined
    callback?.(error)
  }

  destroy(): this {
    this.destroyed = true
    this.destroyCalls += 1
    this.emit('close')
    return this
  }
}

function backpressuredTransport(socket: BackpressuredSocket): QQBridgePcmTransport {
  return new QQBridgePcmTransport('/tmp/crossgram-qq-pcm-backpressure.sock', {
    socketFactory: () => socket,
  } as never)
}

function expectBackpressureWaitersCleaned(socket: BackpressuredSocket, signal: AbortSignal): void {
  expect(socket.listenerCount('drain')).toBe(0)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
}

function expectConnectWaitersCleaned(socket: BackpressuredSocket, signal: AbortSignal): void {
  expectBackpressureWaitersCleaned(socket, signal)
  expect(socket.listenerCount('connect')).toBe(0)
  expectConnectionListenersCleaned(socket)
}

function expectConnectionListenersCleaned(socket: BackpressuredSocket): void {
  expect(socket.listenerCount('data')).toBe(0)
  expect(socket.listenerCount('error')).toBe(0)
  expect(socket.listenerCount('close')).toBe(0)
  expect(socket.listenerCount('drain')).toBe(0)
}

async function unixServer(handler: (socket: Socket) => void): Promise<{
  server: Server
  socketPath: string
  close(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-qq-pcm-'))
  const socketPath = join(directory, 'media.sock')
  const server = net.createServer(handler)
  server.listen(socketPath)
  await once(server, 'listening')
  return {
    server,
    socketPath,
    async close() {
      server.close()
      await once(server, 'close')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function readFrames(socket: Socket, receive: (type: number, payload: Buffer) => void): void {
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    pending = pending.byteLength ? Buffer.concat([pending, bytes]) : Buffer.from(bytes)
    while (pending.byteLength >= 5) {
      const length = pending.readUInt32BE(1)
      if (pending.byteLength < 5 + length) return
      receive(pending[0]!, pending.subarray(5, 5 + length))
      pending = pending.subarray(5 + length)
    }
  })
}

describe('QQ Bridge PCM transport', () => {
  const servers: Array<{ close(): Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it('waits for a delayed drain before authenticating and removes write waiters', async () => {
    const socket = new BackpressuredSocket()
    const controller = new AbortController()
    const ownedToken = new Uint8Array(token)
    let settled = false
    const connecting = backpressuredTransport(socket).connect(options({ signal: controller.signal, token: ownedToken }))
    void connecting.then(() => { settled = true })

    socket.connect()
    socket.complete()
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.emit('drain')
    socket.emit('data', frame(0x80, Uint8Array.of(1)))

    const connection = await connecting
    expect(ownedToken).toEqual(new Uint8Array(32))
    expectBackpressureWaitersCleaned(socket, controller.signal)
    await connection.destroy()
  })

  it('waits for drain after receiving READY before the auth write completes', async () => {
    const socket = new BackpressuredSocket()
    const controller = new AbortController()
    let settled = false
    const connecting = backpressuredTransport(socket).connect(options({ signal: controller.signal }))
    void connecting.then(() => { settled = true })

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    socket.complete()
    await Promise.resolve()
    expect(settled).toBe(false)

    socket.emit('drain')
    const connection = await connecting
    expectBackpressureWaitersCleaned(socket, controller.signal)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('data')).toBe(1)
    expect(socket.listenerCount('error')).toBe(1)
    expect(socket.listenerCount('close')).toBe(1)
    await connection.destroy()
  })

  it('waits for drain when the auth write callback completes synchronously', async () => {
    const socket = new BackpressuredSocket(true)
    const controller = new AbortController()
    let settled = false
    const connecting = backpressuredTransport(socket).connect(options({ signal: controller.signal }))
    void connecting.then(() => { settled = true })

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    await Promise.resolve()
    expect(settled).toBe(false)

    socket.emit('drain')
    const connection = await connecting
    expectBackpressureWaitersCleaned(socket, controller.signal)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('data')).toBe(1)
    expect(socket.listenerCount('error')).toBe(1)
    expect(socket.listenerCount('close')).toBe(1)
    await connection.destroy()
  })

  it('removes connection listeners when destroyed repeatedly', async () => {
    const socket = new BackpressuredSocket()
    const connectionPromise = backpressuredTransport(socket).connect(options())

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    socket.complete()
    socket.emit('drain')
    const connection = await connectionPromise

    await connection.destroy()
    expectConnectionListenersCleaned(socket)
    await connection.destroy()
    expectConnectionListenersCleaned(socket)
    expect(socket.destroyCalls).toBe(1)
  })

  it('removes connection listeners when the remote closes', async () => {
    const socket = new BackpressuredSocket()
    const connectionPromise = backpressuredTransport(socket).connect(options())

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    socket.complete()
    socket.emit('drain')
    await connectionPromise
    socket.emit('close')

    expectConnectionListenersCleaned(socket)
  })

  it('removes connection listeners when the remote errors', async () => {
    const socket = new BackpressuredSocket()
    const connectionPromise = backpressuredTransport(socket).connect(options())

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    socket.complete()
    socket.emit('drain')
    const connection = await connectionPromise
    socket.emit('error', new Error('socket failed'))

    expectConnectionListenersCleaned(socket)
    await connection.destroy()
    expectConnectionListenersCleaned(socket)
    expect(socket.destroyCalls).toBe(1)
  })

  it('destroys the socket and clears the token when an auth write callback fails after READY', async () => {
    const socket = new BackpressuredSocket()
    const controller = new AbortController()
    const ownedToken = new Uint8Array(token)
    const connecting = backpressuredTransport(socket).connect(options({ signal: controller.signal, token: ownedToken }))

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    socket.complete(new Error('write failed'))

    await expect(connecting).rejects.toBeInstanceOf(QQBridgePcmTransportError)
    expect(socket.destroyed).toBe(true)
    expect(socket.destroyCalls).toBe(1)
    expect(ownedToken).toEqual(new Uint8Array(32))
    expectConnectWaitersCleaned(socket, controller.signal)
  })

  it('destroys the socket and clears the token when it errors after READY while waiting for drain', async () => {
    const socket = new BackpressuredSocket()
    const controller = new AbortController()
    const ownedToken = new Uint8Array(token)
    const connecting = backpressuredTransport(socket).connect(options({ signal: controller.signal, token: ownedToken }))

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    socket.emit('error', new Error('socket failed'))

    await expect(connecting).rejects.toBeInstanceOf(QQBridgePcmTransportError)
    expect(socket.destroyed).toBe(true)
    expect(socket.destroyCalls).toBe(1)
    expect(ownedToken).toEqual(new Uint8Array(32))
    expectConnectWaitersCleaned(socket, controller.signal)
  })

  it('destroys the socket and clears the token when aborted after READY while waiting for drain', async () => {
    const socket = new BackpressuredSocket()
    const controller = new AbortController()
    const ownedToken = new Uint8Array(token)
    const connecting = backpressuredTransport(socket).connect(options({ signal: controller.signal, token: ownedToken }))

    socket.connect()
    socket.emit('data', frame(0x80, Uint8Array.of(1)))
    controller.abort()

    await expect(connecting).rejects.toBeInstanceOf(QQVoiceMediaClosedError)
    expect(socket.destroyed).toBe(true)
    expect(socket.destroyCalls).toBe(1)
    expect(ownedToken).toEqual(new Uint8Array(32))
    expectConnectWaitersCleaned(socket, controller.signal)
  })

  it('authenticates once, clears the owned token, and handles fragmented/coalesced frames', async () => {
    const receivedAuth = Promise.withResolvers<Buffer>()
    const receivedUplink = Promise.withResolvers<Buffer>()
    const server = await unixServer((socket) => {
      let authenticated = false
      readFrames(socket, (type, payload) => {
        if (!authenticated) {
          authenticated = true
          expect(type).toBe(0x01)
          receivedAuth.resolve(Buffer.from(payload))
          const ready = frame(0x80, Uint8Array.of(1))
          socket.write(ready.subarray(0, 3))
          socket.write(Buffer.concat([ready.subarray(3), frame(0x81, pcm(3)), frame(0x81, pcm(4))]))
          return
        }
        expect(type).toBe(0x02)
        receivedUplink.resolve(Buffer.from(payload))
      })
    })
    servers.push(server)
    const ownedToken = new Uint8Array(token)
    const connection = await new QQBridgePcmTransport(server.socketPath).connect(options({ token: ownedToken }))

    expect(ownedToken).toEqual(new Uint8Array(32))
    const auth = await receivedAuth.promise
    expect(auth).toHaveLength(49)
    expect(auth).toEqual(Buffer.concat([Buffer.of(1), Buffer.from(leaseId, 'hex'), Buffer.from(token)]))
    const controller = new AbortController()
    const incoming = connection.receive({ signal: controller.signal })
    await expect(incoming[Symbol.asyncIterator]().next().then((value) => value.value?.data)).resolves.toEqual(pcm(3))
    await expect(incoming[Symbol.asyncIterator]().next().then((value) => value.value?.data)).resolves.toEqual(pcm(4))
    await connection.send({ format: QQ_VOICE_PCM_FORMAT, data: pcm(9) }, { signal: controller.signal })
    await expect(receivedUplink.promise).resolves.toEqual(Buffer.from(pcm(9)))
    await connection.close()
  })

  it.each([
    ['wrong ready type', frame(0x7f, Uint8Array.of(1))],
    ['wrong ready length', frame(0x80, Uint8Array.of(1, 1))],
    ['wrong ready version', frame(0x80, Uint8Array.of(2))],
  ])('rejects a %s without exposing connection data', async (_name, reply) => {
    const secretPath = 'token=secret call=opaque path=/private.sock'
    const server = await unixServer((socket) => {
      readFrames(socket, () => socket.write(reply))
    })
    servers.push(server)
    const transport = new QQBridgePcmTransport(server.socketPath)
    const error = await transport.connect(options({ callId: secretPath })).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(QQBridgePcmTransportError)
    expect((error as Error).message).not.toContain(secretPath)
  })

  it('zeroes the owned token when validation fails before opening a socket', async () => {
    const ownedToken = new Uint8Array(31).fill(7)

    await expect(new QQBridgePcmTransport('/tmp/crossgram-missing-media.sock').connect(options({ token: ownedToken })))
      .rejects.toBeInstanceOf(QQBridgePcmTransportError)
    expect(ownedToken).toEqual(new Uint8Array(31))
  })

  it('rejects timeout and abort, destroys the socket, and keeps errors sanitized', async () => {
    const sockets: Socket[] = []
    const server = await unixServer((socket) => readFrames(socket, () => {}))
    servers.push(server)
    const socketFactory = (socketPath: string) => {
      const socket = net.createConnection(socketPath)
      sockets.push(socket)
      return socket
    }

    const timeoutToken = new Uint8Array(token)
    const timeout = await new QQBridgePcmTransport(server.socketPath, { connectTimeoutMs: 5, socketFactory })
      .connect(options({ token: timeoutToken })).catch((error: unknown) => error)
    expect(timeout).toBeInstanceOf(QQBridgePcmTransportError)
    expect(timeoutToken).toEqual(new Uint8Array(32))

    const controller = new AbortController()
    const abortedToken = new Uint8Array(token)
    const pending = new QQBridgePcmTransport(server.socketPath, { connectTimeoutMs: 1_000, socketFactory })
      .connect(options({ signal: controller.signal, token: abortedToken })).catch((error: unknown) => error)
    controller.abort(new Error('token=secret path=/private.sock'))
    const aborted = await pending
    expect(aborted).toBeInstanceOf(QQVoiceMediaClosedError)
    expect(abortedToken).toEqual(new Uint8Array(32))
    expect((aborted as Error).message).not.toContain('secret')
    expect(sockets).toHaveLength(2)
    expect(sockets.every((socket) => socket.destroyed)).toBe(true)
  })

  it('fails promptly and zeroes the token when the remote closes during authentication', async () => {
    const server = await unixServer((socket) => socket.destroy())
    servers.push(server)
    const ownedToken = new Uint8Array(token)

    await expect(new QQBridgePcmTransport(server.socketPath).connect(options({ token: ownedToken })))
      .rejects.toBeInstanceOf(QQBridgePcmTransportError)
    expect(ownedToken).toEqual(new Uint8Array(32))
  })

  it('fails closed instead of retaining more than four downlink frames', async () => {
    const server = await unixServer((socket) => {
      readFrames(socket, () => socket.write(frame(0x80, Uint8Array.of(1)), () => {
        setTimeout(() => socket.write(Buffer.concat(
          Array.from({ length: 5 }, (_, index) => frame(0x81, pcm(index))),
        )), 10).unref()
      }))
    })
    servers.push(server)
    const connection = await new QQBridgePcmTransport(server.socketPath).connect(options())

    await expect(connection.receive({ signal: new AbortController().signal })[Symbol.asyncIterator]().next())
      .rejects.toBeInstanceOf(QQBridgePcmTransportError)
    await expect(connection.close()).resolves.toBeUndefined()
  })

  it.each([
    ['complete', (socket: Socket, header: Buffer) => socket.write(header)],
    ['fragmented', (socket: Socket, header: Buffer) => {
      socket.write(header.subarray(0, 3))
      setImmediate(() => socket.write(header.subarray(3)))
    }],
  ])('fails closed as soon as a %s oversized downlink header arrives', async (_kind, writeHeader) => {
    const socketClosed = Promise.withResolvers<void>()
    const header = Buffer.alloc(5)
    header[0] = 0x81
    header.writeUInt32BE(QQ_VOICE_PCM_FORMAT.bytesPerFrame + 1, 1)
    const server = await unixServer((socket) => {
      socket.once('close', () => socketClosed.resolve())
      readFrames(socket, () => socket.write(frame(0x80, Uint8Array.of(1)), () => writeHeader(socket, header)))
    })
    servers.push(server)
    const connection = await new QQBridgePcmTransport(server.socketPath).connect(options())

    await expect(connection.receive({ signal: new AbortController().signal })[Symbol.asyncIterator]().next())
      .rejects.toBeInstanceOf(QQBridgePcmTransportError)
    await expect(socketClosed.promise).resolves.toBeUndefined()
  })

  it('rejects malformed downlink frames and terminates close/receive waiters', async () => {
    const server = await unixServer((socket) => {
      readFrames(socket, () => socket.write(Buffer.concat([
        frame(0x80, Uint8Array.of(1)),
        frame(0x81, new Uint8Array(1_919)),
      ])))
    })
    servers.push(server)
    const connection = await new QQBridgePcmTransport(server.socketPath).connect(options())
    const waiting = connection.receive({ signal: new AbortController().signal })[Symbol.asyncIterator]().next()

    await expect(waiting).rejects.toBeInstanceOf(QQBridgePcmTransportError)
    await expect(connection.close()).resolves.toBeUndefined()
    await expect(connection.receive({ signal: new AbortController().signal })[Symbol.asyncIterator]().next())
      .rejects.toBeInstanceOf(QQBridgePcmTransportError)
  })
})
