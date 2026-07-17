import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import type { mtp, tl } from '@mtcute/core'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { typed, u8 } from '@fuman/utils'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import { createAesIgeForMessageOld } from '@mtcute/core/utils.js'
import Long from 'long'
import { ServerAuthKey } from './server-auth-key.js'
import type { AuthKeyStore } from './auth-key-store.js'
import type { AuthKeyDataStore } from './auth-key-data-store.js'
import { ServerMessageIdGenerator } from './message-id.js'
import { doServerAuthorization } from './server-authorization.js'
import type { ServerConnection } from '../transport/server-connection.js'
import { isBareVector, unwrapRpcRequest } from '../rpc/dispatcher.js'
import type { RpcDispatcher, ServerRpcContext, RpcResult, BareVector } from '../rpc/dispatcher.js'
import { getApiLayerWriterMap, resolveApiSchemaLayer } from '../rpc/api-layer.js'

// TL constructor IDs for MTProto service messages
const RPC_RESULT_ID = 0xF35C6D01
const BOOL_TRUE_ID = 0x997275B5
const BOOL_FALSE_ID = 0xBC799737
// Bare Vector<X> prefix (https://core.telegram.org/type/Vector%20X)
const VECTOR_ID = 0x1CB5C415

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
  private _msgIdGen: ServerMessageIdGenerator
  private _sessionId: Long = Long.ZERO
  private _sessionIdSet = false
  private _serverSalt = Long.ZERO
  private _authorized = false
  private _apiLayer: number | null = null
  private _responseWriterMap: TlWriterMap
  private _queuedAcks: Long[] = []
  private _futureSalts: { validSince: number, validUntil: number, salt: Long }[] = []
  private _msgHandler: ((data: Uint8Array) => void) | null = null

  constructor(
    private readonly _connection: ServerConnection,
    private readonly _crypto: ICryptoProvider,
    private readonly _readerMap: TlReaderMap,
    private readonly _writerMap: TlWriterMap,
    private readonly _log: Logger,
    private readonly _rsaPrivateKeyPem: string,
    private readonly _rsaKeyFingerprint: Long,
    private readonly _dispatcher: RpcDispatcher,
    private readonly _authKeyData: AuthKeyDataStore,
    private readonly _keyStore?: AuthKeyStore,
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
   * Push an update to the client (server-initiated).
   */
  sendUpdate(update: tl.TypeUpdates): void {
    if (!this._authorized) return
    const serialized = TlBinaryWriter.serializeObject(this._responseWriterMap, update)
    this._sendEncryptedMessage(serialized, true)
  }

  // ── Internal: data handling ──

  private async _onRawData(data: Uint8Array): Promise<void> {
    if (!this._authorized) {
      // A returning client may present a cached permanent auth key (encrypted
      // frame, non-zero auth_key_id) instead of handshaking. If we have that key
      // persisted, adopt it and skip the handshake.
      const firstKeyId = data.subarray(0, 8)
      if (!firstKeyId.every(b => b === 0) && this._keyStore) {
        const stored = await this._keyStore.get(firstKeyId)
        if (stored) {
          this._permAuthKey.setup(stored)
          this._generateFutureSalts()
          this._authorized = true
          this._log.info('resumed session from stored auth key id = %h', this._permAuthKey.id)
          await this._onRawData(data) // re-process this frame, now authorized
          return
        }
        this._log.warn('client presented unknown cached auth key id %h; closing so it re-authorizes', firstKeyId)
        this._connection.close()
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
      // Respond on the session this request came in on.
      this._sessionId = clientSessionId
      this._handleDecryptedMessage(msgId, seqNo, reader).catch((err) => {
        this._log.error('error handling message %s: %s', msgId.toString(16), err)
      })
    })
  }

  /**
   * Run one DH handshake to completion over unencrypted messages.
   *
   * @param data    The first unencrypted frame that triggered the handshake.
   * @param isTemp  false = permanent auth key (first handshake); true = PFS
   *                temporary auth key (second handshake on the same connection).
   */
  private async _runHandshake(data: Uint8Array, isTemp: boolean): Promise<void> {
    this._log.verbose('%s handshake starting (%d bytes)', isTemp ? 'temp-key' : 'perm-key', data.length)

    try {
      const unencryptedQueue: Uint8Array[] = [data]
      let waitingForMessage: ((data: Uint8Array) => void) | null = null

      // Replace handler to capture subsequent unencrypted messages during handshake
      if (this._msgHandler) {
        this._connection.onMessage.remove(this._msgHandler)
      }
      const tempHandler = (msg: Uint8Array) => {
        // A single intermediate frame may contain multiple unencrypted messages.
        // Each unencrypted message: auth_key_id(8)=0 + msg_id(8) + length(4) + body.
        // Split the frame into individual messages.
        let offset = 0
        while (offset + 20 <= msg.length) {
          // During the handshake every message must be plaintext (auth_key_id == 0).
          // A non-zero auth_key_id here means the client is sending encrypted
          // traffic with an auth key this (stateless / restarted) server doesn't
          // know — e.g. a key it cached from a previous server instance. Drop the
          // frame rather than misreading it as a handshake message and stalling.
          let zeroKeyId = true
          for (let i = 0; i < 8; i++) {
            if (msg[offset + i] !== 0) { zeroKeyId = false; break }
          }
          if (!zeroKeyId) {
            this._log.warn('dropping encrypted frame during handshake (client using an unknown/stale auth key id %h)', msg.subarray(offset, offset + 8))
            break
          }

          const dv = new DataView(msg.buffer, msg.byteOffset + offset)
          const length = dv.getUint32(16, true) // length at offset 16 (after 8+8)
          const msgEnd = 20 + length
          if (offset + msgEnd > msg.length) break
          const single = msg.subarray(offset, offset + msgEnd)
          if (waitingForMessage) {
            const resolve = waitingForMessage
            waitingForMessage = null
            resolve(single)
          } else {
            unencryptedQueue.push(single)
          }
          offset += msgEnd
        }
      }
      this._connection.onMessage.add(tempHandler)

      const recvPlain = async (): Promise<Uint8Array> => {
        if (unencryptedQueue.length > 0) {
          return unencryptedQueue.shift()!
        }
        return new Promise((resolve) => {
          waitingForMessage = resolve
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

      if (isTemp) {
        // The temp key lives alongside the perm key; the client binds them via
        // auth.bindTempAuthKey (which arrives encrypted with the temp key) and
        // then uses the temp key for all subsequent traffic.
        this._tempAuthKey = new ServerAuthKey(this._crypto, this._log, this._readerMap)
        this._tempAuthKey.setup(result.authKey)
        this._log.info('temp-key (PFS) handshake complete, temp auth key id = %h', this._tempAuthKey.id)
      } else {
        this._permAuthKey.setup(result.authKey)
        this._serverSalt = result.serverSalt
        this._authorized = true
        this._log.info('handshake complete, auth key id = %h', this._permAuthKey.id)
        // Persist the perm key so a returning client can resume without re-handshaking.
        try {
          await this._keyStore?.save(this._permAuthKey.id, result.authKey)
        } catch (err) {
          this._log.warn('failed to persist auth key: %s', err instanceof Error ? err.message : err)
        }
      }

      // Restore normal handler
      this._connection.onMessage.remove(tempHandler)
      const normalHandler = (msg: Uint8Array) => {
        this._onRawData(msg).catch((err) => {
          this._log.error('unhandled error: %s', err)
        })
      }
      this._msgHandler = normalHandler
      this._connection.onMessage.add(normalHandler)

      // Generate initial future salts once, before the first encrypted message.
      if (!isTemp) {
        this._generateFutureSalts()
      }

      // Note: new_session_created is sent after the first encrypted message
      // is received, because we need the client's session ID (captured from
      // the first message) to encrypt it correctly.
    } catch (err) {
      this._log.error('%s handshake failed: %s', isTemp ? 'temp-key' : 'perm-key', err instanceof Error ? err.stack : err)
      this._connection.close()
    }
  }

  private async _handleDecryptedMessage(msgId: Long, seqNo: number, reader: TlBinaryReader): Promise<void> {
    this._msgIdGen.observeClientMsgId(msgId)

    // Read the object — msg_container (0x73f1f8dc) is not in the reader map,
    // so we handle it manually.
    const savedPos = reader.pos
    const constructorId = reader.uint()
    let obj: { _: string, [key: string]: unknown }

    if (constructorId === 0x73f1f8dc) {
      // msg_container: vector of { msg_id, seqno, length, body }
      const count = reader.uint()
      for (let i = 0; i < count; i++) {
        const innerMsgId = reader.long(true)
        const innerSeqNo = reader.uint()
        const innerLength = reader.uint()
        const innerBody = reader.raw(innerLength)
        const innerReader = new TlBinaryReader(this._readerMap, innerBody)
        await this._handleDecryptedMessage(innerMsgId, innerSeqNo, innerReader)
      }
      return
    }

    // Not a container — restore position and read normally
    reader.pos = savedPos
    obj = reader.object() as mtp.TlObject
    const objId = obj._

    this._log.verbose('<<< %s (msg_id=%s, seq=%d)', objId, msgId.toString(16), seqNo)

    if (!this._isNoAckMessage(objId)) {
      this._queueAck(msgId)
    }

    switch (objId) {
      case 'mt_ping':
        this._handlePing(obj as mtp.RawMt_ping)
        break

      case 'mt_ping_delay_disconnect':
        this._handlePingDelayDisconnect(obj as mtp.RawMt_ping_delay_disconnect)
        break

      case 'mt_msgs_ack':
        break

      case 'mt_get_future_salts':
        this._handleGetFutureSalts(msgId, obj as mtp.RawMt_get_future_salts)
        break

      case 'mt_msgs_state_req':
        this._handleMsgsStateReq(msgId, obj as mtp.RawMt_msgs_state_req)
        break

      case 'mt_destroy_session':
        this._handleDestroySession(msgId, obj as mtp.RawMt_destroy_session)
        break

      case 'mt_destroy_auth_key':
        this._handleDestroyAuthKey(msgId)
        break

      case 'auth.bindTempAuthKey':
        this._handleBindTempAuthKey(msgId, obj as unknown as tl.auth.RawBindTempAuthKeyRequest)
        break

      default:
        // Check if it's an RPC call (method names contain dots, e.g. "help.getConfig")
        // or a known wrapper (invokeWithLayer, initConnection, etc.)
        if (objId.includes('.') || objId.startsWith('invokeWith') || objId === 'initConnection') {
          await this._handleRpcCall(msgId, obj as unknown as tl.RpcMethod)
        } else {
          this._log.warn('unhandled message type: %s', objId)
        }
    }

    this._flushAcks()
  }

  // ── Service message handlers ──

  private _handlePing(ping: mtp.RawMt_ping): void {
    const pong: mtp.RawMt_pong = {
      _: 'mt_pong',
      msgId: Long.ZERO,
      pingId: ping.pingId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, pong)
    this._sendEncryptedMessage(serialized, true)
  }

  private _handlePingDelayDisconnect(ping: mtp.RawMt_ping_delay_disconnect): void {
    const pong: mtp.RawMt_pong = {
      _: 'mt_pong',
      msgId: Long.ZERO,
      pingId: ping.pingId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, pong)
    this._sendEncryptedMessage(serialized, true)
  }

  private _handleGetFutureSalts(msgId: Long, req: mtp.RawMt_get_future_salts): void {
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
      this._sendEncryptedMessage(writer.result(), false)
    } catch (e) {
      this._log.error('failed to serialize future_salts: %s', e)
    }
  }

  private _handleMsgsStateReq(msgId: Long, req: mtp.RawMt_msgs_state_req): void {
    const info = new Uint8Array(req.msgIds.length)
    info.fill(0x01)

    const response: mtp.RawMt_msgs_state_info = {
      _: 'mt_msgs_state_info',
      reqMsgId: msgId,
      info,
    }

    const serialized = TlBinaryWriter.serializeObject(this._writerMap, response)
    this._sendEncryptedMessage(serialized, false)
  }

  private _handleDestroySession(msgId: Long, req: mtp.RawMt_destroy_session): void {
    const response: mtp.RawMt_destroy_session_ok = {
      _: 'mt_destroy_session_ok',
      sessionId: req.sessionId,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, response)
    this._sendEncryptedMessage(serialized, false)
  }

  private _handleDestroyAuthKey(_msgId: Long): void {
    const response: mtp.RawMt_destroy_auth_key_ok = {
      _: 'mt_destroy_auth_key_ok',
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, response)
    this._sendEncryptedMessage(serialized, false)
  }

  /**
   * Handle auth.bindTempAuthKey — binds the temporary (PFS) key to the permanent
   * key. The request arrives encrypted with the temp key; its `encryptedMessage`
   * is a `bind_auth_key_inner` sealed with the *permanent* key using the old
   * MTProto message encryption. We decrypt and verify it, then reply boolTrue.
   */
  private _handleBindTempAuthKey(msgId: Long, req: tl.auth.RawBindTempAuthKeyRequest): void {
    const ok = this._verifyBindInner(req)
    if (ok) {
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
    this._sendEncryptedMessage(writer.result(), true)
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
      if (!tempIdOk || !permIdOk || !nonceOk) {
        this._log.warn('bindTempAuthKey: field mismatch (temp=%s perm=%s nonce=%s)', tempIdOk, permIdOk, nonceOk)
        return false
      }
      return true
    } catch (err) {
      this._log.warn('bindTempAuthKey: verification error: %s', err instanceof Error ? err.message : err)
      return false
    }
  }

  // ── RPC call handling ──

  private async _handleRpcCall(msgId: Long, request: tl.RpcMethod): Promise<void> {
    // invokeWithLayer is the one authoritative source of the client's API layer.
    // Capture it on the MTProto session before constructing the handler context
    // or serializing this request's response. Later unwrapped requests reuse it.
    const unwrapped = unwrapRpcRequest(request)
    if (unwrapped.apiLayer !== null) this._setApiLayer(unwrapped.apiLayer)

    const ctx: ServerRpcContext = {
      connection: this._connection,
      apiLayer: this._apiLayer,
      authKeyId: this._permAuthKey.ready ? this._permAuthKey.id : null,
      sessionId: this._sessionId,
      isAuthorized: this._authorized,
      sendUpdate: (update) => this.sendUpdate(update),
      getPlatformData: <T>() => this._authKeyData.get<T>(this._permAuthKey.ready ? this._permAuthKey.id : null) as T,
      setPlatformData: (data) => this._authKeyData.set(this._permAuthKey.ready ? this._permAuthKey.id : null, data),
    }

    try {
      const result = await this._dispatcher.dispatch(ctx, unwrapped.request)
      this._sendRpcResult(msgId, result)
    } catch (err) {
      this._log.error('RPC dispatch error for %s: %s', request._, err instanceof Error ? err.stack : err)
      this._sendRpcResult(msgId, {
        _: 'mt_rpc_error',
        errorCode: 500,
        errorMessage: 'INTERNAL',
      } as mtp.RawMt_rpc_error)
    }
  }

  // ── Sending ──

  private _setApiLayer(layer: number | null): void {
    if (layer === this._apiLayer) return
    this._apiLayer = layer
    this._responseWriterMap = getApiLayerWriterMap(this._writerMap, layer)
    this._log.info(
      'client API layer negotiated: %d (response compatibility schema layer: %d)',
      layer ?? 0,
      layer === null ? 0 : resolveApiSchemaLayer(layer) ?? 0,
    )
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

  private _sendRpcResult(reqMsgId: Long, result: RpcResult): void {
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

    this._sendEncryptedMessage(writer.result(), true)
    if (kind === 'mt_rpc_error') {
      const error = result as mtp.RawMt_rpc_error
      this._log.warn(
        '>>> rpc_error for %s: %d %s',
        reqMsgId.toString(16), error.errorCode, error.errorMessage,
      )
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
  private _sendEncryptedMessage(body: Uint8Array, isContentRelated: boolean): void {
    const msgId = this._msgIdGen.getMessageId(isContentRelated)
    const seqNo = this._msgIdGen.getSeqNo(isContentRelated)

    const writer = TlBinaryWriter.manual(16 + body.length)
    writer.long(msgId)
    writer.uint(seqNo)
    writer.uint(body.length)
    writer.raw(body)

    const encrypted = this._sendKey.encryptMessage(writer.result(), this._serverSalt, this._sessionId)
    this._connection.send(encrypted)
  }

  // ── Acks ──

  private _queueAck(msgId: Long): void {
    this._queuedAcks.push(msgId)
    if (this._queuedAcks.length >= 10) {
      this._flushAcks()
    }
  }

  private _flushAcks(): void {
    if (this._queuedAcks.length === 0) return

    const msgIds = this._queuedAcks
    this._queuedAcks = []

    const ack: mtp.RawMt_msgs_ack = {
      _: 'mt_msgs_ack',
      msgIds,
    }
    const serialized = TlBinaryWriter.serializeObject(this._writerMap, ack)
    this._sendEncryptedMessage(serialized, false)
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
