import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import type { mtp, tl } from '@mtcute/core'
import type { Context } from 'cordis'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { typed, u8 } from '@fuman/utils'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import { createAesIgeForMessageOld } from '@mtcute/core/utils.js'
import { createHash } from 'node:crypto'
import Long from 'long'
import { ServerAuthKey } from './server-auth-key.js'
import { unpackPackedData } from './packed-data.js'
import type { AuthKeyStore, StoredAuthKey } from './auth-key-store.js'
import type { AuthKeyDataStore } from './auth-key-data-store.js'
import { ServerMessageIdGenerator } from './message-id.js'
import { doServerAuthorization, PqChallengeStore } from './server-authorization.js'
import type { ServerConnection } from '../transport/server-connection.js'
import { isBareVector, isRpcRequestObject, unwrapRpcRequest } from '../rpc/protocol.js'
import type { RpcHandler, ServerRpcContext, RpcResult, BareVector } from '../rpc/protocol.js'
import type { MtprotoPacketScope } from '../rpc/context.js'
import type { MtprotoClientInfo } from '../rpc/context.js'
import { getApiLayerWriterMap, resolveApiSchemaLayer, resolveApiSchemaProfile } from '../rpc/api-layer.js'
import type { MtprotoDebugEvent, MtprotoDebugListener } from '../debug.js'

// TL constructor IDs for MTProto service messages
const RPC_RESULT_ID = 0xF35C6D01
const BOOL_TRUE_ID = 0x997275B5
const BOOL_FALSE_ID = 0xBC799737
const GZIP_PACKED_ID = 0x3072CFA1
// Bare Vector<X> prefix (https://core.telegram.org/type/Vector%20X)
const VECTOR_ID = 0x1CB5C415
const MAX_GZIP_NESTING = 4
const MAX_SHARED_COMPLETED_MESSAGE_IDS = 16_384
const MAX_RPC_REPLAY_ENTRIES = 4_096
const MAX_RPC_REPLAY_BYTES = 32 * 1024 * 1024
const RPC_REPLAY_TTL_MS = 2 * 60 * 1_000
const MAX_SHARED_RPC_INFLIGHT = 512
const MAX_SHARED_RPC_INFLIGHT_PER_AUTH_KEY = 64
const MAX_ACTIVE_RPCS_PER_CONNECTION = 16
const MAX_PENDING_RPCS_PER_CONNECTION = 64
const RPC_READ_PAUSE_THRESHOLD = 32
const RPC_READ_RESUME_THRESHOLD = 16
const FRAME_READ_PAUSE_COUNT = 32
const FRAME_READ_RESUME_COUNT = 16
const FRAME_READ_PAUSE_BYTES = 4 * 1024 * 1024
const FRAME_READ_RESUME_BYTES = 2 * 1024 * 1024
const MAX_QUEUED_FRAMES = 128
const MAX_QUEUED_FRAME_BYTES = 16 * 1024 * 1024

interface RpcReply {
  reqMsgId: Long
  body: Uint8Array
  method?: string
  resultKind: string
  errorCode?: number
  errorMessage?: string
}

interface RpcReplayEntry {
  promise: Promise<RpcReply>
  completedAt: number | null
  bytes: number
}

class RpcReplayLimitError extends Error {
  constructor() {
    super('shared RPC replay registry is at capacity')
  }
}

class RpcConnectionClosedError extends Error {
  constructor() {
    super('MTProto connection closed while RPC was queued')
  }
}

/**
 * Tracks invokeAfterMsg dependencies across TCP connections that share the
 * same permanent auth key. Telegram Android may create a request on one
 * connection and resend it through another after reconnecting.
 */
export class RpcDependencyRegistry {
  private readonly _processing = new Map<string, Promise<void>>()
  private readonly _completed = new Map<string, true>()
  private readonly _replays = new Map<string, RpcReplayEntry>()
  private readonly _inFlightByAuth = new Map<string, number>()
  private readonly _startedAtSeconds = Math.floor(Date.now() / 1000)
  private _replayBytes = 0
  private _inFlight = 0
  private _generation = 0

  register(authKeyId: Uint8Array, msgId: Long, processing: Promise<void>): void {
    this._processing.set(this._key(authKeyId, msgId), processing)
  }

  complete(authKeyId: Uint8Array, msgId: Long, processing: Promise<void>): void {
    const key = this._key(authKeyId, msgId)
    if (this._processing.get(key) === processing) this._processing.delete(key)
    this._completed.delete(key)
    this._completed.set(key, true)
    while (this._completed.size > MAX_SHARED_COMPLETED_MESSAGE_IDS) {
      const oldest = this._completed.keys().next().value
      if (oldest === undefined) break
      this._completed.delete(oldest)
    }
  }

  processing(authKeyId: Uint8Array, msgId: Long): Promise<void> | undefined {
    return this._processing.get(this._key(authKeyId, msgId))
  }

  completed(authKeyId: Uint8Array, msgId: Long): boolean {
    if (this._completed.has(this._key(authKeyId, msgId))) return true
    // No request from before this process started can still be running here.
    // Android keeps invokeAfterMsg wrappers in its resend queue across relay
    // restarts, so treating those historical dependencies as satisfied lets
    // the actual request resume without weakening checks for current ids.
    return (msgId.high >>> 0) < this._startedAtSeconds
  }

  clear(): void {
    this._generation += 1
    this._processing.clear()
    this._completed.clear()
    this._replays.clear()
    this._inFlightByAuth.clear()
    this._replayBytes = 0
    this._inFlight = 0
  }

  /**
   * Coalesce the same RPC across reconnecting sockets and retain a bounded
   * serialized reply so a later retransmission can be answered without
   * executing the handler again.
   */
  execute(
    authKeyId: Uint8Array,
    msgId: Long,
    requestFingerprint: string,
    execute: () => Promise<RpcReply>,
  ): Promise<RpcReply> {
    const now = Date.now()
    this._pruneReplays(now)
    const key = `${this._key(authKeyId, msgId)}:${requestFingerprint}`
    const existing = this._replays.get(key)
    if (existing) {
      if (existing.completedAt !== null) {
        this._replays.delete(key)
        this._replays.set(key, existing)
      }
      return existing.promise
    }

    const authScope = this._authScope(authKeyId)
    if (
      this._inFlight >= MAX_SHARED_RPC_INFLIGHT
      || (this._inFlightByAuth.get(authScope) ?? 0) >= MAX_SHARED_RPC_INFLIGHT_PER_AUTH_KEY
    ) {
      throw new RpcReplayLimitError()
    }

    this._inFlight += 1
    const generation = this._generation
    this._inFlightByAuth.set(authScope, (this._inFlightByAuth.get(authScope) ?? 0) + 1)
    const entry: RpcReplayEntry = {
      completedAt: null,
      bytes: 0,
      promise: undefined as unknown as Promise<RpcReply>,
    }
    const promise = Promise.resolve().then(execute)
    entry.promise = promise
    this._replays.set(key, entry)

    void promise.then((reply) => {
      if (generation !== this._generation) return
      entry.completedAt = Date.now()
      entry.bytes = reply.body.byteLength
      this._replayBytes += entry.bytes
      this._replays.delete(key)
      this._replays.set(key, entry)
      this._pruneReplays(entry.completedAt)
    }, () => {
      if (generation !== this._generation) return
      this._deleteReplay(key, entry)
    }).finally(() => {
      if (generation !== this._generation) return
      this._inFlight -= 1
      const remaining = (this._inFlightByAuth.get(authScope) ?? 1) - 1
      if (remaining > 0) this._inFlightByAuth.set(authScope, remaining)
      else this._inFlightByAuth.delete(authScope)
    })
    return promise
  }

  private _pruneReplays(now: number): void {
    for (const [key, entry] of this._replays) {
      if (entry.completedAt === null) continue
      if (
        now - entry.completedAt <= RPC_REPLAY_TTL_MS
        && this._replays.size <= MAX_RPC_REPLAY_ENTRIES
        && this._replayBytes <= MAX_RPC_REPLAY_BYTES
      ) break
      this._deleteReplay(key, entry)
    }
  }

  private _deleteReplay(key: string, entry: RpcReplayEntry): void {
    if (this._replays.get(key) !== entry) return
    this._replays.delete(key)
    if (entry.completedAt !== null) this._replayBytes -= entry.bytes
  }

  private _authScope(authKeyId: Uint8Array): string {
    let scope = ''
    for (const byte of authKeyId) scope += byte.toString(16).padStart(2, '0')
    return scope
  }

  private _key(authKeyId: Uint8Array, msgId: Long): string {
    return `${this._authScope(authKeyId)}:${msgId.toString()}`
  }
}

class ResumeStoredAuthKey extends Error {
  constructor(
    readonly keyId: Uint8Array,
    readonly record: StoredAuthKey,
    readonly encryptedFrames: Uint8Array[],
  ) {
    super('resume stored auth key')
  }
}

class UnknownStoredAuthKey extends Error {
  constructor(readonly keyId: Uint8Array) {
    super('unknown or expired auth key')
  }
}

// A client may be authorized before its first invokeWithLayer request arrives.
// Keep this bounded because updates are only queued during that short handshake
// window and must not become an unbounded memory sink if a client disappears.
const MAX_PENDING_UPDATES = 256
// invokeAfterMsg references very recent request ids (Telegram Android only
// considers the previous five seconds). Keep a wider bounded history so a
// dependency that completed just before its wrapper was decoded is recognized.
const MAX_COMPLETED_MESSAGE_IDS = 4096
// These RPCs establish the platform identity stored behind an MTProto auth key.
// Calls received after one of them must not observe the old authorization
// state, but unrelated API calls may execute concurrently.
const AUTHORIZATION_TRANSITION_METHODS = new Set([
  'auth.bindTempAuthKey',
  'auth.signIn',
  'auth.importAuthorization',
  'auth.logOut',
  'auth.exportLoginToken',
  'auth.importLoginToken',
])

