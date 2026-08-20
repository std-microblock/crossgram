import type { tl } from '@mtcute/core'
import Long from 'long'
import { describe, expect, it, vi } from 'vitest'
import type { MessageStore } from '../message-store.js'
import type { IMPlatform, PlatformSession } from '../platform.js'
import { CallRegistry, type VoiceWorkerClient } from './call-registry.js'
import { VoiceRpc } from './voice-rpc.js'

const session: PlatformSession = {
  platformSessionId: 'voice-rpc-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

const workerProtocol: tl.RawPhoneCallProtocol = {
  _: 'phoneCallProtocol', udpP2p: false, udpReflector: false,
  minLayer: 100, maxLayer: 100, libraryVersions: ['worker-v1'],
}

function publicValue(value = 1): Uint8Array {
  return new Uint8Array(256).fill(value)
}

function createVoiceHarness(signalingFailure?: Error) {
  const worker = {
    protocol: workerProtocol,
    prepareTelegramCaller: vi.fn(async () => ({
      state: 'ready' as const, gAHash: new Uint8Array(32).fill(1),
    })),
    async completeTelegramCaller() {
      return { state: 'media-active' as const, gA: publicValue(2), keyFingerprint: Long.ONE }
    },
    prepareTelegramRecipient: vi.fn(async () => ({ state: 'ready' as const, gB: publicValue(3) })),
    async completeTelegramRecipient() {
      return { state: 'media-active' as const, keyFingerprint: Long.ONE }
    },
    async discardCall() {},
    async sendSignalingData() {
      if (signalingFailure) throw signalingFailure
    },
  } satisfies VoiceWorkerClient
  const store = {
    getUser: vi.fn(async (_platformId: string, platformUserId: string) =>
      ({ id: platformUserId === 'self' ? 1 : 2 })),
    getUserByTlId: vi.fn(async () => ({ id: 2 })),
  }
  const messageStore = store as unknown as MessageStore
  const calls = new CallRegistry({
    worker,
    mediaStartProvider: {
      async get() {
        return {
          initializationTimeoutMs: 1, receiveTimeoutMs: 1,
          enableP2p: false, allowTcp: true, protocolV1: true,
          enableAec: true, enableNs: true, enableAgc: true,
          endpoints: [{
            id: Long.ONE, ipv4: '127.0.0.1', ipv6: '', port: 443, kind: 'tcp-relay' as const, peerTag: new Uint8Array(16),
          }],
        }
      },
    },
  })
  return { voice: new VoiceRpc(calls, messageStore), calls, worker, store }
}

function createVoiceRpc(signalingFailure?: Error): VoiceRpc {
  return createVoiceHarness(signalingFailure).voice
}

describe('VoiceRpc incoming calls', () => {
  it('accepts compatible worker-provided incoming protocols and rejects incompatible ones', async () => {
    const voice = createVoiceRpc()
    const incoming = await voice.receiveIncoming(session, 'remote', 'qq-incoming-event')
    if (incoming?._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { _: 'inputPhoneCall' as const, id: incoming.id, accessHash: incoming.accessHash }

    await voice.received(session, { peer } as tl.phone.RawReceivedCallRequest)
    await expect(voice.accept(session, {
      peer, gB: publicValue(), protocol: workerProtocol,
    } as tl.phone.RawAcceptCallRequest)).resolves.toMatchObject({
      _: 'phone.phoneCall', phoneCall: { _: 'phoneCallWaiting', protocol: workerProtocol },
    })

    const incompatible = createVoiceRpc()
    const rejected = await incompatible.receiveIncoming(session, 'remote', 'qq-incoming-incompatible')
    if (rejected._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const rejectedPeer = { _: 'inputPhoneCall' as const, id: rejected.id, accessHash: rejected.accessHash }
    await incompatible.received(session, { peer: rejectedPeer } as tl.phone.RawReceivedCallRequest)
    await expect(incompatible.accept(session, {
      peer: rejectedPeer, gB: publicValue(), protocol: { ...workerProtocol, libraryVersions: ['other'] },
    } as tl.phone.RawAcceptCallRequest)).rejects.toMatchObject({ code: 400, text: 'CALL_PROTOCOL_INVALID' })
  })

  it('registers the native active transition through the supplied after-response callback', async () => {
    const voice = createVoiceRpc()
    const incoming = await voice.receiveIncoming(session, 'remote', 'qq-incoming-after-response')
    if (incoming?._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { _: 'inputPhoneCall' as const, id: incoming.id, accessHash: incoming.accessHash }
    const afterResponse = vi.fn()

    await voice.accept(session, {
      peer, gB: publicValue(), protocol: workerProtocol,
    } as tl.phone.RawAcceptCallRequest, undefined, afterResponse)

    expect(afterResponse).toHaveBeenCalledOnce()
  })
})

describe('VoiceRpc outgoing calls', () => {
  it('rejects Telegram-originated requests before reserving a call or preparing the worker', async () => {
    const { voice, calls, worker, store } = createVoiceHarness()
    const request = vi.spyOn(calls, 'request')

    await expect(voice.request(
      { platformKind: 'qq' } as IMPlatform,
      session,
      {
        userId: { _: 'inputUser', userId: 2, accessHash: Long.ONE }, randomId: 1,
        gAHash: new Uint8Array(32).fill(1), protocol: workerProtocol, video: false,
      } as tl.phone.RawRequestCallRequest,
    )).rejects.toMatchObject({ code: 400, text: 'CALL_OUTGOING_UNSUPPORTED' })

    expect(calls.snapshot(session)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    expect(store.getUser).not.toHaveBeenCalled()
    expect(store.getUserByTlId).not.toHaveBeenCalled()
    expect(worker.prepareTelegramCaller).not.toHaveBeenCalled()
    expect(worker.prepareTelegramRecipient).not.toHaveBeenCalled()
  })
})

describe('VoiceRpc signaling failures', () => {
  it('returns the existing sanitized worker error after retiring the call', async () => {
    const voice = createVoiceRpc(new Error('worker forwarding failed'))
    const incoming = await voice.receiveIncoming(session, 'remote', 'qq-incoming-signaling-failure')
    if (incoming?._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { _: 'inputPhoneCall' as const, id: incoming.id, accessHash: incoming.accessHash }
    await voice.accept(session, {
      peer, gB: publicValue(), protocol: workerProtocol,
    } as tl.phone.RawAcceptCallRequest)

    await expect(voice.sendSignalingData(session, {
      peer, data: Uint8Array.of(1),
    } as tl.phone.RawSendSignalingDataRequest)).rejects.toMatchObject({
      code: 500, text: 'CALL_WORKER_FAILED',
    })
  })
})
