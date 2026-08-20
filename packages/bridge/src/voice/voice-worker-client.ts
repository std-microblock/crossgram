import { createConnection, type Socket } from 'node:net'
import Long from 'long'
import type { tl } from '@mtcute/core'
import type { VoicePcmFrame, VoiceWorkerMediaEndpoint } from './media.js'
import {
  VoiceCallError,
  type VoiceWorkerCall,
  type VoiceWorkerCallerCompletion,
  type VoiceWorkerCallerPreparation,
  type VoiceWorkerClient,
  type VoiceWorkerRecipientCompletion,
  type VoiceWorkerRecipientPreparation,
} from './call-registry.js'

export const VOICE_WORKER_PROTOCOL_VERSION = 3
export const VOICE_WORKER_MAX_FRAME_BYTES = 65_536
export const VOICE_WORKER_MAX_SIGNAL_BYTES = 32_768
export const VOICE_WORKER_PCM_FRAME_BYTES = 1_920

const DH_PUBLIC_BYTES = 256
const GA_HASH_BYTES = 32
const PCM_CAPABILITY_BYTES = 32
const PCM_POLL_INTERVAL_MS = 10
const MAX_U64 = (1n << 64n) - 1n
const DEFAULT_TIMEOUT_MS = 5_000

export interface VoiceWorkerEndpoint {
  readonly id: Long
  readonly ipv4: string
  readonly ipv6: string
  readonly port: number
  readonly kind: 'inet' | 'lan' | 'udp-relay' | 'tcp-relay'
  readonly peerTag: Uint8Array
}

/** One WebRTC ICE server shared with both native tgcalls peers. */
export interface VoiceWorkerRtcServer {
  readonly id: number
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly turn: boolean
  readonly tcp: boolean
}

/** Public relay settings copied into the worker only with its private auth key. */
export interface VoiceWorkerMediaStartConfig {
  readonly initializationTimeoutMs: number
  readonly receiveTimeoutMs: number
  readonly enableP2p: boolean
  readonly allowTcp: boolean
  readonly protocolV1: boolean
  readonly enableAec: boolean
  readonly enableNs: boolean
  readonly enableAgc: boolean
  readonly endpoints: readonly VoiceWorkerEndpoint[]
  readonly rtcServers?: readonly VoiceWorkerRtcServer[]
}

export type VoiceWorkerEvent =
  | { readonly kind: 'outbound-signal', readonly data: Uint8Array }
  | { readonly kind: 'native-error' }

export interface VoiceWorkerSocketClientOptions {
  readonly socketPath: string
  readonly timeoutMs?: number
  readonly onEvent?: (call: VoiceWorkerCall, event: VoiceWorkerEvent) => Promise<void> | void
  /** Redacted lifecycle diagnostics; never includes call IDs, capabilities, or media. */
  readonly onDiagnostic?: (phase: VoiceWorkerDiagnosticPhase, code: string) => void
}

export type VoiceWorkerDiagnosticPhase = 'prepare-caller' | 'pcm-send' | 'pcm-receive' | 'pcm-close' | 'native-error'

export type VoiceWorkerIpcRequest =
  | { readonly tag: 0x01, readonly callId: bigint }
  | { readonly tag: 0x02, readonly callId: bigint, readonly gAHash: Uint8Array }
  | { readonly tag: 0x03, readonly callId: bigint, readonly gB: Uint8Array, readonly config: VoiceWorkerMediaStartConfig }
  | { readonly tag: 0x04, readonly callId: bigint, readonly gA: Uint8Array, readonly expectedFingerprint: Long, readonly config: VoiceWorkerMediaStartConfig }
  | { readonly tag: 0x05, readonly callId: bigint, readonly requestId: bigint, readonly signal: Uint8Array }
  | { readonly tag: 0x06, readonly callId: bigint }
  | { readonly tag: 0x07, readonly callId: bigint, readonly requestId: bigint }
  | { readonly tag: 0x08, readonly callId: bigint, readonly capability: Uint8Array, readonly frame: Uint8Array }
  | { readonly tag: 0x09, readonly callId: bigint, readonly capability: Uint8Array }
  | { readonly tag: 0x0a, readonly callId: bigint, readonly capability: Uint8Array }
  | { readonly tag: 0x0b, readonly callId: bigint }
  | { readonly tag: 0x0c, readonly callId: bigint, readonly eventId: bigint }

