import type { tl } from '@mtcute/core'
import Long from 'long'
import { describe, expect, it } from 'vitest'
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

function createVoiceRpc(signalingFailure?: Error): VoiceRpc {
  const worker = {
    protocol: workerProtocol,
    async prepareTelegramCaller() {
      return { state: 'ready' as const, gAHash: new Uint8Array(32).fill(1) }
    },
    async completeTelegramCaller() {
      return { state: 'media-active' as const, gA: publicValue(2), keyFingerprint: Long.ONE }
    },
    async prepareTelegramRecipient() {
      return { state: 'ready' as const, gB: publicValue(3) }
    },
    async completeTelegramRecipient() {
      return { state: 'media-active' as const, keyFingerprint: Long.ONE }
    },
    async discardCall() {},
    async sendSignalingData() {
      if (signalingFailure) throw signalingFailure
    },
  } satisfies VoiceWorkerClient
  const store = {
    async getUser(_platformId: string, platformUserId: string) {
      return { id: platformUserId === 'self' ? 1 : 2 }
    },
    async getUserByTlId() {
      return { id: 2 }
    },
  } as unknown as MessageStore
  return new VoiceRpc(new CallRegistry({
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
  }), store)
}

describe('VoiceRpc incoming calls', () => {
  it('accepts compatible worker-provided incoming protocols and rejects incompatible ones', async () => {
    const voice = createVoiceRpc()
    const incoming = await voice.receiveIncoming(session, 'remote', 'qq-incoming-event')
    if (incoming._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { _: 'inputPhoneCall' as const, id: incoming.id, accessHash: incoming.accessHash }

    await voice.received(session, { peer } as tl.phone.RawReceivedCallRequest)
    await expect(voice.accept(session, {
      peer, gB: publicValue(), protocol: workerProtocol,
    } as tl.phone.RawAcceptCallRequest)).resolves.toMatchObject({
      _: 'phone.phoneCall', phoneCall: { _: 'phoneCallAccepted', protocol: workerProtocol },
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
})

describe('VoiceRpc signaling failures', () => {
  it('returns the existing sanitized worker error after retiring the call', async () => {
    const voice = createVoiceRpc(new Error('worker forwarding failed'))
    const requested = await voice.request(
      { platformKind: 'qq' } as IMPlatform,
      session,
      {
        userId: { _: 'inputUser', userId: 2, accessHash: Long.ONE }, randomId: 1,
        gAHash: new Uint8Array(32).fill(1), protocol: workerProtocol, video: false,
      } as tl.phone.RawRequestCallRequest,
    )
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { _: 'inputPhoneCall' as const, id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash }
    await voice.confirm(session, {
      peer, gA: publicValue(), keyFingerprint: Long.ONE, protocol: workerProtocol,
    } as tl.phone.RawConfirmCallRequest)

    await expect(voice.sendSignalingData(session, {
      peer, data: Uint8Array.of(1),
    } as tl.phone.RawSendSignalingDataRequest)).rejects.toMatchObject({
      code: 500, text: 'CALL_WORKER_FAILED',
    })
  })
})
