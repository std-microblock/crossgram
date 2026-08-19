import { randomUUID } from 'node:crypto'
import { Service, type Context } from 'cordis'
import type { IMConversation, IMEvent, IMMessage, IMMessageInput, PlatformSession, Unsubscribe } from './platform.js'
import type { PlatformEventDeliveryOptions, PlatformEventPublishResult } from './platform-manager.js'

/** A bridge-owned direct peer supplied by an optional, provider-neutral package. */
export interface SystemPeer {
  id: string
  conversation: IMConversation
}

/** A peer resolution permanently bound to the provider that resolved it. */
export interface SystemPeerResolution {
  peer: SystemPeer
  readonly provider: SystemPeerProvider
}

/** Provider-neutral callback input sourced from a durable bridge message. */
export interface SystemPeerCallbackInput {
  message: IMMessage
  data: string
}

/** Provider-neutral callback response mapped by the MTProto RPC boundary. */
export interface SystemPeerCallbackResult {
  alert?: boolean
  message?: string
  url?: string
  cacheTime?: number
}

/** Provider contract for bridge-owned peers. It intentionally has no protocol-specific types. */
export interface SystemPeerProvider {
  /** Create any peers and durable welcome messages for one active platform session. */
  bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void>
  /** Return a peer only when it belongs to this platform session. */
  resolve(session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined>
  /** Called only after the user's outgoing message was canonically committed. */
  receive?(
    session: PlatformSession,
    peer: SystemPeer,
    message: IMMessage,
    peers: SystemPeerService,
    input?: IMMessageInput,
  ): Promise<void>
  /** Resolve a provider-owned callback from its durable source message. */
  callback?(
    session: PlatformSession,
    peer: SystemPeer,
    input: SystemPeerCallbackInput,
    peers: SystemPeerService,
  ): Promise<SystemPeerCallbackResult | undefined>
}

/** A provider-neutral failure that the RPC boundary maps to its existing error text. */
export class SystemPeerCallbackError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/**
 * Provider-neutral bridge seam for local direct conversations. Providers submit
 * ordinary IM events, so persistence, committed-event observers and MTProto
 * updates remain owned by the bridge.
 */
export class SystemPeerService extends Service {
  private readonly _providers = new Set<SystemPeerProvider>()
  private _ingest?: (
    session: PlatformSession,
    event: IMEvent,
    options?: PlatformEventDeliveryOptions,
  ) => Promise<PlatformEventPublishResult>

  constructor(ctx: Context) {
    super(ctx, 'systemPeer')
  }

  attach(
    ingest: (session: PlatformSession, event: IMEvent, options?: PlatformEventDeliveryOptions) => Promise<PlatformEventPublishResult>,
  ): void {
    this._ingest = ingest
  }

  register(provider: SystemPeerProvider): Unsubscribe {
    this._providers.add(provider)
    for (const binding of this.ctx.imPlatform?.sessions ?? []) {
      void provider.bootstrap(binding.session, this).catch((error) => {
        this.ctx.logger('system-peer').warn('system peer bootstrap failed: %s', String(error))
      })
    }
    return () => { this._providers.delete(provider) }
  }

  async bootstrap(session: PlatformSession): Promise<void> {
    for (const provider of this._providers) {
      try {
        await provider.bootstrap(session, this)
      } catch (error) {
        this.ctx.logger('system-peer').warn('system peer bootstrap failed: %s', String(error))
      }
    }
  }

  async resolve(session: PlatformSession, conversationId: string): Promise<SystemPeerResolution | undefined> {
    for (const provider of this._providers) {
      const peer = await provider.resolve(session, conversationId)
      if (peer) return { peer, provider }
    }
  }

  async receive(
    session: PlatformSession,
    resolution: SystemPeerResolution,
    message: IMMessage,
    input?: IMMessageInput,
  ): Promise<void> {
    await resolution.provider.receive?.(session, resolution.peer, message, this, input)
  }

  async callback(
    session: PlatformSession,
    resolution: SystemPeerResolution,
    input: SystemPeerCallbackInput,
  ): Promise<SystemPeerCallbackResult | undefined> {
    return resolution.provider.callback?.(session, resolution.peer, input, this)
  }

  makeOutgoing(session: PlatformSession, resolution: SystemPeerResolution, content: IMMessageInput): IMMessage {
    return {
      id: `bridge:outgoing:${randomUUID()}`,
      conversationId: resolution.peer.id,
      senderId: session.userId,
      content: {
        parts: content.parts.map((part) => part.type === 'media'
          ? { type: 'media' as const, media: { ...part.media, id: `bridge:system-peer-media:${randomUUID()}` } }
          : part) as IMMessage['content']['parts'],
      },
      timestamp: Math.floor(Date.now() / 1_000),
      outgoing: true,
      replyToId: content.replyToId,
    }
  }

  async emit(session: PlatformSession, event: IMEvent, options?: PlatformEventDeliveryOptions): Promise<PlatformEventPublishResult> {
    if (!this._ingest) throw new Error('system peer bridge is not attached')
    return this._ingest(session, event, options)
  }
}
