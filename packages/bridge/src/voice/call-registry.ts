import { createHmac, randomBytes } from 'node:crypto'
import type { tl } from '@mtcute/core'
import Long from 'long'
import type { PlatformSession } from '../platform.js'
import {
  VoiceMediaAttachment, type VoiceCallMediaProvider, type VoiceMediaTerminalPhase, type VoiceWorkerMediaEndpoint,
} from './media.js'
import type { VoiceWorkerEvent, VoiceWorkerMediaStartConfig } from './voice-worker-client.js'

export type VoiceCallState = 'initializing' | 'requested' | 'received' | 'accepted' | 'active' | 'discarded'
export type TelegramCallRole = 'caller' | 'recipient'

type VoiceWorkerState = 'ready' | 'media-active' | 'busy' | 'unsupported'

export class VoiceCallError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** Public-only call metadata exchanged with the native voice worker. */
export interface VoiceWorkerCall {
  readonly callId: string
  readonly callerId: number
  readonly participantId: number
  readonly telegramRole: TelegramCallRole
  readonly protocol: tl.TypePhoneCallProtocol
  /** Exact source-platform reference, retained only for this live call. */
  readonly platformCallRef?: string
  /** Call-scoped public relay settings supplied only by an explicit provider. */
  readonly mediaStartConfig?: VoiceWorkerMediaStartConfig
}

/** Supplies real per-call relay and server settings; no fallback is permitted. */
export interface VoiceMediaStartProvider {
  get(call: VoiceWorkerCall, session: PlatformSession): Promise<VoiceWorkerMediaStartConfig | undefined>
}

export interface VoiceWorkerCallerPreparation {
  readonly state: VoiceWorkerState
  readonly gAHash?: Uint8Array
}

export interface VoiceWorkerCallerCompletion {
  readonly state: VoiceWorkerState
  readonly gA?: Uint8Array
  readonly keyFingerprint?: Long
}

export interface VoiceWorkerRecipientPreparation {
  readonly state: VoiceWorkerState
  readonly gB?: Uint8Array
}

export interface VoiceWorkerRecipientCompletion {
  readonly state: VoiceWorkerState
  /** Signed i64 fingerprint computed by the worker from the shared key. */
  readonly keyFingerprint: Long
}

/**
 * The bridge deliberately cannot receive private DH material, shared keys, or
 * relay credentials. Worker methods identify the Telegram call role rather
 * than relying on an ambiguous MTProto RPC direction.
 */
export interface VoiceWorkerClient {
  /** Public protocol capability supported by this configured worker. */
  readonly protocol: tl.TypePhoneCallProtocol
  prepareTelegramCaller(call: VoiceWorkerCall): Promise<VoiceWorkerCallerPreparation>
  completeTelegramCaller(call: VoiceWorkerCall, gB: Uint8Array): Promise<VoiceWorkerCallerCompletion>
  prepareTelegramRecipient(call: VoiceWorkerCall, gAHash: Uint8Array): Promise<VoiceWorkerRecipientPreparation>
  completeTelegramRecipient(
    call: VoiceWorkerCall,
    gA: Uint8Array,
    keyFingerprint: Long,
  ): Promise<VoiceWorkerRecipientCompletion>
  discardCall(call: VoiceWorkerCall): Promise<void>
  /** Returns only after the worker confirms a call-local PCM endpoint is ready. */
  attachMedia?(call: VoiceWorkerCall): Promise<VoiceWorkerMediaEndpoint>
  sendSignalingData(call: VoiceWorkerCall, data: Uint8Array): Promise<void>
  saveCallDebug?(call: VoiceWorkerCall, debug: VoiceCallDebugSummary): Promise<void>
}

/** Redacted metadata only; debug payload values never leave the registry. */
export interface VoiceCallDebugSummary {
  readonly bytes: number
  readonly topLevelKeys: string[]
}

export interface VoiceCallUpdate {
  readonly session: PlatformSession
  readonly update: tl.RawUpdatePhoneCall
  readonly excludeAuthKeyId?: string
}

export interface CallRegistryOptions {
  readonly worker?: VoiceWorkerClient
  readonly now?: () => number
  readonly randomBytes?: (size: number) => Uint8Array
  readonly timeoutMs?: number
  /** Returns the number of live authorized connections that accepted the update. */
  readonly publish?: (update: VoiceCallUpdate) => number | Promise<number>
  /** Publishes one ephemeral call-scoped signaling update. */
  readonly publishSignaling?: (session: PlatformSession, update: tl.RawUpdatePhoneCallSignalingData) => number | Promise<number>
  /** Replays one ephemeral update to a specific authorized binding. */
  readonly replay?: (session: PlatformSession, update: tl.RawUpdatePhoneCall, authKeyId: string) => number | Promise<number>
  /** Optional platform composition seam used only after worker media confirmation. */
  readonly media?: VoiceCallMediaProvider
  /** Required to make a call media-active; absent providers fail closed. */
  readonly mediaStartProvider?: VoiceMediaStartProvider
  /** Redacted lifecycle diagnostics; never includes call IDs or media. */
  readonly onMediaDiagnostic?: (phase: VoiceMediaTerminalPhase, code: string) => void
}

export interface CallRequest {
  readonly session: PlatformSession
  readonly selfId: number
  readonly participantId: number
  readonly randomId: number
  readonly gAHash: Uint8Array
  readonly protocol: tl.TypePhoneCallProtocol
  readonly excludeAuthKeyId?: string
}

export interface IncomingCall {
  readonly session: PlatformSession
  readonly selfId: number
  readonly callerId: number
  /** Opaque source correlation retained only for in-memory retry deduplication. */
  readonly correlationId: string
  /** Exact source call reference used for controls and media authorization. */
  readonly platformCallRef?: string
  readonly platformControl?: PlatformCallControl
}

export interface PlatformCallControl {
  control(operation: 'accept' | 'reject' | 'hangup'): Promise<void>
}

export interface CallPeer {
  readonly id: Long
  readonly accessHash: Long
}

interface StoredCall {
  readonly id: Long
  readonly accessHash: Long
  readonly session: PlatformSession
  readonly adminId: number
  readonly participantId: number
  readonly date: number
  receiveDate?: number
  startDate?: number
  readonly callerProtocol: tl.TypePhoneCallProtocol
  recipientProtocol?: tl.TypePhoneCallProtocol
  negotiatedProtocol: tl.TypePhoneCallProtocol
  readonly telegramRole: TelegramCallRole
  readonly randomId?: number
  readonly incomingCorrelationDigest?: string
  pendingDelivery?: tl.TypePhoneCall
  pendingDeliveryExcludeAuthKeyId?: string
  state: VoiceCallState
  deadline: number
  gAHash?: Uint8Array
  gB?: Uint8Array
  gA?: Uint8Array
  keyFingerprint?: Long
  discarded?: tl.TypePhoneCallDiscardReason
  duration?: number
  media?: VoiceMediaAttachment
  connections?: tl.TypePhoneConnection[]
  p2pAllowed?: boolean
  platformCallRef?: string
  platformControl?: PlatformCallControl
}

