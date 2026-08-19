import type { tl } from '@mtcute/core'
import { RpcError } from '@mtproto-relay/mtproto'
import type { MessageStore } from '../message-store.js'
import type { IMPlatform, PlatformSession } from '../platform.js'
import {
  CallRegistry, type CallPeer, type IncomingCall, type PlatformCallControl, VoiceCallError,
} from './call-registry.js'
import { getDhConfig } from './dh-config.js'

/** RPC adapter around the transient registry; it performs no database writes. */
export class VoiceRpc {
  constructor(
    private readonly _calls: CallRegistry,
    private readonly _store: MessageStore,
  ) {}

  async getCallConfig(): Promise<tl.RawDataJSON> {
    // No relay credentials or worker endpoint data are ever exposed to JS clients.
    return { _: 'dataJSON', data: '{}' }
  }

  getDhConfig(request: tl.messages.RawGetDhConfigRequest): tl.messages.TypeDhConfig {
    return getDhConfig(request)
  }

  async request(
    platform: IMPlatform,
    session: PlatformSession,
    request: tl.phone.RawRequestCallRequest,
    excludeAuthKeyId?: string,
  ): Promise<tl.phone.RawPhoneCall> {
    this._requireQq(platform)
    if (request.video) throw new RpcError(400, 'CALL_VIDEO_UNSUPPORTED')
    const { selfId, participantId } = await this._participants(session, request.userId)
    try {
      return await this._calls.request({
        session, selfId, participantId, randomId: request.randomId,
        gAHash: request.gAHash, protocol: request.protocol, excludeAuthKeyId,
      })
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async received(
    session: PlatformSession,
    request: tl.phone.RawReceivedCallRequest,
    excludeAuthKeyId?: string,
  ): Promise<tl.TlObject> {
    try {
      await this._calls.received(session, peer(request.peer), excludeAuthKeyId)
      return { _: 'boolTrue' } as unknown as tl.TlObject
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async accept(
    session: PlatformSession,
    request: tl.phone.RawAcceptCallRequest,
    excludeAuthKeyId?: string,
    afterResponse?: (task: () => void | Promise<void>) => void,
  ): Promise<tl.phone.RawPhoneCall> {
    try {
      return await this._calls.accept(
        session, peer(request.peer), request.gB, request.protocol, excludeAuthKeyId, afterResponse,
      )
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async confirm(
    session: PlatformSession,
    request: tl.phone.RawConfirmCallRequest,
    excludeAuthKeyId?: string,
  ): Promise<tl.phone.RawPhoneCall> {
    try {
      return await this._calls.confirm(
        session, peer(request.peer), request.gA, request.keyFingerprint, request.protocol, excludeAuthKeyId,
      )
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async discard(
    session: PlatformSession,
    request: tl.phone.RawDiscardCallRequest,
    excludeAuthKeyId?: string,
  ): Promise<tl.RawUpdates> {
    if (request.video) throw new RpcError(400, 'CALL_VIDEO_UNSUPPORTED')
    try {
      const phoneCall = await this._calls.discard(
        session, peer(request.peer), request.reason, request.duration, excludeAuthKeyId,
      )
      return {
        _: 'updates', updates: [{ _: 'updatePhoneCall', phoneCall }], users: [], chats: [],
        date: Math.floor(Date.now() / 1_000), seq: 0,
      }
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async sendSignalingData(
    session: PlatformSession,
    request: tl.phone.RawSendSignalingDataRequest,
  ): Promise<tl.TlObject> {
    try {
      await this._calls.sendSignalingData(session, peer(request.peer), request.data)
      return { _: 'boolTrue' } as unknown as tl.TlObject
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async saveCallDebug(
    session: PlatformSession,
    request: tl.phone.RawSaveCallDebugRequest,
  ): Promise<tl.TlObject> {
    try {
      await this._calls.saveCallDebug(session, peer(request.peer), request.debug)
      return { _: 'boolTrue' } as unknown as tl.TlObject
    } catch (error) {
      throw asRpcError(error)
    }
  }

  /** QQ/native-call seam; callers must have already authenticated the event. */
  async receiveIncoming(
    session: PlatformSession,
    remotePlatformUserId: string,
    correlationId: string,
    platformControl?: PlatformCallControl,
  ): Promise<tl.RawPhoneCallRequested | tl.RawPhoneCallDiscarded> {
    const [self, remote] = await Promise.all([
      this._store.getUser(session.platformId, session.userId),
      this._store.getUser(session.platformId, remotePlatformUserId),
    ])
    if (!self || !remote || self.id === remote.id) throw new RpcError(400, 'CALL_USER_INVALID')
    try {
      const incoming: IncomingCall = {
        session, selfId: self.id, callerId: remote.id, correlationId,
        platformCallRef: correlationId, platformControl,
      }
      return await this._calls.receiveIncoming(incoming)
    } catch (error) {
      throw asRpcError(error)
    }
  }

  async platformEnded(session: PlatformSession, correlationId: string): Promise<void> {
    try {
      await this._calls.platformEnded(session, correlationId)
    } catch (error) {
      throw asRpcError(error)
    }
  }

  private async _participants(
    session: PlatformSession,
    input: tl.TypeInputUser,
  ): Promise<{ selfId: number, participantId: number }> {
    if (input._ !== 'inputUser' && input._ !== 'inputUserFromMessage') {
      throw new RpcError(400, 'CALL_USER_INVALID')
    }
    const [self, participant] = await Promise.all([
      this._store.getUser(session.platformId, session.userId),
      this._store.getUserByTlId(session.platformId, input.userId),
    ])
    if (!self || !participant || self.id === participant.id) throw new RpcError(400, 'CALL_USER_INVALID')
    return { selfId: self.id, participantId: participant.id }
  }

  private _requireQq(platform: IMPlatform): void {
    if (platform.platformKind !== 'qq') throw new RpcError(400, 'CALL_PLATFORM_UNSUPPORTED')
  }
}

function peer(input: tl.TypeInputPhoneCall): CallPeer {
  if (input._ !== 'inputPhoneCall') throw new RpcError(400, 'CALL_PEER_INVALID')
  return { id: input.id, accessHash: input.accessHash }
}

function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error
  if (error instanceof VoiceCallError) return new RpcError(400, error.code)
  return new RpcError(500, 'CALL_WORKER_FAILED')
}