type VoiceWorkerIpcResponse =
  | { readonly tag: 0x81, readonly gAHash: Uint8Array }
  | { readonly tag: 0x82, readonly gB: Uint8Array }
  | { readonly tag: 0x83, readonly gA: Uint8Array, readonly fingerprint: Long }
  | { readonly tag: 0x84, readonly fingerprint: Long }
  | { readonly tag: 0x85, readonly requestId: bigint }
  | { readonly tag: 0x86 }
  | { readonly tag: 0x87, readonly requestId: bigint, readonly capability: Uint8Array }
  | { readonly tag: 0x88 }
  | { readonly tag: 0x89, readonly frame: Uint8Array }
  | { readonly tag: 0x8a }
  | { readonly tag: 0x8b }
  | { readonly tag: 0x8c, readonly eventId: bigint, readonly event: VoiceWorkerEvent }
  | { readonly tag: 0x8d }
  | { readonly tag: 0x8e, readonly eventId: bigint }
  | { readonly tag: 0xff, readonly errorCode: number }

class VoiceWorkerTransportError extends Error {
  constructor(readonly retryable: boolean) {
    super()
  }
}

/** Encodes one complete IPC v3 request frame for a local voice worker. */
export function encodeVoiceWorkerRequest(request: VoiceWorkerIpcRequest): Buffer {
  const payload: Buffer[] = [Buffer.from([VOICE_WORKER_PROTOCOL_VERSION, request.tag])]
  payload.push(u64(request.callId))
  switch (request.tag) {
    case 0x02:
      payload.push(fixedBytes(request.gAHash, GA_HASH_BYTES))
      break
    case 0x03:
      payload.push(fixedBytes(request.gB, DH_PUBLIC_BYTES), mediaStartConfig(request.config, true))
      break
    case 0x04:
      payload.push(fixedBytes(request.gA, DH_PUBLIC_BYTES), i64le(request.expectedFingerprint), mediaStartConfig(request.config, false))
      break
    case 0x05:
      if (request.signal.length > VOICE_WORKER_MAX_SIGNAL_BYTES) throw unavailable()
      payload.push(u64(request.requestId), u16(request.signal.length), Buffer.from(request.signal))
      break
    case 0x07:
      payload.push(u64(request.requestId))
      break
    case 0x08:
      payload.push(fixedBytes(request.capability, PCM_CAPABILITY_BYTES), fixedBytes(request.frame, VOICE_WORKER_PCM_FRAME_BYTES))
      break
    case 0x09:
    case 0x0a:
      payload.push(fixedBytes(request.capability, PCM_CAPABILITY_BYTES))
      break
    case 0x0c:
      payload.push(u64(request.eventId))
      break
  }
  return frame(Buffer.concat(payload))
}

/** Decodes exactly one IPC v3 response payload after its length prefix. */
export function decodeVoiceWorkerResponse(payload: Uint8Array): VoiceWorkerIpcResponse {
  if (payload.length < 2 || payload.length > VOICE_WORKER_MAX_FRAME_BYTES
    || payload[0] !== VOICE_WORKER_PROTOCOL_VERSION) throw unavailable()
  const input = Buffer.from(payload)
  const tag = input[1]
  let offset = 2
  const take = (length: number): Buffer => {
    const end = offset + length
    if (end > input.length) throw unavailable()
    const value = input.subarray(offset, end)
    offset = end
    return value
  }
  const response: VoiceWorkerIpcResponse = (() => {
    switch (tag) {
      case 0x81: return { tag, gAHash: new Uint8Array(take(GA_HASH_BYTES)) }
      case 0x82: return { tag, gB: new Uint8Array(take(DH_PUBLIC_BYTES)) }
      case 0x83: return { tag, gA: new Uint8Array(take(DH_PUBLIC_BYTES)), fingerprint: readI64le(take(8)) }
      case 0x84: return { tag, fingerprint: readI64le(take(8)) }
      case 0x85: return { tag, requestId: readU64(take(8)) }
      case 0x86: return { tag }
      case 0x87: return { tag, requestId: readU64(take(8)), capability: new Uint8Array(take(PCM_CAPABILITY_BYTES)) }
      case 0x88: return { tag }
      case 0x89: return { tag, frame: new Uint8Array(take(VOICE_WORKER_PCM_FRAME_BYTES)) }
      case 0x8a: return { tag }
      case 0x8b: return { tag }
      case 0x8c: {
        const eventId = readU64(take(8))
        const kind = take(1)[0]
        if (kind === 1) return { tag, eventId, event: { kind: 'outbound-signal', data: new Uint8Array(takeU16Bytes(take)) } }
        if (kind === 2) return { tag, eventId, event: { kind: 'native-error' } }
        throw unavailable()
      }
      case 0x8d: return { tag }
      case 0x8e: return { tag, eventId: readU64(take(8)) }
      case 0xff: {
        const errorCode = take(1)[0]!
        if (errorCode < 1 || errorCode > 5) throw unavailable()
        return { tag, errorCode }
      }
      default: throw unavailable()
    }
  })()
  if (offset !== input.length) throw unavailable()
  return response
}

