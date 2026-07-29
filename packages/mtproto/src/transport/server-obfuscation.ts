import type { IPacketCodec } from '@mtcute/core'
import type { IAesCtr, ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import { IntermediatePacketCodec, PaddedIntermediatePacketCodec } from '@mtcute/core'
import { Bytes, read, write, type ISyncWritable } from '@fuman/io'
import { u8 } from '@fuman/utils'

/**
 * Server-side implementations of the MTProto TCP transports that mtcute does
 * not export as ready-to-use server codecs.
 *
 * mtcute's `ObfuscatedPacketCodec` is written for the *client* side — its
 * `tag()` method generates the random 64-byte init header. On the server we
 * receive that header instead of generating it, so we derive the AES-CTR keys
 * from it (see {@link createServerObfuscation}) rather than making our own.
 */

const EMPTY_TAG = new Uint8Array(0)

/**
 * Abridged transport codec (client tag `0xef`).
 *
 * mtcute only exports `IntermediatePacketCodec` and
 * `PaddedIntermediatePacketCodec`, so we implement abridged here since
 * Telegram Desktop / TDLib forks may negotiate it inside obfuscation.
 *
 * Frame format: a length header (in 4-byte words) followed by the payload.
 *   - length < 0x7f: single byte `length`
 *   - length >= 0x7f: byte `0x7f` then 3-byte little-endian `length`
 */
export class AbridgedPacketCodec implements IPacketCodec {
  tag(): Uint8Array {
    // Never sent by the server; present to satisfy IPacketCodec.
    return new Uint8Array([0xef])
  }

  decode(reader: Bytes, eof: boolean): Uint8Array | null {
    if (eof) return null
    if (reader.available < 1) return null

    const firstByte = reader.readSync(1)[0]
    // Telegram clients set bit 7 on the abridged length marker when they ask
    // for a transport-level quick acknowledgement. It is not part of the
    // packet length. In particular, a short 74-word frame is encoded as 0xca,
    // not as the four-byte-length marker. Treating the unmasked value as the
    // marker makes the following three ciphertext bytes look like a huge
    // length and stalls the connection until the client reconnects.
    const lengthMarker = firstByte & 0x7f
    let length: number
    let headerSize: number
    if (lengthMarker < 0x7f) {
      length = lengthMarker * 4
      headerSize = 1
    } else {
      if (reader.available < 3) {
        reader.rewind(1)
        return null
      }
      const b = reader.readSync(3)
      length = (b[0] | (b[1] << 8) | (b[2] << 16)) * 4
      headerSize = 4
    }

    if (reader.available < length) {
      reader.rewind(headerSize)
      return null
    }

    return new Uint8Array(read.exactly(reader, length))
  }

  encode(frame: Uint8Array, into: ISyncWritable): void {
    const words = frame.length >> 2
    if (words >= 0x7f) {
      const header = new Uint8Array(4)
      header[0] = 0x7f
      header[1] = words & 0xff
      header[2] = (words >> 8) & 0xff
      header[3] = (words >> 16) & 0xff
      write.bytes(into, header)
    } else {
      write.bytes(into, new Uint8Array([words]))
    }
    write.bytes(into, frame)
  }

  reset(): void {}
}

/**
 * Server-side obfuscated transport codec. Wraps an inner codec (intermediate,
 * padded-intermediate or abridged) and transparently AES-CTR de/encrypts the
 * byte stream, using the keys derived from the client's init header.
 */
export class ServerObfuscatedCodec implements IPacketCodec {
  private readonly _decodeBuf = Bytes.alloc()

  constructor(
    private readonly _encryptor: IAesCtr,
    private readonly _decryptor: IAesCtr,
    private readonly _inner: IPacketCodec,
  ) {}

  tag(): Uint8Array {
    return EMPTY_TAG
  }

  decode(reader: Bytes, eof: boolean): Uint8Array | Promise<Uint8Array | null> | null {
    if (eof) return null
    if (reader.available > 0) {
      const decrypted = this._decryptor.process(reader.readSync(reader.available))
      const into = this._decodeBuf.writeSync(decrypted.length)
      into.set(decrypted)
    }
    return this._inner.decode(this._decodeBuf, eof)
  }

  encode(frame: Uint8Array, into: ISyncWritable): void {
    const temp = Bytes.alloc(frame.length + 64)
    const result = this._inner.encode(frame, temp)
    if (result instanceof Promise) {
      throw new TypeError('inner codec must encode synchronously under obfuscation')
    }
    write.bytes(into, this._encryptor.process(temp.result()))
  }

  reset(): void {
    this._inner.reset()
    this._decodeBuf.reset()
    this._encryptor.close?.()
    this._decryptor.close?.()
  }
}

function allEqual(bytes: Uint8Array, value: number): boolean {
  return bytes[0] === value && bytes[1] === value && bytes[2] === value && bytes[3] === value
}

/** Pick the inner codec that matches the 4-byte protocol tag from the header. */
function selectInnerCodec(tag: Uint8Array, crypto: ICryptoProvider, log: Logger): IPacketCodec {
  if (allEqual(tag, 0xdd)) {
    const codec = new PaddedIntermediatePacketCodec()
    codec.setup?.(crypto)
    return codec
  }
  if (allEqual(tag, 0xef)) {
    return new AbridgedPacketCodec()
  }
  if (!allEqual(tag, 0xee)) {
    log.warn('obfuscated: unknown inner protocol tag %h, defaulting to intermediate', tag)
  }
  return new IntermediatePacketCodec()
}

/**
 * Set up server-side obfuscation from a client's 64-byte init header.
 *
 * The client (mtcute / TDLib / Telegram Desktop) builds the header roughly as:
 *   - `header[8:40]`  encrypt key   (client → server)
 *   - `header[40:56]` encrypt IV
 *   - `reverse(header[8:56])[0:32]`  decrypt key (server → client)
 *   - `reverse(header[8:56])[32:48]` decrypt IV
 *   - `header[56:60]` inner protocol tag (encrypted in the last 8 bytes on the wire)
 *
 * It then AES-CTR-encrypts the whole 64-byte header with its *encrypt* cipher
 * and replaces bytes `[56:64]` with the encrypted version before sending.
 *
 * On the server we therefore:
 *   - build our *decryptor* from the client's encrypt key/IV,
 *   - build our *encryptor* from the client's (reversed) decrypt key/IV,
 *   - advance the decryptor over the full 64-byte header so its keystream is in
 *     sync with the client's encryptor, and recover the inner protocol tag from
 *     the decrypted `[56:60]`.
 */
export function createServerObfuscation(
  header: Uint8Array,
  crypto: ICryptoProvider,
  log: Logger,
): { codec: ServerObfuscatedCodec, innerTag: Uint8Array } {
  if (header.length !== 64) {
    throw new RangeError(`obfuscation header must be 64 bytes, got ${header.length}`)
  }

  const encryptKey = header.subarray(8, 40)
  const encryptIv = header.subarray(40, 56)
  const reversed = u8.toReversed(header.subarray(8, 56))
  const decryptKey = reversed.subarray(0, 32)
  const decryptIv = reversed.subarray(32, 48)

  // Names are from the client's perspective: what the client encrypts we
  // decrypt, and vice versa. The boolean flag is a no-op for CTR mode.
  const decryptor = crypto.createAesCtr(encryptKey, encryptIv, false)
  const encryptor = crypto.createAesCtr(decryptKey, decryptIv, true)

  // Advance the decryptor over the whole header (the client's encryptor also
  // processed 64 bytes), and recover the inner protocol tag from [56:60].
  const decryptedHeader = decryptor.process(header)
  const innerTag = decryptedHeader.subarray(56, 60)

  const inner = selectInnerCodec(innerTag, crypto, log)
  return { codec: new ServerObfuscatedCodec(encryptor, decryptor, inner), innerTag }
}
