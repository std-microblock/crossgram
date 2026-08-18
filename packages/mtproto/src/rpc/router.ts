import { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import type { CordisServerRpcContext, ServerRpcContext } from './context.js'
import { unwrapRpcRequest, type RpcHandler, type RpcResult } from './protocol.js'
import { RpcErrors, isRpcError, toRpcError } from './errors.js'

interface RpcInvocationFiberConfig {
  request: tl.RpcMethod
  result?: RpcResult
}

async function rpcInvocationFiber(ctx: Context, config: RpcInvocationFiberConfig) {
  Object.defineProperty(ctx, 'cordis', { value: ctx, configurable: true })
  config.result = await dispatchRpcRoute(ctx as CordisServerRpcContext, config.request)
}

/** Register one method route as an effect owned by the calling Cordis fiber. */
export function registerRpcRoute(ctx: Context, method: string, handler: RpcHandler): () => boolean {
  return ctx.on('mtproto/rpc/method', function (this: CordisServerRpcContext, current, request) {
    if (current !== method) return
    return handler(this, request)
  }, { prepend: true })
}

/** Run the Cordis middleware and method-route events for one normalized request. */
export async function dispatchRpcRoute(
  ctx: CordisServerRpcContext,
  request: tl.RpcMethod,
): Promise<RpcResult> {
  try {
    const result = await ctx.events.waterfall(
      ctx,
      'mtproto/rpc',
      request,
      () => ctx.events.serial(ctx, 'mtproto/rpc/method', request._, request),
    ) as RpcResult | undefined
    if (result !== undefined) return result
    return toRpcError(RpcErrors.notImplemented(request._))
  } catch (error) {
    if (isRpcError(error)) return toRpcError(error)
    const message = error instanceof Error ? error.message : String(error)
    return toRpcError(RpcErrors.internal(message))
  }
}

/**
 * Normalize a decoded request and execute it inside a short-lived child fiber.
 * This is the only RPC invocation path used by the MTProto service and tests.
 */
export async function invokeRpc(
  owner: Context,
  source: ServerRpcContext,
  request: tl.RpcMethod,
): Promise<RpcResult> {
  request = unwrapRpcRequest(request).request
  const base = Context.is(source) ? source : owner.extend(source)
  const connection = source.connection
  const connectionScope = source.mtprotoConnection ?? {
    id: 'direct-dispatch',
    connection,
    session: undefined as never,
    remoteAddress: connection.remoteAddress,
  }
  const parent = base.extend({
    mtprotoConnection: connectionScope,
    mtprotoRpc: source.mtprotoRpc ?? {
      connection: connectionScope,
      request,
      messageId: Long.ZERO,
      receivedAt: Date.now(),
    },
  })
  const config: RpcInvocationFiberConfig = { request }
  const fiber = parent.plugin(rpcInvocationFiber, config)
  try {
    await fiber
    return config.result!
  } finally {
    await fiber.dispose()
  }
}
