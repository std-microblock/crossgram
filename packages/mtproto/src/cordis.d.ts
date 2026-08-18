import 'cordis'
import type { tl } from '@mtcute/core'
import type {
  MtprotoConnectionScope,
  MtprotoPacketScope,
  MtprotoTrafficSample,
  MtprotoRpcScope,
  CordisServerRpcContext,
} from './rpc/context.js'
import type { RpcResult } from './rpc/protocol.js'
import type { MtprotoDebugEvent } from './debug.js'
import type { Mtproto } from './service.js'

declare module 'cordis' {
  interface Context {
    mtproto: Mtproto
    /** Present on connection fibers and all of their descendants. */
    mtprotoConnection: MtprotoConnectionScope
    /** Present while one decoded transport packet is being processed. */
    mtprotoPacket: MtprotoPacketScope
    /** Present on the short-lived fiber of one RPC invocation. */
    mtprotoRpc: MtprotoRpcScope
  }

  interface Events {
    'mtproto/connection'(connection: MtprotoConnectionScope, state: 'open' | 'close'): void
    'mtproto/debug'(event: MtprotoDebugEvent): void
    'mtproto/traffic'(sample: MtprotoTrafficSample): void
    'mtproto/packet'(
      this: Context,
      packet: MtprotoPacketScope,
      next: () => Promise<void>,
    ): Promise<void>
    'mtproto/rpc'(
      this: CordisServerRpcContext,
      request: tl.RpcMethod,
      next: () => Promise<RpcResult | undefined>,
    ): Promise<RpcResult | undefined>
    'mtproto/rpc/method'(
      this: CordisServerRpcContext,
      method: string,
      request: tl.RpcMethod,
    ): Promise<RpcResult | undefined>
  }
}
