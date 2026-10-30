import { Context, Service, type Fiber } from 'cordis'
import { Server } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import { __tlWriterMap, LogManager, type ICryptoProvider, type Logger } from '@mtcute/core/utils.js'
import type { tl } from '@mtcute/core'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import Long from 'long'
import { getServerReaderMap } from './rpc/server-reader-map.js'
import { ServerConnection } from './transport/server-connection.js'
import type { ServerTransportSocket } from './transport/server-socket.js'
import { listenWebSocketServer, WebSocketBridge, type WebSocketServerHandle } from './transport/ws-server.js'
import type { WebSocket } from 'ws'
import { RpcDependencyRegistry, ServerSession } from './session/server-session.js'
import { PqChallengeStore } from './session/server-authorization.js'
import {
  AuthKeyStorePublishedError, MemoryAuthKeyStore, FileAuthKeyStore, type AuthKeyStore,
} from './session/auth-key-store.js'
import { AuthKeyDataStore, authKeyIdHex } from './session/auth-key-data-store.js'
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
  /** TCP 监听端口（默认 4430；0 表示随机端口） */
  port?: number
  /** 浏览器客户端使用的独立 WebSocket 端口（不传则禁用；0 表示随机端口） */
  wsPort?: number
  /** 在宿主 Cordis HTTP 服务上挂载同源 MTProto-over-WebSocket 的路径 */
  wsPath?: string
  /** 监听地址（默认 127.0.0.1） */
  host?: string
  /** 加密实现（默认 NodeCryptoProvider） */
  crypto?: ICryptoProvider
  /** 服务端 RSA 密钥对（若与 rsaKeyPath 均未指定则自动生成） */
  rsaKey?: ServerRsaKey
  /** RSA 密钥对 JSON 持久化路径（公钥 PEM 同步写入 `<path>.pem`） */
  rsaKeyPath?: string
  /** TL reader map（默认使用包含 RPC 方法请求的服务端 reader map） */
  readerMap?: TlReaderMap
  /** TL writer map（默认使用 mtcute 内置实例） */
  writerMap?: TlWriterMap
  /** auth key 持久化文件路径（默认仅存内存） */
  authKeyStorePath?: string
  /** 自定义 auth key 存储实例（优先于 authKeyStorePath） */
  authKeyStore?: AuthKeyStore
  /** 自定义 mtcute 日志器（默认转发至 `ctx.logger`） */
  log?: Logger | LogManager
  /** 全局最大并发 TCP 连接数（默认 256） */
  maxConnections?: number
  /** 单 IP 最大并发 TCP 连接数（默认 64） */
  maxConnectionsPerIp?: number
  /** 连接空闲超时毫秒数（默认 10 分钟；0 表示禁用） */
  connectionIdleTimeoutMs?: number
  /** TCP keepalive 首次探测延迟毫秒数（默认 60 秒） */
  keepAliveInitialDelayMs?: number
}

