import type { mtp, tl } from '@mtcute/core'
import type { ServerRpcContext } from './context.js'
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

/** Result of an RPC call — a TL response object, a bare vector, or an MTProto rpc_error. */
export type RpcResult = tl.TlObject | BareVector | mtp.RawMt_rpc_error

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
}

/** Unwrap Telegram RPC envelopes while explicitly returning invokeWithLayer.layer. */
export function unwrapRpcRequest(request: tl.RpcMethod): UnwrappedRpcRequest {
  let req = request
  let apiLayer: number | null = null
  for (;;) {
    const method = req._
    if (method === 'invokeWithLayer') {
      const wrapper = req as unknown as { layer: number, query: tl.RpcMethod }
      if (Number.isInteger(wrapper.layer) && wrapper.layer > 0) apiLayer = wrapper.layer
      req = wrapper.query
      continue
    }
    if (method === 'initConnection' || method === 'invokeWithoutUpdates') {
      req = (req as unknown as { query: tl.RpcMethod }).query
      continue
    }
    if (method === 'invokeAfterMsg' || method === 'invokeAfterMsgs' || method === 'invokeWithMessagesRange' || method === 'invokeWithTakeout') {
      req = (req as unknown as { query: tl.RpcMethod }).query
      continue
    }
    return { request: req, apiLayer }
  }
}

/**
 * An RPC handler receives the deserialized TL request and context,
 * and returns an RPC result (or throws an RpcError).
 */
export type RpcHandler = (ctx: ServerRpcContext, request: tl.RpcMethod) => Promise<RpcResult>

/**
 * Dispatches incoming RPC calls to registered handlers by method name.
 *
 * Method names use the dot notation from the TL schema (e.g. `'help.getConfig'`,
 * `'auth.sendCode'`, `'messages.sendMessage'`).
 */
export class RpcDispatcher {
  private _handlers = new Map<string, RpcHandler>()
  private _fallback?: RpcHandler

  /**
   * Register a handler for a specific RPC method.
   */
  register(method: string, handler: RpcHandler): this {
    this._handlers.set(method, handler)
    return this
  }

  /**
   * Remove a handler for a specific RPC method. Returns true if one existed.
   * Used by lifecycle-managed registration (cordis effects / HMR reload).
   */
  unregister(method: string): boolean {
    return this._handlers.delete(method)
  }

  /**
   * Register a fallback handler that receives all unregistered methods.
   * If no fallback is set, unregistered methods return a 500 error.
   */
  fallback(handler: RpcHandler): this {
    this._fallback = handler
    return this
  }

  /** Remove the fallback handler (for lifecycle-managed registration / HMR). */
  clearFallback(): void {
    this._fallback = undefined
  }

  /**
   * Dispatch an RPC call to the appropriate handler.
   * Unwraps `invokeWithLayer`/`initConnection`/`invokeWithoutUpdates` wrappers
   * automatically. Returns the TL response object, or an `rpc_error` on failure.
   */
  async dispatch(ctx: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult> {
    const req = unwrapRpcRequest(request).request

    const method = req._
    const handler = this._handlers.get(method) ?? this._fallback

    if (!handler) {
      return toRpcError(RpcErrors.notImplemented(method))
    }

    try {
      return await handler(ctx, req)
    } catch (e) {
      if (isRpcError(e)) {
        return toRpcError(e)
      }
      const msg = e instanceof Error ? e.message : String(e)
      return toRpcError(RpcErrors.internal(msg))
    }
  }

  /** Check if a method has a registered handler */
  has(method: string): boolean {
    return this._handlers.has(method) || !!this._fallback
  }
}

export { RpcError, RpcErrors, toRpcError, isRpcError }
export type { ServerRpcContext }
