import { randomUUID } from 'node:crypto'
import { Service, type Context } from 'cordis'
import type {
  IMConversation, IMEvent, IMMediaUploadPreparation, IMMediaUploadProbe, IMMessage, IMMessageInput,
  PlatformSession, Unsubscribe,
} from './platform.js'
import type { PlatformEventDeliveryOptions, PlatformEventPublishResult } from './platform-manager.js'

/** A bridge-owned direct peer supplied by an optional, provider-neutral package. */
export interface SystemPeer {
  id: string
  conversation: IMConversation
}

/** A bridge-owned bot that can be opened through a Telegram `t.me` link. */
export interface SystemBot {
  /** The conversation ID that the provider resolves for this bot. */
  conversationId: string
  /** Display name exposed to the WebUI and Telegram clients. */
  title: string
  /** Globally unique Telegram-style username, without `@`. */
  username: string
  /** Cordis package which registered the bot. */
  sourcePlugin: string
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
  /** Let a local peer consume Telegram upload parts without platform staging. */
  prepareMediaUpload?(
    session: PlatformSession,
    peer: SystemPeer,
    media: IMMediaUploadProbe,
    peers: SystemPeerService,
  ): Promise<IMMediaUploadPreparation | undefined>
  /** Resolve a provider-owned callback from its durable source message. */
  callback?(
    session: PlatformSession,
    peer: SystemPeer,
    input: SystemPeerCallbackInput,
    peers: SystemPeerService,
  ): Promise<SystemPeerCallbackResult | undefined>
  /** Enumerate the Telegram-style bots owned by this provider. */
  listBots?(): Promise<readonly SystemBot[]> | readonly SystemBot[]
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
  private readonly _listeners = new Set<() => void>()
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
    this._changed()
    for (const binding of this.ctx.imPlatform?.sessions ?? []) {
      void provider.bootstrap(binding.session, this).catch((error) => {
        this.ctx.logger('system-peer').warn('system peer bootstrap failed: %s', String(error))
      })
    }
    return () => {
      if (!this._providers.delete(provider)) return
      this._changed()
    }
  }

  /** List bridge-owned bots for the management dashboard. */
  async listBots(): Promise<SystemBot[]> {
    const listed = await Promise.all([...this._providers].map(async (provider) =>
      provider.listBots ? await provider.listBots() : []))
    const byUsername = new Map<string, SystemBot>()
    for (const bot of listed.flat()) {
      const username = normalizeUsername(bot.username)
      if (!username) continue
      const previous = byUsername.get(username)
      if (previous && previous.conversationId !== bot.conversationId) {
        this.ctx.logger('system-peer').warn(
          'duplicate system bot username @%s from %s and %s; keeping the first registration',
          bot.username, previous.sourcePlugin, bot.sourcePlugin,
        )
        continue
      }
      byUsername.set(username, { ...bot, username: bot.username.replace(/^@/u, '') })
    }
    return [...byUsername.values()].sort((left, right) =>
      left.username.localeCompare(right.username, 'en-US', { sensitivity: 'base' }))
  }

  /** Resolve a `t.me/<username>` target that is available to this platform session. */
  async resolveUsername(session: PlatformSession, username: string): Promise<SystemPeerResolution | undefined> {
    const normalized = normalizeUsername(username)
    if (!normalized) return
    for (const provider of this._providers) {
      if (!provider.listBots) continue
      const bot = (await provider.listBots()).find((candidate) => normalizeUsername(candidate.username) === normalized)
      if (!bot) continue
      const peer = await provider.resolve(session, bot.conversationId)
      if (peer) return { peer, provider }
    }
  }

  /** Notify dashboards when optional bot plugins or their dynamic bots change. */
  onChanged(listener: () => void): Unsubscribe {
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  /** Called by providers whose bot list changes without being re-registered. */
  notifyChanged(): void {
    this._changed()
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

  async prepareMediaUpload(
    session: PlatformSession,
    resolution: SystemPeerResolution,
    media: IMMediaUploadProbe,
  ): Promise<IMMediaUploadPreparation | undefined> {
    return resolution.provider.prepareMediaUpload?.(session, resolution.peer, media, this)
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

  private _changed(): void {
    for (const listener of [...this._listeners]) {
      try { listener() } catch (error) {
        this.ctx.logger('system-peer').warn('system peer change listener failed: %s', String(error))
      }
    }
  }
}

function normalizeUsername(username: string): string | undefined {
  const normalized = username.trim().replace(/^@/u, '').toLocaleLowerCase('en-US')
  return /^[a-z][a-z0-9_]{4,31}$/u.test(normalized) ? normalized : undefined
}
