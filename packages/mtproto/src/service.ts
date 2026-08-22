import { Context, Service, type Fiber } from 'cordis'
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
import {
  AuthKeyStorePublishedError, MemoryAuthKeyStore, FileAuthKeyStore, type AuthKeyStore,
} from './session/auth-key-store.js'
import { AuthKeyDataStore } from './session/auth-key-data-store.js'
import type { RpcHandler, RpcResult } from './rpc/protocol.js'
import { invokeRpc, registerRpcRoute } from './rpc/router.js'
import type { MtprotoConnectionScope, MtprotoTrafficSample, ServerRpcContext } from './rpc/context.js'
import { generateRsaKeyPair, loadOrCreateRsaKeyPair, type ServerRsaKey } from './crypto/rsa-keygen.js'
import { createCordisLogManager } from './cordis-logger.js'
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
  /** Maximum simultaneously retained TCP connections (default: 256). */
  maxConnections?: number
  /** Maximum retained TCP connections from one remote IP (default: 64). */
  maxConnectionsPerIp?: number
  /** Close after this many milliseconds without socket activity (default: 10 minutes; 0 disables). */
  connectionIdleTimeoutMs?: number
  /** Start TCP keepalive probes after this idle delay (default: 60 seconds). */
  keepAliveInitialDelayMs?: number
}