interface CallTombstone {
  readonly id: Long
  readonly accessHash: Long
  /** Minimal authorization key; never retain the PlatformSession or credentials. */
  readonly sessionId: string
  readonly adminId: number
  readonly participantId: number
  readonly telegramRole: TelegramCallRole
  readonly randomId?: number
  /** HMAC digest only; the source correlation is never retained. */
  readonly incomingCorrelationDigest?: string
  readonly phoneCall: tl.RawPhoneCallDiscarded
  pendingDelivery: boolean
  readonly expiresAt: number
}

const GA_HASH_BYTES = 32
const DH_PUBLIC_BYTES = 256
const MAX_SIGNALING_BYTES = 4 * 1024
const MAX_SIGNALING_PER_MINUTE = 32
const MAX_DEBUG_BYTES = 8 * 1024
const MAX_DEBUG_KEYS = 16
const MAX_DEBUG_PER_MINUTE = 8
const MAX_CALL_DURATION_SECONDS = 86_400
const DEFAULT_TIMEOUT_MS = 60_000
const TOMBSTONE_TTL_MS = 5 * 60_000
const MAX_TOMBSTONES = 256

/** Compares i64 values as opaque TL wire patterns, regardless of signed decoding. */
function sameWireLong(left: Long, right: Long): boolean {
  return left.low === right.low && left.high === right.high
}

function cloneLong(value: Long): Long {
  return Long.fromBits(value.low, value.high, value.unsigned)
}

/**
 * An intentionally transient one-to-one audio-call coordinator. It neither
 * knows private key material nor writes call data to a database or journal.
 */
export class CallRegistry {
  private readonly _calls = new Map<string, StoredCall>()
  private readonly _sessionCalls = new Map<string, StoredCall>()
  private readonly _incomingCalls = new Map<string, StoredCall>()
  private readonly _tombstones = new Map<string, CallTombstone>()
  private readonly _incomingTombstones = new Map<string, CallTombstone>()
  /** HMAC-indexed source calls rejected while their Telegram session was occupied. */
  private readonly _occupiedIncomingReceipts = new Map<string, number>()
  private readonly _sessionOperations = new Map<string, Promise<void>>()
  private readonly _signalTimes = new Map<string, number[]>()
  private readonly _debugTimes = new Map<string, number[]>()
  private readonly _worker?: VoiceWorkerClient
  private readonly _now: () => number
  private readonly _randomBytes: (size: number) => Uint8Array
  private readonly _timeoutMs: number
  private readonly _publish?: (update: VoiceCallUpdate) => number | Promise<number>
  private readonly _publishSignaling?: CallRegistryOptions['publishSignaling']
  private readonly _replay?: (session: PlatformSession, update: tl.RawUpdatePhoneCall, authKeyId: string) => number | Promise<number>
  private readonly _media?: VoiceCallMediaProvider
  private readonly _mediaStartProvider?: VoiceMediaStartProvider
  private readonly _onMediaDiagnostic?: CallRegistryOptions['onMediaDiagnostic']
  readonly #incomingHmacSecret = randomBytes(32)

  constructor(options: CallRegistryOptions = {}) {
    this._worker = options.worker
    this._now = options.now ?? Date.now
    this._randomBytes = options.randomBytes ?? randomBytes
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this._publish = options.publish
    this._publishSignaling = options.publishSignaling
    this._replay = options.replay
    this._media = options.media
    this._mediaStartProvider = options.mediaStartProvider
    this._onMediaDiagnostic = options.onMediaDiagnostic
  }

  async request(input: CallRequest): Promise<tl.phone.RawPhoneCall> {
    this._requireAudioProtocol(input.protocol)
    this._requireGAHash(input.gAHash)
    this._requireRandomId(input.randomId)
    const callerProtocol = this._cloneProtocol(input.protocol)
    return this._serialize(input.session.platformSessionId, async () => {
      const existing = this._sessionCalls.get(input.session.platformSessionId)
      if (existing && existing.state !== 'discarded') {
        if (this._isMatchingRequest(existing, input)) {
          await this._deliverPending(existing)
          return this._wrap(existing)
        }
        throw new VoiceCallError('CALL_OCCUPY_FAILED')
      }
      const tombstone = this._findRequestTombstone(input)
      if (tombstone) return { _: 'phone.phoneCall', phoneCall: this._discarded(tombstone), users: [] }
      if (!this._worker) throw new VoiceCallError('CALL_OUTGOING_UNSUPPORTED')
      const recipientProtocol = this._workerProtocol()
      const negotiatedProtocol = this._negotiateProtocol(callerProtocol, recipientProtocol)
      const call = this._create(
        input.session, input.selfId, input.participantId, callerProtocol, 'caller', input.randomId, undefined,
        negotiatedProtocol,
      )
      call.recipientProtocol = this._cloneProtocol(recipientProtocol)
      call.gAHash = input.gAHash.slice()
      this._remember(call)
      const workerGAHash = call.gAHash.slice()
      try {
        const status = await this._requireWorker(
          'prepareTelegramRecipient', this._worker?.prepareTelegramRecipient(this._workerCall(call), workerGAHash),
        )
        if (!status.gB) throw new VoiceCallError('CALL_HANDSHAKE_INVALID')
        this._requirePublicValue(status.gB)
        call.gB = status.gB.slice()
      } catch (error) {
        await this._teardownWorkerCall(call)
        this._forget(call)
        this._zero(call.gAHash)
        this._zero(call.gB)
        call.gAHash = undefined
        call.gB = undefined
        throw error
      } finally {
        this._zero(workerGAHash)
      }
      await this._publishTransition(call, input.excludeAuthKeyId)
      return this._wrap(call)
    })
  }

