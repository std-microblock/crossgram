import { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import {
  invokeRpc,
  registerRpcRoute,
  type RpcHandler,
  type RpcResult,
  type ServerRpcContext,
} from '@mtproto-relay/mtproto'

/** Event-native decoded-RPC harness used by bridge protocol tests. */
export interface CordisRpcTestHarness {
  register(method: string, handler: RpcHandler): void
  dispatch(context: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult>
  dispose(): void
}

export function createCordisRpcTestHarness(): CordisRpcTestHarness {
  const ctx = new Context()
  const disposers: Array<() => boolean> = []
  return {
    register(method, handler) {
      disposers.push(registerRpcRoute(ctx, method, handler))
    },
    dispatch(context, request) {
      return invokeRpc(ctx, context, request)
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}
