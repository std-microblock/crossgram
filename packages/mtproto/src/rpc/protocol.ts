import type { mtp, tl } from '@mtcute/core'
import type Long from 'long'
import type { MtprotoClientInfo, ServerRpcContext } from './context.js'
import { RpcError, RpcErrors, isRpcError, toRpcError } from './errors.js'

/**
 * A bare `Vector<X>` RPC result. Serialized as `0x1cb5c415` + count + items,
 * with no wrapping object — this is what `users.getUsers`, the legacy
 * `messages.getDialogFilters`, etc. return. Use {@link bareVector} to build one.
 */
export interface BareVector {
  /** Marker discriminant — distinguishes a bare vector from a TL object. */
  readonly _: 'vector'
  readonly items: readonly tl.TlObject[]
}

/** A bare Bool constructor serialized directly inside `rpc_result`. */
export interface BareBool {
  readonly _: 'boolTrue' | 'boolFalse'
}

/** Result of an RPC call — a TL response object, bare result, or MTProto rpc_error. */
export type RpcResult = tl.TlObject | BareBool | BareVector | mtp.RawMt_rpc_error

/** Build a bare `Vector<X>` RPC result (e.g. for `users.getUsers`). */
export function bareVector(items: readonly tl.TlObject[]): BareVector {
  return { _: 'vector', items }
}

/** Type guard for a {@link BareVector} result. */
export function isBareVector(result: unknown): result is BareVector {
  return typeof result === 'object'
    && result !== null
    && (result as { _: string })._ === 'vector'
    && Array.isArray((result as { items?: unknown }).items)
}

export interface UnwrappedRpcRequest {
  request: tl.RpcMethod
  /** Layer declared by invokeWithLayer, if this request negotiated one. */
  apiLayer: number | null
  /** Device/application metadata declared by initConnection, if present. */
  clientInfo: MtprotoClientInfo | null
  /** Earlier MTProto message ids that must finish before this request runs. */
  afterMessageIds: readonly Long[]
}

const RPC_WRAPPER_METHODS = new Set([
  'initConnection',
  'invokeAfterMsg',
  'invokeAfterMsgs',
  'invokeWithLayer',
  'invokeWithMessagesRange',
  'invokeWithTakeout',
  'invokeWithoutUpdates',
])

/** Whether a decoded TL object is an API RPC method or a known RPC envelope. */
export function isRpcRequestObject(method: string): boolean {
  return method.includes('.') || RPC_WRAPPER_METHODS.has(method)
}

/** Unwrap Telegram RPC envelopes while explicitly returning invokeWithLayer.layer. */
export function unwrapRpcRequest(request: tl.RpcMethod): UnwrappedRpcRequest {
  let req = request
  let apiLayer: number | null = null
  let clientInfo: MtprotoClientInfo | null = null
  const afterMessageIds: Long[] = []
  for (;;) {
    const method = req._
    if (method === 'invokeWithLayer') {
      const wrapper = req as unknown as { layer: number, query: tl.RpcMethod }
      if (Number.isInteger(wrapper.layer) && wrapper.layer > 0) apiLayer = wrapper.layer
      req = wrapper.query
      continue
    }
    if (method === 'initConnection') {
      const wrapper = req as unknown as tl.RawInitConnectionRequest<tl.RpcMethod>
      clientInfo = {
        apiId: wrapper.apiId,
        deviceModel: wrapper.deviceModel,
        systemVersion: wrapper.systemVersion,
        appVersion: wrapper.appVersion,
        systemLangCode: wrapper.systemLangCode,
        langPack: wrapper.langPack,
        langCode: wrapper.langCode,
      }
      req = wrapper.query
      continue
    }
    if (method === 'invokeWithoutUpdates') {
      req = (req as unknown as { query: tl.RpcMethod }).query
      continue
    }
    if (method === 'invokeAfterMsg') {
      const wrapper = req as unknown as { msgId: Long, query: tl.RpcMethod }
      afterMessageIds.push(wrapper.msgId)
      req = wrapper.query
      continue
    }
    if (method === 'invokeAfterMsgs') {
      const wrapper = req as unknown as { msgIds: Long[], query: tl.RpcMethod }
      afterMessageIds.push(...wrapper.msgIds)
      req = wrapper.query
      continue
    }
    if (method === 'invokeWithMessagesRange' || method === 'invokeWithTakeout') {
      req = (req as unknown as { query: tl.RpcMethod }).query
      continue
    }
    return { request: req, apiLayer, clientInfo, afterMessageIds }
  }
}

/**
 * An RPC handler receives the deserialized TL request and context,
 * and returns an RPC result (or throws an RpcError).
 */
export type RpcHandler = (ctx: ServerRpcContext, request: tl.RpcMethod) => Promise<RpcResult>

export { RpcError, RpcErrors, toRpcError, isRpcError }
export type { ServerRpcContext }
