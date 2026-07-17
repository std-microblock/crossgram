export { Mtproto, default } from './service.js'
export type { MtprotoConfig } from './service.js'

export { RpcDispatcher, bareVector, isBareVector } from './rpc/dispatcher.js'
export type { RpcHandler, RpcResult, BareVector } from './rpc/dispatcher.js'
export type { ServerRpcContext } from './rpc/context.js'
export {
  CURRENT_API_LAYER,
  getApiLayerReaderMap,
  getApiLayerWriterMap,
  getHistoricalApiLayerReaderMap,
  resolveApiSchemaLayer,
} from './rpc/api-layer.js'
export { RpcError, RpcErrors, toRpcError, isRpcError } from './rpc/errors.js'

export { ServerConnection } from './transport/server-connection.js'
export { AbridgedPacketCodec, ServerObfuscatedCodec, createServerObfuscation } from './transport/server-obfuscation.js'
export { MemoryAuthKeyStore, FileAuthKeyStore, type AuthKeyStore } from './session/auth-key-store.js'
export { ServerSession } from './session/server-session.js'
export { ServerAuthKey } from './session/server-auth-key.js'
export { ServerMessageIdGenerator } from './session/message-id.js'
export { doServerAuthorization } from './session/server-authorization.js'
export type { AuthorizationResult } from './session/server-authorization.js'

export { generateRsaKeyPair, loadOrCreateRsaKeyPair, rsaRawDecrypt, generatePq } from './crypto/rsa-keygen.js'
export type { ServerRsaKey } from './crypto/rsa-keygen.js'