/**
 * Minimal production adapter for the Rust worker's local IPC v3 protocol.
 * It owns no worker process or media backend; every operation uses a fresh
 * Unix connection so a restarted worker can be reached by the same instance.
 */
export class VoiceWorkerSocketClient implements VoiceWorkerClient {
  // The pinned native adapter registers InstanceImpl and starts ProtocolVersion::V1.
  // Its upstream source advertises version 5.0.0 with call layers 65 through 92.
  readonly protocol: tl.TypePhoneCallProtocol = {
    _: 'phoneCallProtocol', udpP2p: true, udpReflector: false,
    minLayer: 65, maxLayer: 92, libraryVersions: ['5.0.0'],
  }

  private readonly _callIds = new Map<string, bigint>()
  private readonly _sockets = new Set<Socket>()
  private readonly _endpoints = new Set<VoiceWorkerPcmEndpoint>()
  private readonly _deliveredEvents = new Map<bigint, Set<bigint>>()
  private readonly _eventPumps = new Set<bigint>()
  private readonly _eventAborts = new Map<bigint, AbortController>()
  private readonly _eventPumpSettlements = new Map<bigint, Promise<void>>()
  private readonly _deliveringEvents = new Set<bigint>()
  private _onEvent: VoiceWorkerSocketClientOptions['onEvent']
  private readonly _timeoutMs: number
  private _nextCallId = 0n
  private _nextRequestId = 0n
  private _closed = false

