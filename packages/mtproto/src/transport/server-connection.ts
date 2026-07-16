import type { Socket } from 'node:net'
import type { IPacketCodec } from '@mtcute/core'
import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import { IntermediatePacketCodec, PaddedIntermediatePacketCodec } from '@mtcute/core'
import { Bytes } from '@fuman/io'
import { Emitter } from '@fuman/utils'
import { AbridgedPacketCodec, createServerObfuscation } from './server-obfuscation.js'

/**
 * A single client TCP connection, with MTProto transport framing handled by an
 * mtcute-compatible `IPacketCodec`.
 *
 * The transport is auto-detected from the first bytes the client sends, since
 * different clients pick different transports:
 *   - `0xef`                — abridged (plaintext)
 *   - `0xEEEEEEEE`          — intermediate (plaintext; what mtcute's TcpTransport uses)
 *   - `0xDDDDDDDD`          — padded intermediate (plaintext)
 *   - anything else         — obfuscated: a random 64-byte AES-CTR init header
 *                             (what Telegram Desktop / TDLib forks use)
 *
 * Lifecycle:
 * 1. On connect: nothing is written — the client speaks first.
 * 2. On data: detect the transport (once), then feed raw bytes into the codec's
 *    `decode()` and emit decoded frames.
 * 3. On send: call the codec's `encode()`, write the result to the socket.
 */
export class ServerConnection {
  /** Emitted when a complete framed packet is decoded */
  readonly onMessage = new Emitter<Uint8Array>()
  /** Emitted when the connection is closed */
  readonly onClose = new Emitter<void>()
  /** Emitted when the connection is first established */
  readonly onReady = new Emitter<void>()

  private _closed = false
  private _recvBuffer = Bytes.alloc(65536)
  /** Codec is `null` until the transport is detected from the first bytes. */
  private _codec: IPacketCodec | null = null

  constructor(
    private readonly _socket: Socket,
    private readonly _crypto: ICryptoProvider,
    private readonly _log: Logger,
  ) {
    _socket.on('data', (data: Buffer) => this._handleData(data))
    _socket.on('error', (err: Error) => {
      this._log.warn('socket error: %s', err.message)
    })
    _socket.on('close', () => {
      if (!this._closed) {
        this._closed = true
        this.onClose.emit()
      }
    })
  }

  /**
   * Start the connection.
   *
   * Note: we do NOT send anything to the client. In MTProto transport the
   * client speaks first (sending its transport tag / obfuscation header), and
   * the server replies with framed data directly — never echoing a tag.
   */
  start(): void {
    this.onReady.emit()
  }

  /**
   * Send a raw framed packet to the client.
   * The packet is encoded by the (detected) codec before writing to the socket.
   */
  send(data: Uint8Array): void {
    if (this._closed) return
    if (!this._codec) {
      this._log.warn('send() called before transport was detected; dropping %d bytes', data.length)
      return
    }

    const writable = Bytes.alloc(data.length + 16)
    const result = this._codec.encode(data, writable)
    if (result instanceof Promise) {
      result.then(() => {
        this._socket.write(writable.result())
      })
    } else {
      this._socket.write(writable.result())
    }
  }

  /** Close the connection */
  close(): void {
    if (this._closed) return
    this._closed = true
    this._socket.destroy()
  }

  private _handleData(data: Buffer): void {
    if (this._closed) return

    this._log.debug('received %d bytes from socket', data.length)

    // Append data to receive buffer using the sync write API
    const writeView = this._recvBuffer.writeSync(data.length)
    writeView.set(new Uint8Array(data))
    this._recvBuffer.disposeWriteSync(data.length)

    // Detect the transport from the first bytes (once). Returns false while
    // more bytes are needed to disambiguate.
    if (!this._codec) {
      if (!this._detectTransport()) return
    }

    this._log.debug('recv buffer available for decode: %d bytes', this._recvBuffer.available)

    for (;;) {
      const frame = this._codec!.decode(this._recvBuffer, false)
      if (frame instanceof Promise) {
        frame.then((f) => {
          if (f !== null) {
            this._log.verbose('decoded frame: %d bytes', f.length)
            this.onMessage.emit(f)
          }
        })
        break
      }
      if (frame === null) {
        this._log.debug('decode returned null (incomplete data), available: %d', this._recvBuffer.available)
        break
      }

      this._log.debug('decoded frame: %d bytes', frame.length)
      this.onMessage.emit(frame)
    }

    this._recvBuffer.reclaim()
  }

  /**
   * Inspect the buffered bytes and select the transport codec, consuming the
   * transport header/tag. Returns `true` once a codec has been chosen, or
   * `false` if more bytes are needed to decide.
   */
  private _detectTransport(): boolean {
    const avail = this._recvBuffer.available
    if (avail < 1) return false

    // Abridged: a single 0xEF tag byte.
    const firstByte = this._recvBuffer.readSync(1)[0]
    this._recvBuffer.rewind(1)
    if (firstByte === 0xef) {
      this._recvBuffer.readSync(1)
      this._codec = new AbridgedPacketCodec()
      this._log.debug('transport detected: abridged (plaintext)')
      return true
    }

    // The remaining transports need at least 4 bytes to disambiguate.
    if (avail < 4) return false
    const tag = this._recvBuffer.readSync(4)
    const isAll = (v: number) => tag[0] === v && tag[1] === v && tag[2] === v && tag[3] === v
    const intermediate = isAll(0xee)
    const padded = isAll(0xdd)
    this._recvBuffer.rewind(4)

    if (intermediate) {
      this._recvBuffer.readSync(4)
      this._codec = new IntermediatePacketCodec()
      this._log.debug('transport detected: intermediate (plaintext)')
      return true
    }
    if (padded) {
      this._recvBuffer.readSync(4)
      const codec = new PaddedIntermediatePacketCodec()
      codec.setup?.(this._crypto)
      this._codec = codec
      this._log.debug('transport detected: padded-intermediate (plaintext)')
      return true
    }

    // Otherwise: obfuscated transport, which begins with a 64-byte init header.
    if (avail < 64) return false
    const header = new Uint8Array(this._recvBuffer.readSync(64))
    const { codec, innerTag } = createServerObfuscation(header, this._crypto, this._log)
    this._codec = codec
    this._log.debug('transport detected: obfuscated (inner tag %h)', innerTag)
    return true
  }
}
