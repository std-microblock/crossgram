import type { tl } from '@mtcute/core'
import type Long from 'long'
import type { ServerConnection } from '../transport/server-connection.js'

/**
 * Context passed to every RPC handler. Gives handlers access to the connection,
 * the current auth/session identity, a way to push server-initiated updates, and
 * a per-session scratch slot for backend state (e.g. the resolved platform session).
 */
export interface ServerRpcContext {
  /** The underlying client connection. */
  connection: ServerConnection
  /** API layer declared by invokeWithLayer, retained for the whole MTProto session. */
  readonly apiLayer: number | null
  /** The permanent auth key id (8 bytes), or null before authorization. */
  authKeyId: Uint8Array | null
  /** The client's MTProto session id. */
  sessionId: Long
  /** Whether the DH handshake has completed. */
  isAuthorized: boolean
  /** Backend route selected for this account, or null before routing. */
  routeId: string | null
  /** Push a server-initiated update to this client. */
  sendUpdate: (update: tl.TypeUpdates) => void
  /** Read backend-specific data shared by all connections using this auth key. */
  getPlatformData: <T>() => T
  /** Store backend-specific data for this permanent auth key. */
  setPlatformData: (data: unknown) => void
}
