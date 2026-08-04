import Long from 'long'
import type { tl } from '@mtcute/core'
import { describe, expect, it, vi } from 'vitest'
import {
  CallRegistry, VoiceCallError, type VoiceWorkerCall, type VoiceWorkerClient,
} from './call-registry.js'
import type {
  VoiceCallMediaProvider, VoiceMediaSession, VoicePcmFrame, VoiceWorkerMediaEndpoint,
} from './media.js'

const session = {
  platformSessionId: 'qq-voice-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const protocol: tl.RawPhoneCallProtocol = {
  _: 'phoneCallProtocol', udpP2p: true, udpReflector: false,
  minLayer: 100, maxLayer: 100, libraryVersions: ['bridge'],
}
const frame = (value: number): VoicePcmFrame => ({
  format: {
    encoding: 's16le', sampleRate: 48_000, channels: 1, durationMs: 20, samplesPerFrame: 960, bytesPerFrame: 1_920,
  },
  data: new Uint8Array(1_920).fill(value),
})

class FakeMedia implements VoiceMediaSession {
  readonly sent: VoicePcmFrame[] = []
  readonly closed = Promise.withResolvers<void>()
  private readonly incoming = [frame(2)]
  closeCount = 0
  receiveAborts = 0

  send(value: VoicePcmFrame): void {
    this.sent.push(value)
  }

  async receive(options: { signal?: AbortSignal } = {}): Promise<VoicePcmFrame> {
    const value = this.incoming.shift()
    if (value) return value
    return new Promise<VoicePcmFrame>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        this.receiveAborts++
        reject(options.signal?.reason)
      }, { once: true })
    })
  }

  close(): Promise<void> {
    this.closeCount++
    this.closed.resolve()
    return Promise.resolve()
  }

  finish(): void {
    this.closed.resolve()
  }

  get finished(): Promise<void> {
    return this.closed.promise
  }
}

class FakeEndpoint implements VoiceWorkerMediaEndpoint {
  readonly sent: VoicePcmFrame[] = []
  closeCount = 0
  receiveAborts = 0
  private readonly incoming = [frame(1)]

  async send(value: VoicePcmFrame): Promise<void> {
    this.sent.push(value)
  }

  async *receive({ signal }: { signal: AbortSignal }): AsyncIterable<VoicePcmFrame> {
    const value = this.incoming.shift()
    if (value) yield value
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        this.receiveAborts++
        reject(signal.reason)
      }, { once: true })
    })
  }

  close(): Promise<void> {
    this.closeCount++
    return Promise.resolve()
  }
}

class FakeWorker implements VoiceWorkerClient {
  readonly protocol: tl.TypePhoneCallProtocol = protocol
  readonly endpoints: FakeEndpoint[] = []
  readonly attachMedia = vi.fn(async (_call: VoiceWorkerCall) => {
    const endpoint = new FakeEndpoint()
    this.endpoints.push(endpoint)
    return endpoint
  })
  readonly discardCall = vi.fn(async (_call: VoiceWorkerCall) => {})

  async prepareTelegramCaller() {
    return { state: 'ready' as const, gAHash: new Uint8Array(32).fill(9) }
  }

  async prepareTelegramRecipient() {
    return { state: 'ready' as const, gB: new Uint8Array(256).fill(7) }
  }

  async completeTelegramCaller() {
    return { state: 'media-active' as const, gA: new Uint8Array(256).fill(8), keyFingerprint: Long.fromInt(12) }
  }

  async completeTelegramRecipient() {
    return { state: 'media-active' as const, keyFingerprint: Long.fromInt(12) }
  }

  async sendSignalingData() {}
}

function setup(options: { mediaFailure?: Error, deliveries?: () => number } = {}) {
  let random = 0
  const worker = new FakeWorker()
  const media: FakeMedia[] = []
  const starts = vi.fn(async (
    _call: VoiceWorkerCall,
    _session: typeof session,
    _endpoint: VoiceWorkerMediaEndpoint,
  ) => {
    if (options.mediaFailure) throw options.mediaFailure
    const value = new FakeMedia()
    media.push(value)
    return value
  })
  const updates: tl.RawUpdatePhoneCall[] = []
  const calls = new CallRegistry({
    worker,
    media: { start: starts } satisfies VoiceCallMediaProvider,
    mediaStartProvider: {
      async get() {
        return {
          initializationTimeoutMs: 1, receiveTimeoutMs: 1,
          enableP2p: true, allowTcp: false, protocolV1: true,
          enableAec: true, enableNs: true, enableAgc: true, endpoints: [],
        }
      },
    },
    randomBytes: (size) => {
      const value = new Uint8Array(size)
      value[size - 1] = ++random
      return value
    },
    publish: ({ update }) => {
      updates.push(update)
      return options.deliveries?.() ?? 1
    },
    replay: () => options.deliveries?.() ?? 1,
  })
  return { calls, worker, media, starts, updates }
}

