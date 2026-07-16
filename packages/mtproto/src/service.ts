import { Context, Service } from 'cordis'
import { Server, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { __tlWriterMap, LogManager, type ICryptoProvider, type Logger } from '@mtcute/core/utils.js'
import type { tl } from '@mtcute/core'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { NodePlatform } from '@mtcute/node'
import Long from 'long'
import { getServerReaderMap } from './rpc/server-reader-map.js'
import { ServerConnection } from './transport/server-connection.js'
import { ServerSession } from './session/server-session.js'
import { MemoryAuthKeyStore, FileAuthKeyStore, type AuthKeyStore } from './session/auth-key-store.js'
import { RpcDispatcher, type RpcHandler } from './rpc/dispatcher.js'
import { generateRsaKeyPair, loadOrCreateRsaKeyPair, type ServerRsaKey } from './crypto/rsa-keygen.js'

declare module 'cordis' {
  interface Context {
    mtproto: Mtproto
  }
}

export interface MtprotoConfig {
  /** TCP port to listen on (default: 4430; 0 = ephemeral) */
  port?: number
  /** Host to bind to (default: 127.0.0.1) */
  host?: string
  /** Crypto provider (default: NodeCryptoProvider) */
  crypto?: ICryptoProvider
  /** RSA key pair (if omitted and no rsaKeyPath, a new one is generated) */
  rsaKey?: ServerRsaKey
  /** Path to load/save the RSA key pair JSON (public PEM written to `<path>.pem`) */
  rsaKeyPath?: string
  /** TL reader map (default: server reader map with method requests) */
  readerMap?: TlReaderMap
  /** TL writer map (default: mtcute's built-in) */
  writerMap?: TlWriterMap
  /** Persistent auth-key store path (default: in-memory). */
  authKeyStorePath?: string
  /** Auth-key store instance (overrides authKeyStorePath). */
  authKeyStore?: AuthKeyStore
  /** mtcute Logger/LogManager for the protocol layer (default: a new LogManager). */
  log?: Logger | LogManager
}

/**
 * The MTProto server, as a native cordis service (`ctx.mtproto`).
 *
 * Owns the TCP listener and per-connection MTProto sessions directly (the
 * `@cordisjs/plugin-server` pattern). Backend plugins inject `mtproto` and
 * register RPC handlers via {@link register} / {@link fallback} — each
 * registration is a `ctx.effect`, so a backend hot-reloads (or unloads) cleanly
 * while the listener and live connections stay up.
 */
export class Mtproto extends Service {
  readonly rsaKey: ServerRsaKey
  readonly dispatcher = new RpcDispatcher()

  private readonly _crypto: ICryptoProvider
  private readonly _readerMap: TlReaderMap
  private readonly _writerMap: TlWriterMap
  private readonly _authKeyStore: AuthKeyStore
  private readonly _log: Logger
  private readonly _sessions = new Set<ServerSession>()
  private readonly _sockets = new Set<Socket>()
  private _server: Server | null = null

  constructor(ctx: Context, public config: MtprotoConfig = {}) {
    super(ctx, 'mtproto')

    this.rsaKey = config.rsaKeyPath
      ? loadOrCreateRsaKeyPair(resolve(process.cwd(), config.rsaKeyPath))
      : config.rsaKey ?? generateRsaKeyPair()
    this._crypto = config.crypto ?? new NodeCryptoProvider()
    this._readerMap = config.readerMap ?? getServerReaderMap()
    this._writerMap = config.writerMap ?? __tlWriterMap
    this._authKeyStore = config.authKeyStore
      ?? (config.authKeyStorePath
        ? new FileAuthKeyStore(resolve(process.cwd(), config.authKeyStorePath))
        : new MemoryAuthKeyStore())

    if (config.log) {
      this._log = 'create' in config.log && typeof config.log.create === 'function'
        ? config.log.create('mtproto')
        : config.log as Logger
    } else {
      const mgr = new LogManager('mtproto', new NodePlatform())
      mgr.level = LogManager.VERBOSE
      this._log = mgr.create('mtproto')
    }
  }

  /** The actual bound port (useful when configured with port 0). */
  get port(): number {
    const addr = this._server?.address()
    return addr && typeof addr === 'object' ? addr.port : (this.config.port ?? 4430)
  }

  /** Register an RPC handler, tied to the calling fiber (HMR-safe). */
  register(method: string, handler: RpcHandler): () => void {
    return this.ctx.effect(() => {
      this.dispatcher.register(method, handler)
      return () => this.dispatcher.unregister(method)
    }, `mtproto.register(${method})`)
  }

  /** Register a fallback handler (e.g. relay passthrough), tied to the caller (HMR-safe). */
  fallback(handler: RpcHandler): () => void {
    return this.ctx.effect(() => {
      this.dispatcher.fallback(handler)
      return () => this.dispatcher.clearFallback()
    }, 'mtproto.fallback')
  }

  /** Broadcast a server-initiated update to all authorized sessions. */
  broadcastUpdate(update: tl.TypeUpdates): void {
    for (const session of this._sessions) session.sendUpdate(update)
  }

  async* [Service.init]() {
    await this._crypto.initialize?.()

    const server = new Server((socket) => this._handleConnection(socket))
    this._server = server
    const host = this.config.host ?? '127.0.0.1'
    const port = this.config.port ?? 4430

    await new Promise<void>((res) => {
      server.listen(port, host, () => {
        this._log.info('listening on %s:%d', host, this.port)
        res()
      })
    })

    yield () => new Promise<void>((res) => {
      for (const socket of this._sockets) socket.destroy()
      this._sockets.clear()
      server.close(() => { this._server = null; res() })
    })
  }

  private _handleConnection(socket: Socket): void {
    const connLog = this._log.create(`conn:${socket.remoteAddress}:${socket.remotePort}`)
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    this._sockets.add(socket)
    socket.on('close', () => this._sockets.delete(socket))

    const connection = new ServerConnection(socket, this._crypto, connLog)
    const session = new ServerSession(
      connection,
      this._crypto,
      this._readerMap,
      this._writerMap,
      connLog,
      this.rsaKey.privateKeyPem,
      Long.fromString(this.rsaKey.fingerprint, true, 16),
      this.dispatcher,
      this._authKeyStore,
    )
    this._sessions.add(session)
    connection.onClose.add(() => this._sessions.delete(session))

    session.start()
    connection.start()
  }
}

export default Mtproto