/** Serialize a Long to 8 little-endian bytes (matches an 8-byte auth key id). */
function longToBytesLE(v: Long): Uint8Array {
  const b = new Uint8Array(8)
  const dv = new DataView(b.buffer)
  dv.setInt32(0, v.low, true)
  dv.setInt32(4, v.high, true)
  return b
}

/** Serialize a bare Bool result (4-byte constructor id, little-endian). */
function boolBytes(value: boolean): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, value ? BOOL_TRUE_ID : BOOL_FALSE_ID, true)
  return b
}


/**
 * Server-side MTProto session — one per client connection.
 *
 * Lifecycle:
 * 1. On connect: run the DH handshake (unencrypted messages)
 * 2. After handshake: send `new_session_created`
 * 3. For each incoming encrypted message: decrypt → handle (container/rpc/service) → respond
 * 4. RPC calls are dispatched through the Cordis RPC event pipeline; responses are sent as `rpc_result`
 * 5. Updates can be pushed to the client at any time (after handshake)
 */
export class ServerSession {
  /** Permanent auth key, established by the first DH handshake. */
  private _permAuthKey: ServerAuthKey
  /**
   * Temporary (PFS) auth key, established by a second DH handshake on the same
   * connection and bound to the perm key via auth.bindTempAuthKey. Once present,
   * the client uses it for all encrypted traffic. Null until negotiated.
   */
  private _tempAuthKey: ServerAuthKey | null = null
  private _tempAuthKeyExpiresAt: number | null = null
  private _msgIdGen: ServerMessageIdGenerator
  private _sessionId: Long = Long.ZERO
  private _sessionIdSet = false
  private _serverSalt = Long.ZERO
  private _authorized = false
  private _loginTokenPending = false
  private _loginToken: Uint8Array | null = null
  private _loginTokenExpiresAt: number | null = null
  private _apiLayer: number | null = null
  private _clientInfo: MtprotoClientInfo | undefined
  private _responseWriterMap: TlWriterMap
  private _pendingUpdates: Array<{ update: tl.TypeUpdates, clientSessionId?: Long }> = []
  private _acceptsUpdates = false
  /** Session that last established an updates stream on this connection. */
  private _updateSessionId: Long | null = null
  private _queuedAcks = new Map<string, { sessionId: Long, msgIds: Long[], ids: Set<string> }>()
  private _scheduledAckFlushes = new Set<string>()
  private _futureSalts: { validSince: number, validUntil: number, salt: Long }[] = []
  private _msgHandler: ((data: Uint8Array) => void) | null = null
  /**
   * Handshake frames normally bypass the Cordis packet pipeline after the
   * first plaintext packet replaces the connection handler. Keep an ingress
   * reservation before entering that async pipeline as well: a fast client can
   * otherwise deliver another plaintext frame while the first packet is still
   * crossing middleware, causing two authorization state machines to own the
   * same socket and emit stale nonces indefinitely.
   */
  private _handshakeIngress: {
    pending: Uint8Array[]
    handler: ((data: Uint8Array) => void) | null
  } | null = null
  private _packetSequence = 0
  private _frameQueue: Uint8Array[] = []
  private _queuedFrameBytes = 0
  private _drainingFrames = false
  private _frameReadPaused = false
  private _authResume: { key: string, promise: Promise<boolean> } | null = null
  private _processingMessages = new Map<string, Promise<void>>()
  private _completedMessageIds = new Map<string, true>()
  private _activeRpcCount = 0
  private _rpcWaiters: Array<(release: (() => void) | null) => void> = []
  private _rpcReadPaused = false
  private _disposed = false
  // Only authorization transitions form a barrier. Serializing every API RPC
  // lets one slow history/download request stall all later calls while pings
  // still succeed, leaving Telegram with a deceptively half-alive connection.
  private _authorizationTransitionProcessing: Promise<void> = Promise.resolve()

  constructor(
    private readonly _context: Context,
    private readonly _connection: ServerConnection,
    private readonly _crypto: ICryptoProvider,
    private readonly _readerMap: TlReaderMap,
    private readonly _writerMap: TlWriterMap,
    private readonly _log: Logger,
    private readonly _rsaPrivateKeyPem: string,
    private readonly _rsaKeyFingerprint: Long,
    private readonly _dispatchRpc: RpcHandler,
    private readonly _authKeyData: AuthKeyDataStore,
    private readonly _keyStore?: AuthKeyStore,
    private readonly _debug?: MtprotoDebugListener,
    private readonly _onApiLayer?: (authKeyId: Uint8Array, layer: number) => void,
    private readonly _getApiLayer?: (authKeyId: Uint8Array) => number | undefined,
    private readonly _onLoginTokenIssued?: (authKeyId: Uint8Array, token: Uint8Array, origin: ServerConnection) => void,
    private readonly _dependencyRegistry?: RpcDependencyRegistry,
    private readonly _pqChallenges = new PqChallengeStore(),
  ) {
    this._permAuthKey = new ServerAuthKey(_crypto, _log, _readerMap)
    this._msgIdGen = new ServerMessageIdGenerator()
    this._responseWriterMap = _writerMap
    // Session ID is set from the client's first encrypted message (MTProto convention)
  }

  /** The auth key used to encrypt server→client messages: temp once bound, else perm. */
  private get _sendKey(): ServerAuthKey {
    return this._tempAuthKey?.ready ? this._tempAuthKey : this._permAuthKey
  }

  /**
   * Start the session: begin handshake when data arrives.
   */
  start(): void {
    if (this._msgHandler) return
    const onMsg = (data: Uint8Array) => {
      this._enqueueRawFrame(data)
    }
    this._msgHandler = onMsg
    this._context.effect(() => {
      const dispose = this._connection.listen(onMsg)
      return () => {
        this._disposed = true
        this._frameQueue = []
        this._queuedFrameBytes = 0
        this._releasePendingRpcWaiters()
        this._queuedAcks.clear()
        this._scheduledAckFlushes.clear()
        dispose()
        if (this._msgHandler === onMsg) this._msgHandler = null
      }
    }, 'mtproto.session.frames')
  }

  /**
   * Push a server-initiated update. RPC-local updates supply their originating
   * session explicitly; external pushes target the session that activated the
   * updates stream. Before that activation, retain the legacy latest-session
   * fallback so early post-login updates remain deliverable.
   */
  sendUpdate(update: tl.TypeUpdates, clientSessionId?: Long): void {
    this._clearExpiredLoginToken()
    if (!this._authorized || this._loginTokenPending) return
    const targetSessionId = clientSessionId
      ?? this._updateSessionId
      ?? (this._sessionIdSet ? this._sessionId : undefined)
    if (this._apiLayer === null) {
      if (this._pendingUpdates.length >= MAX_PENDING_UPDATES) {
        this._log.warn('client API layer was not negotiated before update queue overflow; closing connection')
        this._pendingUpdates = []
        this._connection.close()
        return
      }
      this._pendingUpdates.push({ update, clientSessionId: targetSessionId })
      this._log.debug('queued server update until client API layer is negotiated (pending=%d)', this._pendingUpdates.length)
      return
    }
    if (!targetSessionId) {
      this._log.debug('dropping server update before the client establishes an MTProto session')
      return
    }
    const serialized = TlBinaryWriter.serializeObject(this._responseWriterMap, update)
    this._sendEncryptedMessage(serialized, true, update, targetSessionId)
  }

  private _clearLoginToken(): void {
    this._loginTokenPending = false
    this._loginToken = null
    this._loginTokenExpiresAt = null
  }

  private _clearExpiredLoginToken(): void {
    if (this._loginTokenExpiresAt !== null && this._loginTokenExpiresAt <= Math.floor(Date.now() / 1_000)) {
      this._clearLoginToken()
    }
  }

  /** Clear a QR token superseded by an export on another connection. */
  supersedeLoginToken(token: Uint8Array): void {
    if (this._loginToken && !typed.equal(this._loginToken, token)) this._clearLoginToken()
  }

  /** Send the sole pre-authorization update required by the QR-login protocol. */
  sendLoginTokenUpdate(token: Uint8Array): boolean {
    this._clearExpiredLoginToken()
    if (
      !this._authorized
      || !this._loginTokenPending
      || !this._loginToken
      || !typed.equal(this._loginToken, token)
      || this._apiLayer === null
      || !this._sessionIdSet
      || this._connection.closed
    ) return false
    const update: tl.TypeUpdates = {
      _: 'updateShort', update: { _: 'updateLoginToken' }, date: Math.floor(Date.now() / 1_000),
    }
    const serialized = TlBinaryWriter.serializeObject(this._responseWriterMap, update)
    this._sendEncryptedMessage(serialized, true, update, this._sessionId)
    return true
  }

  get authKeyId(): Uint8Array | null {
    return this._permAuthKey.ready ? this._permAuthKey.id : null
  }

  get apiLayer(): number | null {
    return this._apiLayer
  }

  get acceptsUpdates(): boolean {
    return this._acceptsUpdates
  }

  get connection(): ServerConnection {
    return this._connection
  }

  /** Apply an API layer learned by another connection using the same auth key. */
  applyApiLayer(layer: number): void {
    this._setApiLayer(layer, false)
  }

  // ── Internal: data handling ──