  /** Seam for a QQ/native worker to surface an incoming audio call. */
  async receiveIncoming(input: IncomingCall): Promise<tl.RawPhoneCallRequested | tl.RawPhoneCallDiscarded | undefined> {
    if (!input.correlationId) throw new VoiceCallError('CALL_CORRELATION_INVALID')
    return this._serialize(input.session.platformSessionId, async () => {
      const correlationKey = this._incomingKey(input.session, input.correlationId)
      if (this._occupiedIncomingReceipts.has(correlationKey)) return undefined
      const retried = this._incomingCalls.get(correlationKey)
      if (retried && retried.state !== 'discarded') {
        await this._deliverPending(retried)
        return this._requested(retried)
      }
      const tombstone = this._incomingTombstones.get(correlationKey)
      if (tombstone) {
        if (
          tombstone.sessionId !== input.session.platformSessionId
          || tombstone.telegramRole !== 'recipient'
          || tombstone.adminId !== input.callerId
          || tombstone.participantId !== input.selfId
        ) throw new VoiceCallError('CALL_OCCUPY_FAILED')
        await this._deliverTombstone(tombstone, input.session)
        return this._discarded(tombstone)
      }
      const occupied = this._sessionCalls.get(input.session.platformSessionId)
      if (occupied && occupied.state !== 'discarded' && input.platformControl) {
        await input.platformControl.control('reject')
        this._rememberOccupiedIncomingReceipt(correlationKey)
        return undefined
      }
      this._assertSessionAvailable(input.session.platformSessionId)
      const call = this._create(
        input.session, input.callerId, input.selfId, this._incomingProtocol(), 'recipient', undefined, correlationKey,
      )
      call.platformCallRef = input.platformCallRef
      call.platformControl = input.platformControl
      call.state = 'initializing'
      this._remember(call)
      this._incomingCalls.set(correlationKey, call)
      try {
        const status = await this._requireWorker(
          'prepareTelegramCaller', this._worker?.prepareTelegramCaller(this._workerCall(call)),
        )
        if (!status.gAHash) throw new VoiceCallError('CALL_HANDSHAKE_INVALID')
        this._requireGAHash(status.gAHash)
        call.gAHash = status.gAHash.slice()
        call.state = 'requested'
      } catch (error) {
        if (call.platformControl) {
          try {
            await this._controlPlatformCall(call, 'reject')
          } catch {
            await this._teardownWorkerCall(call)
            this._forget(call)
            throw error
          }
          await this._teardownWorkerCall(call)
          call.state = 'discarded'
          call.discarded = { _: 'phoneCallDiscardReasonDisconnect' }
          const discarded = this._discarded(call)
          let pendingDelivery = true
          try {
            pendingDelivery = await this._publishCall(call.session, discarded) <= 0
          } finally {
            this._retire(call, discarded, pendingDelivery)
          }
          return discarded
        }
        await this._teardownWorkerCall(call)
        this._forget(call)
        throw error
      }
      await this._publishTransition(call)
      return this._requested(call)
    })
  }

  async received(session: PlatformSession, peer: CallPeer, excludeAuthKeyId?: string): Promise<void> {
    await this._serialize(session.platformSessionId, async () => {
      const call = this._find(session, peer)
      this._requireTelegramRole(call, 'recipient')
      if (call.state === 'received') {
        await this._deliverPending(call)
        return
      }
      this._requireState(call, 'requested')
      call.state = 'received'
      call.receiveDate = Math.floor(this._now() / 1_000)
      await this._publishTransition(call, excludeAuthKeyId)
    })
  }

  async accept(
    session: PlatformSession,
    peer: CallPeer,
    gB: Uint8Array,
    protocol: tl.TypePhoneCallProtocol,
    excludeAuthKeyId?: string,
    afterResponse?: (task: () => void | Promise<void>) => void,
  ): Promise<tl.phone.RawPhoneCall> {
    this._requireAudioProtocol(protocol)
    this._requirePublicValue(gB)
    return this._serialize(session.platformSessionId, async () => {
      const call = this._find(session, peer)
      this._requireTelegramRole(call, 'recipient')
      if (call.state === 'active') {
        await this._deliverPending(call)
        return this._wrapPhoneCall(this._waiting(call))
      }
      if (call.state === 'accepted') {
        await this._finishAcceptAfterResponse(call, afterResponse)
        return this._wrapPhoneCall(this._waiting(call))
      }
      // phone.receivedCall is only a delivery/ringing acknowledgement. Some
      // Telegram clients accept directly from phoneCallRequested without
      // sending that optional acknowledgement first.
      if (call.state !== 'requested' && call.state !== 'received') {
        throw new VoiceCallError('CALL_STATE_INVALID')
      }
      const publicGB = gB.slice()
      let status: VoiceWorkerCallerCompletion
      try {
        call.recipientProtocol = this._cloneProtocol(protocol)
        call.negotiatedProtocol = this._negotiateProtocol(call.callerProtocol, call.recipientProtocol)
        const mediaStartConfig = this._applyMediaStartConfig(call, await this._mediaConfig(call))
        status = await this._requireWorker(
          'completeTelegramCaller', this._worker?.completeTelegramCaller(
            this._workerCall(call, mediaStartConfig), publicGB.slice(),
          ),
        )
        if (status.state !== 'media-active' || !status.gA || !status.keyFingerprint) {
          throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
        }
        this._requirePublicValue(status.gA)
        await this._attachMedia(call)
        await this._controlPlatformCall(call, 'accept')
      } catch (error) {
        this._zero(publicGB)
        await this._abortWorkerCall(call, excludeAuthKeyId)
        throw error
      }
      call.gB = publicGB
      call.gA = status.gA.slice()
      call.keyFingerprint = cloneLong(status.keyFingerprint).toSigned()
      call.state = 'accepted'
      await this._publishTransition(call, excludeAuthKeyId)
      await this._finishAcceptAfterResponse(call, afterResponse)
      // Telegram Desktop requires phone.acceptCall to return phoneCallWaiting;
      // phoneCallAccepted is the caller-side update, while the recipient moves
      // forward on the subsequent active phoneCall update.
      return this._wrapPhoneCall(this._waiting(call))
    })
  }

