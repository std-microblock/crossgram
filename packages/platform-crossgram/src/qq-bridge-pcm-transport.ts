import net, { type Socket } from 'node:net'
import {
  QQ_VOICE_PCM_FORMAT,
  QQVoiceMediaClosedError,
  type QQVoiceMediaConnectOptions,
  type QQVoiceMediaConnection,
  type QQVoiceMediaTransport,
  type QQVoicePcmFrame,
} from './voice-media.js'

const AUTH_FRAME_TYPE = 0x01
const UPLINK_FRAME_TYPE = 0x02
const READY_FRAME_TYPE = 0x80
const DOWNLINK_FRAME_TYPE = 0x81
const PROTOCOL_VERSION = 1
const LEASE_ID_BYTES = 16
const TOKEN_BYTES = 32
const AUTH_BYTES = 1 + LEASE_ID_BYTES + TOKEN_BYTES
const PCM_FRAME_BYTES = QQ_VOICE_PCM_FORMAT.bytesPerFrame
const MAX_RETAINED_FRAMES = 4
// A Unix stream may coalesce the gateway's real-time writes into a pipe-sized
// burst. Frames are parsed and dropped immediately when no reader is waiting,
// so this bounds one transient read rather than retained audio.
const MAX_WIRE_BURST_FRAMES = 64
const MAX_WIRE_BURST_BYTES = (5 + PCM_FRAME_BYTES) * MAX_WIRE_BURST_FRAMES
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

export interface QQBridgePcmTransportOptions {
  connectTimeoutMs?: number
  /** Provides a socket for connection setup; primarily useful for deterministic transport tests. */
  socketFactory?: (socketPath: string) => Socket
}

/** A local QQ Bridge PCM socket failed without exposing gateway capabilities. */
export class QQBridgePcmTransportError extends Error {
  constructor() {
    super('QQ Bridge PCM transport failed')
    this.name = 'QQBridgePcmTransportError'
  }
}

/**
 * QQ Bridge media gateway adapter. The gateway protocol is five-byte framed:
 * one type byte, a big-endian u32 payload size, then the payload.
 */
export class QQBridgePcmTransport implements QQVoiceMediaTransport {
  private readonly connectTimeoutMs: number
  private readonly socketFactory: (socketPath: string) => Socket

  constructor(
    private readonly socketPath: string,
    options: QQBridgePcmTransportOptions = {},
  ) {
    if (!isAbsoluteUnixPath(socketPath)) throw new RangeError('QQ Bridge PCM socket path is invalid')
    const timeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError('QQ Bridge PCM connect timeout is invalid')
    this.connectTimeoutMs = Math.trunc(timeout)
    this.socketFactory = options.socketFactory ?? ((path) => net.createConnection(path))
  }

  async connect(options: QQVoiceMediaConnectOptions): Promise<QQVoiceMediaConnection> {
    let auth: Buffer | undefined
    let socket: Socket | undefined
    try {
      if (options.signal.aborted) throw new QQVoiceMediaClosedError()
      if (!isLeaseId(options.leaseId) || options.token.byteLength !== TOKEN_BYTES) throw new QQBridgePcmTransportError()

      auth = Buffer.allocUnsafe(AUTH_BYTES)
      auth[0] = PROTOCOL_VERSION
      Buffer.from(options.leaseId, 'hex').copy(auth, 1)
      auth.set(options.token, 1 + LEASE_ID_BYTES)
      socket = this.socketFactory(this.socketPath)

      const pending = await connectAndAuthenticate(socket, auth, options.signal, this.connectTimeoutMs)
      return new QQBridgePcmConnection(socket, pending)
    } catch (error) {
      socket?.destroy()
      if (error instanceof QQVoiceMediaClosedError || options.signal.aborted) {
        throw new QQVoiceMediaClosedError()
      }
      throw new QQBridgePcmTransportError()
    } finally {
      options.token.fill(0)
      auth?.fill(0)
    }
  }
}

class QQBridgePcmConnection implements QQVoiceMediaConnection {
  private readonly received = new FrameQueue()
  private pending = Buffer.alloc(0)
  private closed = false
  private closePromise?: Promise<void>