export const Config = z.object({
  port: z.natural().max(65_535).default(4430),
  wsPort: z.natural().max(65_535),
  wsPath: z.string(),
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

/** 宿主 Cordis HTTP 服务用于挂载同源 WebSocket 的最小接口 */
interface WsCapableServer {
  ws(path: string, handler: (
    req: { _req: IncomingMessage },
    accept: () => Promise<WebSocket>,
  ) => unknown): unknown
}

interface ConnectionFiberConfig {
  open(ctx: Context): void | (() => void | Promise<void>)
}

function connectionFiber(ctx: Context, config: ConnectionFiberConfig) {
  return config.open(ctx)
}

/**
 * 基于 Cordis 的 MTProto 服务端。
 *
 * 每个客户端连接与每次 RPC 调用分别运行在独立的子 Fiber 中，
 * 协议扩展点通过携带连接/报文/RPC 上下文的 Cordis 事件派发。
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
  private readonly _sockets = new Set<ServerTransportSocket>()
  private readonly _socketRecords = new Map<ServerTransportSocket, SocketRecord>()
  private readonly _connectionFibers = new Map<string, Fiber>()
  private readonly _authApiLayers = new Map<string, number>()
  private readonly _rpcDependencies = new RpcDependencyRegistry()
  private readonly _pqChallenges = new PqChallengeStore()
  private _connectionSeq = 0
  private _server: Server | null = null
  private _wsServer: WebSocketServerHandle | null = null
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

  /** 实际绑定的 TCP 端口（配置为 0 时返回系统分配的端口） */
  get port(): number {
    const addr = this._server?.address()
    return addr && typeof addr === 'object' ? addr.port : (this.config.port ?? 4430)
  }

  /** 实际绑定的独立 WebSocket 端口（未启用时为 `null`） */
  get wsPort(): number | null {
    return this._wsServer?.port ?? null
  }

  /** 当前活跃的传输层连接数 */
  get activeConnectionCount(): number {
    return this._sessions.size
  }

  /** 已完成 auth key 协商的连接数 */
  get authorizedConnectionCount(): number {
    let count = 0
    for (const session of this._sessions) {
      if (session.authKeyId) count++
    }
    return count
  }

  /** 在调用方插件的 Fiber 上注册一条 RPC 路由，随插件生命周期自动卸载 */
  register(method: string, handler: RpcHandler): () => boolean {
    return registerRpcRoute(this.ctx, method, handler)
  }

  /** 在短生命周期的调用子 Fiber 中派发一次已解码的 RPC 请求 */
  async dispatch(source: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult> {
    return invokeRpc(this.ctx, source, request)
  }

  /** 向所有已授权且未卡死的会话广播服务端主动推送的 Update */
  broadcastUpdate(update: tl.TypeUpdates): void {
    for (const session of this._sessions) {
      if (session.connection.stalledForMs >= STALL_TIMEOUT_MS) continue
      this._applyKnownApiLayer(session)
      session.sendUpdate(update)
    }
  }

  /** 向指定永久 auth key 关联的连接推送 Update，返回实际投递的连接数 */
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
    // 客户端仅在调用 updates.getState/getDifference/getChannelDifference 后才会标记连接接收推送。
    // 重连初期尚未调用这些方法，且 Telegram Desktop 会在同一 key 下并行维持主连接与媒体连接；
    // 若此时尚无明确接收推送的连接，则向该 key 下所有健康连接投递（ServerSession 会缓存至协商出 API layer，客户端也会按 pts 去重）。
    const targets = updateSessions.length ? updateSessions : healthy
    for (const session of targets) {
      this._applyKnownApiLayer(session)
      session.sendUpdate(update)
    }
    return targets.length
  }

  /** 通知指定 auth key 下等待扫码登录的连接：二维码已被确认 */
  sendLoginTokenUpdateToAuthKey(authKeyId: Uint8Array, token: Uint8Array): number {
    let delivered = 0
    for (const session of this._sessions) {
      if (!equalBytes(session.authKeyId, authKeyId) || session.connection.stalledForMs >= STALL_TIMEOUT_MS) continue
      this._applyKnownApiLayer(session)
      if (session.sendLoginTokenUpdate(token)) delivered++
    }
    return delivered
  }

  /** 检查永久 auth key 是否仍在存储中注册有效 */
  async hasAuthKey(authKeyId: Uint8Array): Promise<boolean> {
    return Boolean(await this._authKeyStore.get(authKeyId))
  }

  /** 写入持久化吊销 tombstone，并关闭该永久 key 关联的其他连接 */
  async beginAuthKeyRevocation(authKeyId: Uint8Array, originConnection?: ServerConnection): Promise<void> {
    try {
      await this._authKeyStore.beginRevocation(authKeyId)
    } catch (error) {
      if (error instanceof AuthKeyStorePublishedError) this._closeAuthKeyConnections(authKeyId)
      throw error
    }
    this._closeAuthKeyConnections(authKeyId, originConnection)
  }

  /** 彻底移除已吊销的 key 及其关联状态，并关闭所有使用该 key 的连接 */
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

  /** 吊销指定永久 auth key 并断开其所有连接 */
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

    if (this.config.wsPort !== undefined) {
      this._wsServer = await listenWebSocketServer(
        { host, port: this.config.wsPort },
        (socket) => this._handleConnection(socket),
      )
      this._log.info('websocket listening on %s:%d', host, this._wsServer.port)
    }

    if (this.config.wsPath) {
      // 仅在宿主同时启用了 HTTP server 服务时注册同源 WebSocket 路由
      this.ctx.inject(['server'], (ctx) => {
        const wsServer = (ctx as unknown as { server: WsCapableServer }).server
        const handleWs = async (req: { _req: IncomingMessage }, accept: () => Promise<WebSocket>) => {
          const ws = await accept()
          this._handleConnection(new WebSocketBridge(ws, req._req))
        }
        // Web 客户端会按 test/premium 会话在路径后追加 _test/_premium 后缀
        for (const path of [this.config.wsPath!, `${this.config.wsPath!}_test`, `${this.config.wsPath!}_premium`]) {
          wsServer.ws(path, handleWs)
        }
      })
    }

    const stallWatcher = setInterval(() => {
      this._pruneIdleState()
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
      this._authKeyData.clear()
      this._authApiLayers.clear()
      await new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
      })
      this._server = null
      await this._wsServer?.close()
      this._wsServer = null
    }
  }

  private _pruneIdleState(): void {
    const activeKeys = new Set(this._rpcDependencies.inFlightAuthKeyIds)
    for (const session of this._sessions) {
      if (!session.connection.closed && session.authKeyId) {
        activeKeys.add(authKeyIdHex(session.authKeyId))
      }
    }
    for (const key of this._authKeyData.prune(activeKeys)) this._authApiLayers.delete(key)
    this._rpcDependencies.prune()
  }

  private _handleConnection(socket: ServerTransportSocket): void {
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

  private _openConnection(ctx: Context, socket: ServerTransportSocket, connectionId: string) {
    const connLog = this._log.create(`conn:${socket.remoteAddress}:${socket.remotePort}`)
    socket.setNoDelay?.(true)
    socket.setKeepAlive?.(true, this._keepAliveInitialDelayMs)

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
      socket.setTimeout?.(this._connectionIdleTimeoutMs)
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
      // 立即从活跃会话集合中移除，避免异步 Fiber 清理完成前继续向已断开的连接推送消息
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

  private _oldestSocket(predicate: (record: SocketRecord) => boolean): [ServerTransportSocket, SocketRecord] | undefined {
    for (const entry of this._socketRecords) {
      if (predicate(entry[1])) return entry
    }
  }

  private _evictSocket(
    socket: ServerTransportSocket,
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
