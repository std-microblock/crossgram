import { Context, Service } from 'cordis'
import { Server, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { __tlWriterMap, LogManager, type ICryptoProvider, type Logger } from '@mtcute/core/utils.js'
import type { tl } from '@mtcute/core'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import Long from 'long'
import { getServerReaderMap } from './rpc/server-reader-map.js'
import { ServerConnection } from './transport/server-connection.js'
import { RpcDependencyRegistry, ServerSession } from './session/server-session.js'
import { PqChallengeStore } from './session/server-authorization.js'
import { MemoryAuthKeyStore, FileAuthKeyStore, type AuthKeyStore } from './session/auth-key-store.js'
import { AuthKeyDataStore } from './session/auth-key-data-store.js'
import { RpcDispatcher, type RpcHandler, type RpcResult } from './rpc/dispatcher.js'
import type { ServerRpcContext } from './rpc/context.js'
import { generateRsaKeyPair, loadOrCreateRsaKeyPair, type ServerRsaKey } from './crypto/rsa-keygen.js'
import { createCordisLogManager } from './cordis-logger.js'
import { Emitter } from '@fuman/utils'
import type { MtprotoDebugEvent } from './debug.js'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

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
  /** Optional mtcute logger override (default: routed through ctx.logger). */
  log?: Logger | LogManager
}