  constructor(private readonly socket: Socket, pending?: Buffer) {
    socket.on('data', this.onData)
    socket.once('error', this.onError)
    socket.once('close', this.onClose)
    if (pending?.byteLength) this.onData(pending)
  }

  async send(frame: QQVoicePcmFrame, options: { signal: AbortSignal }): Promise<void> {
    if (options.signal.aborted) throw new QQVoiceMediaClosedError()
    if (this.closed || this.socket.destroyed) throw new QQVoiceMediaClosedError()
    if (frame.data.byteLength !== PCM_FRAME_BYTES) throw new QQBridgePcmTransportError()

    const payload = Buffer.from(frame.data)
    const output = frameBuffer(UPLINK_FRAME_TYPE, payload)
    payload.fill(0)
    try {
      await writeWithBackpressure(this.socket, output, options.signal)
    } finally {
      output.fill(0)
    }
  }

  async *receive(options: { signal: AbortSignal }): AsyncIterable<QQVoicePcmFrame> {
    while (true) {
      const value = await this.received.next(options.signal)
      yield { format: QQ_VOICE_PCM_FORMAT, data: value }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.received.close(new QQVoiceMediaClosedError())
    this.closePromise = waitForClose(this.socket, () => this.socket.end())
    return this.closePromise
  }

  destroy(): Promise<void> {
    this.closed = true
    this.received.close(new QQVoiceMediaClosedError())
    if (!this.closePromise) {
      this.closePromise = waitForClose(this.socket, () => this.socket.destroy())
    } else if (!this.socket.destroyed) {
      this.socket.destroy()
    }
    return this.closePromise
  }

  private readonly onData = (chunk: Buffer) => {
    if (this.closed) return
    if (chunk.byteLength + this.pending.byteLength > MAX_WIRE_BURST_BYTES) return this.fail()
    this.pending = this.pending.byteLength ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk)
    while (this.pending.byteLength >= 5) {
      const type = this.pending[0]!
      const length = this.pending.readUInt32BE(1)
      if (length > PCM_FRAME_BYTES) return this.fail()
      if (this.pending.byteLength < 5 + length) return
      const payload = this.pending.subarray(5, 5 + length)
      this.pending = this.pending.subarray(5 + length)
      if (type !== DOWNLINK_FRAME_TYPE || length !== PCM_FRAME_BYTES) return this.fail()
      this.received.push(new Uint8Array(payload))
    }
  }

  private readonly onError = () => this.fail()

  private readonly onClose = () => {
    this.removeSocketListeners()
    this.closed = true
    this.pending.fill(0)
    this.pending = Buffer.alloc(0)
    this.received.close(new QQVoiceMediaClosedError())
  }

  private fail(): void {
    if (this.closed) return
    this.removeSocketListeners()
    this.closed = true
    this.pending.fill(0)
    this.pending = Buffer.alloc(0)
    this.received.close(new QQBridgePcmTransportError())
    this.socket.destroy()
  }

  private removeSocketListeners(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
  }
}

async function connectAndAuthenticate(
  socket: Socket,
  auth: Buffer,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let done = false
    let ready = false
    let authWritten = false
    let pending = Buffer.alloc(0)
    let authFrame: Buffer | undefined
    let timer: NodeJS.Timeout | undefined
    const authWriteController = new AbortController()

    const finish = (reason?: unknown) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.off('connect', connect)
      socket.off('data', data)
      socket.off('error', onError)
      socket.off('close', close)
      authWriteController.abort()
      authFrame?.fill(0)
      authFrame = undefined
      const remainder = reason ? undefined : Buffer.from(pending.subarray(6))
      pending.fill(0)
      pending = Buffer.alloc(0)
      if (reason) reject(reason)
      else resolve(remainder!)
    }
    const complete = () => {
      if (ready && authWritten) finish()
    }
    const abort = () => finish(new QQVoiceMediaClosedError())
    const connect = () => {
      authFrame = frameBuffer(AUTH_FRAME_TYPE, auth)
      writeWithBackpressure(socket, authFrame, authWriteController.signal).then(
        () => {
          authFrame?.fill(0)
          authFrame = undefined
          authWritten = true
          complete()
        },
        (error) => {
          authFrame?.fill(0)
          authFrame = undefined
          finish(error)
        },
      )
    }
    const data = (chunk: Buffer) => {
      if (chunk.byteLength + pending.byteLength > 6 + MAX_WIRE_BURST_BYTES) return finish(new QQBridgePcmTransportError())
      pending = pending.byteLength ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
      if (pending.byteLength < 5) return
      const type = pending[0]!
      const length = pending.readUInt32BE(1)
      if (length !== 1 || pending.byteLength < 6 || type !== READY_FRAME_TYPE || pending[5] !== PROTOCOL_VERSION) {
        return finish(new QQBridgePcmTransportError())
      }
      ready = true
      complete()
    }
    const onError = () => finish(new QQBridgePcmTransportError())
    const close = () => finish(new QQBridgePcmTransportError())

    signal.addEventListener('abort', abort, { once: true })
    socket.once('connect', connect)
    socket.on('data', data)
    socket.once('error', onError)
    socket.once('close', close)
    timer = setTimeout(() => finish(new QQBridgePcmTransportError()), timeoutMs)
    timer.unref()
    if (signal.aborted) abort()
  })
}