  async confirm(
    session: PlatformSession,
    peer: CallPeer,
    gA: Uint8Array,
    keyFingerprint: Long,
    protocol: tl.TypePhoneCallProtocol,
    excludeAuthKeyId?: string,
  ): Promise<tl.phone.RawPhoneCall> {
    this._requireAudioProtocol(protocol)
    this._requirePublicValue(gA)
    return this._serialize(session.platformSessionId, async () => {
      const call = this._find(session, peer)
      this._requireTelegramRole(call, 'caller')
      if (call.state === 'active') {
        await this._deliverPending(call)
        return this._wrap(call)
      }
      this._requireState(call, 'requested')
      call.negotiatedProtocol = this._negotiateProtocol(call.negotiatedProtocol, protocol)
      const publicGA = gA.slice()
      const workerFingerprint = cloneLong(keyFingerprint).toSigned()
      try {
        const mediaStartConfig = this._applyMediaStartConfig(call, await this._mediaConfig(call))
        const status = await this._requireWorker(
          'completeTelegramRecipient',
          this._worker?.completeTelegramRecipient(
            this._workerCall(call, mediaStartConfig), publicGA.slice(), workerFingerprint,
          ),
        )
        if (status.state !== 'media-active') throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
        if (!status.keyFingerprint || !sameWireLong(status.keyFingerprint, keyFingerprint)) {
          throw new VoiceCallError('CALL_HANDSHAKE_INVALID')
        }
        await this._attachMedia(call)
        call.keyFingerprint = cloneLong(status.keyFingerprint).toSigned()
      } catch (error) {
        this._zero(publicGA)
        await this._abortWorkerCall(call, excludeAuthKeyId)
        throw error
      }
      call.gA = publicGA
      call.state = 'active'
      call.startDate = Math.floor(this._now() / 1_000)
      await this._publishTransition(call, excludeAuthKeyId)
      return this._wrap(call)
    })
  }