  constructor(private readonly _options: VoiceWorkerSocketClientOptions) {
    if (!_options.socketPath || !Number.isSafeInteger(_options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      || (_options.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0) throw unavailable()
    this._timeoutMs = _options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this._onEvent = _options.onEvent
  }

  setEventHandler(handler: VoiceWorkerSocketClientOptions['onEvent']): void {
    this._onEvent = handler
  }

  async prepareTelegramCaller(call: VoiceWorkerCall): Promise<VoiceWorkerCallerPreparation> {
    const response = await this._request({ tag: 0x01, callId: this._callId(call) }, true, undefined, 'prepare-caller')
    try {
      if (response.tag !== 0x81) throw unavailable()
      return { state: 'ready', gAHash: response.gAHash }
    } catch (error) {
      this._diagnose('prepare-caller', error)
      throw error
    }
  }

  async prepareTelegramRecipient(
    call: VoiceWorkerCall,
    gAHash: Uint8Array,
  ): Promise<VoiceWorkerRecipientPreparation> {
    const response = await this._request({ tag: 0x02, callId: this._callId(call), gAHash: gAHash.slice() })
    if (response.tag !== 0x82) throw unavailable()
    return { state: 'ready', gB: response.gB }
  }

  async completeTelegramCaller(call: VoiceWorkerCall, gB: Uint8Array): Promise<VoiceWorkerCallerCompletion> {
    const callId = this._callId(call)
    const response = await this._request({ tag: 0x03, callId, gB: gB.slice(), config: this._mediaConfig(call) })
    if (response.tag !== 0x83) throw unavailable()
    this._startEventPump(call, callId)
    return { state: 'media-active', gA: response.gA, keyFingerprint: response.fingerprint }
  }

  async completeTelegramRecipient(
    call: VoiceWorkerCall,
    gA: Uint8Array,
    keyFingerprint: Long,
  ): Promise<VoiceWorkerRecipientCompletion> {
    const callId = this._callId(call)
    const response = await this._request({
      tag: 0x04, callId, gA: gA.slice(), expectedFingerprint: keyFingerprint, config: this._mediaConfig(call),
    })
    if (response.tag !== 0x84) throw unavailable()
    this._startEventPump(call, callId)
    return { state: 'media-active', keyFingerprint: response.fingerprint }
  }

  async sendSignalingData(call: VoiceWorkerCall, data: Uint8Array): Promise<void> {
    const requestId = this._nextId('_nextRequestId')
    const response = await this._request({
      tag: 0x05, callId: this._callId(call), requestId, signal: data.slice(),
    }, true)
    if (response.tag !== 0x85 || response.requestId !== requestId) throw unavailable()
  }

  /** Attaches the worker's single fixed-format PCM endpoint after media is active. */
  async attachMedia(call: VoiceWorkerCall): Promise<VoiceWorkerMediaEndpoint> {
    const callId = this._callId(call)
    const requestId = this._nextId('_nextRequestId')
    const response = await this._request({ tag: 0x07, callId, requestId }, true)
    if (response.tag !== 0x87 || response.requestId !== requestId) throw unavailable()
    const endpoint = new VoiceWorkerPcmEndpoint(this, callId, response.capability)
    this._endpoints.add(endpoint)
    return endpoint
  }

  async discardCall(call: VoiceWorkerCall): Promise<void> {
    const callId = this._callIds.get(call.callId)
    if (!callId) return
    this._eventAborts.get(callId)?.abort()
    const pump = this._eventPumpSettlements.get(callId)
    // A native-error handler can discard its own call; waiting for that pump
    // would deadlock because it is awaiting this handler's return.
    if (pump && !this._deliveringEvents.has(callId)) await pump.catch(() => {})
    try {
      const response = await this._request({ tag: 0x06, callId })
      if (response.tag !== 0x86) throw unavailable()
    } finally {
      this._invalidateCallEndpoints(callId)
      this._eventAborts.delete(callId)
      this._deliveredEvents.delete(callId)
      this._callIds.delete(call.callId)
    }
  }

  /** Aborts in-flight local requests; this does not start, stop, or manage the worker. */
  close(): void {
    if (this._closed) return
    this._closed = true
    for (const socket of this._sockets) socket.destroy()
    this._sockets.clear()
    for (const controller of this._eventAborts.values()) controller.abort()
    this._eventAborts.clear()
    for (const endpoint of this._endpoints) endpoint.invalidate()
    this._endpoints.clear()
    this._deliveredEvents.clear()
    this._callIds.clear()
  }

  private _mediaConfig(call: VoiceWorkerCall): VoiceWorkerMediaStartConfig {
    if (!call.mediaStartConfig) throw unavailable()
    return cloneMediaStartConfig(call.mediaStartConfig)
  }

  private _startEventPump(call: VoiceWorkerCall, callId: bigint): void {
    if (!this._onEvent || this._eventPumps.has(callId)) return
    const controller = new AbortController()
    this._eventPumps.add(callId)
    this._eventAborts.set(callId, controller)
    const pump = this._drainEvents(call, callId, controller.signal)
    this._eventPumpSettlements.set(callId, pump)
    void pump.finally(() => {
      if (this._eventPumpSettlements.get(callId) === pump) this._eventPumpSettlements.delete(callId)
    }).catch(() => {})
  }

  private async _drainEvents(call: VoiceWorkerCall, callId: bigint, signal: AbortSignal): Promise<void> {
    let failures = 0
    try {
      while (!this._closed && this._callIds.get(call.callId) === callId) {
        try {
          const response = await this._request({ tag: 0x0b, callId }, true, signal)
          if (response.tag === 0x8d) {
            failures = 0
            await delay(PCM_POLL_INTERVAL_MS, signal)
            continue
          }
          if (response.tag !== 0x8c) throw unavailable()
          const delivered = this._deliveredEvents.get(callId) ?? new Set<bigint>()
          this._deliveredEvents.set(callId, delivered)
          if (!delivered.has(response.eventId)) {
            this._deliveringEvents.add(callId)
            try {
              await this._onEvent?.(call, response.event)
              delivered.add(response.eventId)
            } finally {
              this._deliveringEvents.delete(callId)
            }
          }
          const ack = await this._request({ tag: 0x0c, callId, eventId: response.eventId }, true)
          if (ack.tag !== 0x8e || ack.eventId !== response.eventId) throw unavailable()
          delivered.delete(response.eventId)
          if (!delivered.size) this._deliveredEvents.delete(callId)
          failures = 0
          if (response.event.kind === 'native-error') {
            this._diagnose('native-error', 'NATIVE_ERROR')
            return
          }
        } catch {
          if (signal.aborted || this._closed) return
          failures++
          const delayMs = Math.min(PCM_POLL_INTERVAL_MS * (2 ** Math.min(failures, 6)), 250)
          try {
            await delay(delayMs, signal)
          } catch {
            return
          }
        }
      }
    } finally {
      this._eventPumps.delete(callId)
      this._eventAborts.delete(callId)
    }
  }

  async _requestPcm(request: VoiceWorkerIpcRequest): Promise<VoiceWorkerIpcResponse> {
    return this._request(request)
  }

  _releaseEndpoint(endpoint: VoiceWorkerPcmEndpoint): void {
    this._endpoints.delete(endpoint)
  }

  private _invalidateCallEndpoints(callId: bigint): void {
    for (const endpoint of this._endpoints) {
      if (endpoint.belongsTo(callId)) endpoint.invalidate()
    }
  }

  _diagnose(phase: VoiceWorkerDiagnosticPhase, error: unknown): void {
    const code = typeof error === 'string'
      ? error
      : error instanceof VoiceCallError
        ? error.code
        : error instanceof VoiceWorkerTransportError
          ? error.retryable ? 'TRANSPORT_RETRYABLE' : 'TRANSPORT_TERMINAL'
          : error instanceof Error && error.name ? error.name : 'UNKNOWN'
    try {
      this._options.onDiagnostic?.(phase, code)
    } catch {
      // Diagnostics must never change media lifecycle behavior.
    }
  }

  private _callId(call: VoiceWorkerCall): bigint {
    if (!call.callId || call.callId.length > 128) throw unavailable()
    let callId = this._callIds.get(call.callId)
    if (!callId) {
      callId = this._nextId('_nextCallId')
      this._callIds.set(call.callId, callId)
    }
    return callId
  }

  private _nextId(field: '_nextCallId' | '_nextRequestId'): bigint {
    if (this[field] >= MAX_U64) throw unavailable()
    this[field]++
    return this[field]
  }

  private async _request(
    request: VoiceWorkerIpcRequest,
    retryTransport = false,
    signal?: AbortSignal,
    diagnosticPhase?: VoiceWorkerDiagnosticPhase,
  ): Promise<VoiceWorkerIpcResponse> {
    if (this._closed || signal?.aborted) throw unavailable()
    const encoded = encodeVoiceWorkerRequest(request)
    try {
      return await this._requestEncoded(encoded, retryTransport, signal)
    } catch (error) {
      if (diagnosticPhase) this._diagnose(diagnosticPhase, error)
      if (error instanceof VoiceCallError) throw error
      throw unavailable()
    } finally {
      encoded.fill(0)
    }
  }

  private async _requestEncoded(
    request: Buffer,
    retryTransport: boolean,
    signal?: AbortSignal,
  ): Promise<VoiceWorkerIpcResponse> {
    try {
      return await this._decodeExchange(request, signal)
    } catch (error) {
      if (!retryTransport || this._closed || signal?.aborted
        || !(error instanceof VoiceWorkerTransportError) || !error.retryable) throw error
      return this._decodeExchange(request, signal)
    }
  }

  private async _decodeExchange(request: Buffer, signal?: AbortSignal): Promise<VoiceWorkerIpcResponse> {
    const payload = await this._exchange(request, signal)
    try {
      return this._decodeResponse(payload)
    } finally {
      payload.fill(0)
    }
  }

  private _decodeResponse(payload: Buffer): VoiceWorkerIpcResponse {
    const response = decodeVoiceWorkerResponse(payload)
    if (response.tag === 0xff) throw workerError(response.errorCode)
    return response
  }

  private _exchange(request: Buffer, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let settled = false
      let connected = false
      let received = Buffer.alloc(0)
      let expectedLength: number | undefined
      const socket = createConnection({ path: this._options.socketPath })
      const finish = (error?: Error, response?: Buffer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this._sockets.delete(socket)
        socket.removeAllListeners()
        // `destroy()` may asynchronously surface a reset after listeners were
        // removed; keep this terminal listener so it cannot escape the exchange.
        socket.once('error', () => {})
        socket.destroy()
        if (error) reject(error)
        else resolve(response!)
      }
      const transportFailure = (retryable = connected) => new VoiceWorkerTransportError(retryable)
      const abort = () => finish(new VoiceWorkerTransportError(false))
      const timer = setTimeout(() => finish(transportFailure(connected && received.length === 0)), this._timeoutMs)
      timer.unref()
      this._sockets.add(socket)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      socket.once('error', () => finish(transportFailure(connected && received.length === 0)))
      socket.once('connect', () => {
        connected = true
        try {
          socket.write(request, (error) => {
            if (error) finish(transportFailure())
          })
        } catch {
          finish(transportFailure())
        }
      })
      socket.on('data', (chunk: Buffer) => {
        if (settled || received.length + chunk.length > VOICE_WORKER_MAX_FRAME_BYTES + 4) {
          finish(transportFailure(false))
          return
        }
        received = Buffer.concat([received, chunk])
        if (expectedLength === undefined && received.length >= 4) {
          expectedLength = received.readUInt32BE(0)
          if (expectedLength < 2 || expectedLength > VOICE_WORKER_MAX_FRAME_BYTES) {
            finish(transportFailure(false))
            return
          }
        }
        if (expectedLength !== undefined && received.length > expectedLength + 4) finish(transportFailure(false))
      })
      socket.once('end', () => {
        if (expectedLength === undefined || received.length !== expectedLength + 4) {
          finish(transportFailure(connected && received.length === 0))
        } else finish(undefined, received.subarray(4))
      })
      socket.once('close', () => finish(transportFailure(connected && received.length === 0)))
    })
  }
}