  private _enqueueRawFrame(data: Uint8Array): void {
    if (this._disposed || this._connection.closed) return
    // A handshake owns the socket until DH authorization finishes. The normal
    // frame drain is deliberately single-file and is currently awaiting that
    // handshake, so queueing the next plaintext frame behind it deadlocks the
    // handshake's recvPlain() waiter. Route follow-up frames straight to the
    // handshake ingress instead; frames that arrive before its temporary
    // handler is installed remain buffered on the ingress reservation.
    const activeHandshake = this._handshakeIngress
    if (activeHandshake) {
      const owned = new Uint8Array(data)
      if (activeHandshake.handler) activeHandshake.handler(owned)
      else activeHandshake.pending.push(owned)
      return
    }
    if (
      this._frameQueue.length >= MAX_QUEUED_FRAMES
      || this._queuedFrameBytes + data.byteLength > MAX_QUEUED_FRAME_BYTES
    ) {
      this._log.warn(
        'incoming MTProto frame queue overflow (%d frames, %d bytes); closing connection',
        this._frameQueue.length,
        this._queuedFrameBytes,
      )
      this._connection.close()
      return
    }

    this._frameQueue.push(data)
    this._queuedFrameBytes += data.byteLength
    this._updateFrameReadPressure()
    if (!this._drainingFrames) void this._drainRawFrames()
  }

  private async _drainRawFrames(): Promise<void> {
    if (this._drainingFrames) return
    this._drainingFrames = true
    try {
      while (!this._disposed && !this._connection.closed) {
        const data = this._frameQueue.shift()
        if (!data) break
        this._queuedFrameBytes -= data.byteLength
        this._updateFrameReadPressure()
        try {
          await this._onRawData(data)
        } catch (err) {
          this._log.error('unhandled error in message processing: %s', err)
        }
      }
    } finally {
      this._drainingFrames = false
      this._updateFrameReadPressure()
      if (!this._disposed && !this._connection.closed && this._frameQueue.length) {
        void this._drainRawFrames()
      }
    }
  }

  private _updateFrameReadPressure(): void {
    if (
      !this._frameReadPaused
      && (
        this._frameQueue.length >= FRAME_READ_PAUSE_COUNT
        || this._queuedFrameBytes >= FRAME_READ_PAUSE_BYTES
      )
    ) {
      this._frameReadPaused = true
      this._connection.pauseReading()
    } else if (
      this._frameReadPaused
      && this._frameQueue.length <= FRAME_READ_RESUME_COUNT
      && this._queuedFrameBytes <= FRAME_READ_RESUME_BYTES
    ) {
      this._frameReadPaused = false
      if (!this._rpcReadPaused) this._connection.resumeReading()
    }
  }

  private async _onRawData(data: Uint8Array): Promise<void> {
    const activeHandshake = this._handshakeIngress
    if (activeHandshake) {
      if (activeHandshake.handler) activeHandshake.handler(data)
      else activeHandshake.pending.push(data)
      return
    }

    const keyId = data.subarray(0, 8)
    const mayEnterHandshake = !this._authorized || keyId.every(byte => byte === 0)
    const handshakeIngress = mayEnterHandshake
      ? { pending: [] as Uint8Array[], handler: null as ((data: Uint8Array) => void) | null }
      : null
    if (handshakeIngress) this._handshakeIngress = handshakeIngress

    const packet: MtprotoPacketScope = {
      connection: this._context.mtprotoConnection,
      sequence: ++this._packetSequence,
      data,
    }
    const packetCtx = this._context.extend({ mtprotoPacket: packet })
    try {
      await packetCtx.waterfall(
        packetCtx,
        'mtproto/packet',
        packet,
        () => this._processRawData(data, packetCtx),
      )
    } finally {
      if (handshakeIngress && this._handshakeIngress === handshakeIngress) {
        this._handshakeIngress = null
        for (const pending of handshakeIngress.pending.splice(0)) {
          this._onRawData(pending).catch((err) => {
            this._log.error('unhandled error in deferred message processing: %s', err)
          })
        }
      }
    }
  }

  private async _processRawData(data: Uint8Array, packetCtx: Context): Promise<void> {
    if (!this._authorized) {
      // Returning API and media connections may present either a permanent key
      // or a temporary PFS key before any plaintext handshake.
      const firstKeyId = data.subarray(0, 8)
      if (!firstKeyId.every(b => b === 0)) {
        if (await this._resumeStoredAuthKey(firstKeyId)) {
          await this._processRawData(data, packetCtx) // re-process this frame, now authorized
          return
        }
        this._sendAuthKeyNotFound(firstKeyId)
        return
      }
      await this._runHandshake(data, false)
      return
    }

    const keyId = data.subarray(0, 8)

    // A zero auth_key_id after the first handshake means the client is opening a
    // second plaintext handshake on the same connection to negotiate a PFS
    // temporary auth key (Telegram Desktop / TDLib always do this).
    if (keyId.every(b => b === 0)) {
      const object = new TlBinaryReader(this._readerMap, data, 20).object() as mtp.TlObject
      if (object._ === 'mt_msgs_ack') {
        this._capturePlain(data, 'client->server')
        this._log.debug('ignoring plaintext msgs_ack after handshake')
        return
      }
      if (this._tempAuthKey?.ready) {
        this._log.warn('unexpected plaintext frame after temp key established, ignoring')
        return
      }
      await this._runHandshake(data, true)
      return
    }

    const key = this._permAuthKey.match(keyId)
      ? this._permAuthKey
      : (this._tempAuthKey?.match(keyId) ? this._tempAuthKey : null)
    if (!key) {
      this._log.warn('received message with unknown auth key id: %h', keyId)
      return
    }

    // Accept messages on any session the client uses (a connection may carry
    // more than one, e.g. the PFS bind session vs the API session). We echo each
    // response on the session of the request it answers, so we never validate
    // against a single pinned session — just track the latest.
    key.decryptMessage(data, null, (msgId, seqNo, reader, clientSessionId) => {
      if (!this._sessionIdSet) this._sessionIdSet = true
      // Service frames must not wait behind slow RPC dispatches. The RPC path
      // retains this value and restores it immediately before dispatching.
      this._sessionId = clientSessionId
      this._handleDecryptedMessage(msgId, seqNo, reader, clientSessionId, packetCtx).catch((err) => {
        this._log.error('error handling message %s: %s', msgId.toString(16), err)
      })
    })
  }

  private _resumeStoredAuthKey(keyId: Uint8Array): Promise<boolean> {
    if (this._authorized) {
      return Promise.resolve(this._permAuthKey.match(keyId) || Boolean(this._tempAuthKey?.match(keyId)))
    }

    const key = Buffer.from(keyId).toString('hex')
    if (this._authResume) {
      if (this._authResume.key === key) return this._authResume.promise
      return this._authResume.promise.then(() => (
        this._permAuthKey.match(keyId) || Boolean(this._tempAuthKey?.match(keyId))
      ))
    }

    const promise = Promise.resolve().then(async () => {
      const stored = await this._keyStore?.get(keyId)
      return Boolean(stored && await this._adoptStoredAuthKey(keyId, stored))
    }).finally(() => {
      if (this._authResume?.promise === promise) this._authResume = null
    })
    this._authResume = { key, promise }
    return promise
  }

