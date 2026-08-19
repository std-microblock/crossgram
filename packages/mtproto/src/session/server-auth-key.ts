import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import type { TlReaderMap } from '@mtcute/tl-runtime'
import type Long from 'long'
import type { tl } from '@mtcute/core'
import { typed, u8 } from '@fuman/utils'
import { TlBinaryReader } from '@mtcute/tl-runtime'
import { createAesIgeForMessage } from '@mtcute/core/utils.js'

/**
 * Server-side auth key wrapper.
 *
 * The MTProto message encryption is symmetric — the same algorithm is used
 * in both directions, but with different slices of the auth key:
 *
 * Client → Server (decrypting client messages):
 *   - message_key = SHA256(authKey[88:88+32] + plaintext)[8:24]
 *   - AES key/IV derived from `createAesIgeForMessage(crypto, key, msgKey, client=true)` (x=0)
 *
 * Server → Client (encrypting server responses):
 *   - message_key = SHA256(authKey[96:96+32] + plaintext)[8:24]
 *   - AES key/IV derived from `createAesIgeForMessage(crypto, key, msgKey, client=false)` (x=8)
 *
 * mtcute's `AuthKey.encryptMessage` uses `client=true` (x=0, clientSalt=authKey[88:120])
 * and `AuthKey.decryptMessage` uses `client=false` (x=8, serverSalt=authKey[96:128]).
 * On the server, we swap: we encrypt with `client=false` and decrypt with `client=true`.
 */
export class ServerAuthKey {
  ready = false
  key!: Uint8Array
  id!: Uint8Array
  /** authKey[88:120] — used to derive msg_key when decrypting client→server messages */
  clientSalt!: Uint8Array
  /** authKey[96:128] — used to derive msg_key when encrypting server→client messages */
  serverSalt!: Uint8Array

  constructor(
    readonly _crypto: ICryptoProvider,
    readonly _log: Logger,
    readonly _readerMap: TlReaderMap,
  ) {}

  setup(authKey?: Uint8Array | null): void {
    if (!authKey) {
      this.ready = false
      return
    }
    this.ready = true
    this.key = authKey
    this.clientSalt = authKey.subarray(88, 120)
    this.serverSalt = authKey.subarray(96, 128)
    this.id = new Uint8Array(this._crypto.sha1(authKey).subarray(-8))
    this._log.verbose('server auth key set up, id = %h', this.id)
  }

  reset(): void {
    this.ready = false
  }

  match(keyId: Uint8Array): boolean {
    return this.ready && typed.equal(keyId, this.id)
  }

  /**
   * Encrypt a server→client message (MTProto v2).
   *
   * This is the mirror of mtcute's `AuthKey.decryptMessage` — we use
   * `client=false` (x=8) which corresponds to the server direction.
   *
   * @param message  The serialized message body (msg_id + seq_no + length + body)
   * @param serverSalt  Current server salt
   * @param sessionId  Session ID
   * @returns Encrypted packet: authKeyId(8) + messageKey(16) + ciphertext
   */
  encryptMessage(message: Uint8Array, serverSalt: Long, sessionId: Long): Uint8Array {
    if (!this.ready) throw new Error('Auth key not set up')

    // Pad to 16-byte alignment with at least 12 bytes of random padding
    let padding = (16 + message.length + 12) % 16
    padding = 12 + (padding ? 16 - padding : 0)

    const buf = u8.alloc(16 + message.length + padding)
    const dv = typed.toDataView(buf)
    dv.setInt32(0, serverSalt.low, true)
    dv.setInt32(4, serverSalt.high, true)
    dv.setInt32(8, sessionId.low, true)
    dv.setInt32(12, sessionId.high, true)
    buf.set(message, 16)
    this._crypto.randomFill(buf.subarray(16 + message.length, 16 + message.length + padding))

    // Server direction: use serverSalt (authKey[96:128]) and client=false
    const messageKey = this._crypto.sha256(u8.concat2(this.serverSalt, buf)).subarray(8, 24)
    const ige = createAesIgeForMessage(this._crypto, this.key, messageKey, false) // client=false = server direction
    const encryptedData = ige.encrypt(buf)

    return u8.concat3(this.id, messageKey, encryptedData)
  }

  /**
   * Decrypt a client→server message (MTProto v2).
   *
   * This is the mirror of mtcute's `AuthKey.encryptMessage` — we use
   * `client=true` (x=0) which corresponds to the client direction.
   *
   * @param data  The encrypted packet: authKeyId(8) + messageKey(16) + ciphertext
   * @param sessionId  Expected session ID. If null, session ID validation is skipped
   *   (used for the first message to extract the client's session ID).
   * @param callback  Called with (msgId, seqNo, reader) for each message in the packet
   */
  decryptMessage(
    data: Uint8Array,
    sessionId: Long | null,
    callback: (msgId: tl.Long, seqNo: number, reader: TlBinaryReader, sessionId: Long) => void,
  ): void {
    const messageKey = data.subarray(8, 24)
    let encryptedData = data.subarray(24)

    // Strip transport padding (not a multiple of 16)
    const mod16 = encryptedData.byteLength % 16
    if (mod16 !== 0) {
      encryptedData = encryptedData.subarray(0, encryptedData.byteLength - mod16)
    }

    // Client direction: use clientSalt (authKey[88:120]) and client=true
    const ige = createAesIgeForMessage(this._crypto, this.key, messageKey, true) // client=true = client direction
    const innerData = ige.decrypt(encryptedData)

    // Verify message key: SHA256(clientSalt + innerData)[8:24]
    const expectedMessageKey = this._crypto.sha256(u8.concat2(this.clientSalt, innerData)).subarray(8, 24)
    if (!typed.equal(messageKey, expectedMessageKey)) {
      this._log.warn('received message with invalid messageKey = %h (expected %h)', messageKey, expectedMessageKey)
      return
    }

    const innerReader = new TlBinaryReader(this._readerMap, innerData)
    innerReader.seek(8) // skip salt
    const sessionId_ = innerReader.long()
    const rawBytes = innerData.subarray(0, 32)
    this._log.verbose('decrypted innerData[0:32] = %h, sessionId = %h', rawBytes, sessionId_)
    if (sessionId !== null && sessionId_.neq(sessionId)) {
      this._log.warn('ignoring message with invalid sessionId = %h (expected %h)', sessionId_, sessionId)
      return
    }

    const messageId = innerReader.long(true)
    const seqNo = innerReader.uint()
    const length = innerReader.uint()

    if (length > innerData.length - 32) {
      this._log.warn('ignoring message with invalid length: %d > %d', length, innerData.length - 32)
      return
    }

    if (length % 4 !== 0) {
      this._log.warn('ignoring message with invalid length: %d is not a multiple of 4', length)
      return
    }

    const paddingSize = innerData.length - length - 32
    if (paddingSize < 12 || paddingSize > 1024) {
      this._log.warn('ignoring message with invalid padding size: %d', paddingSize)
      return
    }

    callback(messageId, seqNo, innerReader, sessionId_)
  }
}