export const Config = z.object({
  port: z.natural().max(65_535).default(4430),
  host: z.string().default('127.0.0.1'),
  rsaKeyPath: z.string(),
  authKeyStorePath: z.string(),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

/**
 * A connection that has been write-backpressured for this long (the peer is
 * not consuming bytes) is presumed stalled and is closed so the client
 * reconnects and re-syncs via updates.getDifference.
 */
const STALL_TIMEOUT_MS = 30_000
const STALL_WATCH_INTERVAL_MS = 5_000

/**
 * The MTProto server, as a native cordis service (`ctx.mtproto`).
 *
 * Owns the TCP listener and per-connection MTProto sessions directly (the
 * `@cordisjs/plugin-server` pattern). Backend plugins inject `mtproto` and
 * register RPC handlers via {@link register} — each
 * registration is a `ctx.effect`, so a backend hot-reloads (or unloads) cleanly
 * while the listener and live connections stay up.
 */
export class Mtproto extends Service {
  static Config = Config
  readonly rsaKey: ServerRsaKey
  readonly dispatcher = new RpcDispatcher()
  readonly onDebug = new Emitter<MtprotoDebugEvent>()

  private readonly _crypto: ICryptoProvider
  private readonly _readerMap: TlReaderMap
  private readonly _writerMap: TlWriterMap
  private readonly _authKeyStore: AuthKeyStore
  private readonly _authKeyData = new AuthKeyDataStore()
  private readonly _log: Logger
  private readonly _sessions = new Set<ServerSession>()
  private readonly _sockets = new Set<Socket>()
  private readonly _authApiLayers = new Map<string, number>()
  private readonly _rpcDependencies = new RpcDependencyRegistry()
  private readonly _pqChallenges = new PqChallengeStore()
  private _connectionSeq = 0
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
      this._log = createCordisLogManager(ctx.logger)
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

  /** Broadcast a server-initiated update to all authorized, non-stalled sessions. */
  broadcastUpdate(update: tl.TypeUpdates): void {
    for (const session of this._sessions) {
      if (session.connection.stalledForMs >= STALL_TIMEOUT_MS) continue
      this._applyKnownApiLayer(session)
      session.sendUpdate(update)
    }
  }

  /** Send an update to connections authenticated with the given permanent auth key. */
  sendUpdateToAuthKey(
    authKeyId: Uint8Array,
    update: tl.TypeUpdates,
    excludeConnection?: ServerConnection,
  ): number {
    const candidates = [...this._sessions].filter((session) =>
      equalBytes(session.authKeyId, authKeyId) && session.connection !== excludeConnection)
    // A stalled connection accepts bytes into its kernel/Node buffers forever
    // without the peer ever reading them. Skip it so the update is delivered
    // on a live connection (or left pending for updates.getDifference).
    const healthy = candidates.filter((session) =>
      session.connection.stalledForMs < STALL_TIMEOUT_MS)
    const updateSessions = healthy.filter((session) => session.acceptsUpdates)
    const targets = updateSessions.length ? updateSessions : healthy.slice(0, 1)
    for (const session of targets) {
      this._applyKnownApiLayer(session)
      session.sendUpdate(update)
    }
    return targets.length
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

    // Reap stalled connections so a client whose TCP path went black (but the
    // socket still reports ESTABLISHED) reconnects and re-syncs updates.
    const stallWatcher = setInterval(() => {
      for (const session of this._sessions) {
        const stalled = session.connection.stalledForMs
        if (stalled < STALL_TIMEOUT_MS) continue
        this._log.warn(
          'connection %s stalled for %d ms with %d bytes buffered; closing to force a client reconnect',
          session.connection.label, stalled, session.connection.bufferedBytes,
        )
        session.connection.close()
      }
    }, STALL_WATCH_INTERVAL_MS)
    stallWatcher.unref?.()

    yield () => new Promise<void>((res) => {
      clearInterval(stallWatcher)
      for (const socket of this._sockets) socket.destroy()
      this._sockets.clear()
      server.close(() => { this._server = null; res() })
    })
  }

  private _handleConnection(socket: Socket): void {
    const connectionId = `conn-${++this._connectionSeq}`
    const connLog = this._log.create(`conn:${socket.remoteAddress}:${socket.remotePort}`)
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    this._sockets.add(socket)
    socket.on('close', () => this._sockets.delete(socket))

    this.onDebug.emit({
      direction: 'client->server', phase: 'connection', connectionId,
      timestamp: Date.now(), payload: {
        _: 'connection_opened',
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
      },
    })

    const connection = new ServerConnection(socket, this._crypto, connLog)
    const session = new ServerSession(
      connection,
      this._crypto,
      this._readerMap,
      this._writerMap,
      connLog,
      this.rsaKey.privateKeyPem,
      Long.fromString(this.rsaKey.fingerprint, true, 16),
      { dispatch: (ctx, request) => this._dispatch(ctx, request) },
      this._authKeyData,
      this._authKeyStore,
      (event) => this.onDebug.emit({ ...event, connectionId }),
      (authKeyId, layer) => { void this._rememberApiLayer(authKeyId, layer) },
      (authKeyId) => this._authApiLayers.get(bytesHex(authKeyId)),
      this._rpcDependencies,
      this._pqChallenges,
    )
    this._sessions.add(session)
    connection.onClose.add(() => {
      this._sessions.delete(session)
      this.onDebug.emit({
        direction: 'client->server', phase: 'connection', connectionId,
        timestamp: Date.now(), payload: { _: 'connection_closed' },
      })
    })

    session.start()
    connection.start()
  }

  private async _rememberApiLayer(authKeyId: Uint8Array, layer: number): Promise<void> {
    const key = bytesHex(authKeyId)
    this._authApiLayers.set(key, layer)
    for (const session of this._sessions) {
      if (equalBytes(session.authKeyId, authKeyId)) session.applyApiLayer(layer)
    }
    try {
      const stored = await this._authKeyStore.get(authKeyId)
      if (stored && !stored.permanentKeyId && stored.apiLayer !== layer) {
        await this._authKeyStore.save(authKeyId, { ...stored, apiLayer: layer })
      }
    } catch (error) {
      this._log.warn('failed to persist API layer for auth key %h: %s', authKeyId, error)
    }
  }

  private _applyKnownApiLayer(session: ServerSession): void {
    if (session.apiLayer !== null) return
    const authKeyId = session.authKeyId
    if (!authKeyId) return
    const layer = this._authApiLayers.get(bytesHex(authKeyId))
    if (layer !== undefined) session.applyApiLayer(layer)
  }

  private async _dispatch(ctx: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult> {
    return this.dispatcher.dispatch(ctx, request)
  }
}

function equalBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  if (!left || left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function bytesHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export default Mtproto