  /**
   * Run one DH handshake to completion over unencrypted messages.
   *
   * @param data    The first unencrypted frame that triggered the handshake.
   * @param isTemp  Whether this is a second handshake on an authorized socket.
   *                The key kind itself comes from p_q_inner_data(_temp)_dc.
   */
  private async _runHandshake(data: Uint8Array, isTemp: boolean): Promise<void> {
    this._log.verbose('%s handshake starting (%d bytes)', isTemp ? 'temp-key' : 'perm-key', data.length)

    const ingress = this._handshakeIngress ?? {
      pending: [] as Uint8Array[],
      handler: null as ((data: Uint8Array) => void) | null,
    }
    if (!this._handshakeIngress) this._handshakeIngress = ingress
    const unencryptedQueue: Uint8Array[] = [data]
    const encryptedFrames: Uint8Array[] = []
    let handshakeError: Error | null = null
    let resumeLookup: Promise<void> | null = null
    let waitingForMessage: {
      resolve: (data: Uint8Array) => void
      reject: (error: Error) => void
    } | null = null

    const interruptHandshake = (error: Error) => {
      handshakeError = error
      if (waitingForMessage) {
        const waiter = waitingForMessage
        waitingForMessage = null
        waiter.reject(error)
      }
    }

    const tempHandler = (msg: Uint8Array) => {
      // Telegram Desktop probes a media connection with req_pq, then reuses its
      // cached permanent or temporary key on that same socket. Pause the probe
      // handshake and resume only after the key store confirms the key id.
      const keyId = msg.subarray(0, 8)
      const encrypted = !keyId.every(b => b === 0)
      if (encrypted && !isTemp) {
        encryptedFrames.push(msg)
        if (!resumeLookup) {
          const storedKeyId = new Uint8Array(keyId)
          resumeLookup = Promise.resolve()
            .then(() => this._keyStore?.get(storedKeyId))
            .then((stored) => {
              if (!stored) {
                throw new UnknownStoredAuthKey(storedKeyId)
              }
              interruptHandshake(new ResumeStoredAuthKey(storedKeyId, stored, encryptedFrames))
            })
            .catch((err) => {
              const error = err instanceof Error ? err : new Error(String(err))
              interruptHandshake(error)
            })
        }
        return
      }

      // A single intermediate frame may contain multiple unencrypted messages.
      // Each unencrypted message: auth_key_id(8)=0 + msg_id(8) + length(4) + body.
      let offset = 0
      while (offset + 20 <= msg.length) {
        // Encrypted traffic during a PFS handshake cannot replace its already
        // established permanent key, so retain the previous strict behavior.
        let zeroKeyId = true
        for (let i = 0; i < 8; i++) {
          if (msg[offset + i] !== 0) { zeroKeyId = false; break }
        }
        if (!zeroKeyId) {
          this._log.warn('dropping encrypted frame during temp-key handshake (auth key id %h)', msg.subarray(offset, offset + 8))
          break
        }

        const dv = new DataView(msg.buffer, msg.byteOffset + offset)
        const length = dv.getUint32(16, true)
        const msgEnd = 20 + length
        if (offset + msgEnd > msg.length) break
        const single = msg.subarray(offset, offset + msgEnd)
        if (waitingForMessage) {
          const waiter = waitingForMessage
          waitingForMessage = null
          waiter.resolve(single)
        } else {
          unencryptedQueue.push(single)
        }
        offset += msgEnd
      }
    }

    let resumed: ResumeStoredAuthKey | null = null
    try {
      // Capture frames that reached the normal handler before this handshake
      // crossed the async packet middleware, then route all later frames here.
      ingress.handler = tempHandler
      for (const pending of ingress.pending.splice(0)) tempHandler(pending)

      const recvPlain = async (): Promise<Uint8Array> => {
        if (handshakeError) throw handshakeError
        if (unencryptedQueue.length > 0) {
          const value = unencryptedQueue.shift()!
          this._capturePlain(value, 'client->server')
          return value
        }
        return new Promise((resolve, reject) => {
          waitingForMessage = {
            resolve: (value) => {
              this._capturePlain(value, 'client->server')
              resolve(value)
            },
            reject,
          }
        })
      }

      const sendPlain = async (message: mtp.TlObject): Promise<void> => {
        const length = TlSerializationCounter.countNeededBytes(this._writerMap, message)
        const writer = TlBinaryWriter.alloc(this._writerMap, length + 20)
        const messageId = this._msgIdGen.getMessageId(false)
        writer.long(Long.ZERO)
        writer.long(messageId)
        writer.uint(length)
        writer.object(message)
        this._capture('server->client', 'handshake', message, { messageId })
        this._connection.send(writer.result())
      }

      const result = await doServerAuthorization(
        this._crypto,
        this._readerMap,
        this._writerMap,
        this._log,
        this._rsaPrivateKeyPem,
        this._rsaKeyFingerprint,
        sendPlain,
        recvPlain,
        this._pqChallenges,
      )

      this._msgIdGen.updateTimeOffset(result.timeOffset)

      if (isTemp && !result.temporary) {
        throw new Error('client requested a permanent key during a PFS handshake')
      }

      if (result.temporary) {
        // Desktop shares the PFS key across its API, upload, and download TCP
        // connections. A fresh media socket may create this key directly; its
        // permanent identity is loaded later from auth.bindTempAuthKey.
        this._tempAuthKey = new ServerAuthKey(this._crypto, this._log, this._readerMap)
        this._tempAuthKey.setup(result.authKey)
        this._tempAuthKeyExpiresAt = result.expiresAt ?? null
        this._serverSalt = result.serverSalt
        this._authorized = true
        this._log.info('temp-key (PFS) handshake complete, temp auth key id = %h', this._tempAuthKey.id)
      } else {
        this._permAuthKey.setup(result.authKey)
        this._serverSalt = result.serverSalt
        this._authorized = true
        this._log.info('handshake complete, auth key id = %h', this._permAuthKey.id)
        // Persist the perm key so a returning client can resume without re-handshaking.
        try {
          await this._keyStore?.save(this._permAuthKey.id, { key: result.authKey })
        } catch (err) {
          this._log.warn('failed to persist auth key: %s', err instanceof Error ? err.message : err)
        }
      }

      // Generate initial future salts once, before the first encrypted message.
      if (this._futureSalts.length === 0) {
        this._generateFutureSalts()
      }

      // Note: new_session_created is sent after the first encrypted message
      // is received, because we need the client's session ID (captured from
      // the first message) to encrypt it correctly.
    } catch (err) {
      if (err instanceof ResumeStoredAuthKey) {
        resumed = err
      } else if (err instanceof UnknownStoredAuthKey) {
        this._sendAuthKeyNotFound(err.keyId)
      } else {
        this._log.error('%s handshake failed: %s', isTemp ? 'temp-key' : 'perm-key', err instanceof Error ? err.stack : err)
        this._connection.close()
      }
    } finally {
      ingress.handler = null
    }

    if (resumed) {
      if (!await this._adoptStoredAuthKey(resumed.keyId, resumed.record)) {
        this._sendAuthKeyNotFound(resumed.encryptedFrames[0].subarray(0, 8))
        return
      }
      for (const frame of resumed.encryptedFrames) {
        await this._onRawData(frame)
      }
    }
  }

  private async _adoptStoredAuthKey(keyId: Uint8Array, record: StoredAuthKey): Promise<boolean> {
    if (record.permanentKeyId) {
      const temporary = await this._keyStore?.get(keyId)
      if (!temporary || !temporary.permanentKeyId || !typed.equal(temporary.permanentKeyId, record.permanentKeyId)) {
        return false
      }
      // This is the final await before adopting either key. A durable tombstone
      // makes this lookup fail, so no revoked record can be installed afterward.
      const permanent = await this._keyStore?.get(temporary.permanentKeyId)
      if (!permanent || permanent.permanentKeyId) return false
      this._permAuthKey.setup(permanent.key)
      this._tempAuthKey = new ServerAuthKey(this._crypto, this._log, this._readerMap)
      this._tempAuthKey.setup(temporary.key)
      this._tempAuthKeyExpiresAt = temporary.expiresAt ?? null
      this._log.info(
        'resumed temporary auth key %h for permanent key %h',
        this._tempAuthKey.id,
        this._permAuthKey.id,
      )
      this._generateFutureSalts()
      this._authorized = true
      if (permanent.apiLayer !== undefined) this._setApiLayer(permanent.apiLayer, false)
      return true
    }

    // This final lookup closes the race with durable revocation for a permanent key.
    const permanent = await this._keyStore?.get(keyId)
    if (!permanent || permanent.permanentKeyId || !typed.equal(permanent.key, record.key)) return false
    this._permAuthKey.setup(permanent.key)
    this._log.info('resumed permanent auth key %h', this._permAuthKey.id)
    this._generateFutureSalts()
    this._authorized = true
    if (permanent.apiLayer !== undefined) this._setApiLayer(permanent.apiLayer, false)
    return true
  }

  private _sendAuthKeyNotFound(keyId: Uint8Array): void {
    this._log.warn('client presented unknown or expired auth key id %h; sending -404', keyId)
    const error = new Uint8Array(4)
    new DataView(error.buffer).setInt32(0, -404, true)
    this._connection.sendAndClose(error)
  }

  private async _handleDecryptedMessage(
    msgId: Long,
    seqNo: number,
    reader: TlBinaryReader,
    clientSessionId: Long = this._sessionId,
    packetCtx: Context = this._context,
  ): Promise<void> {
    const key = msgId.toString()
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    this._processingMessages.set(key, completion)
    const dependencyAuthKeyId = this._permAuthKey.ready ? this._permAuthKey.id : null
    if (dependencyAuthKeyId) {
      this._dependencyRegistry?.register(dependencyAuthKeyId, msgId, completion)
    }

    try {
      await this._processDecryptedMessage(msgId, seqNo, reader, clientSessionId, packetCtx)
    } finally {
      if (this._processingMessages.get(key) === completion) {
        this._processingMessages.delete(key)
      }
      this._rememberCompletedMessage(key)
      if (dependencyAuthKeyId) {
        this._dependencyRegistry?.complete(dependencyAuthKeyId, msgId, completion)
      }
      resolveCompletion()
    }
  }

