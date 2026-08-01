import { describe, expect, it, vi } from 'vitest'
import {
  QQVoiceMedia, QQVoiceMediaClosedError, QQVoiceMediaTimeoutError, QQVoiceMediaTransportError,
  QQ_VOICE_PCM_FORMAT,
  type QQVoiceMediaConnectOptions, type QQVoiceMediaConnection, type QQVoiceMediaTransport,
  type QQVoicePcmFrame, type QQVoiceMediaStartOptions,
} from './voice-media.js'
import { Context } from 'cordis'

const frame = (value: number): QQVoicePcmFrame => ({
  format: QQ_VOICE_PCM_FORMAT,
  data: new Uint8Array(QQ_VOICE_PCM_FORMAT.bytesPerFrame).fill(value),
})

const sessionOptions = (overrides: Partial<QQVoiceMediaStartOptions> = {}): QQVoiceMediaStartOptions => ({
  callId: 'opaque call/id',
  leaseId: 'lease-1',
  token: new Uint8Array([1, 2, 3, 4]),
  ...overrides,
})

class InMemoryTransport implements QQVoiceMediaTransport, QQVoiceMediaConnection {
  readonly sent: QQVoicePcmFrame[] = []
  closed = false
  destroyed = false
  connectOptions?: QQVoiceMediaConnectOptions
  private readonly releaseSend = Promise.withResolvers<void>()

  constructor(
    private readonly incoming: QQVoicePcmFrame[] = [],
    private readonly blockSends = false,
  ) {}

  async connect(options: QQVoiceMediaConnectOptions): Promise<QQVoiceMediaConnection> {
    this.connectOptions = options
    if (options.signal.aborted) throw options.signal.reason
    return this
  }

