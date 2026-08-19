import type { tl } from '@mtcute/core'
import type { Context } from 'cordis'
import type Long from 'long'
import type { ServerConnection } from '../transport/server-connection.js'
import type { ServerSession } from '../session/server-session.js'

/** Metadata owned by the lifetime fiber of one TCP connection. */
export interface MtprotoConnectionScope {
  id: string
  connection: ServerConnection
  session: ServerSession
  remoteAddress?: string
  remotePort?: number
  /** Wall-clock time when this TCP connection was accepted. */
  connectedAt?: number
  /** Most recent decoded API RPC received on this connection. */
  lastActiveAt?: number
  /** Client metadata announced by initConnection. */
  clientInfo?: MtprotoClientInfo
}

/** Stable device/application metadata announced by Telegram's initConnection wrapper. */
export interface MtprotoClientInfo {
  apiId: number
  deviceModel: string
  systemVersion: string
  appVersion: string
  systemLangCode: string
  langPack: string
  langCode: string
}

/** Metadata attached to the derived context of one decoded transport packet. */
export interface MtprotoPacketScope {
  connection: MtprotoConnectionScope
  sequence: number
  data: Uint8Array
}

/** Raw TCP traffic observed at the transport boundary. */
export interface MtprotoTrafficSample {
  connection: MtprotoConnectionScope
  direction: 'received' | 'sent'
  bytes: number
  timestamp: number
}

/** Metadata attached to the short-lived fiber of one RPC invocation. */
export interface MtprotoRpcScope {
  connection: MtprotoConnectionScope
  request: tl.RpcMethod
  messageId: Long
  receivedAt: number
}

/**
 * Context passed to every RPC handler. Gives handlers access to the connection,
 * the current auth/session identity, a way to push server-initiated updates, and
 * a per-session scratch slot for backend state (e.g. the resolved platform session).
 */
export interface ServerRpcContext {
  /** The Cordis derived context for this invocation, when dispatched by Mtproto. */
  readonly cordis?: Context
  /** Connection-level metadata inherited from the connection fiber. */
  readonly mtprotoConnection?: MtprotoConnectionScope
  /** Invocation-level metadata owned by the current RPC fiber. */
  readonly mtprotoRpc?: MtprotoRpcScope
  /** The underlying client connection. */
  connection: ServerConnection
  /** API layer declared by invokeWithLayer, retained for the whole MTProto session. */
  readonly apiLayer: number | null
  /** Client metadata retained from the latest initConnection on this connection. */
  readonly clientInfo?: MtprotoClientInfo
  /** Wall-clock time when this TCP connection was accepted. */
  readonly connectedAt?: number
  /** Wall-clock time of this decoded RPC. */
  readonly lastActiveAt?: number
  /** The permanent auth key id (8 bytes), or null before authorization. */
  authKeyId: Uint8Array | null
  /** The client's MTProto session id. */
  sessionId: Long
  /** Whether the DH handshake has completed. */
  isAuthorized: boolean
  /** Push a server-initiated update to this client. */
  sendUpdate: (update: tl.TypeUpdates) => void
  /**
   * Register work that must start only after this RPC's `rpc_result` has been
   * queued on the connection. This is used by state machines whose update is
   * meaningful only after the client has consumed the matching RPC result.
   */
  afterResponse?: (task: () => void | Promise<void>) => void
  /** Read backend-specific data shared by all connections using this auth key. */
  getPlatformData: <T>() => T
  /** Store backend-specific data for this permanent auth key. */
  setPlatformData: (data: unknown) => void
}

/** Actual runtime shape used by the Cordis-native server dispatch path. */
export type CordisServerRpcContext = Context & ServerRpcContext & {
  readonly cordis: Context
  readonly mtprotoConnection: MtprotoConnectionScope
  readonly mtprotoRpc: MtprotoRpcScope
}