  async discard(
    session: PlatformSession,
    peer: CallPeer,
    reason: tl.TypePhoneCallDiscardReason,
    duration: number,
    excludeAuthKeyId?: string,
  ): Promise<tl.RawPhoneCallDiscarded> {
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > MAX_CALL_DURATION_SECONDS) {
      throw new VoiceCallError('CALL_DURATION_INVALID')
    }
    return this._serialize(session.platformSessionId, async () => {
      const call = this._findOrTombstone(session, peer)
      if (!('session' in call)) {
        await this._deliverTombstone(call, session, excludeAuthKeyId)
        return this._discarded(call)
      }
      const ringingIncoming = call.telegramRole === 'recipient'
        && (call.state === 'initializing' || call.state === 'requested' || call.state === 'received')
      await this._controlPlatformCall(call, ringingIncoming ? 'reject' : 'hangup')
      await this._teardownWorkerCall(call)
      call.state = 'discarded'
      call.discarded = ringingIncoming ? { _: 'phoneCallDiscardReasonBusy' } : reason
      call.duration = ringingIncoming ? 0 : duration
      const discarded = this._discarded(call)
      let pendingDelivery = true
      try {
        pendingDelivery = await this._publishCall(call.session, discarded, excludeAuthKeyId) <= 0
      } finally {
        this._retire(call, discarded, pendingDelivery)
      }
      return discarded
    })
  }

  /** Retires a Telegram call when the source platform reports its terminal state. */
  async platformEnded(session: PlatformSession, correlationId: string): Promise<void> {
    if (!correlationId) throw new VoiceCallError('CALL_CORRELATION_INVALID')
    await this._serialize(session.platformSessionId, async () => {
      const correlationKey = this._incomingKey(session, correlationId)
      const call = this._incomingCalls.get(correlationKey)
      if (!call || call.state === 'discarded') return
      const state = call.state
      await this._teardownWorkerCall(call)
      call.state = 'discarded'
      call.discarded = state === 'initializing' || state === 'requested' || state === 'received'
        ? { _: 'phoneCallDiscardReasonMissed' }
        : { _: 'phoneCallDiscardReasonHangup' }
      const now = Math.floor(this._now() / 1_000)
      call.duration = state === 'active'
        ? Math.min(MAX_CALL_DURATION_SECONDS, Math.max(0, now - (call.startDate ?? now)))
        : 0
      const discarded = this._discarded(call)
      let pendingDelivery = true
      try {
        pendingDelivery = await this._publishCall(call.session, discarded) <= 0
      } finally {
        this._retire(call, discarded, pendingDelivery)
      }
    })
  }

  /** Delivers one acknowledged worker event into Telegram's call update stream. */
  async handleWorkerEvent(workerCall: VoiceWorkerCall, event: VoiceWorkerEvent): Promise<void> {
    const call = this._calls.get(workerCall.callId)
    if (!call || call.state === 'discarded') return
    await this._serialize(call.session.platformSessionId, async () => {
      if (this._calls.get(workerCall.callId) !== call || call.state === 'discarded') return
      if (event.kind === 'native-error') {
        await this._abortWorkerCall(call)
        return
      }
      const data = event.data.slice()
      try {
        const delivered = await this._publishSignaling?.(call.session, {
          _: 'updatePhoneCallSignalingData', phoneCallId: cloneLong(call.id), data,
        }) ?? 0
        if (!Number.isSafeInteger(delivered) || delivered <= 0) {
          throw new VoiceCallError('CALL_SIGNALING_UNDELIVERED')
        }
      } finally {
        data.fill(0)
      }
    })
  }

  async sendSignalingData(session: PlatformSession, peer: CallPeer, data: Uint8Array): Promise<void> {
    if (!data.length || data.length > MAX_SIGNALING_BYTES) throw new VoiceCallError('CALL_SIGNALING_INVALID')
    await this._serialize(session.platformSessionId, async () => {
      const call = this._find(session, peer)
      if (call.state !== 'accepted' && call.state !== 'active') throw new VoiceCallError('CALL_STATE_INVALID')
      const key = this._key(call.id)
      const now = this._now()
      const recent = (this._signalTimes.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000)
      if (recent.length >= MAX_SIGNALING_PER_MINUTE) throw new VoiceCallError('CALL_SIGNALING_FLOOD')
      recent.push(now)
      this._signalTimes.set(key, recent)
      try {
        await this._worker?.sendSignalingData(this._workerCall(call), data.slice())
      } catch (error) {
        await this._abortWorkerCall(call)
        throw error
      }
    })
  }

  async saveCallDebug(session: PlatformSession, peer: CallPeer, debug: tl.TypeDataJSON): Promise<void> {
    if (debug._ !== 'dataJSON' || Buffer.byteLength(debug.data, 'utf8') > MAX_DEBUG_BYTES) {
      throw new VoiceCallError('CALL_DEBUG_INVALID')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(debug.data)
    } catch {
      throw new VoiceCallError('CALL_DEBUG_INVALID')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new VoiceCallError('CALL_DEBUG_INVALID')
    const bytes = Buffer.byteLength(debug.data, 'utf8')
    const topLevelKeys = Object.keys(parsed).filter((key) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key)).slice(0, MAX_DEBUG_KEYS)
    await this._serialize(session.platformSessionId, async () => {
      const call = this._find(session, peer)
      if (call.state !== 'accepted' && call.state !== 'active') throw new VoiceCallError('CALL_STATE_INVALID')
      const key = this._key(call.id)
      const now = this._now()
      const recent = (this._debugTimes.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000)
      if (recent.length >= MAX_DEBUG_PER_MINUTE) throw new VoiceCallError('CALL_DEBUG_FLOOD')
      recent.push(now)
      this._debugTimes.set(key, recent)
      await this._worker?.saveCallDebug?.(this._workerCall(call), { bytes, topLevelKeys: [...topLevelKeys] })
    })
  }

  /** Expires unanswered calls without using timers that outlive plugin disposal. */
  async expire(): Promise<void> {
    this._pruneTombstones()
    const now = this._now()
    for (const call of this._calls.values()) {
      if (call.state !== 'discarded' && call.pendingDelivery && (call.state === 'active' || now < call.deadline)) {
        await this._serialize(call.session.platformSessionId, async () => {
          if (this._calls.get(this._key(call.id)) === call) await this._deliverPending(call)
        })
      }
      if (call.state === 'discarded' || call.state === 'active' || now < call.deadline) continue
      await this.discard(call.session, { id: call.id, accessHash: call.accessHash }, { _: 'phoneCallDiscardReasonMissed' }, 0)
    }
  }

  /** Returns the current transient call update for an authorized reconnecting binding. */
  snapshot(session: PlatformSession): tl.RawUpdatePhoneCall | undefined {
    this._pruneTombstones()
    const call = this._sessionCalls.get(session.platformSessionId)
    if (call && call.state !== 'initializing') return { _: 'updatePhoneCall', phoneCall: this._phoneCall(call) }
    const tombstone = [...this._tombstones.values()].find((value) => value.sessionId === session.platformSessionId
      && value.pendingDelivery)
    return tombstone ? { _: 'updatePhoneCall', phoneCall: this._discarded(tombstone) } : undefined
  }

  /** Replays a call update to one verified binding without retaining that binding's credentials. */
  async replay(session: PlatformSession, authKeyId: string): Promise<void> {
    await this._serialize(session.platformSessionId, async () => {
      const call = this._sessionCalls.get(session.platformSessionId)
      if (call && call.state !== 'initializing') {
        if (await this._replayCall(session, this._phoneCall(call), authKeyId) > 0) {
          call.pendingDelivery = undefined
          call.pendingDeliveryExcludeAuthKeyId = undefined
        }
        return
      }
      const tombstone = [...this._tombstones.values()].find((value) => value.sessionId === session.platformSessionId
        && value.pendingDelivery)
      if (!tombstone) return
      if (await this._replayCall(session, this._discarded(tombstone), authKeyId) > 0) {
        tombstone.pendingDelivery = false
      }
    })
  }

  private _create(
    session: PlatformSession,
    adminId: number,
    participantId: number,
    protocol: tl.TypePhoneCallProtocol,
    telegramRole: TelegramCallRole,
    randomId?: number,
    incomingCorrelationDigest?: string,
    negotiatedProtocol = protocol,
  ): StoredCall {
    if (!Number.isSafeInteger(adminId) || !Number.isSafeInteger(participantId) || adminId === participantId) {
      throw new VoiceCallError('CALL_USER_INVALID')
    }
    const id = this._uniqueRandomLong((value) => this._calls.has(this._key(value)) || this._tombstones.has(this._key(value)))
    const accessHash = this._uniqueRandomLong((value) => sameWireLong(value, id)
      || [...this._calls.values()].some((call) => sameWireLong(call.accessHash, value))
      || [...this._tombstones.values()].some((tombstone) => sameWireLong(tombstone.accessHash, value)))
    const now = Math.floor(this._now() / 1_000)
    const callerProtocol = this._cloneProtocol(protocol)
    return {
      id, accessHash, session, adminId, participantId, callerProtocol,
      negotiatedProtocol: this._cloneProtocol(negotiatedProtocol), telegramRole, randomId, incomingCorrelationDigest,
      state: 'requested', date: now, deadline: this._now() + this._timeoutMs,
    }
  }

  private _remember(call: StoredCall): void {
    this._calls.set(this._key(call.id), call)
    this._sessionCalls.set(call.session.platformSessionId, call)
  }

  private _forget(call: StoredCall): void {
    if (this._calls.get(this._key(call.id)) === call) this._calls.delete(this._key(call.id))
    this._release(call)
  }

  private _retire(
    call: StoredCall,
    phoneCall: tl.RawPhoneCallDiscarded = this._discarded(call),
    pendingDelivery = false,
  ): void {
    const tombstone: CallTombstone = {
      id: cloneLong(call.id), accessHash: cloneLong(call.accessHash), sessionId: call.session.platformSessionId,
      adminId: call.adminId, participantId: call.participantId, telegramRole: call.telegramRole, randomId: call.randomId,
      incomingCorrelationDigest: call.incomingCorrelationDigest,
      phoneCall: this._clonePhoneCall(phoneCall) as tl.RawPhoneCallDiscarded,
      pendingDelivery, expiresAt: this._now() + TOMBSTONE_TTL_MS,
    }
    this._forget(call)
    this._signalTimes.delete(this._key(call.id))
    this._debugTimes.delete(this._key(call.id))
    this._zero(call.gAHash)
    this._zero(call.gB)
    this._zero(call.gA)
    call.gAHash = undefined
    call.gB = undefined
    call.gA = undefined
    call.keyFingerprint = undefined
    call.connections = undefined
    call.p2pAllowed = undefined
    call.recipientProtocol = undefined
    call.pendingDelivery = undefined
    call.pendingDeliveryExcludeAuthKeyId = undefined
    call.platformCallRef = undefined
    call.platformControl = undefined
    this._tombstones.set(this._key(call.id), tombstone)
    if (tombstone.incomingCorrelationDigest) this._incomingTombstones.set(tombstone.incomingCorrelationDigest, tombstone)
    this._pruneTombstones()
    while (this._tombstones.size > MAX_TOMBSTONES) this._dropTombstone(this._tombstones.keys().next().value!)
  }

  private _release(call: StoredCall): void {
    if (this._sessionCalls.get(call.session.platformSessionId) === call) {
      this._sessionCalls.delete(call.session.platformSessionId)
    }
    if (call.incomingCorrelationDigest && this._incomingCalls.get(call.incomingCorrelationDigest) === call) {
      this._incomingCalls.delete(call.incomingCorrelationDigest)
    }
  }

  private _find(session: PlatformSession, peer: CallPeer): StoredCall {
    this._pruneTombstones()
    const call = this._calls.get(this._key(peer.id))
    if (!call || call.session.platformSessionId !== session.platformSessionId || !sameWireLong(call.accessHash, peer.accessHash)) {
      throw new VoiceCallError('CALL_PEER_INVALID')
    }
    return call
  }

  private _findOrTombstone(session: PlatformSession, peer: CallPeer): StoredCall | CallTombstone {
    this._pruneTombstones()
    const call = this._calls.get(this._key(peer.id))
    if (call && call.session.platformSessionId === session.platformSessionId && sameWireLong(call.accessHash, peer.accessHash)) return call
    const tombstone = this._tombstones.get(this._key(peer.id))
    if (tombstone && tombstone.sessionId === session.platformSessionId && sameWireLong(tombstone.accessHash, peer.accessHash)) {
      return tombstone
    }
    throw new VoiceCallError('CALL_PEER_INVALID')
  }

  private _rememberOccupiedIncomingReceipt(correlationKey: string): void {
    this._occupiedIncomingReceipts.set(correlationKey, this._now() + TOMBSTONE_TTL_MS)
    while (this._occupiedIncomingReceipts.size > MAX_TOMBSTONES) {
      this._occupiedIncomingReceipts.delete(this._occupiedIncomingReceipts.keys().next().value!)
    }
  }

  private _pruneTombstones(): void {
    const now = this._now()
    for (const [key, tombstone] of this._tombstones) {
      if (tombstone.expiresAt <= now) this._dropTombstone(key, tombstone)
    }
    for (const [key, expiresAt] of this._occupiedIncomingReceipts) {
      if (expiresAt <= now) this._occupiedIncomingReceipts.delete(key)
    }
  }

  private _dropTombstone(key: string, tombstone = this._tombstones.get(key)): void {
    if (!tombstone) return
    this._tombstones.delete(key)
    if (tombstone.incomingCorrelationDigest && this._incomingTombstones.get(tombstone.incomingCorrelationDigest) === tombstone) {
      this._incomingTombstones.delete(tombstone.incomingCorrelationDigest)
    }
  }

  private _isMatchingRequest(call: StoredCall | CallTombstone, input: CallRequest): boolean {
    return call.telegramRole === 'caller'
      && call.adminId === input.selfId
      && call.participantId === input.participantId
      && call.randomId === input.randomId
  }

  private _findRequestTombstone(input: CallRequest): CallTombstone | undefined {
    const sessionTombstones = [...this._tombstones.values()]
      .filter((tombstone) => tombstone.sessionId === input.session.platformSessionId
        && tombstone.telegramRole === 'caller' && tombstone.randomId === input.randomId)
    if (!sessionTombstones.length) return undefined
    const tombstone = sessionTombstones.find((value) => this._isMatchingRequest(value, input))
    if (!tombstone) throw new VoiceCallError('CALL_OCCUPY_FAILED')
    return tombstone
  }

  private _assertSessionAvailable(sessionId: string): void {
    const call = this._sessionCalls.get(sessionId)
    if (call && call.state !== 'discarded') throw new VoiceCallError('CALL_OCCUPY_FAILED')
  }

  private _requireState(call: StoredCall, expected: VoiceCallState): void {
    if (call.state !== expected) throw new VoiceCallError('CALL_STATE_INVALID')
  }

  private _requireTelegramRole(call: StoredCall, expected: TelegramCallRole): void {
    if (call.telegramRole !== expected) throw new VoiceCallError('CALL_ROLE_INVALID')
  }

  private async _requireWorker<T extends { readonly state: VoiceWorkerState }>(
    operation: string,
    pending: Promise<T> | undefined,
  ): Promise<T> {
    if (!pending) {
      throw new VoiceCallError(operation === 'prepareTelegramRecipient'
        ? 'CALL_OUTGOING_UNSUPPORTED'
        : 'CALL_MEDIA_UNAVAILABLE')
    }
    const status = await pending
    if (status.state === 'busy') throw new VoiceCallError('CALL_OCCUPY_FAILED')
    if (status.state === 'unsupported') throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
    return status
  }

  private async _abortWorkerCall(call: StoredCall, excludeAuthKeyId?: string): Promise<void> {
    await this._controlPlatformCall(
      call,
      call.state === 'initializing' || call.state === 'requested' || call.state === 'received'
        ? 'reject'
        : 'hangup',
    ).catch(() => {})
    await this._teardownWorkerCall(call)
    call.state = 'discarded'
    call.discarded = { _: 'phoneCallDiscardReasonDisconnect' }
    const discarded = this._discarded(call)
    let pendingDelivery = true
    try {
      pendingDelivery = await this._publishCall(call.session, discarded, excludeAuthKeyId) <= 0
    } catch {
      // Retire secrets even when the terminal update must be retried later.
    } finally {
      this._retire(call, discarded, pendingDelivery)
    }
  }

  private async _teardownWorkerCall(call: StoredCall): Promise<void> {
    const media = call.media
    call.media = undefined
    await media?.close().catch(() => {})
    await this._worker?.discardCall(this._workerCall(call)).catch(() => {})
  }

  private async _controlPlatformCall(
    call: StoredCall,
    operation: 'accept' | 'reject' | 'hangup',
  ): Promise<void> {
    if (!call.platformControl) return
    await call.platformControl.control(operation)
  }

  private async _attachMedia(call: StoredCall): Promise<void> {
    if (!this._media) return
    if (call.media) throw new VoiceCallError('CALL_OCCUPY_FAILED')
    let endpoint: VoiceWorkerMediaEndpoint | undefined
    try {
      endpoint = await this._worker?.attachMedia?.(this._workerCall(call))
      if (!endpoint
        || typeof endpoint.send !== 'function'
        || typeof endpoint.receive !== 'function'
        || typeof endpoint.close !== 'function') {
        throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
      }
      const media = await this._media.start(this._workerCall(call), call.session, endpoint)
      const attachment = new VoiceMediaAttachment(media, endpoint, this._onMediaDiagnostic)
      call.media = attachment
      void attachment.finished.then(() => this._terminalMedia(call))
    } catch {
      if (endpoint && typeof endpoint.close === 'function') {
        await Promise.resolve(endpoint.close()).catch(() => {})
      }
      throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
    }
  }

  private async _terminalMedia(call: StoredCall): Promise<void> {
    await this._serialize(call.session.platformSessionId, async () => {
      if (this._calls.get(this._key(call.id)) !== call || call.state === 'discarded') return
      await this._abortWorkerCall(call)
    }).catch(() => {})
  }

  private async _finishAccept(call: StoredCall): Promise<void> {
    await this._deliverPending(call)
    call.state = 'active'
    call.startDate = Math.floor(this._now() / 1_000)
    // The worker is the synthetic Telegram caller, so no second Telegram auth
    // key will ever confirm this incoming call. The accepting recipient gets
    // phoneCallAccepted in its RPC response, then must also receive the active
    // update that a real caller's phone.confirmCall would normally produce.
    await this._publishTransition(call)
  }

  private async _finishAcceptAfterResponse(
    call: StoredCall,
    afterResponse: ((task: () => void | Promise<void>) => void) | undefined,
  ): Promise<void> {
    if (!afterResponse) {
      await this._finishAccept(call)
      return
    }
    afterResponse(() => this._serialize(call.session.platformSessionId, async () => {
      if (this._calls.get(this._key(call.id)) !== call || call.state !== 'accepted') return
      await this._finishAccept(call)
    }))
  }

  private async _publishTransition(call: StoredCall, excludeAuthKeyId?: string): Promise<void> {
    call.pendingDelivery = this._phoneCall(call)
    call.pendingDeliveryExcludeAuthKeyId = excludeAuthKeyId
    await this._deliverPending(call)
  }

  private async _deliverPending(call: StoredCall): Promise<void> {
    if (!call.pendingDelivery) return
    if (await this._publishCall(call.session, call.pendingDelivery, call.pendingDeliveryExcludeAuthKeyId) > 0) {
      call.pendingDelivery = undefined
      call.pendingDeliveryExcludeAuthKeyId = undefined
    }
  }

  private async _deliverTombstone(
    tombstone: CallTombstone,
    session: PlatformSession,
    excludeAuthKeyId?: string,
  ): Promise<void> {
    if (!tombstone.pendingDelivery) return
    if (await this._publishCall(session, tombstone.phoneCall, excludeAuthKeyId) > 0) {
      tombstone.pendingDelivery = false
    }
  }

  private async _publishCall(
    session: PlatformSession,
    phoneCall: tl.TypePhoneCall,
    excludeAuthKeyId?: string,
  ): Promise<number> {
    const delivered = await this._publish?.({
      session,
      update: { _: 'updatePhoneCall', phoneCall: this._clonePhoneCall(phoneCall) },
      excludeAuthKeyId,
    })
    return Number.isSafeInteger(delivered) && delivered > 0 ? delivered : 0
  }

  private async _replayCall(
    session: PlatformSession,
    phoneCall: tl.TypePhoneCall,
    authKeyId: string,
  ): Promise<number> {
    const delivered = await this._replay?.(
      session, { _: 'updatePhoneCall', phoneCall: this._clonePhoneCall(phoneCall) }, authKeyId,
    )
    return Number.isSafeInteger(delivered) && delivered > 0 ? delivered : 0
  }

  private _phoneCall(call: StoredCall): tl.TypePhoneCall {
    switch (call.state) {
      case 'initializing': throw new VoiceCallError('CALL_STATE_INVALID')
      case 'requested': return this._requested(call)
      case 'received': return this._waiting(call)
      case 'accepted': return this._accepted(call)
      case 'active': return {
        _: 'phoneCall', p2pAllowed: call.p2pAllowed === true, id: cloneLong(call.id), accessHash: cloneLong(call.accessHash), date: call.date,
        adminId: call.adminId, participantId: call.participantId,
        gAOrB: (call.telegramRole === 'caller' ? call.gB : call.gA)?.slice() ?? new Uint8Array(),
        keyFingerprint: cloneLong(call.keyFingerprint ?? Long.ZERO), protocol: this._cloneProtocol(call.negotiatedProtocol),
        connections: (call.connections ?? []).map((connection) => this._cloneConnection(connection)), startDate: call.startDate ?? call.date,
      }
      case 'discarded': return this._discarded(call)
    }
  }

  private _requested(call: StoredCall): tl.RawPhoneCallRequested {
    return {
      _: 'phoneCallRequested', id: cloneLong(call.id), accessHash: cloneLong(call.accessHash), date: call.date,
      adminId: call.adminId, participantId: call.participantId,
      gAHash: call.gAHash?.slice() ?? new Uint8Array(), protocol: this._cloneProtocol(call.callerProtocol),
    }
  }

  private _waiting(call: StoredCall): tl.RawPhoneCallWaiting {
    return {
      _: 'phoneCallWaiting', id: cloneLong(call.id), accessHash: cloneLong(call.accessHash), date: call.date,
      adminId: call.adminId, participantId: call.participantId, protocol: this._cloneProtocol(call.callerProtocol),
      receiveDate: call.receiveDate ?? call.date,
    }
  }

  private _accepted(call: StoredCall): tl.RawPhoneCallAccepted {
    return {
      _: 'phoneCallAccepted', id: cloneLong(call.id), accessHash: cloneLong(call.accessHash), date: call.date,
      adminId: call.adminId, participantId: call.participantId,
      gB: call.gB?.slice() ?? new Uint8Array(), protocol: this._cloneProtocol(call.recipientProtocol ?? call.callerProtocol),
    }
  }

  private _discarded(call: StoredCall | CallTombstone): tl.RawPhoneCallDiscarded {
    if ('phoneCall' in call) return this._clonePhoneCall(call.phoneCall) as tl.RawPhoneCallDiscarded
    return {
      _: 'phoneCallDiscarded', id: cloneLong(call.id), reason: call.discarded, duration: call.duration,
    }
  }

  private _cloneConnection(connection: tl.TypePhoneConnection): tl.TypePhoneConnection {
    if (connection._ === 'phoneConnection') {
      return { ...connection, id: cloneLong(connection.id), peerTag: connection.peerTag.slice() }
    }
    return { ...connection, id: cloneLong(connection.id) }
  }

  private _clonePhoneCall(phoneCall: tl.TypePhoneCall): tl.TypePhoneCall {
    switch (phoneCall._) {
      case 'phoneCallRequested': return {
        ...phoneCall, id: cloneLong(phoneCall.id), accessHash: cloneLong(phoneCall.accessHash),
        gAHash: phoneCall.gAHash.slice(), protocol: this._cloneProtocol(phoneCall.protocol),
      }
      case 'phoneCallWaiting': return {
        ...phoneCall, id: cloneLong(phoneCall.id), accessHash: cloneLong(phoneCall.accessHash),
        protocol: this._cloneProtocol(phoneCall.protocol),
      }
      case 'phoneCallAccepted': return {
        ...phoneCall, id: cloneLong(phoneCall.id), accessHash: cloneLong(phoneCall.accessHash),
        gB: phoneCall.gB.slice(), protocol: this._cloneProtocol(phoneCall.protocol),
      }
      case 'phoneCall': return {
        ...phoneCall, id: cloneLong(phoneCall.id), accessHash: cloneLong(phoneCall.accessHash),
        keyFingerprint: cloneLong(phoneCall.keyFingerprint), gAOrB: phoneCall.gAOrB.slice(),
        protocol: this._cloneProtocol(phoneCall.protocol), connections: phoneCall.connections.map((connection) => this._cloneConnection(connection)),
      }
      case 'phoneCallDiscarded': return { ...phoneCall, id: cloneLong(phoneCall.id) }
      default: return { ...phoneCall }
    }
  }

  private _wrap(call: StoredCall): tl.phone.RawPhoneCall {
    return this._wrapPhoneCall(this._phoneCall(call))
  }

  private _wrapPhoneCall(phoneCall: tl.TypePhoneCall): tl.phone.RawPhoneCall {
    return { _: 'phone.phoneCall', phoneCall: this._clonePhoneCall(phoneCall), users: [] }
  }

  private async _mediaConfig(call: StoredCall): Promise<VoiceWorkerMediaStartConfig> {
    const config = await this._mediaStartProvider?.get(this._workerCall(call), call.session)
    if (!config) throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
    return config
  }

  private _applyMediaStartConfig(
    call: StoredCall,
    config: VoiceWorkerMediaStartConfig,
  ): VoiceWorkerMediaStartConfig {
    const enableP2p = call.negotiatedProtocol.udpP2p && config.enableP2p
    const effectiveConfig = { ...config, enableP2p }
    if (!effectiveConfig.endpoints.length && !(effectiveConfig.rtcServers?.length) && !enableP2p) {
      throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
    }
    call.connections = this._connectionsFromConfig(effectiveConfig)
    call.p2pAllowed = enableP2p
    call.negotiatedProtocol = { ...call.negotiatedProtocol, udpP2p: enableP2p }
    return effectiveConfig
  }

  private _connectionsFromConfig(config: VoiceWorkerMediaStartConfig): tl.TypePhoneConnection[] {
    const legacy: tl.TypePhoneConnection[] = config.endpoints.map((endpoint) => ({
      _: 'phoneConnection', id: cloneLong(endpoint.id), ip: endpoint.ipv4, ipv6: endpoint.ipv6,
      port: endpoint.port, peerTag: endpoint.peerTag.slice(), tcp: endpoint.kind === 'tcp-relay',
    }))
    const webRtc: tl.TypePhoneConnection[] = (config.rtcServers ?? []).map((server) => ({
      _: 'phoneConnectionWebrtc', id: Long.fromInt(server.id), ip: server.host, ipv6: '', port: server.port,
      username: server.username, password: server.password,
      turn: server.turn || undefined, stun: !server.turn || undefined,
    }))
    return [...legacy, ...webRtc]
  }

  private _workerCall(call: StoredCall, mediaStartConfig?: VoiceWorkerMediaStartConfig): VoiceWorkerCall {
    return {
      callId: this._key(call.id), callerId: call.adminId, participantId: call.participantId,
      telegramRole: call.telegramRole, protocol: this._cloneProtocol(call.negotiatedProtocol), mediaStartConfig,
      platformCallRef: call.platformCallRef,
    }
  }

  private _incomingProtocol(): tl.TypePhoneCallProtocol {
    return this._workerProtocol()
  }

  private _workerProtocol(): tl.TypePhoneCallProtocol {
    const protocol = this._worker?.protocol
    if (!protocol) throw new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
    this._requireAudioProtocol(protocol)
    if (!protocol.libraryVersions.length) throw new VoiceCallError('CALL_PROTOCOL_INVALID')
    return this._cloneProtocol(protocol)
  }

  private _cloneProtocol(protocol: tl.TypePhoneCallProtocol): tl.TypePhoneCallProtocol {
    return { ...protocol, libraryVersions: [...protocol.libraryVersions] }
  }

  private _negotiateProtocol(
    caller: tl.TypePhoneCallProtocol,
    recipient: tl.TypePhoneCallProtocol,
  ): tl.TypePhoneCallProtocol {
    const minLayer = Math.max(caller.minLayer, recipient.minLayer)
    const maxLayer = Math.min(caller.maxLayer, recipient.maxLayer)
    const libraryVersions = caller.libraryVersions.filter((version) => recipient.libraryVersions.includes(version))
    if (minLayer > maxLayer || !libraryVersions.length) throw new VoiceCallError('CALL_PROTOCOL_INVALID')
    return {
      _: 'phoneCallProtocol', udpP2p: caller.udpP2p && recipient.udpP2p,
      udpReflector: caller.udpReflector && recipient.udpReflector, minLayer, maxLayer, libraryVersions,
    }
  }

  private _requireAudioProtocol(protocol: tl.TypePhoneCallProtocol): void {
    if (
      protocol._ !== 'phoneCallProtocol'
      || !Number.isSafeInteger(protocol.minLayer)
      || !Number.isSafeInteger(protocol.maxLayer)
      || protocol.minLayer < 1
      || protocol.maxLayer < protocol.minLayer
      || !Array.isArray(protocol.libraryVersions)
      || protocol.libraryVersions.some((version) => typeof version !== 'string' || !version)
    ) throw new VoiceCallError('CALL_PROTOCOL_INVALID')
  }

  private _requireGAHash(value: Uint8Array): void {
    if (value.length !== GA_HASH_BYTES) throw new VoiceCallError('CALL_HANDSHAKE_INVALID')
  }

  private _requirePublicValue(value: Uint8Array): void {
    if (value.length !== DH_PUBLIC_BYTES) throw new VoiceCallError('CALL_HANDSHAKE_INVALID')
  }

  private _requireRandomId(randomId: number): void {
    if (!Number.isInteger(randomId)) throw new VoiceCallError('CALL_RANDOM_ID_INVALID')
  }

  private _uniqueRandomLong(inUse: (value: Long) => boolean): Long {
    for (let attempt = 0; attempt < 128; attempt++) {
      const value = Long.fromBytesBE([...this._randomBytes(8)], true)
      if (!value.isZero() && !inUse(value)) return value
    }
    throw new VoiceCallError('CALL_ID_GENERATION_FAILED')
  }

  private _incomingKey(session: PlatformSession, correlationId: string): string {
    return createHmac('sha256', this.#incomingHmacSecret)
      .update(session.platformSessionId)
      .update('\0')
      .update(correlationId)
      .digest('hex')
  }

  private async _serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this._pruneTombstones()
    const previous = this._sessionOperations.get(sessionId) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    const tail = previous.catch(() => {}).then(() => gate.promise)
    this._sessionOperations.set(sessionId, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      gate.resolve()
      if (this._sessionOperations.get(sessionId) === tail) this._sessionOperations.delete(sessionId)
    }
  }

  private _key(id: Long): string {
    return id.toUnsigned().toString()
  }

  private _zero(value: Uint8Array | undefined): void {
    value?.fill(0)
  }
}
