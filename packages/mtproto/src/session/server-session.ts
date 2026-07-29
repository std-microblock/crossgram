import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import type { mtp, tl } from '@mtcute/core'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { typed, u8 } from '@fuman/utils'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import { createAesIgeForMessageOld } from '@mtcute/core/utils.js'
import { gunzipSync } from 'node:zlib'
import Long from 'long'
import { ServerAuthKey } from './server-auth-key.js'
import type { AuthKeyStore, StoredAuthKey } from './auth-key-store.js'
import type { AuthKeyDataStore } from './auth-key-data-store.js'
import { ServerMessageIdGenerator } from './message-id.js'
import { doServerAuthorization } from './server-authorization.js'
import type { ServerConnection } from '../transport/server-connection.js'
import { isBareVector, isRpcRequestObject, unwrapRpcRequest } from '../rpc/dispatcher.js'
import type { RpcDispatch, ServerRpcContext, RpcResult, BareVector } from '../rpc/dispatcher.js'
import { getApiLayerWriterMap, resolveApiSchemaLayer, resolveApiSchemaProfile } from '../rpc/api-layer.js'
import type { MtprotoDebugEvent, MtprotoDebugListener } from '../debug.js'

// TL constructor IDs for MTProto service messages
const RPC_RESULT_ID = 0xF35C6D01
const BOOL_TRUE_ID = 0x997275B5
const BOOL_FALSE_ID = 0xBC799737
const GZIP_PACKED_ID = 0x3072CFA1
// Bare Vector<X> prefix (https://core.telegram.org/type/Vector%20X)
const VECTOR_ID = 0x1CB5C415
const MAX_GZIP_UNPACKED_SIZE = 16 * 1024 * 1024
const MAX_SHARED_COMPLETED_MESSAGE_IDS = 16_384

/**
 * Tracks invokeAfterMsg dependencies across TCP connections that share the
 * same permanent auth key. Telegram Android may create a request on one
 * connection and resend it through another after reconnecting.
 */
export class RpcDependencyRegistry {
  private readonly _processing = new Map<string, Promise<void>>()
  private readonly _completed = new Map<string, true>()

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
    return this._completed.has(this._key(authKeyId, msgId))
  }

  private _key(authKeyId: Uint8Array, msgId: Long): string {
    let scope = ''
    for (const byte of authKeyId) scope += byte.toString(16).padStart(2, '0')
    return `${scope}:${msgId.toString()}`
  }
}

