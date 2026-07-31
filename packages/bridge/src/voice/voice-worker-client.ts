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

export const VOICE_WORKER_PROTOCOL_VERSION = 2
export const VOICE_WORKER_MAX_FRAME_BYTES = 65_536
export const VOICE_WORKER_MAX_SIGNAL_BYTES = 32_768
export const VOICE_WORKER_PCM_FRAME_BYTES = 1_920

const DH_PUBLIC_BYTES = 256
const GA_HASH_BYTES = 32
const PCM_CAPABILITY_BYTES = 32
const PCM_POLL_INTERVAL_MS = 10
const MAX_U64 = (1n << 64n) - 1n
const DEFAULT_TIMEOUT_MS = 5_000

export interface VoiceWorkerSocketClientOptions {
  readonly socketPath: string
  readonly timeoutMs?: number
}

export type VoiceWorkerIpcRequest =
  | { readonly tag: 0x01, readonly callId: bigint }
  | { readonly tag: 0x02, readonly callId: bigint, readonly gAHash: Uint8Array }
  | { readonly tag: 0x03, readonly callId: bigint, readonly gB: Uint8Array }
  | { readonly tag: 0x04, readonly callId: bigint, readonly gA: Uint8Array, readonly expectedFingerprint: Long }
  | { readonly tag: 0x05, readonly callId: bigint, readonly requestId: bigint, readonly signal: Uint8Array }
  | { readonly tag: 0x06, readonly callId: bigint }
  | { readonly tag: 0x07, readonly callId: bigint, readonly requestId: bigint }
  | { readonly tag: 0x08, readonly callId: bigint, readonly capability: Uint8Array, readonly frame: Uint8Array }
  | { readonly tag: 0x09, readonly callId: bigint, readonly capability: Uint8Array }
  | { readonly tag: 0x0a, readonly callId: bigint, readonly capability: Uint8Array }

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
  | { readonly tag: 0xff, readonly errorCode: number }

class VoiceWorkerTransportError extends Error {
  constructor(readonly retryable: boolean) {
    super()
  }
}

/** Encodes one complete IPC v2 request frame for a local voice worker. */
export function encodeVoiceWorkerRequest(request: VoiceWorkerIpcRequest): Buffer {
  const payload: Buffer[] = [Buffer.from([VOICE_WORKER_PROTOCOL_VERSION, request.tag])]
  payload.push(u64(request.callId))
  switch (request.tag) {
    case 0x02:
      payload.push(fixedBytes(request.gAHash, GA_HASH_BYTES))
      break
    case 0x03:
      payload.push(fixedBytes(request.gB, DH_PUBLIC_BYTES))
      break
    case 0x04:
      payload.push(fixedBytes(request.gA, DH_PUBLIC_BYTES), i64le(request.expectedFingerprint))
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
  }
  return frame(Buffer.concat(payload))
}

/** Decodes exactly one IPC v2 response payload after its length prefix. */
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
 * Minimal production adapter for the Rust worker's local IPC v2 protocol.
 * It owns no worker process or media backend; every operation uses a fresh
 * Unix connection so a restarted worker can be reached by the same instance.
 */
export class VoiceWorkerSocketClient implements VoiceWorkerClient {
  readonly protocol: tl.TypePhoneCallProtocol = {
    _: 'phoneCallProtocol', udpP2p: false, udpReflector: false,
    minLayer: 100, maxLayer: 100, libraryVersions: ['crossgram-voice-worker-v2'],
  }

  private readonly _callIds = new Map<string, bigint>()
  private readonly _sockets = new Set<Socket>()
  private readonly _endpoints = new Set<VoiceWorkerPcmEndpoint>()
  private readonly _timeoutMs: number
  private _nextCallId = 0n
  private _nextRequestId = 0n
  private _closed = false

  constructor(private readonly _options: VoiceWorkerSocketClientOptions) {
    if (!_options.socketPath || !Number.isSafeInteger(_options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      || (_options.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0) throw unavailable()
    this._timeoutMs = _options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async prepareTelegramCaller(call: VoiceWorkerCall): Promise<VoiceWorkerCallerPreparation> {
    const response = await this._request({ tag: 0x01, callId: this._callId(call) })
    if (response.tag !== 0x81) throw unavailable()
    return { state: 'ready', gAHash: response.gAHash }
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
    const response = await this._request({ tag: 0x03, callId: this._callId(call), gB: gB.slice() })
    if (response.tag !== 0x83) throw unavailable()
    return { state: 'media-active', gA: response.gA, keyFingerprint: response.fingerprint }
  }

  async completeTelegramRecipient(
    call: VoiceWorkerCall,
    gA: Uint8Array,
    keyFingerprint: Long,
  ): Promise<VoiceWorkerRecipientCompletion> {
    const response = await this._request({
      tag: 0x04, callId: this._callId(call), gA: gA.slice(), expectedFingerprint: keyFingerprint,
    })
    if (response.tag !== 0x84) throw unavailable()
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
    try {
      const response = await this._request({ tag: 0x06, callId })
      if (response.tag !== 0x86) throw unavailable()
    } finally {
      this._invalidateCallEndpoints(callId)
      this._callIds.delete(call.callId)
    }
  }

  /** Aborts in-flight local requests; this does not start, stop, or manage the worker. */
  close(): void {
    if (this._closed) return
    this._closed = true
    for (const socket of this._sockets) socket.destroy()
    this._sockets.clear()
    for (const endpoint of this._endpoints) endpoint.invalidate()
    this._endpoints.clear()
    this._callIds.clear()
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

  private async _request(request: VoiceWorkerIpcRequest, retryTransport = false): Promise<VoiceWorkerIpcResponse> {
    if (this._closed) throw unavailable()
    const encoded = encodeVoiceWorkerRequest(request)
    try {
      return await this._requestEncoded(encoded, retryTransport)
    } catch (error) {
      if (error instanceof VoiceCallError) throw error
      throw unavailable()
    } finally {
      encoded.fill(0)
    }
  }

  private async _requestEncoded(request: Buffer, retryTransport: boolean): Promise<VoiceWorkerIpcResponse> {
    try {
      return await this._decodeExchange(request)
    } catch (error) {
      if (!retryTransport || this._closed
        || !(error instanceof VoiceWorkerTransportError) || !error.retryable) throw error
      return this._decodeExchange(request)
    }
  }

  private async _decodeExchange(request: Buffer): Promise<VoiceWorkerIpcResponse> {
    const payload = await this._exchange(request)
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

  private _exchange(request: Buffer): Promise<Buffer> {
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
        this._sockets.delete(socket)
        socket.removeAllListeners()
        socket.destroy()
        if (error) reject(error)
        else resolve(response!)
      }
      const transportFailure = (retryable = connected) => new VoiceWorkerTransportError(retryable)
      const timer = setTimeout(() => finish(transportFailure(connected && received.length === 0)), this._timeoutMs)
      timer.unref()
      this._sockets.add(socket)
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
    } catch {
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
    } catch {
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
    } catch {
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