class VoiceWorkerPcmEndpoint implements VoiceWorkerMediaEndpoint {
  private _closed = false

  constructor(
    private readonly _client: VoiceWorkerSocketClient,
    private readonly _callId: bigint,
    private readonly _capability: Uint8Array,
  ) {}

  belongsTo(callId: bigint): boolean {
    return this._callId === callId
  }

  async send(frame: VoicePcmFrame, options: { signal: AbortSignal }): Promise<void> {
    this._requireOpen(options.signal)
    const data = pcmData(frame)
    try {
      const response = await abortable(this._client._requestPcm({
        tag: 0x08, callId: this._callId, capability: this._capability, frame: data,
      }), options.signal)
      if (response.tag !== 0x88) throw unavailable()
    } catch (error) {
      this._client._diagnose('pcm-send', error)
      this.invalidate()
      throw unavailable()
    } finally {
      data.fill(0)
    }
  }

  async *receive(options: { signal: AbortSignal }): AsyncIterable<VoicePcmFrame> {
    try {
      while (!options.signal.aborted) {
        const response = await abortable(this._client._requestPcm({
          tag: 0x09, callId: this._callId, capability: this._capability,
        }), options.signal)
        if (response.tag === 0x89) {
          yield pcmFrame(response.frame)
          continue
        }
        if (response.tag !== 0x8a) throw unavailable()
        await delay(PCM_POLL_INTERVAL_MS, options.signal)
      }
    } catch (error) {
      this._client._diagnose('pcm-receive', error)
      this.invalidate()
      throw unavailable()
    }
  }