export const Config = z.object({
  port: z.natural().max(65_535).default(4430),
  host: z.string().default('127.0.0.1'),
  rsaKeyPath: z.string(),
  authKeyStorePath: z.string(),
  maxConnections: z.natural().max(65_535).default(256),
  maxConnectionsPerIp: z.natural().max(65_535).default(64),
  connectionIdleTimeoutMs: z.natural().max(86_400_000).default(600_000),
  keepAliveInitialDelayMs: z.natural().max(86_400_000).default(60_000),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

const STALL_TIMEOUT_MS = 30_000
const STALL_WATCH_INTERVAL_MS = 5_000
const DEFAULT_MAX_CONNECTIONS = 256
const DEFAULT_MAX_CONNECTIONS_PER_IP = 64
const DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_KEEPALIVE_INITIAL_DELAY_MS = 60_000

interface SocketRecord {
  connectionId: string
  remoteAddress: string
  remotePort?: number
  connectedAt: number
}

interface ConnectionFiberConfig {
  open(ctx: Context): void | (() => void | Promise<void>)
}

function connectionFiber(ctx: Context, config: ConnectionFiberConfig) {
  return config.open(ctx)
}

/**
 * Cordis-native MTProto server.
 *
 * The service owns only process-wide resources. Every accepted TCP connection
 * is a child fiber, every RPC is a short-lived child fiber of that connection,
 * and protocol extension points are Cordis events dispatched with derived
 * contexts carrying the current connection/packet/RPC metadata.
 */
export class Mtproto extends Service {
  static Config = Config
  readonly rsaKey: ServerRsaKey

  private readonly _crypto: ICryptoProvider
  private readonly _readerMap: TlReaderMap
  private readonly _writerMap: TlWriterMap
  private readonly _authKeyStore: AuthKeyStore
  private readonly _authKeyData = new AuthKeyDataStore()
  private readonly _log: Logger
  private readonly _sessions = new Set<ServerSession>()
  private readonly _sockets = new Set<Socket>()
  private readonly _socketRecords = new Map<Socket, SocketRecord>()
  private readonly _connectionFibers = new Map<string, Fiber>()
  private readonly _authApiLayers = new Map<string, number>()
  private readonly _rpcDependencies = new RpcDependencyRegistry()
  private readonly _pqChallenges = new PqChallengeStore()
  private _connectionSeq = 0
  private _server: Server | null = null
  private readonly _maxConnections: number
  private readonly _maxConnectionsPerIp: number
  private readonly _connectionIdleTimeoutMs: number
  private readonly _keepAliveInitialDelayMs: number

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
    this._maxConnections = positiveLimit(config.maxConnections, DEFAULT_MAX_CONNECTIONS)
    this._maxConnectionsPerIp = positiveLimit(config.maxConnectionsPerIp, DEFAULT_MAX_CONNECTIONS_PER_IP)
    this._connectionIdleTimeoutMs = nonNegativeInteger(
      config.connectionIdleTimeoutMs,
      DEFAULT_CONNECTION_IDLE_TIMEOUT_MS,
    )
    this._keepAliveInitialDelayMs = nonNegativeInteger(
      config.keepAliveInitialDelayMs,
      DEFAULT_KEEPALIVE_INITIAL_DELAY_MS,
    )

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

  /** Number of currently open MTProto transport connections. */
  get activeConnectionCount(): number {
    return this._sessions.size
  }

  /** Number of open transports that have selected an auth key. */
  get authorizedConnectionCount(): number {
    let count = 0
    for (const session of this._sessions) {
      if (session.authKeyId) count++
    }
    return count
  }

  /**
   * Register one RPC route on the calling plugin's fiber.
   *
   * The routed Cordis event keeps registration HMR-safe and lets the
   * dispatch context select listeners through normal derived-context filters.
   */
  register(method: string, handler: RpcHandler): () => boolean {
    return registerRpcRoute(this.ctx, method, handler)
  }

  /** Dispatch a decoded RPC through a short-lived invocation fiber. */
  async dispatch(source: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult> {
    return invokeRpc(this.ctx, source, request)
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

  /** Notify every eligible unauthenticated connection that its QR login token was approved. */
  sendLoginTokenUpdateToAuthKey(authKeyId: Uint8Array, token: Uint8Array): number {
    let delivered = 0
    for (const session of this._sessions) {
      if (!equalBytes(session.authKeyId, authKeyId) || session.connection.stalledForMs >= STALL_TIMEOUT_MS) continue
      this._applyKnownApiLayer(session)
      if (session.sendLoginTokenUpdate(token)) delivered++
    }
    return delivered
  }

  /** Whether a permanent auth key is still registered for resumed connections. */
  async hasAuthKey(authKeyId: Uint8Array): Promise<boolean> {
    return Boolean(await this._authKeyStore.get(authKeyId))
  }

  /** Write the durable fail-closed marker and close other connections using this permanent key. */
  async beginAuthKeyRevocation(authKeyId: Uint8Array, originConnection?: ServerConnection): Promise<void> {
    try {
      await this._authKeyStore.beginRevocation(authKeyId)
    } catch (error) {
      if (error instanceof AuthKeyStorePublishedError) this._closeAuthKeyConnections(authKeyId)
      throw error
    }
    this._closeAuthKeyConnections(authKeyId, originConnection)
  }

  /** Purge one revoked key and close all connections using it. */
  async finishAuthKeyRevocation(authKeyId: Uint8Array): Promise<boolean> {
    try {
      return await this._authKeyStore.finishRevocation(authKeyId)
    } finally {
      this._authKeyData.delete(authKeyId)
      this._authApiLayers.delete(bytesHex(authKeyId))
      this._closeAuthKeyConnections(authKeyId)
    }
  }

  private _closeAuthKeyConnections(authKeyId: Uint8Array, exceptConnection?: ServerConnection): void {
    for (const session of [...this._sessions]) {
      if (session.connection !== exceptConnection && equalBytes(session.authKeyId, authKeyId)) {
        session.connection.close()
      }
    }
  }

  private _supersedeLoginToken(authKeyId: Uint8Array, token: Uint8Array, origin: ServerConnection): void {
    for (const session of this._sessions) {
      if (session.connection !== origin && equalBytes(session.authKeyId, authKeyId)) {
        session.supersedeLoginToken(token)
      }
    }
  }

  /** Revoke one permanent authorization and disconnect every connection using it. */
  async revokeAuthKey(authKeyId: Uint8Array): Promise<boolean> {
    await this.beginAuthKeyRevocation(authKeyId)
    return this.finishAuthKeyRevocation(authKeyId)
  }

  async* [Service.init]() {
    await this._crypto.initialize?.()
    try {
      await this._authKeyStore.recoverPendingRevocations()
    } catch (error) {
      this._log.warn('failed to recover pending auth key revocations: %s', error instanceof Error ? error.message : error)
    }

    const server = new Server((socket) => this._handleConnection(socket))
    this._server = server
    const host = this.config.host ?? '127.0.0.1'
    const port = this.config.port ?? 4430

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        this._log.info('listening on %s:%d', host, this.port)
        resolve()
      })
    })

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

    yield async () => {
      clearInterval(stallWatcher)
      for (const socket of this._sockets) socket.destroy()
      await Promise.allSettled([...this._connectionFibers.values()].map((fiber) => fiber.dispose()))
      this._connectionFibers.clear()
      this._sockets.clear()
      this._socketRecords.clear()
      this._rpcDependencies.clear()
      await new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
      })
      this._server = null
    }
  }

  private _handleConnection(socket: Socket): void {
    const connectionId = `conn-${++this._connectionSeq}`
    const record: SocketRecord = {
      connectionId,
      remoteAddress: normalizeRemoteAddress(socket.remoteAddress),
      remotePort: socket.remotePort,
      connectedAt: Date.now(),
    }
    this._evictConnectionsFor(record)
    this._sockets.add(socket)
    this._socketRecords.set(socket, record)

    const fiber = this.ctx.plugin(connectionFiber, {
      open: (ctx) => this._openConnection(ctx, socket, connectionId),
    })
    this._connectionFibers.set(connectionId, fiber)

    const dispose = () => {
      this._sockets.delete(socket)
      this._socketRecords.delete(socket)
      this._connectionFibers.delete(connectionId)
      void fiber.dispose()
    }
    socket.once('close', dispose)
    void fiber.await().catch((error) => {
      this._log.error('failed to initialize connection %s: %s', connectionId, error)
      socket.destroy()
    })
  }

  private _openConnection(ctx: Context, socket: Socket, connectionId: string) {
    const connLog = this._log.create(`conn:${socket.remoteAddress}:${socket.remotePort}`)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, this._keepAliveInitialDelayMs)

    let connectionCtx!: Context
    let scope!: MtprotoConnectionScope
    let trafficObserverEnabled = true
    const connection = new ServerConnection(socket, this._crypto, connLog, (sample) => {
      if (!trafficObserverEnabled) return
      try {
        const event: MtprotoTrafficSample = { ...sample, connection: scope }
        connectionCtx.emit(connectionCtx, 'mtproto/traffic', event)
      } catch (error) {
        trafficObserverEnabled = false
        connLog.error('MTProto traffic observer failed and was disabled: %s', error)
      }
    })
    const idleTimeout = this._connectionIdleTimeoutMs
      ? () => {
          connLog.warn(
            'connection idle for %d ms; closing to release retained session resources',
            this._connectionIdleTimeoutMs,
          )
          connection.close()
        }
      : undefined
    if (idleTimeout) {
      socket.setTimeout(this._connectionIdleTimeoutMs)
      socket.on('timeout', idleTimeout)
    }
    scope = {
      id: connectionId,
      connection,
      session: undefined as unknown as ServerSession,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      connectedAt: Date.now(),
    } satisfies MtprotoConnectionScope
    connectionCtx = ctx.extend({ mtprotoConnection: scope })
    const debug = (event: Omit<MtprotoDebugEvent, 'connectionId'>) => {
      const scoped = { ...event, connectionId }
      connectionCtx.emit(connectionCtx, 'mtproto/debug', scoped)
    }

    const session = new ServerSession(
      connectionCtx,
      connection,
      this._crypto,
      this._readerMap,
      this._writerMap,
      connLog,
      this.rsaKey.privateKeyPem,
      Long.fromString(this.rsaKey.fingerprint, true, 16),
      (rpc, request) => this.dispatch(rpc, request),
      this._authKeyData,
      this._authKeyStore,
      debug,
      (authKeyId, layer) => { void this._rememberApiLayer(authKeyId, layer) },
      (authKeyId) => this._authApiLayers.get(bytesHex(authKeyId)),
      (authKeyId, token, origin) => this._supersedeLoginToken(authKeyId, token, origin),
      this._rpcDependencies,
      this._pqChallenges,
    )
    scope.session = session
    this._sessions.add(session)

    debug({
      direction: 'client->server', phase: 'connection', timestamp: Date.now(),
      payload: {
        _: 'connection_opened',
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
      },
    })
    connectionCtx.emit(connectionCtx, 'mtproto/connection', scope, 'open')

    session.start()

    let closeEmitted = false
    const emitClose = () => {
      if (closeEmitted) return
      closeEmitted = true
      // Stop routing updates to this session immediately. Fiber disposal also
      // removes it, but asynchronous teardown may lag behind a reconnect storm.
      this._sessions.delete(session)
      debug({
        direction: 'client->server', phase: 'connection', timestamp: Date.now(),
        payload: { _: 'connection_closed' },
      })
      connectionCtx.emit(connectionCtx, 'mtproto/connection', scope, 'close')
    }
    socket.once('close', emitClose)

    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      socket.off('close', emitClose)
      if (idleTimeout) socket.off('timeout', idleTimeout)
      emitClose()
      connection.dispose()
      connection.close()
    }
  }

  private _evictConnectionsFor(incoming: SocketRecord): void {
    while (this._countConnectionsFrom(incoming.remoteAddress) >= this._maxConnectionsPerIp) {
      const oldest = this._oldestSocket((record) => record.remoteAddress === incoming.remoteAddress)
      if (!oldest) break
      this._evictSocket(oldest[0], oldest[1], 'per-IP connection limit', incoming)
    }
    while (this._socketRecords.size >= this._maxConnections) {
      const oldest = this._oldestSocket(() => true)
      if (!oldest) break
      this._evictSocket(oldest[0], oldest[1], 'global connection limit', incoming)
    }
  }

  private _countConnectionsFrom(remoteAddress: string): number {
    let count = 0
    for (const record of this._socketRecords.values()) {
      if (record.remoteAddress === remoteAddress) count++
    }
    return count
  }

  private _oldestSocket(predicate: (record: SocketRecord) => boolean): [Socket, SocketRecord] | undefined {
    for (const entry of this._socketRecords) {
      if (predicate(entry[1])) return entry
    }
  }

  private _evictSocket(
    socket: Socket,
    record: SocketRecord,
    reason: string,
    incoming: SocketRecord,
  ): void {
    this._socketRecords.delete(socket)
    this._sockets.delete(socket)
    this._log.warn(
      '%s reached while accepting %s:%d (%s); evicting oldest %s:%d (%s, age=%d ms)',
      reason,
      incoming.remoteAddress,
      incoming.remotePort ?? 0,
      incoming.connectionId,
      record.remoteAddress,
      record.remotePort ?? 0,
      record.connectionId,
      Math.max(0, incoming.connectedAt - record.connectedAt),
    )
    socket.destroy()
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
}

function normalizeRemoteAddress(address?: string): string {
  if (!address) return 'unknown'
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) return fallback
  return value
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) return fallback
  return value
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