function writeWithBackpressure(socket: Socket, data: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new QQVoiceMediaClosedError())
  return new Promise<void>((resolve, reject) => {
    let callbackDone = false
    let drained = false
    let writeReturned = false
    let needsDrain = false
    let settled = false

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      socket.off('error', fail)
      socket.off('drain', drain)
      socket.off('close', close)
      if (error) reject(error)
      else resolve()
    }
    const complete = (error?: Error | null) => {
      if (error) return finish(new QQBridgePcmTransportError())
      callbackDone = true
      if (writeReturned && (!needsDrain || drained)) finish()
    }
    const drain = () => {
      drained = true
      if (writeReturned && callbackDone) finish()
    }
    const fail = () => finish(new QQBridgePcmTransportError())
    const close = () => finish(new QQVoiceMediaClosedError())
    const abort = () => finish(new QQVoiceMediaClosedError())

    signal.addEventListener('abort', abort, { once: true })
    socket.once('error', fail)
    socket.once('drain', drain)
    socket.once('close', close)
    try {
      needsDrain = !socket.write(data, complete)
      writeReturned = true
      if (callbackDone && (!needsDrain || drained)) finish()
      else if (!needsDrain) socket.off('drain', drain)
    } catch {
      finish(new QQBridgePcmTransportError())
    }
  })
}

function waitForClose(socket: Socket, action: () => void): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise<void>((resolve) => {
    socket.once('close', resolve)
    action()
  })
}

function frameBuffer(type: number, payload: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(5 + payload.byteLength)
  output[0] = type
  output.writeUInt32BE(payload.byteLength, 1)
  output.set(payload, 5)
  return output
}

function isLeaseId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value)
}

function isAbsoluteUnixPath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0')
}

class FrameQueue {
  private readonly values: Uint8Array[] = []
  private readonly readers: Array<{ resolve(value: Uint8Array): void, reject(error: unknown): void }> = []
  private error?: unknown

  push(value: Uint8Array): void {
    if (this.error) return
    const reader = this.readers.shift()
    if (reader) return reader.resolve(value)
    if (this.values.length === MAX_RETAINED_FRAMES) this.values.shift()!.fill(0)
    this.values.push(value)
  }

  next(signal: AbortSignal): Promise<Uint8Array> {
    const value = this.values.shift()
    if (value) return Promise.resolve(value)
    if (this.error) return Promise.reject(this.error)
    if (signal.aborted) return Promise.reject(new QQVoiceMediaClosedError())
    return new Promise<Uint8Array>((resolve, reject) => {
      const entry = {
        resolve: (value: Uint8Array) => { signal.removeEventListener('abort', abort); resolve(value) },
        reject: (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) },
      }
      const abort = () => {
        const index = this.readers.indexOf(entry)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new QQVoiceMediaClosedError())
      }
      signal.addEventListener('abort', abort, { once: true })
      this.readers.push(entry)
    })
  }

  close(error: unknown): void {
    if (this.error) return
    this.error = error
    for (const value of this.values.splice(0)) value.fill(0)
    for (const reader of this.readers.splice(0)) reader.reject(error)
  }
}
