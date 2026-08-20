import type { tl } from '@mtcute/core'
import Long from 'long'
import { describe, expect, it } from 'vitest'
import {
  CallRegistry, type VoiceCallDebugSummary, type VoiceWorkerCall, type VoiceWorkerClient,
} from './call-registry.js'
import { createBuiltInVoiceMediaProvider } from './media-config.js'

const session = {
  platformSessionId: 'voice-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const protocol: tl.RawPhoneCallProtocol = {
  _: 'phoneCallProtocol', udpP2p: true, udpReflector: false, minLayer: 100, maxLayer: 100, libraryVersions: ['bridge'],
}

class FakeWorker implements VoiceWorkerClient {
  readonly protocol: tl.TypePhoneCallProtocol = protocol
  readonly calls: VoiceWorkerCall[] = []
  discarded = 0

  async prepareTelegramCaller(call: VoiceWorkerCall) {
    this.calls.push(call)
    return { state: 'ready' as const, gAHash: new Uint8Array(32).fill(9) }
  }

  async completeTelegramCaller(call: VoiceWorkerCall) {
    this.calls.push(call)
    return { state: 'media-active' as const, gA: new Uint8Array(256).fill(8), keyFingerprint: Long.ONE }
  }

  async prepareTelegramRecipient(call: VoiceWorkerCall) {
    this.calls.push(call)
    return { state: 'ready' as const, gB: new Uint8Array(256).fill(7) }
  }

  async completeTelegramRecipient(call: VoiceWorkerCall) {
    this.calls.push(call)
    return { state: 'media-active' as const, keyFingerprint: Long.fromInt(12) }
  }

  async discardCall(call: VoiceWorkerCall) {
    this.calls.push(call)
    this.discarded++
  }

  async sendSignalingData() {}

  async saveCallDebug(_call: VoiceWorkerCall, _debug: VoiceCallDebugSummary) {}
}

describe('direct ICE media configuration', () => {
  it('passes private-LAN direct ICE settings through request and confirm', async () => {
    const worker = new FakeWorker()
    let randomValue = 0
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: createBuiltInVoiceMediaProvider({
        serverHost: '192.168.99.1', directIce: true, workerTimeoutMs: 5_000,
      }),
      publish: () => 1,
      randomBytes: (size) => {
        const value = new Uint8Array(size)
        value[size - 1] = ++randomValue
        return value
      },
    })

    const requested = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 1,
      gAHash: new Uint8Array(32).fill(2), protocol,
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash }

    const confirmed = await calls.confirm(session, peer, new Uint8Array(256).fill(3), Long.fromInt(12), protocol)
    expect(confirmed.phoneCall).toMatchObject({ _: 'phoneCall', p2pAllowed: true, connections: [] })
    expect(worker.calls.at(-1)?.mediaStartConfig).toMatchObject({
      enableP2p: true,
      endpoints: [],
      rtcServers: [],
    })

    await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 0)
    expect(worker.discarded).toBe(1)
    expect(calls.snapshot(session)).toBeUndefined()
  })
})
