import { Service, type Context } from 'cordis'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'
import type { DialogRpc } from './dialogs.js'
import type { IMPlatform, PlatformSession } from './platform.js'
import type { StickerRpc } from './sticker-rpc.js'

export interface BridgeSessionState {
  generation: object
  platform: IMPlatform
  session: PlatformSession
  dialogs: DialogRpc
  stickers: StickerRpc
}

export type BridgeSessionResolver = (
  rpc: ServerRpcContext,
  provisionalIdentity?: { platformId: string, platformSessionId: string },
  cache?: boolean,
) => Promise<BridgeSessionState>

/** Public Cordis seam for feature plugins that extend authorized Bridge RPCs. */
export class MtprotoBridgeService extends Service {
  constructor(ctx: Context, private readonly _resolveSession: BridgeSessionResolver) {
    super(ctx, 'mtprotoBridge')
  }

  resolveSession(rpc: ServerRpcContext): Promise<BridgeSessionState> {
    return this._resolveSession(rpc)
  }
}