async function request(calls: CallRegistry) {
  const result = await calls.request({
    session, selfId: 1, participantId: 2, randomId: 1, gAHash: new Uint8Array(32).fill(1), protocol,
  })
  if (result.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
  return { id: result.phoneCall.id, accessHash: result.phoneCall.accessHash }
}

async function incoming(
  calls: CallRegistry,
  platformControl?: { control(operation: 'accept' | 'reject' | 'hangup'): Promise<void> },
) {
  const result = await calls.receiveIncoming({
    session, selfId: 1, callerId: 2, correlationId: 'opaque-qq-call',
    platformCallRef: 'opaque-qq-call', platformControl,
  })
  if (result._ !== 'phoneCallRequested') throw new Error('expected requested call')
  return { id: result.id, accessHash: result.accessHash }
}

describe('CallRegistry QQ media composition', () => {
  it('obtains one media session only after the caller worker confirms active and relays both PCM directions', async () => {
    const { calls, worker, media, starts } = setup()
    const peer = await request(calls)

    expect(starts).not.toHaveBeenCalled()
    const active = await calls.confirm(session, peer, new Uint8Array(256).fill(4), Long.fromInt(12), protocol)

    expect(active.phoneCall._).toBe('phoneCall')
    expect(starts).toHaveBeenCalledOnce()
    expect(worker.attachMedia).toHaveBeenCalledOnce()
    expect(starts.mock.calls[0]?.[2]).toBe(worker.endpoints[0])
    await vi.waitFor(() => {
      expect(media[0]?.sent[0]?.data[0]).toBe(1)
      expect(worker.endpoints[0]?.sent[0]?.data[0]).toBe(2)
    })

    await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 0)
    expect(media[0]?.closeCount).toBe(1)
    expect(worker.endpoints[0]?.closeCount).toBe(1)
    expect(media[0]?.receiveAborts).toBe(1)
    expect(worker.endpoints[0]?.receiveAborts).toBe(1)
    expect(worker.discardCall).toHaveBeenCalledOnce()
  })

  it('composes the recipient role only after caller completion and does not duplicate an established attachment', async () => {
    const { calls, worker, starts } = setup()
    const peer = await incoming(calls)
    await calls.received(session, peer)

    const accepted = await calls.accept(session, peer, new Uint8Array(256).fill(5), protocol)
    const repeated = await calls.accept(session, peer, new Uint8Array(256).fill(5), protocol)

    expect(accepted.phoneCall._).toBe('phoneCallAccepted')
    expect(repeated.phoneCall._).toBe('phoneCall')
    expect(starts).toHaveBeenCalledOnce()
    expect(worker.attachMedia).toHaveBeenCalledOnce()
    expect(worker.attachMedia.mock.calls[0]?.[0]).toMatchObject({ telegramRole: 'recipient' })
  })

  it('retains the exact QQ reference in memory and accepts QQ only after worker media is attached', async () => {
    const { calls, worker, starts } = setup()
    const control = { control: vi.fn(async (_operation: 'accept' | 'reject' | 'hangup') => {}) }
    const peer = await incoming(calls, control)
    await calls.received(session, peer)

    await calls.accept(session, peer, new Uint8Array(256).fill(5), protocol)

    expect(worker.attachMedia.mock.calls[0]?.[0]).toMatchObject({
      telegramRole: 'recipient', platformCallRef: 'opaque-qq-call',
    })
    expect(starts.mock.calls[0]?.[0]).toMatchObject({ platformCallRef: 'opaque-qq-call' })
    expect(control.control).toHaveBeenCalledOnce()
    expect(control.control).toHaveBeenCalledWith('accept')
    expect(starts.mock.invocationCallOrder[0]).toBeLessThan(control.control.mock.invocationCallOrder[0]!)
  })

  it('uses reject while QQ is ringing and hangup after it has been accepted', async () => {
    const first = setup()
    const firstControl = { control: vi.fn(async (_operation: 'accept' | 'reject' | 'hangup') => {}) }
    const ringingPeer = await incoming(first.calls, firstControl)

    await first.calls.discard(session, ringingPeer, { _: 'phoneCallDiscardReasonBusy' }, 0)
    await first.calls.platformEnded(session, 'opaque-qq-call')

    expect(firstControl.control).toHaveBeenCalledOnce()
    expect(firstControl.control).toHaveBeenCalledWith('reject')

    const second = setup()
    const secondControl = { control: vi.fn(async (_operation: 'accept' | 'reject' | 'hangup') => {}) }
    const activePeer = await incoming(second.calls, secondControl)
    await second.calls.received(session, activePeer)
    await second.calls.accept(session, activePeer, new Uint8Array(256).fill(5), protocol)
    await second.calls.discard(session, activePeer, { _: 'phoneCallDiscardReasonHangup' }, 3)

    expect(secondControl.control.mock.calls.map(([operation]) => operation)).toEqual(['accept', 'hangup'])
  })

  it('turns a source-side QQ end into one Telegram discarded update without echoing a control', async () => {
    const { calls, updates, worker } = setup()
    const control = { control: vi.fn(async (_operation: 'accept' | 'reject' | 'hangup') => {}) }
    await incoming(calls, control)

    await calls.platformEnded(session, 'opaque-qq-call')
    await calls.platformEnded(session, 'opaque-qq-call')

    expect(control.control).not.toHaveBeenCalled()
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested', 'phoneCallDiscarded'])
    expect(worker.discardCall).toHaveBeenCalledOnce()
    expect(calls.snapshot(session)).toBeUndefined()
  })

  it('rejects and acknowledges a QQ call when worker preparation fails before Telegram can ring', async () => {
    const { calls, updates, worker } = setup()
    vi.spyOn(worker, 'prepareTelegramCaller').mockRejectedValue(new Error('worker unavailable'))
    const control = { control: vi.fn(async (_operation: 'accept' | 'reject' | 'hangup') => {}) }

    const result = await calls.receiveIncoming({
      session, selfId: 1, callerId: 2, correlationId: 'failed-qq-call',
      platformCallRef: 'failed-qq-call', platformControl: control,
    })

    expect(result).toMatchObject({ _: 'phoneCallDiscarded', reason: { _: 'phoneCallDiscardReasonDisconnect' } })
    expect(control.control).toHaveBeenCalledOnce()
    expect(control.control).toHaveBeenCalledWith('reject')
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallDiscarded'])
    expect(worker.discardCall).toHaveBeenCalledOnce()
    expect(calls.snapshot(session)).toBeUndefined()
  })

  it('fails closed before acquiring a platform lease when the confirmed endpoint is invalid', async () => {
    const { calls, worker, starts, updates } = setup()
    worker.attachMedia.mockResolvedValueOnce({} as unknown as FakeEndpoint)
    const peer = await request(calls)

    const error = await calls.confirm(session, peer, new Uint8Array(256).fill(4), Long.fromInt(12), protocol)
      .catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(starts).not.toHaveBeenCalled()
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested', 'phoneCallDiscarded'])
    expect(worker.discardCall).toHaveBeenCalledOnce()
  })

  it('sanitizes lease failures, closes the worker endpoint, and never publishes active media', async () => {
    const secret = 'lease-token=/private/media.sock'
    const { calls, worker, updates } = setup({ mediaFailure: new Error(secret) })
    const peer = await request(calls)

    const error = await calls.confirm(session, peer, new Uint8Array(256).fill(4), Long.fromInt(12), protocol)
      .catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect((error as Error).message).not.toContain(secret)
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested', 'phoneCallDiscarded'])
    expect(worker.endpoints[0]?.closeCount).toBe(1)
    expect(worker.discardCall).toHaveBeenCalledOnce()
  })

  it('handles terminal-media and local-discard races once, then replays the terminal state on reconnect', async () => {
    let delivered = 0
    const { calls, worker, media, updates } = setup({ deliveries: () => delivered })
    const peer = await request(calls)
    await calls.confirm(session, peer, new Uint8Array(256).fill(4), Long.fromInt(12), protocol)

    media[0]!.finish()
    const localDiscard = calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 0)
    await vi.waitFor(() => expect(updates.map((update) => update.phoneCall._)).toContain('phoneCallDiscarded'))
    await localDiscard

    expect(worker.discardCall).toHaveBeenCalledOnce()
    expect(media[0]?.closeCount).toBe(1)
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    delivered = 1
    await calls.replay(session, 'authorized-reconnect')
    expect(calls.snapshot(session)).toBeUndefined()
    expect(worker.discardCall).toHaveBeenCalledOnce()
  })
})