  async send(value: QQVoicePcmFrame, { signal }: { signal: AbortSignal }): Promise<void> {
    this.sent.push(value)
    if (!this.blockSends) return
    await Promise.race([
      this.releaseSend.promise,
      new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
  }

  async *receive({ signal }: { signal: AbortSignal }): AsyncIterable<QQVoicePcmFrame> {
    for (const value of this.incoming) yield value
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }

  release(): void {
    this.releaseSend.resolve()
  }

  async close(): Promise<void> {
    this.closed = true
    this.release()
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.release()
  }
}

function voiceMedia(): QQVoiceMedia {
  return new QQVoiceMedia(new Context())
}

describe('QQ voice PCM media service', () => {
  it('forwards the opaque call context and permits exactly one active session', async () => {
    const transport = new InMemoryTransport()
    const service = voiceMedia()
    const session = await service.start(transport, sessionOptions())

    expect(transport.connectOptions).toMatchObject({
      callId: 'opaque call/id', leaseId: 'lease-1',
    })
    expect(transport.connectOptions?.signal).toBeInstanceOf(AbortSignal)
    await expect(service.start(new InMemoryTransport(), sessionOptions())).rejects.toBeInstanceOf(QQVoiceMediaClosedError)

    await service.close()
    expect(transport.closed).toBe(true)
    await vi.waitFor(() => expect(service.session).toBeUndefined())
    expect(session.closed).toBe(true)
  })

  it('copies and zeroes the caller-owned token after a successful connection', async () => {
    const token = new Uint8Array([11, 22, 33, 44])
    const transport = new InMemoryTransport()
    const service = voiceMedia()

    await service.start(transport, sessionOptions({ token }))

    expect(transport.connectOptions?.token).not.toBe(token)
    expect(token).toEqual(new Uint8Array(token.byteLength))
    expect(transport.connectOptions?.token).toEqual(new Uint8Array(token.byteLength))
    await service.close()
  })

  it('zeroes caller and transferred tokens when connect fails', async () => {
    const token = new Uint8Array([11, 22, 33, 44])
    let transferred: Uint8Array | undefined
    const service = voiceMedia()

    await expect(service.start({
      async connect(options) {
        transferred = options.token
        throw new Error('connection failed')
      },
    }, sessionOptions({ token }))).rejects.toBeInstanceOf(QQVoiceMediaTransportError)

    expect(token).toEqual(new Uint8Array(token.byteLength))
    expect(transferred).toEqual(new Uint8Array(token.byteLength))
  })

  it('zeroes caller and transferred tokens when connect is aborted', async () => {
    const token = new Uint8Array([11, 22, 33, 44])
    const controller = new AbortController()
    let transferred: Uint8Array | undefined
    const service = voiceMedia()
    const started = service.start({
      connect(options) {
        transferred = options.token
        return new Promise<QQVoiceMediaConnection>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      },
    }, sessionOptions({ token, signal: controller.signal }))

    await vi.waitFor(() => expect(transferred).toBeDefined())
    controller.abort(new QQVoiceMediaClosedError())
    await expect(started).rejects.toBeInstanceOf(QQVoiceMediaClosedError)

    expect(token).toEqual(new Uint8Array(token.byteLength))
    expect(transferred).toEqual(new Uint8Array(token.byteLength))
  })

  it('zeroes caller and transferred tokens when connect times out', async () => {
    const token = new Uint8Array([11, 22, 33, 44])
    let transferred: Uint8Array | undefined
    const service = voiceMedia()

    await expect(service.start({
      connect(options) {
        transferred = options.token
        return new Promise<QQVoiceMediaConnection>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      },
    }, sessionOptions({ token, timeoutMs: 5 }))).rejects.toBeInstanceOf(QQVoiceMediaTimeoutError)

    expect(token).toEqual(new Uint8Array(token.byteLength))
    expect(transferred).toEqual(new Uint8Array(token.byteLength))
  })

  it('zeroes caller and transferred tokens after a remote close', async () => {
    const token = new Uint8Array([11, 22, 33, 44])
    let transferred: Uint8Array | undefined
    const close = vi.fn(async () => {})
    const service = voiceMedia()
    const session = await service.start({
      async connect(options) {
        transferred = options.token
        return {
          async send() {},
          async *receive() {},
          close,
          async destroy() {},
        }
      },
    }, sessionOptions({ token }))

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    await expect(session.finished).resolves.toBeUndefined()
    expect(token).toEqual(new Uint8Array(token.byteLength))
    expect(transferred).toEqual(new Uint8Array(token.byteLength))
  })

  it('rejects invalid connect timeouts without acquiring session resources', async () => {
    const service = voiceMedia()
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const token = new Uint8Array([11, 22, 33, 44])
    Object.defineProperty(token, 'slice', { value: () => { throw new Error('token copied') } })

    for (const timeoutMs of [-1, NaN, Infinity]) {
      const transport = new InMemoryTransport()
      await expect(service.start(transport, sessionOptions({ token, signal: controller.signal, timeoutMs })))
        .rejects.toThrow('connect timeout must be non-negative')
      expect(transport.connectOptions).toBeUndefined()
    }

    expect(addEventListener).not.toHaveBeenCalled()
    await expect(service.close()).resolves.toBeUndefined()
    const session = await service.start(new InMemoryTransport(), sessionOptions())
    await service.close()
    expect(session.closed).toBe(true)
  })

  it('copies queued caller frames without invoking overridden slice', async () => {
    const transport = new InMemoryTransport([], true)
    const service = voiceMedia()
    const session = await service.start(transport, sessionOptions())
    session.send(frame(1))
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))

    const aliased = frame(2)
    Object.defineProperty(aliased.data, 'slice', { value: () => aliased.data })
    session.send(aliased)
    aliased.data.fill(9)
    transport.release()

    await vi.waitFor(() => expect(transport.sent).toHaveLength(2))
    expect(transport.sent[1].data[0]).toBe(2)
    await service.close()
  })

  it('never blocks an outbound producer and retains the newest four frames in order', async () => {
    const transport = new InMemoryTransport([], true)
    const service = voiceMedia()
    const session = await service.start(transport, sessionOptions())

    session.send(frame(1))
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const producerResult = [2, 3, 4, 5, 6].map((value) => session.send(frame(value)))

    expect(producerResult).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(session.stats).toEqual({ outgoingDroppedFrames: 1, incomingDroppedFrames: 0 })
    transport.release()
    await vi.waitFor(() => expect(transport.sent).toHaveLength(5))
    expect(transport.sent.map((value) => value.data[0])).toEqual([1, 3, 4, 5, 6])

    await service.close()
  })

  it('bounds inbound buffering to the newest four frames and reports drops by direction', async () => {
    const transport = new InMemoryTransport([frame(1), frame(2), frame(3), frame(4), frame(5), frame(6)])
    const service = voiceMedia()
    const session = await service.start(transport, sessionOptions())

    await vi.waitFor(() => expect(session.stats.incomingDroppedFrames).toBe(2))
    const received = await Promise.all([session.receive(), session.receive(), session.receive(), session.receive()])

    expect(received.map((value) => value.data[0])).toEqual([3, 4, 5, 6])
    expect(session.stats).toEqual({ outgoingDroppedFrames: 0, incomingDroppedFrames: 2 })

    await service.close()
  })

  it('freezes the exported PCM format and validates against private format constants', async () => {
    expect(Object.isFrozen(QQ_VOICE_PCM_FORMAT)).toBe(true)
    expect(() => Object.assign(QQ_VOICE_PCM_FORMAT, { channels: 2 })).toThrow()

    const service = voiceMedia()
    const session = await service.start(new InMemoryTransport(), sessionOptions())
    expect(() => session.send({
      format: { ...QQ_VOICE_PCM_FORMAT, channels: 2 },
      data: new Uint8Array(QQ_VOICE_PCM_FORMAT.bytesPerFrame),
    } as unknown as QQVoicePcmFrame)).toThrow('48 kHz mono s16le')
    await service.close()
  })

  it('rejects non-48 kHz mono s16le 20 ms frames', async () => {
    const service = voiceMedia()
    const session = await service.start(new InMemoryTransport(), sessionOptions())

    expect(() => session.send({ ...frame(1), data: new Uint8Array(1_919) })).toThrow('exactly 1,920 bytes')
    expect(() => session.send({
      ...frame(1),
      format: { ...QQ_VOICE_PCM_FORMAT, channels: 2 },
    } as unknown as QQVoicePcmFrame)).toThrow('48 kHz mono s16le')

    await service.close()
  })

  it('sanitizes sensitive transport failures', async () => {
    const service = voiceMedia()
    const secret = 'token=capability-token call=opaque-call'
    const error = await service.start({
      async connect() {
        throw new Error(secret)
      },
    }, sessionOptions()).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(QQVoiceMediaTransportError)
    expect((error as Error).message).not.toContain(secret)
  })

  it('settles close and releases the service when connect ignores cancellation forever', async () => {
    const transport: QQVoiceMediaTransport = {
      connect: vi.fn(() => new Promise<QQVoiceMediaConnection>(() => {})),
    }
    const service = voiceMedia()
    const started = service.start(transport, sessionOptions()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce())

    await expect(service.close()).resolves.toBeUndefined()
    expect(await started).toBeInstanceOf(QQVoiceMediaClosedError)

    const replacement = await service.start(new InMemoryTransport(), sessionOptions())
    expect(service.session).toBe(replacement)
    await replacement.close()
  })

  it('destroys a late connect exactly once without affecting its replacement session', async () => {
    const connected = Promise.withResolvers<QQVoiceMediaConnection>()
    const transport: QQVoiceMediaTransport = { connect: () => connected.promise }
    const service = voiceMedia()
    const started = service.start(transport, sessionOptions()).catch((error: unknown) => error)
    await expect(service.close()).resolves.toBeUndefined()

    const replacement = await service.start(new InMemoryTransport(), sessionOptions())
    const late = new InMemoryTransport()
    const destroy = vi.spyOn(late, 'destroy')
    connected.resolve(late)

    expect(await started).toBeInstanceOf(QQVoiceMediaClosedError)
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce())
    expect(service.session).toBe(replacement)
    await replacement.close()
  })

