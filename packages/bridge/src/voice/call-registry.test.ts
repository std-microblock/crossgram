import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { describe, expect, it } from 'vitest'
import {
  CallRegistry, VoiceCallError, type VoiceCallDebugSummary, type VoiceWorkerCall, type VoiceWorkerClient,
} from './call-registry.js'

const session = {
  platformSessionId: 'voice-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

const protocol: tl.RawPhoneCallProtocol = {
  _: 'phoneCallProtocol', udpP2p: true, udpReflector: false, minLayer: 100, maxLayer: 100, libraryVersions: ['bridge'],
}

const gAHash = (value = 1) => new Uint8Array(32).fill(value)
const publicValue = (value = 1) => new Uint8Array(256).fill(value)

function roundTrip(object: tl.TlObject): tl.TlObject {
  return new TlBinaryReader(__tlReaderMap, TlBinaryWriter.serializeObject(__tlWriterMap, object)).object() as tl.TlObject
}

class FakeWorker implements VoiceWorkerClient {
  protocol: tl.TypePhoneCallProtocol = { ...protocol, libraryVersions: [...protocol.libraryVersions] }
  readonly events: Array<{
    operation: string
    call: VoiceWorkerCall
    debug?: VoiceCallDebugSummary
    bytes?: number
    value?: Uint8Array
    keyFingerprint?: Long
  }> = []
  callerCompletionState: 'media-active' | 'ready' = 'media-active'
  recipientCompletionState: 'media-active' | 'ready' = 'media-active'
  recipientPreparationGate?: Promise<void>
  callerPreparationGate?: Promise<void>
  callerCompletionGate?: Promise<void>
  signalingGate?: Promise<void>
  signalingFailure?: Error
  callerGAHash = gAHash(9)
  callerGA = publicValue(8)
  callerFingerprint = Long.fromInt(11)
  recipientFingerprint = Long.fromInt(12)
  recipientGB = publicValue(7)

  async prepareTelegramCaller(call: VoiceWorkerCall) {
    this.events.push({ operation: 'prepare-caller', call })
    await this.callerPreparationGate
    return { state: 'ready' as const, gAHash: this.callerGAHash.slice() }
  }

  async completeTelegramCaller(call: VoiceWorkerCall, gB: Uint8Array) {
    this.events.push({ operation: 'complete-caller', call, value: gB.slice() })
    await this.callerCompletionGate
    return {
      state: this.callerCompletionState,
      gA: this.callerGA.slice(),
      keyFingerprint: this.callerFingerprint,
    }
  }

  async prepareTelegramRecipient(call: VoiceWorkerCall, hash: Uint8Array) {
    this.events.push({ operation: 'prepare-recipient', call, value: hash.slice() })
    await this.recipientPreparationGate
    return { state: 'ready' as const, gB: this.recipientGB.slice() }
  }

  async completeTelegramRecipient(call: VoiceWorkerCall, gA: Uint8Array, keyFingerprint: Long) {
    this.events.push({ operation: 'complete-recipient', call, value: gA.slice(), keyFingerprint })
    return { state: this.recipientCompletionState, keyFingerprint: this.recipientFingerprint }
  }

  async discardCall(call: VoiceWorkerCall) {
    this.events.push({ operation: 'discard', call })
  }

  async sendSignalingData(call: VoiceWorkerCall, data: Uint8Array) {
    this.events.push({ operation: 'signal', call, bytes: data.length })
    await this.signalingGate
    if (this.signalingFailure) throw this.signalingFailure
  }

  async saveCallDebug(call: VoiceWorkerCall, debug: VoiceCallDebugSummary) {
    this.events.push({ operation: 'debug', call, debug })
  }
}

function directProvider() {
  return {
    async get() {
      return {
        initializationTimeoutMs: 1, receiveTimeoutMs: 1,
        enableP2p: true, allowTcp: false, protocolV1: true,
        enableAec: true, enableNs: true, enableAgc: true, endpoints: [],
      }
    },
  }
}

function setup(now = 1_000) {
  let current = now
  let randomValue = 0
  const updates: tl.RawUpdatePhoneCall[] = []
  const deliveries: Array<{ state: tl.TypePhoneCall['_'], excludeAuthKeyId?: string }> = []
  const worker = new FakeWorker()
  const calls = new CallRegistry({
    worker,
    now: () => current,
    randomBytes: (size) => {
      const value = new Uint8Array(size)
      value[size - 1] = ++randomValue
      return value
    },
    timeoutMs: 60_000,
    mediaStartProvider: {
      async get() {
        return {
          initializationTimeoutMs: 1, receiveTimeoutMs: 1,
          enableP2p: true, allowTcp: false, protocolV1: true,
          enableAec: true, enableNs: true, enableAgc: true, endpoints: [],
        }
      },
    },
    publish: ({ update, excludeAuthKeyId }) => {
      updates.push(update)
      deliveries.push({ state: update.phoneCall._, excludeAuthKeyId })
      return 1
    },
  })
  return { calls, worker, updates, deliveries, advance: (milliseconds: number) => { current += milliseconds } }
}

async function requested(registry: CallRegistry, randomId = 1) {
  const result = await registry.request({
    session, selfId: 1, participantId: 2, randomId, gAHash: gAHash(), protocol,
  })
  if (result.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
  return { id: result.phoneCall.id, accessHash: result.phoneCall.accessHash }
}

async function incoming(registry: CallRegistry, correlationId = 'opaque-qq-call'): Promise<tl.RawPhoneCallRequested> {
  const result = await registry.receiveIncoming({ session, selfId: 1, callerId: 2, correlationId })
  if (result._ !== 'phoneCallRequested') throw new Error('expected requested call')
  return result
}

describe('CallRegistry', () => {
  it('runs the Telegram-caller flow through recipient preparation and recipient completion', async () => {
    const { calls, worker, updates } = setup()
    const clientGAHash = gAHash(3)
    const requested = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: clientGAHash, protocol,
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash }
    const clientGA = publicValue(4)
    const fingerprint = Long.fromInt(12)
    const active = await calls.confirm(session, peer, clientGA, fingerprint, protocol)

    expect(worker.events.slice(0, 2)).toMatchObject([
      { operation: 'prepare-recipient', call: { telegramRole: 'caller' }, value: clientGAHash },
      { operation: 'complete-recipient', call: { telegramRole: 'caller' }, value: clientGA, keyFingerprint: fingerprint },
    ])
    expect(active.phoneCall).toMatchObject({
      _: 'phoneCall', gAOrB: worker.recipientGB, keyFingerprint: fingerprint, p2pAllowed: true, connections: [],
    })
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested', 'phoneCall'])
    for (const update of updates) expect(roundTrip(update)._).toBe('updatePhoneCall')
  })

  it('lets a relay provider disable P2P in the final negotiated call', async () => {
    const worker = new FakeWorker()
    const calls = new CallRegistry({
      worker, publish: () => 1,
      mediaStartProvider: {
        async get() {
          return {
            initializationTimeoutMs: 1, receiveTimeoutMs: 1,
            enableP2p: true, allowTcp: true, protocolV1: true,
            enableAec: true, enableNs: true, enableAgc: true,
            endpoints: [{
              id: Long.ONE, ipv4: '127.0.0.1', ipv6: '', port: 443, kind: 'tcp-relay' as const, peerTag: new Uint8Array(16),
            }],
          }
        },
      },
    })
    const requested = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 98, gAHash: gAHash(), protocol: { ...protocol, udpP2p: false },
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const active = await calls.confirm(session, {
      id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash,
    }, publicValue(), Long.fromInt(12), { ...protocol, udpP2p: false })
    expect(active.phoneCall).toMatchObject({ _: 'phoneCall', p2pAllowed: false, protocol: { udpP2p: false } })
    expect(worker.events.at(-1)?.call.mediaStartConfig?.enableP2p).toBe(false)
  })

  it('publishes call-scoped TURN credentials as a WebRTC connection', async () => {
    const worker = new FakeWorker()
    const calls = new CallRegistry({
      worker, publish: () => 1,
      mediaStartProvider: {
        async get() {
          return {
            initializationTimeoutMs: 1, receiveTimeoutMs: 1,
            enableP2p: true, allowTcp: false, protocolV1: true,
            enableAec: true, enableNs: true, enableAgc: true, endpoints: [],
            rtcServers: [{
              id: 7, host: 'turn.example.test', port: 3478,
              username: '1900000000:call', password: 'credential', turn: true, tcp: false,
            }],
          }
        },
      },
    })
    const incoming = await calls.receiveIncoming({
      session, selfId: 1, callerId: 2, correlationId: 'turn-backed-incoming',
    })
    if (incoming._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const accepted = await calls.accept(session, {
      id: incoming.id, accessHash: incoming.accessHash,
    }, publicValue(), { ...protocol, udpP2p: false })

    const snapshot = calls.snapshot(session)
    expect(accepted.phoneCall._).toBe('phoneCallWaiting')
    expect(snapshot?.phoneCall).toMatchObject({
      _: 'phoneCall', p2pAllowed: false,
      connections: [{
        _: 'phoneConnectionWebrtc', id: Long.fromInt(7), ip: 'turn.example.test', port: 3478,
        username: '1900000000:call', password: 'credential', turn: true,
      }],
    })
    expect(worker.events.at(-1)?.call.mediaStartConfig?.rtcServers).toHaveLength(1)
    expect(roundTrip(snapshot!)._).toBe('updatePhoneCall')
  })

  it('rejects Direct ICE before caller or recipient worker completion when the peer disables P2P', async () => {
    const recipientWorker = new FakeWorker()
    const recipientCalls = new CallRegistry({ worker: recipientWorker, mediaStartProvider: directProvider(), publish: () => 1 })
    const requested = await recipientCalls.request({
      session, selfId: 1, participantId: 2, randomId: 96, gAHash: gAHash(), protocol,
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    await expect(recipientCalls.confirm(session, {
      id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash,
    }, publicValue(), Long.fromInt(12), { ...protocol, udpP2p: false })).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(recipientWorker.events.filter((event) => event.operation === 'complete-recipient')).toHaveLength(0)

    const callerWorker = new FakeWorker()
    const callerCalls = new CallRegistry({ worker: callerWorker, mediaStartProvider: directProvider(), publish: () => 1 })
    const incoming = await callerCalls.receiveIncoming({ session, selfId: 1, callerId: 2, correlationId: 'p2p-disabled-peer' })
    if (incoming._ !== 'phoneCallRequested') throw new Error('expected requested call')
    await callerCalls.received(session, { id: incoming.id, accessHash: incoming.accessHash })
    await expect(callerCalls.accept(session, {
      id: incoming.id, accessHash: incoming.accessHash,
    }, publicValue(), { ...protocol, udpP2p: false })).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(callerWorker.events.filter((event) => event.operation === 'complete-caller')).toHaveLength(0)
  })

  it('fails closed before media activation without a call-scoped provider', async () => {
    const worker = new FakeWorker()
    const calls = new CallRegistry({ worker })
    const requested = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 99, gAHash: gAHash(), protocol,
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    await expect(calls.confirm(session, {
      id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash,
    }, publicValue(), Long.fromInt(12), protocol)).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(worker.events.filter((event) => event.operation === 'complete-recipient')).toHaveLength(0)
  })

  it('rejects an outbound worker signal until an authorized delivery accepts it', async () => {
    const worker = new FakeWorker()
    let liveDeliveries = 0
    let attempts = 0
    const calls = new CallRegistry({
      worker, mediaStartProvider: directProvider(), publish: () => 1,
      publishSignaling: async () => {
        attempts++
        return liveDeliveries
      },
    })
    const requested = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 100, gAHash: gAHash(), protocol,
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash }
    await calls.confirm(session, peer, publicValue(), Long.fromInt(12), protocol)
    const workerCall = {
      callId: requested.phoneCall.id.toUnsigned().toString(), callerId: 1, participantId: 2,
      telegramRole: 'caller' as const, protocol,
    }

    await expect(calls.handleWorkerEvent(workerCall, { kind: 'outbound-signal', data: Uint8Array.of(4, 5) }))
      .rejects.toMatchObject({ code: 'CALL_SIGNALING_UNDELIVERED' })
    liveDeliveries = 1
    await expect(calls.handleWorkerEvent(workerCall, { kind: 'outbound-signal', data: Uint8Array.of(4, 5) })).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('rejects a mismatched worker-computed recipient fingerprint before publishing active', async () => {
    const { calls, worker, updates } = setup()
    const peer = await requested(calls)
    worker.recipientFingerprint = Long.fromInt(13)

    await expect(calls.confirm(session, peer, publicValue(4), Long.fromInt(12), protocol))
      .rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })

    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested', 'phoneCallDiscarded'])
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
    expect(calls.snapshot(session)).toBeUndefined()
  })

  it('compares negative worker fingerprints as signed i64 values', async () => {
    const { calls, worker } = setup()
    const peer = await requested(calls)
    worker.recipientFingerprint = Long.NEG_ONE
    const expected = Long.fromBits(-1, -1, true)

    const active = await calls.confirm(session, peer, publicValue(4), expected, protocol)

    expect(active.phoneCall).toMatchObject({ _: 'phoneCall', keyFingerprint: Long.NEG_ONE })
  })

  it('validates signed TL-decoded high-bit call peers across live, active, and tombstone paths', async () => {
    const randomValues = [1, 1, 2, 3, 4]
    const worker = new FakeWorker()
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: directProvider(),
      randomBytes: (size) => {
        const value = new Uint8Array(size)
        value[0] = 0x80
        value[size - 1] = randomValues.shift() ?? 5
        return value
      },
    })
    const first = await incoming(calls, 'high-bit-incoming')
    const decodedFirst = roundTrip({
      _: 'inputPhoneCall', id: first.id, accessHash: first.accessHash,
    }) as tl.RawInputPhoneCall
    const incomingPeer = { id: decodedFirst.id, accessHash: decodedFirst.accessHash }

    expect(decodedFirst.id.isNegative()).toBe(true)
    expect(decodedFirst.accessHash.isNegative()).toBe(true)
    expect(decodedFirst.id.low).not.toBe(decodedFirst.accessHash.low)
    await calls.received(session, incomingPeer)
    await calls.accept(session, incomingPeer, publicValue(), protocol)
    await calls.sendSignalingData(session, incomingPeer, Uint8Array.of(1))
    await calls.saveCallDebug(session, incomingPeer, { _: 'dataJSON', data: '{}' })
    await calls.discard(session, incomingPeer, { _: 'phoneCallDiscardReasonHangup' }, 0)
    await expect(calls.discard(session, incomingPeer, { _: 'phoneCallDiscardReasonHangup' }, 0))
      .resolves.toMatchObject({ _: 'phoneCallDiscarded' })

    const requested = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 2, gAHash: gAHash(), protocol,
    })
    if (requested.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const decodedOutgoing = roundTrip({
      _: 'inputPhoneCall', id: requested.phoneCall.id, accessHash: requested.phoneCall.accessHash,
    }) as tl.RawInputPhoneCall
    const outgoingPeer = { id: decodedOutgoing.id, accessHash: decodedOutgoing.accessHash }

    await calls.confirm(session, outgoingPeer, publicValue(), Long.fromInt(12), protocol)
    await calls.sendSignalingData(session, outgoingPeer, Uint8Array.of(2))
    await calls.saveCallDebug(session, outgoingPeer, { _: 'dataJSON', data: '{}' })
    await calls.discard(session, outgoingPeer, { _: 'phoneCallDiscardReasonHangup' }, 0)
  })

  it('runs the Telegram-recipient flow through caller preparation and caller completion', async () => {
    const { calls, worker, updates, deliveries } = setup()
    const first = await incoming(calls)
    const retry = await incoming(calls)
    const peer = { id: first.id, accessHash: first.accessHash }

    await calls.received(session, peer)
    const accepted = await calls.accept(session, peer, publicValue(5), protocol, 'accepting-auth-key')

    expect(first).toMatchObject({ _: 'phoneCallRequested', gAHash: worker.callerGAHash })
    expect(retry).toEqual(first)
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)
    expect(worker.events.find((event) => event.operation === 'complete-caller')).toMatchObject({
      call: { telegramRole: 'recipient' }, value: publicValue(5),
    })
    expect(accepted.phoneCall).toMatchObject({ _: 'phoneCallWaiting' })
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallWaiting', 'phoneCallAccepted', 'phoneCall',
    ])
    expect(updates.at(-1)?.phoneCall).toMatchObject({
      _: 'phoneCall', gAOrB: worker.callerGA, keyFingerprint: worker.callerFingerprint,
    })
    expect(deliveries.slice(-2)).toEqual([
      { state: 'phoneCallAccepted', excludeAuthKeyId: 'accepting-auth-key' },
      { state: 'phoneCall', excludeAuthKeyId: undefined },
    ])
  })

  it('defers the active incoming-call update until after the accept response', async () => {
    const { calls, updates } = setup()
    const first = await incoming(calls, 'deferred-active-update')
    const peer = { id: first.id, accessHash: first.accessHash }
    const deferred: Array<() => void | Promise<void>> = []

    await calls.received(session, peer)
    const accepted = await calls.accept(
      session,
      peer,
      publicValue(5),
      protocol,
      'accepting-auth-key',
      (task) => deferred.push(task),
    )

    expect(accepted.phoneCall).toMatchObject({ _: 'phoneCallWaiting' })
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallWaiting', 'phoneCallAccepted',
    ])
    expect(deferred).toHaveLength(1)

    await deferred[0]!()

    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallWaiting', 'phoneCallAccepted', 'phoneCall',
    ])
  })

  it('accepts directly from requested when the client skips phone.receivedCall', async () => {
    const { calls, worker, updates } = setup()
    const requested = await incoming(calls, 'accept-without-received-ack')
    const peer = { id: requested.id, accessHash: requested.accessHash }

    const accepted = await calls.accept(session, peer, publicValue(6), protocol)

    expect(accepted.phoneCall).toMatchObject({ _: 'phoneCallWaiting' })
    expect(worker.events.map((event) => event.operation)).toEqual([
      'prepare-caller', 'complete-caller',
    ])
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallAccepted', 'phoneCall',
    ])
  })

  it('rejects role-incompatible phone RPC transitions without changing the call', async () => {
    const { calls, updates } = setup()
    const caller = await requested(calls)
    await expect(calls.received(session, caller)).rejects.toMatchObject({ code: 'CALL_ROLE_INVALID' })
    await expect(calls.accept(session, caller, publicValue(), protocol)).rejects.toMatchObject({ code: 'CALL_ROLE_INVALID' })

    await calls.discard(session, caller, { _: 'phoneCallDiscardReasonHangup' }, 0)
    const recipient = await incoming(calls)
    await expect(calls.confirm(session, recipient, publicValue(), Long.ONE, protocol))
      .rejects.toMatchObject({ code: 'CALL_ROLE_INVALID' })
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallDiscarded', 'phoneCallRequested',
    ])
  })

  it('requires exactly 32-byte hashes and 256-byte public DH values', async () => {
    const { calls, worker } = setup()
    await expect(calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: new Uint8Array(31), protocol,
    })).rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })
    await expect(calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: new Uint8Array(33), protocol,
    })).rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })

    worker.callerGAHash = new Uint8Array(31)
    await expect(incoming(calls)).rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })
    worker.callerGAHash = gAHash()
    const requested = await incoming(calls, 'valid-incoming')
    const peer = { id: requested.id, accessHash: requested.accessHash }
    await calls.received(session, peer)
    await expect(calls.accept(session, peer, new Uint8Array(255), protocol))
      .rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })
    await expect(calls.accept(session, peer, new Uint8Array(257), protocol))
      .rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })

    await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 0)
    const caller = await requestedForLength(calls)
    await expect(calls.confirm(session, caller, new Uint8Array(255), Long.ONE, protocol))
      .rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })
    await expect(calls.confirm(session, caller, new Uint8Array(257), Long.ONE, protocol))
      .rejects.toMatchObject({ code: 'CALL_HANDSHAKE_INVALID' })
  })

  it('does not publish active media and tears down when recipient completion cannot activate', async () => {
    const { calls, worker, updates } = setup()
    const peer = await requested(calls)
    worker.recipientCompletionState = 'ready'

    await expect(calls.confirm(session, peer, publicValue(), Long.ONE, protocol))
      .rejects.toBeInstanceOf(VoiceCallError)
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallDiscarded',
    ])
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
    expect(calls.snapshot(session)).toBeUndefined()
  })

  it('does not publish active media and tears down when caller completion cannot activate', async () => {
    const { calls, worker, updates } = setup()
    const requested = await incoming(calls)
    const peer = { id: requested.id, accessHash: requested.accessHash }
    await calls.received(session, peer)
    worker.callerCompletionState = 'ready'

    await expect(calls.accept(session, peer, publicValue(), protocol)).rejects.toBeInstanceOf(VoiceCallError)
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCallWaiting', 'phoneCallDiscarded',
    ])
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
    expect(calls.snapshot(session)).toBeUndefined()
  })

  it('retries failed request, received, accept, and confirm deliveries without repeating worker effects', async () => {
    const requestWorker = new FakeWorker()
    let failRequest = true
    const requestCalls = new CallRegistry({
      worker: requestWorker,
      publish: ({ update }) => {
        if (update.phoneCall._ === 'phoneCallRequested' && failRequest) {
          failRequest = false
          throw new Error('publisher unavailable')
        }
        return 1
      },
    })
    const requestInput = { session, selfId: 1, participantId: 2, randomId: 1, gAHash: gAHash(), protocol }
    await expect(requestCalls.request(requestInput)).rejects.toThrow('publisher unavailable')
    await requestCalls.request(requestInput)
    expect(requestWorker.events.filter((event) => event.operation === 'prepare-recipient')).toHaveLength(1)

    const receivedWorker = new FakeWorker()
    let failReceived = true
    const receivedCalls = new CallRegistry({
      worker: receivedWorker,
      publish: ({ update }) => {
        if (update.phoneCall._ === 'phoneCallWaiting' && failReceived) {
          failReceived = false
          throw new Error('publisher unavailable')
        }
        return 1
      },
    })
    const incomingCall = await incoming(receivedCalls, 'retry-received-delivery')
    const incomingPeer = { id: incomingCall.id, accessHash: incomingCall.accessHash }
    await expect(receivedCalls.received(session, incomingPeer)).rejects.toThrow('publisher unavailable')
    await receivedCalls.received(session, incomingPeer)
    expect(receivedWorker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)

    const acceptWorker = new FakeWorker()
    let failAccepted = true
    const acceptCalls = new CallRegistry({
      worker: acceptWorker,
      mediaStartProvider: directProvider(),
      publish: ({ update }) => {
        if (update.phoneCall._ === 'phoneCallAccepted' && failAccepted) {
          failAccepted = false
          throw new Error('publisher unavailable')
        }
        return 1
      },
    })
    const acceptedIncoming = await incoming(acceptCalls, 'retry-accept-delivery')
    const acceptedPeer = { id: acceptedIncoming.id, accessHash: acceptedIncoming.accessHash }
    await acceptCalls.received(session, acceptedPeer)
    await expect(acceptCalls.accept(session, acceptedPeer, publicValue(), protocol)).rejects.toThrow('publisher unavailable')
    await acceptCalls.accept(session, acceptedPeer, publicValue(), protocol)
    expect(acceptWorker.events.filter((event) => event.operation === 'complete-caller')).toHaveLength(1)

    const confirmWorker = new FakeWorker()
    let failActive = true
    const confirmCalls = new CallRegistry({
      worker: confirmWorker,
      mediaStartProvider: directProvider(),
      publish: ({ update }) => {
        if (update.phoneCall._ === 'phoneCall' && failActive) {
          failActive = false
          throw new Error('publisher unavailable')
        }
        return 1
      },
    })
    const confirmedPeer = await requested(confirmCalls)
    await expect(confirmCalls.confirm(session, confirmedPeer, publicValue(), Long.fromInt(12), protocol))
      .rejects.toThrow('publisher unavailable')
    await confirmCalls.confirm(session, confirmedPeer, publicValue(), Long.fromInt(12), protocol)
    expect(confirmWorker.events.filter((event) => event.operation === 'complete-recipient')).toHaveLength(1)
  })

  it('retries failed incoming initial delivery without rerunning caller preparation', async () => {
    const worker = new FakeWorker()
    const retryPublishStarted = Promise.withResolvers<void>()
    const releaseRetryPublish = Promise.withResolvers<void>()
    let publishAttempts = 0
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: directProvider(),
      publish: async () => {
        publishAttempts++
        if (publishAttempts === 1) throw new Error('publisher unavailable')
        if (publishAttempts === 2) {
          retryPublishStarted.resolve()
          await releaseRetryPublish.promise
        }
        return 1
      },
    })

    await expect(incoming(calls, 'retry-incoming-delivery')).rejects.toThrow('publisher unavailable')
    const retry = incoming(calls, 'retry-incoming-delivery')
    await retryPublishStarted.promise
    const concurrentRetry = incoming(calls, 'retry-incoming-delivery')
    releaseRetryPublish.resolve()
    const [firstResult, concurrentResult] = await Promise.all([retry, concurrentRetry])

    expect(concurrentResult).toEqual(firstResult)
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)
    expect(publishAttempts).toBe(2)
    expect(await incoming(calls, 'retry-incoming-delivery')).toEqual(firstResult)
    expect(publishAttempts).toBe(2)
  })

  it('withholds incoming snapshots and updates until the caller hash is ready', async () => {
    const { calls, worker, updates } = setup()
    const gate = Promise.withResolvers<void>()
    worker.callerPreparationGate = gate.promise

    const first = incoming(calls, 'gated-incoming')
    await Promise.resolve()
    const retry = incoming(calls, 'gated-incoming')
    await Promise.resolve()

    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)
    expect(calls.snapshot(session)).toBeUndefined()
    expect(updates).toEqual([])

    gate.resolve()
    const [requested, retried] = await Promise.all([first, retry])
    const snapshot = calls.snapshot(session)

    expect(retried).toEqual(requested)
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)
    expect(updates).toMatchObject([{ phoneCall: { _: 'phoneCallRequested', gAHash: worker.callerGAHash } }])
    expect(snapshot).toMatchObject({ phoneCall: { _: 'phoneCallRequested', gAHash: worker.callerGAHash } })
  })

  it('deduplicates caller preparation by randomId and reserves the session while it is pending', async () => {
    const { calls, worker } = setup()
    const gate = Promise.withResolvers<void>()
    worker.recipientPreparationGate = gate.promise
    const input = { session, selfId: 1, participantId: 2, randomId: 42, gAHash: gAHash(), protocol }
    const first = calls.request(input)
    await Promise.resolve()
    const retry = calls.request(input)
    const conflict = calls.request({ ...input, participantId: 3, randomId: 43 })
    gate.resolve()

    await expect(conflict).rejects.toMatchObject({ code: 'CALL_OCCUPY_FAILED' })
    expect(await retry).toEqual(await first)
    expect(worker.events.filter((event) => event.operation === 'prepare-recipient')).toHaveLength(1)
  })

  it('uses the worker protocol capability for incoming calls and rejects an empty capability', async () => {
    const { calls, worker } = setup()
    worker.protocol = { ...protocol, libraryVersions: [] }
    await expect(incoming(calls, 'missing-worker-capability')).rejects.toMatchObject({ code: 'CALL_PROTOCOL_INVALID' })

    worker.protocol = { ...protocol, libraryVersions: ['worker-v1', 'worker-v2'] }
    const first = await incoming(calls, 'worker-capability')
    worker.protocol.libraryVersions.push('mutated')

    expect(first.protocol.libraryVersions).toEqual(['worker-v1', 'worker-v2'])
  })

  it('keeps caller and recipient protocols separate and publishes their negotiated overlap', async () => {
    const { calls, worker, updates } = setup()
    const callerProtocol: tl.RawPhoneCallProtocol = {
      _: 'phoneCallProtocol', udpP2p: true, udpReflector: true,
      minLayer: 90, maxLayer: 110, libraryVersions: ['legacy', 'bridge'],
    }
    const recipientProtocol: tl.RawPhoneCallProtocol = {
      _: 'phoneCallProtocol', udpP2p: true, udpReflector: true,
      minLayer: 100, maxLayer: 120, libraryVersions: ['bridge', 'modern'],
    }
    worker.protocol = callerProtocol
    const first = await calls.receiveIncoming({
      session, selfId: 1, callerId: 2, correlationId: 'protocol-overlap',
    })
    if (first._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = { id: first.id, accessHash: first.accessHash }
    await calls.received(session, peer)
    const accepted = await calls.accept(session, peer, publicValue(), recipientProtocol)

    expect(accepted.phoneCall).toMatchObject({ _: 'phoneCallWaiting', protocol: callerProtocol })
    expect(updates.at(-2)?.phoneCall).toMatchObject({
      _: 'phoneCallAccepted', protocol: recipientProtocol,
    })
    expect(updates.at(-1)?.phoneCall).toMatchObject({
      _: 'phoneCall', protocol: {
        minLayer: 100, maxLayer: 110, libraryVersions: ['bridge'], udpP2p: true, udpReflector: true,
      },
    })
  })

  it('fails closed when accept protocols have no layer or library-version compatibility', async () => {
    const { calls, worker } = setup()
    for (const recipientProtocol of [
      { ...protocol, minLayer: 101, maxLayer: 120 },
      { ...protocol, libraryVersions: ['incompatible'] },
    ]) {
      const first = await incoming(calls, `incompatible-${recipientProtocol.minLayer}-${recipientProtocol.libraryVersions[0]}`)
      const peer = { id: first.id, accessHash: first.accessHash }
      await calls.received(session, peer)
      await expect(calls.accept(session, peer, publicValue(), recipientProtocol)).rejects.toMatchObject({
        code: 'CALL_PROTOCOL_INVALID',
      })
      expect(calls.snapshot(session)).toBeUndefined()
    }
    expect(worker.events.filter((event) => event.operation === 'complete-caller')).toHaveLength(0)
  })

  it('keeps signaling and debug data bounded and never records their values', async () => {
    const { calls, worker, updates } = setup()
    const first = await incoming(calls)
    const peer = { id: first.id, accessHash: first.accessHash }
    await calls.received(session, peer)
    await calls.accept(session, peer, publicValue(), protocol)

    await expect(calls.sendSignalingData(session, peer, new Uint8Array(4_097)))
      .rejects.toMatchObject({ code: 'CALL_SIGNALING_INVALID' })
    for (let index = 0; index < 32; index++) await calls.sendSignalingData(session, peer, Uint8Array.of(index))
    await expect(calls.sendSignalingData(session, peer, Uint8Array.of(1)))
      .rejects.toMatchObject({ code: 'CALL_SIGNALING_FLOOD' })
    await calls.saveCallDebug(session, peer, { _: 'dataJSON', data: '{"relayPassword":"not-for-logs","stats":1}' })

    const recorded = JSON.stringify({ events: worker.events, updates })
    expect(recorded).not.toContain('not-for-logs')
    expect(recorded).toContain('relayPassword')
    expect(worker.events.filter((event) => event.operation === 'signal')).toHaveLength(32)
    expect(worker.events.find((event) => event.operation === 'debug')?.debug).toEqual({
      bytes: 42, topLevelKeys: ['relayPassword', 'stats'],
    })
  })

  it('retires a failed signaling call once when signaling and discard race', async () => {
    const { calls, worker, updates } = setup()
    const peer = await requested(calls)
    await calls.confirm(session, peer, publicValue(), Long.fromInt(12), protocol)
    const gate = Promise.withResolvers<void>()
    worker.signalingGate = gate.promise
    worker.signalingFailure = new VoiceCallError('CALL_MEDIA_UNAVAILABLE')

    const failed = calls.sendSignalingData(session, peer, Uint8Array.of(1))
    await Promise.resolve()
    const repeated = calls.sendSignalingData(session, peer, Uint8Array.of(2))
    const concurrentDiscard = calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 0)
    gate.resolve()

    await expect(failed).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    await expect(repeated).rejects.toMatchObject({ code: 'CALL_PEER_INVALID' })
    await expect(concurrentDiscard).resolves.toMatchObject({ _: 'phoneCallDiscarded' })
    await expect(calls.sendSignalingData(session, peer, Uint8Array.of(3)))
      .rejects.toMatchObject({ code: 'CALL_PEER_INVALID' })
    expect(worker.events.filter((event) => event.operation === 'signal')).toHaveLength(1)
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
    expect(updates.map((update) => update.phoneCall._)).toEqual([
      'phoneCallRequested', 'phoneCall', 'phoneCallDiscarded',
    ])
    expect(calls.snapshot(session)).toBeUndefined()
  })

  it('replays a failed signaling terminal tombstone without repeating teardown or incoming preparation', async () => {
    const worker = new FakeWorker()
    let liveConnections = 0
    let replayAttempts = 0
    const published: tl.RawUpdatePhoneCall[] = []
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: directProvider(),
      publish: ({ update }) => {
        if (update.phoneCall._ === 'phoneCallDiscarded') published.push(update)
        return liveConnections
      },
      replay: () => {
        replayAttempts++
        return liveConnections
      },
    })
    const correlationId = 'signaling-failure-correlation'
    const first = await incoming(calls, correlationId)
    const peer = { id: first.id, accessHash: first.accessHash }
    await calls.received(session, peer)
    await calls.accept(session, peer, publicValue(), protocol)
    worker.signalingFailure = new VoiceCallError('CALL_MEDIA_UNAVAILABLE')

    await expect(calls.sendSignalingData(session, peer, Uint8Array.of(1)))
      .rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
    expect(published).toMatchObject([{ phoneCall: { _: 'phoneCallDiscarded', reason: { _: 'phoneCallDiscardReasonDisconnect' } } }])
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    await expect(calls.receiveIncoming({ session, selfId: 1, callerId: 2, correlationId }))
      .resolves.toMatchObject({ _: 'phoneCallDiscarded', id: first.id })
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)

    await calls.replay(session, 'authorized-auth-key')
    expect(replayAttempts).toBe(1)
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    liveConnections = 1
    await calls.replay(session, 'authorized-auth-key')
    expect(replayAttempts).toBe(2)
    expect(calls.snapshot(session)).toBeUndefined()
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
  })

  it('returns only public Telegram call objects from snapshots', async () => {
    const { calls, worker } = setup()
    const peer = await requested(calls)
    worker.recipientFingerprint = Long.fromInt(14)
    await calls.confirm(session, peer, publicValue(6), Long.fromInt(14), protocol)
    const snapshot = calls.snapshot(session)

    expect(snapshot).toMatchObject({
      _: 'updatePhoneCall', phoneCall: { _: 'phoneCall', gAOrB: worker.recipientGB, keyFingerprint: Long.fromInt(14) },
    })
    expect(JSON.stringify(snapshot)).not.toContain('telegramRole')
    expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(roundTrip(snapshot!)._).toBe('updatePhoneCall')
  })

  it('does not retain mutable public arrays or protocol objects', async () => {
    const { calls } = setup()
    const result = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: gAHash(3), protocol,
    })
    if (result.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    result.phoneCall.gAHash.fill(99)
    result.phoneCall.protocol.minLayer = 1
    result.phoneCall.protocol.libraryVersions.push('mutated')

    const snapshot = calls.snapshot(session)
    if (snapshot?.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested snapshot')
    expect(snapshot.phoneCall.gAHash).toEqual(gAHash(3))
    expect(snapshot.phoneCall.protocol).toEqual(protocol)

    snapshot.phoneCall.gAHash.fill(88)
    snapshot.phoneCall.protocol.libraryVersions.push('snapshot-mutated')
    const retry = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: gAHash(3), protocol,
    })
    expect(retry.phoneCall).toMatchObject({ _: 'phoneCallRequested', gAHash: gAHash(3), protocol })
  })

  it('retires terminal calls to bounded credential-free tombstones', async () => {
    const { calls, advance } = setup()
    const peer = await requested(calls)
    await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1)
    const internals = calls as unknown as {
      _calls: Map<string, unknown>
      _sessionCalls: Map<string, unknown>
      _incomingCalls: Map<string, unknown>
      _tombstones: Map<string, unknown>
    }

    expect(internals._calls.size).toBe(0)
    expect(internals._sessionCalls.size).toBe(0)
    expect(internals._incomingCalls.size).toBe(0)
    expect([...internals._tombstones.values()][0]).not.toHaveProperty('session')
    expect(JSON.stringify([...internals._tombstones.values()])).not.toContain('credentials')
    await expect(calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1))
      .resolves.toMatchObject({ _: 'phoneCallDiscarded', duration: 1 })

    advance(5 * 60_000)
    await expect(calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1))
      .rejects.toMatchObject({ code: 'CALL_PEER_INVALID' })
  })

  it('expires unanswered calls, makes discard idempotent, and has no worker by default', async () => {
    const { calls, worker, updates, advance } = setup()
    const peer = await requested(calls)
    advance(60_000)
    await calls.expire()
    const repeated = await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1)

    expect(repeated).toMatchObject({ _: 'phoneCallDiscarded', reason: { _: 'phoneCallDiscardReasonMissed' }, duration: 0 })
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested', 'phoneCallDiscarded'])
    const unavailable = new CallRegistry()
    await expect(unavailable.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: gAHash(), protocol,
    })).rejects.toMatchObject({ code: 'CALL_OUTGOING_UNSUPPORTED' })
    await expect(unavailable.receiveIncoming({
      session, selfId: 1, callerId: 2, correlationId: 'opaque-qq-call',
    })).rejects.toMatchObject({ code: 'CALL_MEDIA_UNAVAILABLE' })
  })

  it('negotiates outgoing protocols before worker preparation and requires confirm compatibility', async () => {
    const { calls, worker } = setup()
    worker.protocol = { ...protocol, libraryVersions: [] }
    await expect(calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: gAHash(), protocol,
    })).rejects.toMatchObject({ code: 'CALL_PROTOCOL_INVALID' })
    expect(worker.events).toEqual([])
    worker.protocol = { ...protocol, libraryVersions: ['worker-only'] }
    await expect(calls.request({
      session, selfId: 1, participantId: 2, randomId: 1, gAHash: gAHash(), protocol,
    })).rejects.toMatchObject({ code: 'CALL_PROTOCOL_INVALID' })
    expect(worker.events).toEqual([])

    worker.protocol = { ...protocol, minLayer: 105, maxLayer: 120, libraryVersions: ['bridge', 'worker'] }
    const callerProtocol = { ...protocol, minLayer: 100, maxLayer: 110, libraryVersions: ['caller', 'bridge'] }
    const requestedCall = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 2, gAHash: gAHash(), protocol: callerProtocol,
    })
    if (requestedCall.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    expect(requestedCall.phoneCall.protocol).toEqual(callerProtocol)
    expect(worker.events.at(-1)).toMatchObject({
      operation: 'prepare-recipient', call: { protocol: { minLayer: 105, maxLayer: 110, libraryVersions: ['bridge'] } },
    })

    const peer = { id: requestedCall.phoneCall.id, accessHash: requestedCall.phoneCall.accessHash }
    await expect(calls.confirm(session, peer, publicValue(), Long.fromInt(12), {
      ...protocol, libraryVersions: ['incompatible'],
    })).rejects.toMatchObject({ code: 'CALL_PROTOCOL_INVALID' })
    expect(worker.events.filter((event) => event.operation === 'complete-recipient')).toHaveLength(0)
    await calls.confirm(session, peer, publicValue(), Long.fromInt(12), {
      ...protocol, minLayer: 106, maxLayer: 108, libraryVersions: ['bridge', 'other'],
    })
  })

  it('replays a pending terminal tombstone without retaining session secrets or rerunning teardown', async () => {
    const worker = new FakeWorker()
    const updates: tl.RawUpdatePhoneCall[] = []
    let failTerminal = true
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: directProvider(),
      publish: ({ update }) => {
        if (update.phoneCall._ === 'phoneCallDiscarded' && failTerminal) {
          failTerminal = false
          throw new Error('publisher unavailable')
        }
        updates.push(update)
        return 1
      },
    })
    const peer = await requested(calls, 41)
    await expect(calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1)).rejects.toThrow('publisher unavailable')
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    const internals = calls as unknown as { _tombstones: Map<string, unknown> }
    const tombstone = [...internals._tombstones.values()][0]
    expect(JSON.stringify(tombstone)).not.toContain('credentials')
    expect(tombstone).not.toHaveProperty('session')
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)

    await expect(calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1))
      .resolves.toMatchObject({ _: 'phoneCallDiscarded' })
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)
    expect(updates.filter((update) => update.phoneCall._ === 'phoneCallDiscarded')).toHaveLength(1)
    expect(calls.snapshot(session)).toBeUndefined()

    await expect(calls.request({
      session, selfId: 1, participantId: 2, randomId: 41, gAHash: gAHash(), protocol,
    })).resolves.toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    await expect(calls.request({
      session, selfId: 1, participantId: 3, randomId: 41, gAHash: gAHash(), protocol,
    })).rejects.toMatchObject({ code: 'CALL_OCCUPY_FAILED' })
    await calls.request({ session, selfId: 1, participantId: 2, randomId: 42, gAHash: gAHash(), protocol })
    expect(worker.events.filter((event) => event.operation === 'prepare-recipient')).toHaveLength(2)
  })

  it('retries a pending current call from expire once a live connection is available', async () => {
    const worker = new FakeWorker()
    const updates: tl.RawUpdatePhoneCall[] = []
    const exclusions: Array<string | undefined> = []
    let liveConnections = 0
    const calls = new CallRegistry({
      worker,
      publish: ({ update, excludeAuthKeyId }) => {
        exclusions.push(excludeAuthKeyId)
        if (liveConnections) updates.push(update)
        return liveConnections
      },
    })
    const input = {
      session, selfId: 1, participantId: 2, randomId: 71, gAHash: gAHash(), protocol, excludeAuthKeyId: 'initiator',
    }

    await calls.request(input)
    const internals = calls as unknown as { _calls: Map<string, { pendingDelivery?: tl.TypePhoneCall }> }
    expect([...internals._calls.values()][0]?.pendingDelivery).toMatchObject({ _: 'phoneCallRequested' })
    liveConnections = 1
    await calls.expire()

    expect([...internals._calls.values()][0]?.pendingDelivery).toBeUndefined()
    expect(exclusions).toEqual(['initiator', 'initiator'])
    expect(updates.map((update) => update.phoneCall._)).toEqual(['phoneCallRequested'])
    expect(worker.events.filter((event) => event.operation === 'prepare-recipient')).toHaveLength(1)
  })

  it('clears a current pending delivery after a successful targeted replay', async () => {
    const worker = new FakeWorker()
    let publishes = 0
    let replays = 0
    const calls = new CallRegistry({
      worker,
      publish: () => { publishes++; return 0 },
      replay: () => { replays++; return 1 },
    })

    await calls.request({ session, selfId: 1, participantId: 2, randomId: 72, gAHash: gAHash(), protocol })
    await calls.replay(session, 'authorized-auth-key')
    await calls.expire()

    expect(replays).toBe(1)
    expect(publishes).toBe(1)
  })

  it('keeps a zero-delivery incoming terminal tombstone pending through reconnect without repeating teardown', async () => {
    const worker = new FakeWorker()
    let liveConnections = 0
    let replayAttempts = 0
    let current = 1_000
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: directProvider(),
      now: () => current,
      publish: () => liveConnections,
      replay: () => {
        replayAttempts++
        return liveConnections
      },
    })
    const correlationId = 'qq-private-correlation'
    const first = await incoming(calls, correlationId)
    const peer = { id: first.id, accessHash: first.accessHash }

    await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1)
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    const redelivered = await calls.receiveIncoming({ session, selfId: 1, callerId: 2, correlationId })
    expect(redelivered).toMatchObject({ _: 'phoneCallDiscarded', id: first.id })
    await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1)
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(1)
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)

    const internals = calls as unknown as {
      _tombstones: Map<string, unknown>
      _incomingTombstones: Map<string, unknown>
    }
    expect(JSON.stringify([...internals._tombstones.values()])).not.toContain(correlationId)
    expect(internals._incomingTombstones.size).toBe(1)

    await calls.replay(session, 'authorized-auth-key')
    expect(replayAttempts).toBe(1)
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCallDiscarded' } })
    liveConnections = 1
    await calls.replay(session, 'authorized-auth-key')
    expect(replayAttempts).toBe(2)
    expect(calls.snapshot(session)).toBeUndefined()
    await expect(calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1))
      .resolves.toMatchObject({ _: 'phoneCallDiscarded' })
    expect(worker.events.filter((event) => event.operation === 'discard')).toHaveLength(1)

    current += 5 * 60_000
    const afterExpiry = await incoming(calls, correlationId)
    expect(afterExpiry).toMatchObject({ _: 'phoneCallRequested' })
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(2)
  })

  it('bounds and evicts HMAC-indexed incoming terminal tombstones', async () => {
    const worker = new FakeWorker()
    let randomValue = 0
    const calls = new CallRegistry({
      worker,
      mediaStartProvider: directProvider(),
      randomBytes: (size) => {
        const bytes = new Uint8Array(size)
        new DataView(bytes.buffer).setUint32(size - 4, ++randomValue)
        return bytes
      },
      publish: () => 1,
    })
    for (let index = 0; index <= 256; index++) {
      const first = await incoming(calls, `cap-${index}`)
      await calls.discard(session, { id: first.id, accessHash: first.accessHash }, { _: 'phoneCallDiscardReasonHangup' }, 0)
    }

    const internals = calls as unknown as {
      _tombstones: Map<string, unknown>
      _incomingTombstones: Map<string, unknown>
    }
    expect(internals._tombstones.size).toBe(256)
    expect(internals._incomingTombstones.size).toBe(256)
    expect(JSON.stringify([...internals._tombstones.values()])).not.toContain('cap-1')
    await incoming(calls, 'cap-0')
    expect(worker.events.filter((event) => event.operation === 'prepare-caller')).toHaveLength(258)
  })

  it('stores receive and start dates at their transitions', async () => {
    const { calls, advance } = setup(1_000)
    const first = await incoming(calls, 'stable-dates')
    const peer = { id: first.id, accessHash: first.accessHash }
    advance(4_500)
    await calls.received(session, peer)
    const waiting = calls.snapshot(session)
    expect(waiting).toMatchObject({ phoneCall: { _: 'phoneCallWaiting', receiveDate: 5 } })
    advance(2_000)
    await calls.accept(session, peer, publicValue(), protocol)
    const active = calls.snapshot(session)
    expect(active).toMatchObject({ phoneCall: { _: 'phoneCall', startDate: 7 } })
    advance(10_000)
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { _: 'phoneCall', startDate: 7 } })
  })

  it('clones public Long values so external mutations cannot change retained calls or tombstones', async () => {
    const { calls, worker } = setup()
    const first = await calls.request({
      session, selfId: 1, participantId: 2, randomId: 51, gAHash: gAHash(), protocol,
    })
    if (first.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
    const peer = {
      id: Long.fromBits(first.phoneCall.id.low, first.phoneCall.id.high, first.phoneCall.id.unsigned),
      accessHash: Long.fromBits(first.phoneCall.accessHash.low, first.phoneCall.accessHash.high, first.phoneCall.accessHash.unsigned),
    }
    ;(first.phoneCall.id as unknown as { low: number }).low = 99
    ;(first.phoneCall.accessHash as unknown as { high: number }).high = 99
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { id: peer.id, accessHash: peer.accessHash } })

    const active = await calls.confirm(session, peer, publicValue(), Long.fromInt(12), protocol)
    if (active.phoneCall._ !== 'phoneCall') throw new Error('expected active call')
    ;(active.phoneCall.keyFingerprint as unknown as { low: number }).low = 99
    expect(calls.snapshot(session)).toMatchObject({ phoneCall: { keyFingerprint: Long.fromInt(12) } })
    const discarded = await calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1)
    ;(discarded.id as unknown as { low: number }).low = 99
    await expect(calls.discard(session, peer, { _: 'phoneCallDiscardReasonHangup' }, 1))
      .resolves.toMatchObject({ id: peer.id })
    expect(worker.events.find((event) => event.operation === 'complete-recipient')?.keyFingerprint)
      .toEqual(Long.fromInt(12))
  })

  it('serializes and rate-limits redacted debug summaries for accepted or active calls only', async () => {
    const { calls, worker } = setup()
    const caller = await requested(calls, 61)
    await expect(calls.saveCallDebug(session, caller, { _: 'dataJSON', data: '{}' }))
      .rejects.toMatchObject({ code: 'CALL_STATE_INVALID' })
    await calls.discard(session, caller, { _: 'phoneCallDiscardReasonHangup' }, 0)
    const first = await incoming(calls, 'debug-rate')
    const peer = { id: first.id, accessHash: first.accessHash }
    await calls.received(session, peer)
    await calls.accept(session, peer, publicValue(), protocol)
    for (let index = 0; index < 8; index++) {
      await calls.saveCallDebug(session, peer, { _: 'dataJSON', data: '{"secret":"not-retained"}' })
    }
    await expect(calls.saveCallDebug(session, peer, { _: 'dataJSON', data: '{}' }))
      .rejects.toMatchObject({ code: 'CALL_DEBUG_FLOOD' })
    expect(worker.events.filter((event) => event.operation === 'debug')).toHaveLength(8)
    expect(JSON.stringify(worker.events)).not.toContain('not-retained')
  })
})

async function requestedForLength(registry: CallRegistry) {
  const result = await registry.request({
    session, selfId: 1, participantId: 2, randomId: 101, gAHash: gAHash(), protocol,
  })
  if (result.phoneCall._ !== 'phoneCallRequested') throw new Error('expected requested call')
  return { id: result.phoneCall.id, accessHash: result.phoneCall.accessHash }
}