  private async _processDecryptedMessage(
    msgId: Long,
    seqNo: number,
    reader: TlBinaryReader,
    clientSessionId: Long,
    packetCtx: Context = this._context,
  ): Promise<void> {
    this._msgIdGen.observeClientMsgId(msgId)

    let obj: { _: string }
    let gzipNesting = 0

    // Both gzip_packed and msg_container are transport envelopes. TDLib can
    // place compressed requests inside a container and can nest gzip_packed,
    // so unwrap envelopes until an ordinary API/service object is reached.
    for (;;) {
      const savedPos = reader.pos
      const constructorId = reader.uint()

      if (constructorId === 0x73f1f8dc) {
        // msg_container: vector of { msg_id, seqno, length, body }
        const count = reader.uint()
        this._capture('client->server', 'message', { _: 'msg_container', count }, {
          messageId: msgId,
          seqNo,
        })
        const processing: Promise<void>[] = []
        for (let i = 0; i < count; i++) {
          const innerMsgId = reader.long(true)
          const innerSeqNo = reader.uint()
          const innerLength = reader.uint()
          const innerBody = reader.raw(innerLength)
          const innerReader = new TlBinaryReader(this._readerMap, innerBody)
          processing.push(
            this._handleDecryptedMessage(innerMsgId, innerSeqNo, innerReader, clientSessionId, packetCtx)
              .catch((error) => {
                this._handleContainerMessageError(innerMsgId, innerSeqNo, innerBody, error, clientSessionId)
              }),
          )
        }
        // A container is a transport batch, not an execution queue. Android
        // groups independent upload.getFile calls in one container; awaiting
        // each handler in wire order lets one slow or wedged asset prevent all
        // following media and reaction resources from receiving a response.
        await Promise.all(processing)
        return
      }

      if (constructorId === GZIP_PACKED_ID) {
        if (gzipNesting >= MAX_GZIP_NESTING) {
          throw new Error(`gzip_packed nesting exceeds ${MAX_GZIP_NESTING}`)
        }
        const packedData = reader.bytes()
        const unpacked = unpackPackedData(packedData)
        reader = new TlBinaryReader(this._readerMap, unpacked)
        gzipNesting += 1
        continue
      }

      // Not a transport envelope — restore position and read normally.
      reader.pos = savedPos
      break
    }

    obj = this._unwrapGzipQueries(reader.object() as { _: string }, gzipNesting)
    const objId = obj._

    this._capture('client->server', 'message', obj, { messageId: msgId, seqNo })

    this._log.verbose('<<< %s (msg_id=%s, seq=%d)', objId, msgId.toString(16), seqNo)

    if (!this._isNoAckMessage(objId)) {
      this._queueAck(msgId, clientSessionId)
    }

    switch (objId) {
      case 'mt_ping':
        this._handlePing(msgId, obj as unknown as mtp.RawMt_ping, clientSessionId)
        break

      case 'mt_ping_delay_disconnect':
        this._handlePingDelayDisconnect(
          msgId,
          obj as unknown as mtp.RawMt_ping_delay_disconnect,
          clientSessionId,
        )
        break

      case 'mt_msgs_ack':
        break

      case 'mt_get_future_salts':
        this._handleGetFutureSalts(msgId, obj as unknown as mtp.RawMt_get_future_salts, clientSessionId)
        break

      case 'mt_rpc_drop_answer':
        this._handleRpcDropAnswer(msgId, obj as unknown as mtp.RawMt_rpc_drop_answer)
        break

      case 'mt_msgs_state_req':
        this._handleMsgsStateReq(msgId, obj as unknown as mtp.RawMt_msgs_state_req, clientSessionId)
        break

      case 'mt_destroy_session':
        this._handleDestroySession(msgId, obj as unknown as mtp.RawMt_destroy_session, clientSessionId)
        break

      case 'mt_destroy_auth_key':
        this._handleDestroyAuthKey(msgId, clientSessionId)
        break

      case 'auth.bindTempAuthKey':
        await this._enqueueRpcCall(msgId, obj as unknown as tl.RpcMethod, clientSessionId, packetCtx)
        break

      default:
        if (isRpcRequestObject(objId)) {
          await this._enqueueRpcCall(msgId, obj as unknown as tl.RpcMethod, clientSessionId, packetCtx)
        } else if ((seqNo & 1) !== 0) {
          const errorMessage = `METHOD_NOT_IMPLEMENTED: ${objId}`
          this._log.error(
            'unhandled content-related message type %s (msg_id=%s, seq=%d); returning rpc_error',
            objId,
            msgId.toString(16),
            seqNo,
          )
          this._sendRpcResult(msgId, {
            _: 'mt_rpc_error',
            errorCode: 500,
            errorMessage,
          } as mtp.RawMt_rpc_error, objId, clientSessionId)
        } else {
          this._log.warn(
            'unhandled non-content message type %s (msg_id=%s, seq=%d)',
            objId,
            msgId.toString(16),
            seqNo,
          )
        }
    }

    this._flushAcks(clientSessionId)
  }

  private _unwrapGzipQueries(obj: { _: string }, gzipNesting: number): { _: string } {
    if (obj._ === 'gzip_packed') {
      if (gzipNesting >= MAX_GZIP_NESTING) {
        throw new Error(`gzip_packed nesting exceeds ${MAX_GZIP_NESTING}`)
      }
      const packedData = (obj as unknown as { packedData: Uint8Array }).packedData
      const unpacked = unpackPackedData(packedData)
      const unpackedObject = new TlBinaryReader(this._readerMap, unpacked).object() as { _: string }
      return this._unwrapGzipQueries(unpackedObject, gzipNesting + 1)
    }

    const wrapper = obj as unknown as { query?: { _: string } }
    if (wrapper.query && typeof wrapper.query === 'object' && typeof wrapper.query._ === 'string') {
      return {
        ...obj,
        query: this._unwrapGzipQueries(wrapper.query, gzipNesting),
      } as { _: string }
    }
    return obj
  }

  /**
   * A msg_container is only a transport batch. One malformed or unsupported
   * inner RPC must not discard its siblings (Telegram Android commonly batches
   * background probes together with user-visible requests such as sendMessage).
   */
  private _handleContainerMessageError(
    msgId: Long,
    seqNo: number,
    body: Uint8Array,
    error: unknown,
    clientSessionId: Long,
  ): void {
    const constructorId = body.length >= 4
      ? new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true)
      : null
    const constructor = constructorId === null
      ? 'truncated'
      : `0x${constructorId.toString(16).padStart(8, '0')}`
    const message = error instanceof Error ? error.message : String(error)
    this._log.error(
      'error handling container message %s (constructor=%s, seq=%d): %s',
      msgId.toString(16),
      constructor,
      seqNo,
      message,
    )
    this._capture('client->server', 'message', {
      _: 'unparsed', constructorId, bytes: body.length,
    }, { messageId: msgId, seqNo, error: message })

