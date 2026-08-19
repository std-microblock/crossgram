import type { Socket } from 'node:net'
import type { IPacketCodec } from '@mtcute/core'
import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import { IntermediatePacketCodec, PaddedIntermediatePacketCodec } from '@mtcute/core'
import { Bytes } from '@fuman/io'
import { AbridgedPacketCodec, createServerObfuscation } from './server-obfuscation.js'

export interface TransportTrafficSample {
  direction: 'received' | 'sent'
  bytes: number
  timestamp: number
}

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
  private _closed = false
  private _readPaused = false
  private _recvBuffer = Bytes.alloc(65536)
  private _messageHandler: ((data: Uint8Array) => void) | null = null
  /** Codec is `null` until the transport is detected from the first bytes. */
  private _codec: IPacketCodec | null = null
  /**
   * Monotonic timestamp (ms) when the socket last reported write
   * backpressure (`socket.write()` returned false). Reset on `drain`.
   * A connection that stays backpressured for a long time is stalled —
   * the peer is not consuming bytes (dead app, black-holed path), while TCP
   * still reports ESTABLISHED. Without this signal updates pile up forever.
   */
  private _backpressuredSince: number | null = null
  private readonly _onDrain = (): void => {
    this._backpressuredSince = null
  }
  private readonly _onData = (data: Buffer): void => this._handleData(data)
  private readonly _onError = (error: Error): void => {
    this._log.warn('socket error: %s', error.message)
  }
  private readonly _onClose = (): void => {
    this._closed = true
    this._readPaused = false
    this._backpressuredSince = null
  }

  constructor(
    private readonly _socket: Socket,
    private readonly _crypto: ICryptoProvider,
    private readonly _log: Logger,
    private readonly _onTraffic?: (sample: TransportTrafficSample) => void,
  ) {
    _socket.on('data', this._onData)
    _socket.on('drain', this._onDrain)
    _socket.on('error', this._onError)
    _socket.on('close', this._onClose)
  }

  /** Install the single frame consumer owned by this connection fiber. */
  listen(handler: (data: Uint8Array) => void): () => void {
    if (this._messageHandler) throw new Error('MTProto connection already has a frame consumer')
    this._messageHandler = handler
    return () => {
      this._messageHandler = null
    }
  }

  /** Temporarily replace the frame consumer while a handshake owns the socket. */
  replaceMessageHandler(handler: ((data: Uint8Array) => void) | null): void {
    this._messageHandler = handler
  }

  /**
   * Send a raw framed packet to the client.
   * The packet is encoded by the (detected) codec before writing to the socket.
   */
  send(data: Uint8Array): void {
    this._send(data, false)
  }

  /** Send one final framed packet and close after the socket flushes it. */
  sendAndClose(data: Uint8Array): void {
    this._send(data, true)
  }

  private _send(data: Uint8Array, closeAfterWrite: boolean): void {
    if (this._closed) return
    if (!this._codec) {
      this._log.warn('send() called before transport was detected; dropping %d bytes', data.length)
      if (closeAfterWrite) this.close()
      return
    }

    const writable = Bytes.alloc(data.length + 16)
    const result = this._codec.encode(data, writable)
    const write = () => {
      const encoded = writable.result()
      this._onTraffic?.({ direction: 'sent', bytes: encoded.length, timestamp: Date.now() })
      if (closeAfterWrite) {
        this._closed = true
        this._socket.end(encoded)
      } else {
        const flushed = this._socket.write(encoded)
        if (!flushed && this._backpressuredSince === null) {
          this._backpressuredSince = Date.now()
        }
      }
    }
    if (result instanceof Promise) {
      result.then(write)
    } else {
      write()
    }
  }

  /**
   * Milliseconds this connection has been write-backpressured without the
   * peer draining it. `0` means the peer is consuming bytes normally.
   */
  get stalledForMs(): number {
    if (this._backpressuredSince === null) return 0
    return Date.now() - this._backpressuredSince
  }

  /** Bytes currently queued in the Node writable buffer. */
  get bufferedBytes(): number {
    return this._socket.writableLength
  }

  /** Whether the transport can no longer deliver RPC results to its peer. */
  get closed(): boolean {
    return this._closed
  }

  /** Pause kernel-to-userland reads while the session drains bounded work. */
  pauseReading(): void {
    if (this._closed || this._readPaused) return
    this._readPaused = true
    this._socket.pause()
  }

  /** Resume reads after both frame and RPC queues fall below their low watermarks. */
  resumeReading(): void {
    if (this._closed || !this._readPaused) return
    this._readPaused = false
    this._socket.resume()
  }

  /** Remote IP address for connection-level rate limits. */
  get remoteAddress(): string | undefined {
    return this._socket.remoteAddress
  }

  /** Human-readable peer identity for logs. */
  get label(): string {
    return `${this._socket.remoteAddress ?? '?'}:${this._socket.remotePort ?? '?'}`
  }

  /** Close the connection */
  close(): void {
    if (this._closed) return
    this._closed = true
    this._readPaused = false
    this._backpressuredSince = null
    this._socket.off('drain', this._onDrain)
    this._socket.destroy()
  }

  /** Detach all native socket listeners owned by this transport wrapper. */
  dispose(): void {
    this._messageHandler = null
    this._socket.off('data', this._onData)
    this._socket.off('drain', this._onDrain)
    this._socket.off('error', this._onError)
    this._socket.off('close', this._onClose)
  }

  private _handleData(data: Buffer): void {
    if (this._closed) return

    this._onTraffic?.({ direction: 'received', bytes: data.length, timestamp: Date.now() })
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
            this._messageHandler?.(f)
          }
        })
        break
      }
      if (frame === null) {
        this._log.debug('decode returned null (incomplete data), available: %d', this._recvBuffer.available)
        break
      }

      this._log.debug('decoded frame: %d bytes', frame.length)
      this._messageHandler?.(frame)
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