class ResumeStoredAuthKey extends Error {
  constructor(
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
  'auth.signIn',
  'auth.importAuthorization',
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
 * 4. RPC calls are dispatched to the RpcDispatcher; responses sent as `rpc_result`
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
  private _apiLayer: number | null = null
  private _responseWriterMap: TlWriterMap
  private _pendingUpdates: Array<{ update: tl.TypeUpdates, clientSessionId?: Long }> = []
  private _acceptsUpdates = false
  /** Session that last established an updates stream on this connection. */
  private _updateSessionId: Long | null = null
  private _queuedAcks = new Map<string, { sessionId: Long, msgIds: Long[] }>()
  private _futureSalts: { validSince: number, validUntil: number, salt: Long }[] = []
  private _msgHandler: ((data: Uint8Array) => void) | null = null
  private _processingMessages = new Map<string, Promise<void>>()
  private _completedMessageIds = new Map<string, true>()
  // Only authorization transitions form a barrier. Serializing every API RPC
  // lets one slow history/download request stall all later calls while pings
  // still succeed, leaving Telegram with a deceptively half-alive connection.
  private _authorizationTransitionProcessing: Promise<void> = Promise.resolve()

  constructor(
    private readonly _connection: ServerConnection,
    private readonly _crypto: ICryptoProvider,
    private readonly _readerMap: TlReaderMap,
    private readonly _writerMap: TlWriterMap,
    private readonly _log: Logger,
    private readonly _rsaPrivateKeyPem: string,
    private readonly _rsaKeyFingerprint: Long,
    private readonly _dispatcher: RpcDispatch,
    private readonly _authKeyData: AuthKeyDataStore,
    private readonly _keyStore?: AuthKeyStore,
    private readonly _debug?: MtprotoDebugListener,
    private readonly _onApiLayer?: (authKeyId: Uint8Array, layer: number) => void,
    private readonly _getApiLayer?: (authKeyId: Uint8Array) => number | undefined,
    private readonly _dependencyRegistry?: RpcDependencyRegistry,
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
    const onMsg = (data: Uint8Array) => {
      this._onRawData(data).catch((err) => {
        this._log.error('unhandled error in message processing: %s', err)
      })
    }
    this._msgHandler = onMsg
    this._connection.onMessage.add(onMsg)

    const onClose = () => {
      this._log.debug('connection closed')
    }
    this._connection.onClose.add(onClose)
  }

  /**
   * Push a server-initiated update. RPC-local updates supply their originating
   * session explicitly; external pushes target the session that activated the
   * updates stream. Before that activation, retain the legacy latest-session
   * fallback so early post-login updates remain deliverable.
   */
  sendUpdate(update: tl.TypeUpdates, clientSessionId?: Long): void {
    if (!this._authorized) return
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

  get authKeyId(): Uint8Array | null {
    return this._permAuthKey.ready ? this._permAuthKey.id : null
  }

  get apiLayer(): number | null {
    return this._apiLayer
  }

  get acceptsUpdates(): boolean {
    return this._acceptsUpdates
  }

  /** Apply an API layer learned by another connection using the same auth key. */
  applyApiLayer(layer: number): void {
    this._setApiLayer(layer, false)
  }

  // ── Internal: data handling ──

  private async _onRawData(data: Uint8Array): Promise<void> {
    if (!this._authorized) {
      // Returning API and media connections may present either a permanent key
      // or a temporary PFS key before any plaintext handshake.
      const firstKeyId = data.subarray(0, 8)
      if (!firstKeyId.every(b => b === 0)) {
        const stored = await this._keyStore?.get(firstKeyId)
        if (stored && await this._adoptStoredAuthKey(stored)) {
          await this._onRawData(data) // re-process this frame, now authorized
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
      this._handleDecryptedMessage(msgId, seqNo, reader, clientSessionId).catch((err) => {
        this._log.error('error handling message %s: %s', msgId.toString(16), err)
      })
    })
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

    const normalHandler = this._msgHandler
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
              interruptHandshake(new ResumeStoredAuthKey(stored, encryptedFrames))
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
      // Replace handler to capture subsequent unencrypted messages during handshake
      if (normalHandler) {
        this._connection.onMessage.remove(normalHandler)
      }
      this._connection.onMessage.add(tempHandler)

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
      this._connection.onMessage.remove(tempHandler)
      if (normalHandler) {
        this._msgHandler = normalHandler
        this._connection.onMessage.add(normalHandler)
      }
    }

    if (resumed) {
      if (!await this._adoptStoredAuthKey(resumed.record)) {
        this._sendAuthKeyNotFound(resumed.encryptedFrames[0].subarray(0, 8))
        return
      }
      for (const frame of resumed.encryptedFrames) {
        await this._onRawData(frame)
      }
    }
  }

  private async _adoptStoredAuthKey(record: StoredAuthKey): Promise<boolean> {
    let apiLayer = record.apiLayer
    if (record.permanentKeyId) {
      const permanent = await this._keyStore?.get(record.permanentKeyId)
      if (!permanent || permanent.permanentKeyId) return false
      this._permAuthKey.setup(permanent.key)
      apiLayer = permanent.apiLayer
      this._tempAuthKey = new ServerAuthKey(this._crypto, this._log, this._readerMap)
      this._tempAuthKey.setup(record.key)
      this._tempAuthKeyExpiresAt = record.expiresAt ?? null
      this._log.info(
        'resumed temporary auth key %h for permanent key %h',
        this._tempAuthKey.id,
        this._permAuthKey.id,
      )
    } else {
      this._permAuthKey.setup(record.key)
      this._log.info('resumed permanent auth key %h', this._permAuthKey.id)
    }
    this._generateFutureSalts()
    this._authorized = true
    if (apiLayer !== undefined) this._setApiLayer(apiLayer, false)
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
      await this._processDecryptedMessage(msgId, seqNo, reader, clientSessionId)
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
  ): Promise<void> {
    this._msgIdGen.observeClientMsgId(msgId)

    // Read the object — msg_container (0x73f1f8dc) is not in the reader map,
    // so we handle it manually.
    const savedPos = reader.pos
    const constructorId = reader.uint()
    let obj: { _: string }

    if (constructorId === 0x73f1f8dc) {
      // msg_container: vector of { msg_id, seqno, length, body }
      const count = reader.uint()
      this._capture('client->server', 'message', { _: 'msg_container', count }, {
        messageId: msgId,
        seqNo,
      })
      for (let i = 0; i < count; i++) {
        const innerMsgId = reader.long(true)
        const innerSeqNo = reader.uint()
        const innerLength = reader.uint()
        const innerBody = reader.raw(innerLength)
        const innerReader = new TlBinaryReader(this._readerMap, innerBody)
        try {
          await this._handleDecryptedMessage(innerMsgId, innerSeqNo, innerReader, clientSessionId)
        } catch (error) {
          this._handleContainerMessageError(innerMsgId, innerSeqNo, innerBody, error, clientSessionId)
        }
      }
      return
    }

    // gzip_packed is an MTProto envelope around one ordinary TL object. The
    // upstream tl-runtime documents the constructor but does not currently
    // inflate it, so unwrap it at the server boundary before normal dispatch.
    if (constructorId === GZIP_PACKED_ID) {
      const packedData = reader.bytes()
      const unpacked = gunzipSync(packedData, { maxOutputLength: MAX_GZIP_UNPACKED_SIZE })
      reader = new TlBinaryReader(this._readerMap, unpacked)
    } else {
      // Not a container or compressed envelope — restore position and read normally.
      reader.pos = savedPos
    }
    obj = reader.object() as { _: string }
    const objId = obj._

    this._capture('client->server', 'message', obj, { messageId: msgId, seqNo })

    this._log.verbose('<<< %s (msg_id=%s, seq=%d)', objId, msgId.toString(16), seqNo)

    if (!this._isNoAckMessage(objId)) {
      this._queueAck(msgId, clientSessionId)
    }

    switch (objId) {
      case 'mt_ping':
        this._handlePing(obj as unknown as mtp.RawMt_ping, clientSessionId)
        break

      case 'mt_ping_delay_disconnect':
        this._handlePingDelayDisconnect(obj as unknown as mtp.RawMt_ping_delay_disconnect, clientSessionId)
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
        await this._handleBindTempAuthKey(
          msgId, obj as unknown as tl.auth.RawBindTempAuthKeyRequest, clientSessionId,
        )
        break

      default:
        if (isRpcRequestObject(objId)) {
          await this._enqueueRpcCall(msgId, obj as unknown as tl.RpcMethod, clientSessionId)
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

  private _handlePing(ping: mtp.RawMt_ping, clientSessionId: Long): void {
    const pong: mtp.RawMt_pong = {
      _: 'mt_pong',
      msgId: Long.ZERO,
      pingId: ping.pingId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, pong)
    this._sendEncryptedMessage(serialized, true, pong, clientSessionId)
  }

  private _handlePingDelayDisconnect(ping: mtp.RawMt_ping_delay_disconnect, clientSessionId: Long): void {
    const pong: mtp.RawMt_pong = {
      _: 'mt_pong',
      msgId: Long.ZERO,
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
   * MTProto message encryption. We decrypt and verify it, then reply boolTrue.
   */
  private async _handleBindTempAuthKey(
    msgId: Long,
    req: tl.auth.RawBindTempAuthKeyRequest,
    clientSessionId: Long,
  ): Promise<void> {
    const permanentId = longToBytesLE(req.permAuthKeyId)
    if (!this._permAuthKey.match(permanentId)) {
      const permanent = await this._keyStore?.get(permanentId)
      if (permanent && !permanent.permanentKeyId) {
        const replacedFreshKey = this._permAuthKey.ready
        this._permAuthKey.setup(permanent.key)
        if (permanent.apiLayer !== undefined) this._setApiLayer(permanent.apiLayer, false)
        this._log.info(
          replacedFreshKey
            ? 'replaced fresh permanent key with requested key %h for temp-key binding'
            : 'loaded permanent key %h for direct temp-key binding',
          this._permAuthKey.id,
        )
      }
    }
    const ok = this._verifyBindInner(req)
    if (ok) {
      try {
        await this._keyStore?.save(this._tempAuthKey!.id, {
          key: this._tempAuthKey!.key,
          permanentKeyId: new Uint8Array(this._permAuthKey.id),
          expiresAt: req.expiresAt,
        })
      } catch (err) {
        this._log.warn('failed to persist bound temp auth key: %s', err instanceof Error ? err.message : err)
      }
      this._log.info('temp key bound to perm key (temp id = %h)', this._tempAuthKey?.id)
    } else {
      this._log.warn('bindTempAuthKey verification failed, replying boolTrue anyway')
    }
    // Reply boolTrue — Telegram Desktop only needs this to consider the temp key
    // bound. `boolTrue` is a bare Bool that mtcute's writer map can't serialize
    // as an object, so build the rpc_result manually: id(4) + req_msg_id(8) + boolTrue(4).
    const writer = TlBinaryWriter.manual(4 + 8 + 4)
    writer.uint(RPC_RESULT_ID)
    writer.long(msgId)
    writer.uint(BOOL_TRUE_ID)
    this._sendEncryptedMessage(
      writer.result(), true, { _: 'rpc_result', reqMsgId: msgId, result: { _: 'boolTrue' } }, clientSessionId,
    )
    this._log.verbose('>>> rpc_result boolTrue for bindTempAuthKey %s', msgId.toString(16))
  }

  /**
   * Decrypt and verify the `encrypted_message` from auth.bindTempAuthKey.
   * Returns true if the binding is consistent. Verification is best-effort:
   * a mismatch is logged but does not abort the bind (the client only cares
   * about the boolTrue reply).
   */
  private _verifyBindInner(req: tl.auth.RawBindTempAuthKeyRequest): boolean {
    try {
      if (!this._permAuthKey.ready || !this._tempAuthKey?.ready) return false

      const enc = req.encryptedMessage
      if (enc.length < 24 + 16) return false

      const keyId = enc.subarray(0, 8)
      if (!typed.equal(keyId, this._permAuthKey.id)) {
        this._log.warn('bindTempAuthKey: encrypted_message key id %h != perm key id %h', keyId, this._permAuthKey.id)
        return false
      }

      const msgKey = enc.subarray(8, 24)
      const encData = enc.subarray(24)
      // The client encrypts with the OLD MTProto message scheme, client=true.
      const ige = createAesIgeForMessageOld(this._crypto, this._permAuthKey.key, msgKey, true)
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
      const permIdOk = typed.equal(longToBytesLE(bind.permAuthKeyId), this._permAuthKey.id)
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
  ): Promise<void> {
    const method = unwrapRpcRequest(request).request._
    if (AUTHORIZATION_TRANSITION_METHODS.has(method)) {
      const scheduled = this._authorizationTransitionProcessing.then(
        () => this._handleRpcCall(msgId, request, clientSessionId),
      )
      this._authorizationTransitionProcessing = scheduled.catch((err) => {
        this._log.error('error handling RPC message %s: %s', msgId.toString(16), err)
      })
      await scheduled
      return
    }

    const precedingAuthorizationTransitions = this._authorizationTransitionProcessing
    await precedingAuthorizationTransitions
    await this._handleRpcCall(msgId, request, clientSessionId)
  }

  private async _handleRpcCall(
    msgId: Long,
    request: tl.RpcMethod,
    clientSessionId: Long,
  ): Promise<void> {
    // invokeWithLayer is the one authoritative source of the client's API layer.
    // Capture it on the MTProto session before constructing the handler context
    // or serializing this request's response. Later unwrapped requests reuse it.
    const unwrapped = unwrapRpcRequest(request)
    if (
      unwrapped.request._ === 'updates.getState'
      || unwrapped.request._ === 'updates.getDifference'
      || unwrapped.request._ === 'updates.getChannelDifference'
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
    if (this._apiLayer === null) {
      // The API layer is not part of the DH handshake and cannot be inferred
      // from a bare RPC. Telegram clients retry this request after receiving
      // CONNECTION_NOT_INITED with invokeWithLayer(initConnection(...)).
      this._sendRpcResult(msgId, {
        _: 'mt_rpc_error',
        errorCode: 400,
        errorMessage: 'CONNECTION_NOT_INITED',
      } as mtp.RawMt_rpc_error, unwrapped.request._, clientSessionId)
      return
    }

    if (!await this._waitForRpcDependencies(msgId, unwrapped.afterMessageIds)) {
      this._sendRpcResult(msgId, {
        _: 'mt_rpc_error',
        errorCode: 500,
        errorMessage: 'MSG_WAIT_FAILED',
      } as mtp.RawMt_rpc_error, unwrapped.request._, clientSessionId)
      return
    }

    const ctx: ServerRpcContext = {
      connection: this._connection,
      apiLayer: this._apiLayer,
      authKeyId: this._permAuthKey.ready ? this._permAuthKey.id : null,
      sessionId: clientSessionId,
      isAuthorized: this._authorized,
      sendUpdate: (update) => this.sendUpdate(update, clientSessionId),
      getPlatformData: <T>() => this._authKeyData.get<T>(this._permAuthKey.ready ? this._permAuthKey.id : null) as T,
      setPlatformData: (data) => this._authKeyData.set(this._permAuthKey.ready ? this._permAuthKey.id : null, data),
    }

    try {
      const result = await this._dispatcher.dispatch(ctx, unwrapped.request)
      this._sendRpcResult(msgId, result, unwrapped.request._, clientSessionId)
    } catch (err) {
      this._log.error('RPC dispatch error for %s: %s', unwrapped.request._, err instanceof Error ? err.stack : err)
      this._sendRpcResult(msgId, {
        _: 'mt_rpc_error',
        errorCode: 500,
        errorMessage: 'INTERNAL',
      } as mtp.RawMt_rpc_error, unwrapped.request._, clientSessionId)
    }
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

    this._sendEncryptedMessage(
      writer.result(), true, { _: 'rpc_result', reqMsgId: reqMsgId, result }, clientSessionId,
    )
    if (kind === 'mt_rpc_error') {
      const error = result as mtp.RawMt_rpc_error
      const args = [
        reqMsgId.toString(16), method ?? 'unknown', error.errorCode, error.errorMessage,
      ] as const
      if (error.errorMessage.startsWith('METHOD_NOT_IMPLEMENTED:')) {
        this._log.warn('>>> rpc_error for %s (%s): %d %s', ...args)
      } else {
        this._log.error('>>> rpc_error for %s (%s): %d %s', ...args)
      }
    } else {
      this._log.verbose('>>> rpc_result for %s: %s', reqMsgId.toString(16), kind)
    }
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
  ): void {
    const msgId = this._msgIdGen.getMessageId(isContentRelated)
    const seqNo = this._msgIdGen.getSeqNo(isContentRelated)

    const writer = TlBinaryWriter.manual(16 + body.length)
    writer.long(msgId)
    writer.uint(seqNo)
    writer.uint(body.length)
    writer.raw(body)

    const encrypted = this._sendKey.encryptMessage(writer.result(), this._serverSalt, clientSessionId)
    this._capture('server->client', 'message', payload ?? this._decodeDebugBody(body), {
      messageId: msgId,
      seqNo,
    }, clientSessionId)
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
      queued = { sessionId: clientSessionId, msgIds: [] }
      this._queuedAcks.set(key, queued)
    }
    queued.msgIds.push(msgId)
    if (queued.msgIds.length >= 10) this._flushAcks(clientSessionId)
  }

  private _flushAcks(clientSessionId: Long): void {
    const key = clientSessionId.toString()
    const queued = this._queuedAcks.get(key)
    if (!queued?.msgIds.length) return
    this._queuedAcks.delete(key)

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