    if ((seqNo & 1) === 0) return
    this._queueAck(msgId, clientSessionId)
    try {
      this._sendRpcResult(msgId, {
        _: 'mt_rpc_error',
        errorCode: 400,
        errorMessage: 'METHOD_INVALID',
      } as mtp.RawMt_rpc_error, constructor, clientSessionId)
    } catch (sendError) {
      this._log.error(
        'failed to return METHOD_INVALID for container message %s: %s',
        msgId.toString(16),
        sendError instanceof Error ? sendError.message : String(sendError),
      )
    }
  }

  // ── Service message handlers ──

  private _handlePing(msgId: Long, ping: mtp.RawMt_ping, clientSessionId: Long): void {
    const pong: mtp.RawMt_pong = {
      _: 'mt_pong',
      msgId,
      pingId: ping.pingId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, pong)
    this._sendEncryptedMessage(serialized, true, pong, clientSessionId)
  }

  private _handlePingDelayDisconnect(
    msgId: Long,
    ping: mtp.RawMt_ping_delay_disconnect,
    clientSessionId: Long,
  ): void {
    const pong: mtp.RawMt_pong = {
      _: 'mt_pong',
      msgId,
      pingId: ping.pingId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, pong)
    this._sendEncryptedMessage(serialized, true, pong, clientSessionId)
  }

  private _handleGetFutureSalts(
    msgId: Long,
    req: mtp.RawMt_get_future_salts,
    clientSessionId: Long,
  ): void {
    // Ensure future salts are generated
    if (this._futureSalts.length === 0) {
      this._generateFutureSalts()
    }

    const now = Math.floor(Date.now() / 1000)
    const num = req.num ?? 64
    const count = Math.min(num, this._futureSalts.length)
    const salts: mtp.RawMt_future_salt[] = []
    for (let i = 0; i < count; i++) {
      const s = this._futureSalts[i]
      salts.push({
        _: 'mt_future_salt' as const,
        validSince: s.validSince,
        validUntil: s.validUntil,
        salt: s.salt,
      })
    }

    this._log.debug('get_future_salts: num=%d, returning %d salts, first=%j', num, salts.length, salts[0])

    const response: mtp.RawMt_future_salts = {
      _: 'mt_future_salts' as const,
      reqMsgId: msgId,
      now,
      salts,
    }

    try {
      // Manually serialize mt_future_salts — the generated writer has a bug
      // with bare vectors that makes TlSerializationCounter crash.
      // Format: constructor_id(4) + req_msg_id(8) + now(4) + count(4) + salts[]
      // Each salt: valid_since(4) + valid_until(4) + salt(8) = 16 bytes (bare, no constructor id)
      const size = 4 + 8 + 4 + 4 + salts.length * 16
      const writer = TlBinaryWriter.manual(size)
      writer.uint(0xAE500895) // mt_future_salts constructor id
      writer.long(msgId)
      writer.uint(now)
      writer.uint(salts.length) // bare vector: just count, no 0x1CB5C415 prefix
      for (const s of salts) {
        writer.uint(s.validSince)
        writer.uint(s.validUntil)
        writer.long(s.salt)
      }
      this._sendEncryptedMessage(writer.result(), false, response, clientSessionId)
    } catch (e) {
      this._log.error('failed to serialize future_salts: %s', e)
    }
  }

  private _handleMsgsStateReq(
    msgId: Long,
    req: mtp.RawMt_msgs_state_req,
    clientSessionId: Long,
  ): void {
    const info = new Uint8Array(req.msgIds.length)
    info.fill(0x01)

    const response: mtp.RawMt_msgs_state_info = {
      _: 'mt_msgs_state_info',
      reqMsgId: msgId,
      info,
    }

    const serialized = TlBinaryWriter.serializeObject(this._writerMap, response)
    this._sendEncryptedMessage(serialized, false, response, clientSessionId)
  }

  private _handleDestroySession(
    msgId: Long,
    req: mtp.RawMt_destroy_session,
    clientSessionId: Long,
  ): void {
    const response: mtp.RawMt_destroy_session_ok = {
      _: 'mt_destroy_session_ok',
      sessionId: req.sessionId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, response)
    this._sendEncryptedMessage(serialized, false, response, clientSessionId)
  }

  private _handleDestroyAuthKey(_msgId: Long, clientSessionId: Long): void {
    const response: mtp.RawMt_destroy_auth_key_ok = {
      _: 'mt_destroy_auth_key_ok',
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, response)
    this._sendEncryptedMessage(serialized, false, response, clientSessionId)
  }

  /**
   * Handle auth.bindTempAuthKey — binds the temporary (PFS) key to the permanent
   * key. The request arrives encrypted with the temp key; its `encryptedMessage`
   * is a `bind_auth_key_inner` sealed with the *permanent* key using the old
   * MTProto message encryption. Verify the requested permanent key before making
   * it this session's identity or persisting the temporary-key association.
   */
  private async _handleBindTempAuthKey(
    _msgId: Long,
    req: tl.auth.RawBindTempAuthKeyRequest,
    _clientSessionId: Long,
    apiLayer: number | null = null,
  ): Promise<RpcResult> {
    const permanentId = longToBytesLE(req.permAuthKeyId)
    let candidate: ServerAuthKey | null = this._permAuthKey.match(permanentId)
      ? this._permAuthKey
      : null
    let storedPermanent: StoredAuthKey | undefined

    if (!candidate) {
      try {
        storedPermanent = await this._keyStore?.get(permanentId)
      } catch (err) {
        this._log.warn('failed to load permanent auth key for temp-key binding: %s', err instanceof Error ? err.message : err)
        return {
          _: 'mt_rpc_error',
          errorCode: 500,
          errorMessage: 'INTERNAL',
        } as mtp.RawMt_rpc_error
      }
      if (storedPermanent && !storedPermanent.permanentKeyId) {
        const storedCandidate = new ServerAuthKey(this._crypto, this._log, this._readerMap)
        storedCandidate.setup(storedPermanent.key)
        if (storedCandidate.match(permanentId)) candidate = storedCandidate
      }
    }

    if (!candidate || !this._verifyBindInner(req, candidate)) {
      this._log.warn('bindTempAuthKey verification failed')
      return {
        _: 'mt_rpc_error',
        errorCode: 400,
        errorMessage: 'ENCRYPTED_MESSAGE_INVALID',
      } as mtp.RawMt_rpc_error
    }

    try {
      await this._keyStore?.save(this._tempAuthKey!.id, {
        key: this._tempAuthKey!.key,
        permanentKeyId: new Uint8Array(candidate.id),
        expiresAt: req.expiresAt,
      })
    } catch (err) {
      this._log.warn('failed to persist bound temp auth key: %s', err instanceof Error ? err.message : err)
      return {
        _: 'mt_rpc_error',
        errorCode: 500,
        errorMessage: 'INTERNAL',
      } as mtp.RawMt_rpc_error
    }

    if (candidate !== this._permAuthKey) {
      // The temp-key save may yield long enough for another connection to
      // tombstone this permanent identity. Make this the final await before
      // installing the stored key on the PFS session.
      const revalidated = await this._keyStore?.get(permanentId)
      if (!revalidated || revalidated.permanentKeyId || !typed.equal(revalidated.key, candidate.key)) {
        this._connection.close()
        return {
          _: 'mt_rpc_error',
          errorCode: 401,
          errorMessage: 'AUTH_KEY_UNREGISTERED',
        } as mtp.RawMt_rpc_error
      }
      this._permAuthKey.setup(revalidated.key)
      if (revalidated.apiLayer !== undefined) this._setApiLayer(revalidated.apiLayer, false)
      this._log.info('loaded permanent key %h for temp-key binding', this._permAuthKey.id)
    }
    if (apiLayer !== null) this._setApiLayer(apiLayer)
    this._log.info('temp key bound to perm key (temp id = %h)', this._tempAuthKey?.id)
    return { _: 'boolTrue' }
  }

  /** Decrypt and verify the `encrypted_message` from auth.bindTempAuthKey. */
  private _verifyBindInner(req: tl.auth.RawBindTempAuthKeyRequest, permanent: ServerAuthKey): boolean {
    try {
      if (!permanent.ready || !this._tempAuthKey?.ready) return false

      const enc = req.encryptedMessage
      if (enc.length < 24 + 16) return false

      const keyId = enc.subarray(0, 8)
      if (!typed.equal(keyId, permanent.id)) {
        this._log.warn('bindTempAuthKey: encrypted_message key id %h != perm key id %h', keyId, permanent.id)
        return false
      }

      const msgKey = enc.subarray(8, 24)
      const encData = enc.subarray(24)
      // The client encrypts with the OLD MTProto message scheme, client=true.
      const ige = createAesIgeForMessageOld(this._crypto, permanent.key, msgKey, true)
      const dec = ige.decrypt(encData)
      if (dec.length < 32) return false

      // Layout: random(16) + msg_id(8) + seq_no(4) + length(4) + bind_auth_key_inner + padding
      const dv = typed.toDataView(dec)
      const innerLen = dv.getUint32(28, true)
      const msgEnd = 32 + innerLen
      if (msgEnd > dec.length) return false

      // msg_key = SHA1(message without padding)[4:20]
      const expectedMsgKey = this._crypto.sha1(dec.subarray(0, msgEnd)).subarray(4, 20)
      if (!typed.equal(msgKey, expectedMsgKey)) {
        this._log.warn('bindTempAuthKey: inner msg_key mismatch')
        return false
      }

      const inner = new TlBinaryReader(this._readerMap, dec, 32).object() as mtp.TlObject
      if (inner._ !== 'mt_bind_auth_key_inner') {
        this._log.warn('bindTempAuthKey: unexpected inner object %s', inner._)
        return false
      }
      const bind = inner as mtp.RawMt_bind_auth_key_inner

      const tempIdOk = typed.equal(longToBytesLE(bind.tempAuthKeyId), this._tempAuthKey.id)
      const permIdOk = typed.equal(longToBytesLE(bind.permAuthKeyId), permanent.id)
      const nonceOk = bind.nonce.eq(req.nonce)
      const expiryOk = bind.expiresAt === req.expiresAt
        && req.expiresAt > Math.floor(Date.now() / 1000)
      if (!tempIdOk || !permIdOk || !nonceOk || !expiryOk) {
        this._log.warn(
          'bindTempAuthKey: field mismatch (temp=%s perm=%s nonce=%s expiry=%s)',
          tempIdOk,
          permIdOk,
          nonceOk,
          expiryOk,
        )
        return false
      }
      return true
    } catch (err) {
      this._log.warn('bindTempAuthKey: verification error: %s', err instanceof Error ? err.message : err)
      return false
    }
  }

  // ── RPC call handling ──

  /**
   * Commit authorization transitions in wire order. Ordinary RPCs wait for the
   * transitions that arrived before them, then execute independently; explicit
   * invokeAfterMsg dependencies are enforced by _waitForRpcDependencies.
   */
  private async _enqueueRpcCall(
    msgId: Long,
    request: tl.RpcMethod,
    clientSessionId: Long,
    packetCtx: Context = this._context,
  ): Promise<void> {
    const method = unwrapRpcRequest(request).request._
    if (AUTHORIZATION_TRANSITION_METHODS.has(method)) {
      const scheduled = this._authorizationTransitionProcessing.then(
        () => this._handleRpcCall(msgId, request, clientSessionId, packetCtx),
      )
      this._authorizationTransitionProcessing = scheduled.catch((err) => {
        this._log.error('error handling RPC message %s: %s', msgId.toString(16), err)
      })
      await scheduled
      return
    }

    const precedingAuthorizationTransitions = this._authorizationTransitionProcessing
    await precedingAuthorizationTransitions
    await this._handleRpcCall(msgId, request, clientSessionId, packetCtx)
  }

  private async _handleRpcCall(
    msgId: Long,
    request: tl.RpcMethod,
    clientSessionId: Long,
    packetCtx: Context = this._context,
  ): Promise<void> {
    if (this._connection.closed) return
    const unwrapped = unwrapRpcRequest(request)
    const method = unwrapped.request._
    const now = Date.now()
    if (unwrapped.clientInfo) {
      this._clientInfo = unwrapped.clientInfo
      this._context.mtprotoConnection.clientInfo = unwrapped.clientInfo
    }
    this._context.mtprotoConnection.lastActiveAt = now
    if (method !== 'auth.bindTempAuthKey') {
      if (
        method === 'updates.getState'
        || method === 'updates.getDifference'
        || method === 'updates.getChannelDifference'
      ) {
        this._acceptsUpdates = true
        this._updateSessionId = clientSessionId
      }
      if (unwrapped.apiLayer !== null) {
        this._setApiLayer(unwrapped.apiLayer)
      } else if (this._apiLayer === null && this._permAuthKey.ready) {
        const inherited = this._getApiLayer?.(this._permAuthKey.id)
        if (inherited !== undefined) this._setApiLayer(inherited, false)
      }
    }

    let debugResult: RpcResult | undefined
    const afterResponse: Array<() => void | Promise<void>> = []
    const afterResponseSettled: Array<() => void | Promise<void>> = []
    const execute = async (): Promise<RpcReply> => {
      const release = await this._acquireRpcSlot()
      if (!release) {
        if (this._disposed || this._connection.closed) throw new RpcConnectionClosedError()
        debugResult = {
          _: 'mt_rpc_error', errorCode: 500, errorMessage: 'SERVER_BUSY',
        } as mtp.RawMt_rpc_error
        return this._buildRpcReply(msgId, debugResult, method)
      }
      try {
        const result = await this._executeRpcCall(
          msgId, unwrapped, clientSessionId, packetCtx, now, afterResponse, afterResponseSettled,
        )
        const resultKind = (result as { _: string })._
        if (method === 'auth.exportLoginToken' && resultKind === 'auth.loginToken') {
          this._loginTokenPending = true
          this._loginToken = new Uint8Array((result as { token: Uint8Array }).token)
          this._loginTokenExpiresAt = (result as { expires: number }).expires
          this._onLoginTokenIssued?.(this._permAuthKey.id, this._loginToken, this._connection)
        } else if (resultKind === 'auth.authorization' || resultKind === 'auth.loginTokenSuccess') {
          this._clearLoginToken()
        }
        debugResult = result
        return this._buildRpcReply(msgId, result, method)
      } finally {
        release()
      }
    }

    let reply: RpcReply
    try {
      const authKeyId = this._permAuthKey.ready ? this._permAuthKey.id : null
      // Binding a fresh temporary key mutates this connection's crypto state and
      // therefore cannot be replayed from another socket's execution.
      reply = authKeyId && method !== 'auth.bindTempAuthKey' && this._dependencyRegistry
        ? await this._dependencyRegistry.execute(authKeyId, msgId, this._rpcFingerprint(request), execute)
        : await execute()
    } catch (error) {
      if (error instanceof RpcConnectionClosedError) return
      if (!(error instanceof RpcReplayLimitError)) throw error
      this._log.warn('shared RPC replay registry is full; rejecting %s', method)
      debugResult = {
        _: 'mt_rpc_error', errorCode: 500, errorMessage: 'SERVER_BUSY',
      } as mtp.RawMt_rpc_error
      reply = this._buildRpcReply(msgId, debugResult, method)
    }

    let responseSettled: Promise<unknown> | undefined
    if (!this._connection.closed) {
      responseSettled = this._sendRpcReply(
        reply, clientSessionId, debugResult, reply.resultKind !== 'mt_rpc_error',
      )
      if (reply.resultKind !== 'mt_rpc_error') {
        for (const task of afterResponse) {
          try {
            await task()
          } catch (error) {
            this._log.error(
              'after-response task failed for %s: %s',
              method,
              error instanceof Error ? error.stack ?? error.message : error,
            )
          }
        }
      }
    }
    if (reply.resultKind !== 'mt_rpc_error') {
      await responseSettled
      for (const task of afterResponseSettled) {
        try {
          await task()
        } catch (error) {
          this._log.error(
            'after-response-settled task failed for %s: %s',
            method,
            error instanceof Error ? error.stack ?? error.message : error,
          )
        }
      }
    }
  }

  private async _executeRpcCall(
    msgId: Long,
    unwrapped: ReturnType<typeof unwrapRpcRequest>,
    clientSessionId: Long,
    packetCtx: Context,
    now: number,
    afterResponse: Array<() => void | Promise<void>>,
    afterResponseSettled: Array<() => void | Promise<void>>,
  ): Promise<RpcResult> {

    // A wrapped bind must prove the requested permanent identity before its
    // invokeWithLayer value can affect this session. The bare form is handled
    // in _processDecryptedMessage; wrapped binds arrive here after unwrapping.
    if (unwrapped.request._ === 'auth.bindTempAuthKey') {
      return this._handleBindTempAuthKey(
        msgId,
        unwrapped.request as tl.auth.RawBindTempAuthKeyRequest,
        clientSessionId,
        unwrapped.apiLayer,
      )
    }

    // invokeWithLayer is the one authoritative source of the client's API layer.
    // Capture it on the MTProto session before constructing the handler context
    // or serializing this request's response. Later unwrapped requests reuse it.
    if (this._apiLayer === null) {
      // The API layer is not part of the DH handshake and cannot be inferred
      // from a bare RPC. Telegram clients retry this request after receiving
      // CONNECTION_NOT_INITED with invokeWithLayer(initConnection(...)).
      return {
        _: 'mt_rpc_error',
        errorCode: 400,
        errorMessage: 'CONNECTION_NOT_INITED',
      } as mtp.RawMt_rpc_error
    }

    if (!await this._waitForRpcDependencies(msgId, unwrapped.afterMessageIds)) {
      return {
        _: 'mt_rpc_error',
        errorCode: 500,
        errorMessage: 'MSG_WAIT_FAILED',
      } as mtp.RawMt_rpc_error
    }
    // The connection fiber is disposed as soon as its socket closes. Requests
    // released from an authorization/dependency queue after that point cannot
    // deliver a result and must not try to create an RPC child fiber from the
    // now-inactive packet context.
    if (this._connection.closed) {
      throw new RpcConnectionClosedError()
    }

    const ctx = packetCtx.extend({
      mtprotoRpc: {
        connection: this._context.mtprotoConnection,
        request: unwrapped.request,
        messageId: msgId,
        receivedAt: now,
      },
      connection: this._connection,
      apiLayer: this._apiLayer,
      clientInfo: this._clientInfo,
      connectedAt: this._context.mtprotoConnection.connectedAt,
      lastActiveAt: now,
      authKeyId: this._permAuthKey.ready ? new Uint8Array(this._permAuthKey.id) : null,
      sessionId: clientSessionId,
      isAuthorized: this._authorized,
      sendUpdate: (update) => this.sendUpdate(update, clientSessionId),
      afterResponse: (task) => afterResponse.push(task),
      afterResponseSettled: (task) => afterResponseSettled.push(task),
      getPlatformData: <T>() => this._authKeyData.get<T>(this._permAuthKey.ready ? this._permAuthKey.id : null) as T,
      setPlatformData: (data) => this._authKeyData.set(this._permAuthKey.ready ? this._permAuthKey.id : null, data),
    }) as unknown as ServerRpcContext

    try {
      return await this._dispatchRpc(ctx, unwrapped.request)
    } catch (err) {
      this._log.error('RPC dispatch error for %s: %s', unwrapped.request._, err instanceof Error ? err.stack : err)
      return {
        _: 'mt_rpc_error',
        errorCode: 500,
        errorMessage: 'INTERNAL',
      } as mtp.RawMt_rpc_error
    }
  }

  private _acquireRpcSlot(): Promise<(() => void) | null> {
    if (this._disposed || this._connection.closed) return Promise.resolve(null)
    if (this._activeRpcCount < MAX_ACTIVE_RPCS_PER_CONNECTION) {
      this._activeRpcCount += 1
      return Promise.resolve(this._rpcSlotRelease())
    }
    if (this._rpcWaiters.length >= MAX_PENDING_RPCS_PER_CONNECTION) {
      this._log.warn(
        'per-connection RPC queue overflow (%d active, %d pending)',
        this._activeRpcCount,
        this._rpcWaiters.length,
      )
      return Promise.resolve(null)
    }
    if (!this._rpcReadPaused && this._rpcWaiters.length >= RPC_READ_PAUSE_THRESHOLD) {
      this._rpcReadPaused = true
      this._connection.pauseReading()
    }
    return new Promise(resolve => this._rpcWaiters.push(resolve))
  }

  private _rpcSlotRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this._rpcWaiters.shift()
      if (next && !this._disposed && !this._connection.closed) {
        next(this._rpcSlotRelease())
      } else {
        this._activeRpcCount = Math.max(0, this._activeRpcCount - 1)
        next?.(null)
      }
      if (this._rpcReadPaused && this._rpcWaiters.length <= RPC_READ_RESUME_THRESHOLD) {
        this._rpcReadPaused = false
        if (!this._frameReadPaused) this._connection.resumeReading()
      }
    }
  }

  private _releasePendingRpcWaiters(): void {
    for (const resolve of this._rpcWaiters.splice(0)) resolve(null)
    this._activeRpcCount = 0
    this._rpcReadPaused = false
  }

  private _rpcFingerprint(request: tl.RpcMethod): string {
    const hash = createHash('sha256')
    const visit = (value: unknown): void => {
      if (value === null) return void hash.update('null;')
      if (value === undefined) return void hash.update('undefined;')
      if (Long.isLong(value)) return void hash.update(`long:${value.low}:${value.high}:${value.unsigned};`)
      if (value instanceof Uint8Array) {
        hash.update(`bytes:${value.byteLength}:`)
        hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
        hash.update(';')
        return
      }
      if (Array.isArray(value)) {
        hash.update(`array:${value.length}:[`)
        for (const item of value) visit(item)
        hash.update('];')
        return
      }
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        hash.update(`object:${keys.length}:{`)
        for (const key of keys) {
          hash.update(`${key.length}:${key}=`)
          visit(record[key])
        }
        hash.update('};')
        return
      }
      hash.update(`${typeof value}:${String(value)};`)
    }
    visit(request)
    return hash.digest('hex').slice(0, 32)
  }

  private async _waitForRpcDependencies(msgId: Long, dependencies: readonly Long[]): Promise<boolean> {
    if (dependencies.length === 0) return true

    const waits: Promise<void>[] = []
    const missing: string[] = []
    const currentKey = msgId.toString()
    const dependencyAuthKeyId = this._permAuthKey.ready ? this._permAuthKey.id : null
    for (const dependency of dependencies) {
      const key = dependency.toString()
      if (key === currentKey) {
        missing.push(`0x${dependency.toString(16)} (self)`)
        continue
      }
      if (this._completedMessageIds.has(key)) continue
      if (dependencyAuthKeyId
        && this._dependencyRegistry?.completed(dependencyAuthKeyId, dependency)) continue
      const processing = this._processingMessages.get(key)
        ?? (dependencyAuthKeyId
          ? this._dependencyRegistry?.processing(dependencyAuthKeyId, dependency)
          : undefined)
      if (processing) {
        waits.push(processing)
      } else {
        missing.push(`0x${dependency.toString(16)}`)
      }
    }

    if (missing.length > 0) {
      this._log.error(
        'invoke-after dependency unavailable for msg_id=%s: %s; returning MSG_WAIT_FAILED',
        msgId.toString(16),
        missing.join(', '),
      )
      return false
    }

    if (waits.length > 0) {
      this._log.verbose(
        'waiting for %d invoke-after dependency message(s) before msg_id=%s',
        waits.length,
        msgId.toString(16),
      )
      await Promise.all(waits)
    }
    return true
  }

  private _rememberCompletedMessage(key: string): void {
    this._completedMessageIds.delete(key)
    this._completedMessageIds.set(key, true)
    while (this._completedMessageIds.size > MAX_COMPLETED_MESSAGE_IDS) {
      const oldest = this._completedMessageIds.keys().next().value
      if (oldest === undefined) break
      this._completedMessageIds.delete(oldest)
    }
  }

  private _handleRpcDropAnswer(msgId: Long, request: mtp.RawMt_rpc_drop_answer): void {
    const result: mtp.TypeRpcDropAnswer = this._processingMessages.has(request.reqMsgId.toString())
      ? { _: 'mt_rpc_answer_dropped_running' }
      : { _: 'mt_rpc_answer_unknown' }
    this._sendRpcResult(msgId, result as unknown as tl.TlObject, request._)
  }

  // ── Sending ──

  private _setApiLayer(layer: number | null, publish = true): void {
    if (layer === this._apiLayer) return
    this._apiLayer = layer
    this._responseWriterMap = getApiLayerWriterMap(this._writerMap, layer)
    this._log.info(
      'client API layer negotiated: %d (response schema: %s layer %d)',
      layer ?? 0,
      layer === null ? 'none' : resolveApiSchemaProfile(layer) ?? 'none',
      layer === null ? 0 : resolveApiSchemaLayer(layer) ?? 0,
    )
    if (publish && layer !== null && this._permAuthKey.ready) this._onApiLayer?.(this._permAuthKey.id, layer)
    const pending = this._pendingUpdates
    this._pendingUpdates = []
    for (const { update, clientSessionId } of pending) this.sendUpdate(update, clientSessionId)
  }

  private _sendNewSessionCreated(): void {
    const msg: mtp.RawMt_new_session_created = {
      _: 'mt_new_session_created',
      firstMsgId: Long.ZERO,
      uniqueId: this._sessionId,
      serverSalt: this._serverSalt,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, msg)
    this._sendEncryptedMessage(serialized, false)
    this._log.debug('sent new_session_created')
  }

  private _sendRpcResult(
    reqMsgId: Long,
    result: RpcResult,
    method?: string,
    clientSessionId: Long = this._sessionId,
  ): void {
    this._sendRpcReply(this._buildRpcReply(reqMsgId, result, method), clientSessionId, result)
  }

  private _buildRpcReply(reqMsgId: Long, result: RpcResult, method?: string): RpcReply {
    const kind = (result as { _: string })._

    let resultBytes: Uint8Array
    if (kind === 'boolTrue' || kind === 'boolFalse') {
      // Bare Bool results aren't in mtcute's writer map (Bool is modeled as a JS
      // boolean), so serialize their constructor id directly.
      resultBytes = boolBytes(kind === 'boolTrue')
    } else if (isBareVector(result)) {
      // Bare Vector<X>: 0x1cb5c415 + count + items (no wrapping object).
      resultBytes = this._serializeBareVector(result)
    } else {
      resultBytes = TlBinaryWriter.serializeObject(this._responseWriterMap, result)
    }

    // Build rpc_result: id(4) + req_msg_id(8) + result
    const writer = TlBinaryWriter.manual(4 + 8 + resultBytes.length)
    writer.uint(RPC_RESULT_ID)
    writer.long(reqMsgId)
    writer.raw(resultBytes)

    const error = kind === 'mt_rpc_error' ? result as mtp.RawMt_rpc_error : undefined
    return {
      reqMsgId,
      body: writer.result(),
      method,
      resultKind: kind,
      errorCode: error?.errorCode,
      errorMessage: error?.errorMessage,
    }
  }

  private _sendRpcReply(
    reply: RpcReply,
    clientSessionId: Long,
    debugResult?: RpcResult,
    waitForTransport = false,
  ): Promise<unknown> | undefined {
    const settled = this._sendEncryptedMessage(
      reply.body,
      true,
      debugResult === undefined
        ? undefined
        : { _: 'rpc_result', reqMsgId: reply.reqMsgId, result: debugResult },
      clientSessionId,
      waitForTransport,
    )
    if (reply.resultKind === 'mt_rpc_error') {
      const args = [
        reply.reqMsgId.toString(16), reply.method ?? 'unknown', reply.errorCode ?? 500, reply.errorMessage ?? 'INTERNAL',
      ] as const
      if ((reply.errorMessage ?? '').startsWith('METHOD_NOT_IMPLEMENTED:')) {
        this._log.warn('>>> rpc_error for %s (%s): %d %s', ...args)
      } else {
        this._log.error('>>> rpc_error for %s (%s): %d %s', ...args)
      }
    } else {
      this._log.verbose('>>> rpc_result for %s: %s', reply.reqMsgId.toString(16), reply.resultKind)
    }
    return settled ?? Promise.resolve()
  }

  /** Serialize a bare `Vector<X>`: `0x1cb5c415` + count + each item. */
  private _serializeBareVector(vec: BareVector): Uint8Array {
    const serialized: Uint8Array[] = []
    let size = 8 // constructor id + count
    for (const item of vec.items) {
      const b = TlBinaryWriter.serializeObject(this._responseWriterMap, item)
      serialized.push(b)
      size += b.length
    }
    const writer = TlBinaryWriter.manual(size)
    writer.uint(VECTOR_ID)
    writer.uint(vec.items.length)
    for (const b of serialized) writer.raw(b)
    return writer.result()
  }

  /**
   * Encrypt and send a message.
   * The message body should NOT include the msg_id/seq_no/length header —
   * we add it here.
   */
  private _sendEncryptedMessage(
    body: Uint8Array,
    isContentRelated: boolean,
    payload?: unknown,
    clientSessionId: Long = this._sessionId,
    waitForTransport = false,
  ): Promise<unknown> | undefined {
    const msgId = this._msgIdGen.getMessageId(isContentRelated)
    const seqNo = this._msgIdGen.getSeqNo(isContentRelated)

    const writer = TlBinaryWriter.manual(16 + body.length)
    writer.long(msgId)
    writer.uint(seqNo)
    writer.uint(body.length)
    writer.raw(body)

    const encrypted = this._sendKey.encryptMessage(writer.result(), this._serverSalt, clientSessionId)
    if (this._debug) {
      this._capture('server->client', 'message', payload ?? this._decodeDebugBody(body), {
        messageId: msgId,
        seqNo,
      }, clientSessionId)
    }
    if (waitForTransport) return this._connection.sendAndWait(encrypted)
    this._connection.send(encrypted)
  }

  private _capturePlain(data: Uint8Array, direction: MtprotoDebugEvent['direction']): void {
    try {
      const reader = new TlBinaryReader(this._readerMap, data, 20)
      const payload = reader.object()
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const messageId = new Long(view.getInt32(8, true), view.getInt32(12, true))
      this._capture(direction, 'handshake', payload, { messageId })
    } catch (error) {
      this._capture(direction, 'handshake', { _: 'unparsed', bytes: data.length }, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private _decodeDebugBody(body: Uint8Array): unknown {
    try {
      return new TlBinaryReader(this._readerMap, body).object()
    } catch {
      const constructorId = body.length >= 4
        ? new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true)
        : null
      return { _: 'unparsed', constructorId, bytes: body.length }
    }
  }

  private _capture(
    direction: MtprotoDebugEvent['direction'],
    phase: MtprotoDebugEvent['phase'],
    payload: unknown,
    extra: Pick<MtprotoDebugEvent, 'messageId' | 'seqNo' | 'error'> = {},
    clientSessionId: Long = this._sessionId,
  ): void {
    if (!this._debug) return
    try {
      this._debug({
        direction,
        phase,
        connectionId: 'unknown',
        timestamp: Date.now(),
        authKeyId: this._sendKey.ready ? new Uint8Array(this._sendKey.id) : null,
        sessionId: clientSessionId,
        payload,
        ...extra,
      })
    } catch (error) {
      this._log.warn('MTProto debug listener failed: %s', error instanceof Error ? error.message : error)
    }
  }

  // ── Acks ──

  private _queueAck(msgId: Long, clientSessionId: Long): void {
    const key = clientSessionId.toString()
    let queued = this._queuedAcks.get(key)
    if (!queued) {
      queued = { sessionId: clientSessionId, msgIds: [], ids: new Set() }
      this._queuedAcks.set(key, queued)
    }
    const messageKey = msgId.toString()
    if (queued.ids.has(messageKey)) return
    queued.ids.add(messageKey)
    queued.msgIds.push(msgId)
    if (queued.msgIds.length >= 10) {
      this._flushAcks(clientSessionId)
      return
    }
    if (this._scheduledAckFlushes.has(key)) return
    this._scheduledAckFlushes.add(key)
    queueMicrotask(() => {
      this._scheduledAckFlushes.delete(key)
      if (!this._disposed && !this._connection.closed) this._flushAcks(clientSessionId)
    })
  }

  private _flushAcks(clientSessionId: Long): void {
    const key = clientSessionId.toString()
    const queued = this._queuedAcks.get(key)
    if (!queued?.msgIds.length) return
    this._queuedAcks.delete(key)
    this._scheduledAckFlushes.delete(key)

    const ack: mtp.RawMt_msgs_ack = {
      _: 'mt_msgs_ack',
      msgIds: queued.msgIds,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, ack)
    this._sendEncryptedMessage(serialized, false, undefined, queued.sessionId)
  }

  // ── Future salts ──

  private _generateFutureSalts(): void {
    const now = Math.floor(Date.now() / 1000)
    this._futureSalts = []

    for (let i = 0; i < 64; i++) {
      const validSince = now + i * 1800
      const validUntil = validSince + 1800
      const saltBytes = this._crypto.randomBytes(8)
      const dv = typed.toDataView(saltBytes)
      const salt = new Long(dv.getInt32(0, true), dv.getInt32(4, true))
      this._futureSalts.push({ validSince, validUntil, salt })
    }

    if (this._futureSalts.length > 0) {
      this._serverSalt = this._futureSalts[0].salt
    }
  }

  // ── Helpers ──

  private _isNoAckMessage(objId: string): boolean {
    return objId === 'mt_msgs_ack'
      || objId === 'mt_http_wait'
      || objId === 'mt_bad_msg_notification'
      || objId === 'mt_bad_server_salt'
      || objId === 'mt_msgs_all_info'
      || objId === 'mt_msgs_state_info'
      || objId === 'mt_msg_detailed_info'
      || objId === 'mt_msg_new_detailed_info'
  }
}