  async close(): Promise<void> {
    if (this._closed) return
    try {
      const response = await this._client._requestPcm({
        tag: 0x0a, callId: this._callId, capability: this._capability,
      })
      if (response.tag !== 0x8b) throw unavailable()
    } catch (error) {
      this._client._diagnose('pcm-close', error)
      throw unavailable()
    } finally {
      this.invalidate()
    }
  }

  invalidate(): void {
    if (this._closed) return
    this._closed = true
    this._capability.fill(0)
    this._client._releaseEndpoint(this)
  }

  private _requireOpen(signal: AbortSignal): void {
    if (this._closed || signal.aborted) throw unavailable()
  }
}

function pcmData(frame: VoicePcmFrame): Uint8Array {
  if (
    frame.format.encoding !== 's16le'
    || frame.format.sampleRate !== 48_000
    || frame.format.channels !== 1
    || frame.format.durationMs !== 20
    || frame.format.samplesPerFrame !== 960
    || frame.format.bytesPerFrame !== VOICE_WORKER_PCM_FRAME_BYTES
    || frame.data.length !== VOICE_WORKER_PCM_FRAME_BYTES
  ) throw unavailable()
  return new Uint8Array(frame.data)
}

function pcmFrame(data: Uint8Array): VoicePcmFrame {
  if (data.length !== VOICE_WORKER_PCM_FRAME_BYTES) throw unavailable()
  return {
    format: {
      encoding: 's16le', sampleRate: 48_000, channels: 1, durationMs: 20,
      samplesPerFrame: 960, bytesPerFrame: VOICE_WORKER_PCM_FRAME_BYTES,
    },
    data: new Uint8Array(data),
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(unavailable())
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    timer.unref()
    const abort = () => {
      clearTimeout(timer)
      reject(unavailable())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function takeU16Bytes(take: (length: number) => Buffer): Buffer {
  const length = take(2).readUInt16BE(0)
  if (length > VOICE_WORKER_MAX_SIGNAL_BYTES) throw unavailable()
  return take(length)
}

function mediaStartConfig(config: VoiceWorkerMediaStartConfig, isOutgoing: boolean): Buffer {
  const normalized = cloneMediaStartConfig(config)
  const flags = Number(normalized.enableP2p)
    | (Number(normalized.allowTcp) << 1)
    | (Number(normalized.protocolV1) << 2)
    | (Number(normalized.enableAec) << 3)
    | (Number(normalized.enableNs) << 4)
    | (Number(normalized.enableAgc) << 5)
  const header = Buffer.allocUnsafe(12)
  header[0] = Number(isOutgoing)
  header.writeUInt32BE(normalized.initializationTimeoutMs, 1)
  header.writeUInt32BE(normalized.receiveTimeoutMs, 5)
  header[9] = flags
  header[10] = normalized.endpoints.length
  header[11] = normalized.rtcServers?.length ?? 0
  const endpoints = normalized.endpoints.map((endpoint) => {
    const kind = { inet: 0, lan: 1, 'udp-relay': 2, 'tcp-relay': 3 }[endpoint.kind]
    const prefix = Buffer.allocUnsafe(27)
    i64(endpoint.id).copy(prefix, 0)
    prefix.writeUInt16BE(endpoint.port, 8)
    prefix[10] = kind
    fixedBytes(endpoint.peerTag, 16).copy(prefix, 11)
    return Buffer.concat([prefix, boundedString(endpoint.ipv4), boundedString(endpoint.ipv6)])
  })
  const rtcServers = (normalized.rtcServers ?? []).map((server) => {
    const prefix = Buffer.allocUnsafe(4)
    prefix[0] = server.id
    prefix.writeUInt16BE(server.port, 1)
    prefix[3] = Number(server.turn) | (Number(server.tcp) << 1)
    return Buffer.concat([
      prefix,
      boundedString(server.host),
      boundedString(server.username),
      boundedString(server.password),
    ])
  })
  return Buffer.concat([header, ...endpoints, ...rtcServers])
}

function cloneMediaStartConfig(config: VoiceWorkerMediaStartConfig): VoiceWorkerMediaStartConfig {
  if (!Number.isSafeInteger(config.initializationTimeoutMs) || config.initializationTimeoutMs < 1 || config.initializationTimeoutMs > 0xffff_ffff
    || !Number.isSafeInteger(config.receiveTimeoutMs) || config.receiveTimeoutMs < 1 || config.receiveTimeoutMs > 0xffff_ffff
    || typeof config.enableP2p !== 'boolean' || typeof config.allowTcp !== 'boolean' || typeof config.protocolV1 !== 'boolean'
    || typeof config.enableAec !== 'boolean' || typeof config.enableNs !== 'boolean' || typeof config.enableAgc !== 'boolean'
    || !Array.isArray(config.endpoints) || config.endpoints.length > 16
    || config.rtcServers !== undefined && (!Array.isArray(config.rtcServers) || config.rtcServers.length > 16)
    || !config.endpoints.length && !(config.rtcServers?.length) && !config.enableP2p) throw unavailable()
  return {
    initializationTimeoutMs: config.initializationTimeoutMs,
    receiveTimeoutMs: config.receiveTimeoutMs,
    enableP2p: config.enableP2p, allowTcp: config.allowTcp, protocolV1: config.protocolV1,
    enableAec: config.enableAec, enableNs: config.enableNs, enableAgc: config.enableAgc,
    endpoints: config.endpoints.map((endpoint) => {
      if (!endpoint || !Long.isLong(endpoint.id) || typeof endpoint.ipv4 !== 'string' || typeof endpoint.ipv6 !== 'string'
        || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535
        || !['inet', 'lan', 'udp-relay', 'tcp-relay'].includes(endpoint.kind)
        || !(endpoint.peerTag instanceof Uint8Array) || !endpoint.ipv4.length && !endpoint.ipv6.length
        || endpoint.ipv4.includes('\0') || endpoint.ipv6.includes('\0')
        || Buffer.byteLength(endpoint.ipv4, 'utf8') > 255 || Buffer.byteLength(endpoint.ipv6, 'utf8') > 255
        || endpoint.peerTag.length !== 16) throw unavailable()
      return { ...endpoint, id: Long.fromBits(endpoint.id.low, endpoint.id.high, false), peerTag: endpoint.peerTag.slice() }
    }),
    rtcServers: (config.rtcServers ?? []).map((server) => {
      if (!server || !Number.isSafeInteger(server.id) || server.id < 1 || server.id > 255
        || typeof server.host !== 'string' || !server.host.length || server.host.includes('\0')
        || !Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65_535
        || typeof server.username !== 'string' || server.username.includes('\0')
        || typeof server.password !== 'string' || server.password.includes('\0')
        || typeof server.turn !== 'boolean' || typeof server.tcp !== 'boolean'
        || Buffer.byteLength(server.host, 'utf8') > 255
        || Buffer.byteLength(server.username, 'utf8') > 255
        || Buffer.byteLength(server.password, 'utf8') > 255
        || server.turn && (!server.username.length || !server.password.length)
        || !server.turn && (server.username.length > 0 || server.password.length > 0)) throw unavailable()
      return { ...server }
    }),
  }
}

function boundedString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > 255) throw unavailable()
  const length = Buffer.allocUnsafe(2)
  length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function frame(payload: Buffer): Buffer {
  if (payload.length < 2 || payload.length > VOICE_WORKER_MAX_FRAME_BYTES) throw unavailable()
  const output = Buffer.allocUnsafe(4 + payload.length)
  output.writeUInt32BE(payload.length, 0)
  payload.copy(output, 4)
  return output
}

function fixedBytes(value: Uint8Array, length: number): Buffer {
  if (value.length !== length) throw unavailable()
  return Buffer.from(value)
}

function u16(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) throw unavailable()
  const output = Buffer.allocUnsafe(2)
  output.writeUInt16BE(value)
  return output
}

function u64(value: bigint): Buffer {
  if (value < 1n || value > MAX_U64) throw unavailable()
  const output = Buffer.allocUnsafe(8)
  output.writeBigUInt64BE(value)
  return output
}

function readU64(value: Buffer): bigint {
  return value.readBigUInt64BE()
}

function i64le(value: Long): Buffer {
  const output = Buffer.allocUnsafe(8)
  output.writeInt32LE(value.low, 0)
  output.writeInt32LE(value.high, 4)
  return output
}

function i64(value: Long): Buffer {
  const output = Buffer.allocUnsafe(8)
  output.writeBigInt64BE(BigInt.asIntN(64, BigInt(value.toString())))
  return output
}

function readI64le(value: Buffer): Long {
  return Long.fromBits(value.readInt32LE(0), value.readInt32LE(4), false)
}

function workerError(errorCode: number): VoiceCallError {
  switch (errorCode) {
    case 1: return new VoiceCallError('CALL_WORKER_FAILED')
    case 2: return new VoiceCallError('CALL_OCCUPY_FAILED')
    case 3: return new VoiceCallError('CALL_STATE_INVALID')
    case 4: return new VoiceCallError('CALL_HANDSHAKE_INVALID')
    case 5: return unavailable()
    default: return unavailable()
  }
}

function unavailable(): VoiceCallError {
  return new VoiceCallError('CALL_MEDIA_UNAVAILABLE')
}