  it('isolates a terminal old session from a replacement after bounded cleanup', async () => {
    vi.useFakeTimers()
    try {
      const destroyed = Promise.withResolvers<void>()
      class NoncooperativeTransport extends InMemoryTransport {
        override close(): Promise<void> {
          return new Promise<void>(() => {})
        }

        override destroy(): Promise<void> {
          this.destroyed = true
          return destroyed.promise
        }
      }

      const transport = new NoncooperativeTransport()
      const service = voiceMedia()
      const old = await service.start(transport, sessionOptions())
      const closeResult = service.close().catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(transport.destroyed).toBe(true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await closeResult).toBeInstanceOf(QQVoiceMediaTimeoutError)
      expect(service.session).toBeUndefined()

      const replacement = await service.start(new InMemoryTransport(), sessionOptions())
      destroyed.resolve()
      await old.finished
      await Promise.resolve()
      expect(service.session).toBe(replacement)
      await replacement.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels waiting receives, times them out, and tears down the connection', async () => {
    const transport = new InMemoryTransport()
    const service = voiceMedia()
    const session = await service.start(transport, sessionOptions())
    const controller = new AbortController()
    const cancelled = session.receive({ signal: controller.signal })
    controller.abort(new Error('test cancellation'))

    await expect(cancelled).rejects.toThrow('test cancellation')
    await expect(session.receive({ timeoutMs: 1 })).rejects.toBeInstanceOf(QQVoiceMediaTimeoutError)
    await service.close()
    expect(transport.closed).toBe(true)
  })
})
