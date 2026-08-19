import { Service, type Context } from 'cordis'
import type {
  IMConversationRef, IMDirectDownload, IMMediaSource, JsonValue, PlatformSession, Unsubscribe,
} from './platform.js'

export type IMStickerFormat = 'static' | 'animated' | 'video'

export interface IMStickerRef {
  providerId: string
  stickerId: string
}

export interface IMSticker extends IMStickerRef {
  /** Undefined for platform/user saved stickers that do not belong to a set. */
  packId?: string
  title?: string
  emoji?: string[]
  keywords?: string[]
  format: IMStickerFormat
  mimeType: string
  width?: number
  height?: number
  size?: number
  version?: number
  /** Optional static frame shown while an animated/video sticker is loading. */
  thumbnail?: IMStickerThumbnail
  /** Telegram compact SVG path painted with a moving gradient while loading. */
  outline?: Uint8Array
  locator?: JsonValue
}

export interface IMStickerThumbnail {
  mimeType: string
  size: number
  width: number
  height: number
  /** Provider-owned reference used by openThumbnail(). */
  locator?: JsonValue
}

export interface IMStickerPackSummary {
  providerId: string
  packId: string
  title: string
  shortName?: string
  count?: number
  cover?: IMStickerRef
  version?: number
  /** Bridge-owned assignment policy; providers only describe pack ownership. */
  automaticAssociation?: 'provider-account'
}

export interface IMStickerPack extends IMStickerPackSummary {
  stickers: IMSticker[]
}

export interface StickerProviderContext {
  session: PlatformSession
  conversation?: IMConversationRef
  platformKind: string
}

export interface StickerPageQuery {
  cursor?: string
  limit?: number
}

export interface IMStickerPackPage {
  packs: IMStickerPackSummary[]
  nextCursor?: string
}

export interface IMStickerPage {
  stickers: IMSticker[]
  nextCursor?: string
}

export interface IMStickerAsset {
  source: IMMediaSource
  mimeType: string
  size?: number
  width?: number
  height?: number
}

export type IMStickerSendPlan =
  | {
      type: 'native'
      providerId: string
      stickerId: string
      packId?: string
      reference: JsonValue
    }
  | {
      type: 'upload'
      providerId: string
      stickerId: string
      packId?: string
      format: IMStickerFormat
      mimeType: string
      emoji?: string[]
      width?: number
      height?: number
      source: IMMediaSource
    }

export interface StickerProviderCapabilities {
  platformKinds?: string[]
  /** Platform entry that owns this provider's native account-scoped data. */
  ownerPlatformId?: string
  sessionScoped?: boolean
  conversationScoped?: boolean
  search?: boolean
  /** Require sticker documents to be resolved through getSticker() before opening assets. */
  canonicalLookup?: boolean
}

export interface IMStickerProvider {
  readonly capabilities?: StickerProviderCapabilities

  listPacks(context: StickerProviderContext, query?: StickerPageQuery): Promise<IMStickerPackPage>
  getPack(context: StickerProviderContext, packId: string): Promise<IMStickerPack | null>
  getSticker(context: StickerProviderContext, stickerId: string): Promise<IMSticker | null>
  search?(context: StickerProviderContext, query: {
    text?: string
    emoji?: string
    cursor?: string
    limit?: number
  }): Promise<IMStickerPage>
  /** Platform-native saved/favorite stickers, including stickers with no set. */
  listSavedStickers?(
    context: StickerProviderContext,
    query?: StickerPageQuery,
  ): Promise<IMStickerPage>
  openAsset(context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset>
  /** Resolve an original provider URL so patched clients can bypass relay bytes. */
  resolveAssetUrl?(
    context: StickerProviderContext,
    sticker: IMSticker,
  ): Promise<IMDirectDownload | undefined>
  /** Open the static thumbnail advertised by IMSticker.thumbnail. */
  openThumbnail?(context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null>
  prepareSend?(
    context: StickerProviderContext,
    sticker: IMSticker,
  ): Promise<IMStickerSendPlan | null>
  /** Mirror Telegram's favorite toggle into the platform-native saved collection. */
  setSavedSticker?(
    context: StickerProviderContext,
    sticker: IMSticker,
    saved: boolean,
  ): Promise<void>
}

export class StickerProviderRegistry {
  private readonly _providers = new Map<string, IMStickerProvider>()
  private readonly _sessionRevisions = new Map<string, number>()
  private _revision = 0

  register(id: string, provider: IMStickerProvider): Unsubscribe {
    if (this._providers.has(id)) throw new Error(`duplicate sticker provider ID: ${id}`)
    this._providers.set(id, provider)
    this._revision++
    return () => {
      if (this._providers.get(id) === provider) {
        this._providers.delete(id)
        this._revision++
      }
    }
  }

  /** Mark provider-owned catalog data as changed, optionally for one platform session. */
  touch(id: string, platformSessionId?: string): void {
    if (!this._providers.has(id)) throw new Error(`sticker provider is not registered: ${id}`)
    if (!platformSessionId) {
      this._revision++
      return
    }
    this._sessionRevisions.set(platformSessionId, (this._sessionRevisions.get(platformSessionId) ?? 0) + 1)
  }

  revisionFor(platformSessionId: string): string {
    return `${this._revision}:${this._sessionRevisions.get(platformSessionId) ?? 0}`
  }

  releaseSession(platformSessionId: string): void {
    this._sessionRevisions.delete(platformSessionId)
  }

  get(id: string): IMStickerProvider | undefined {
    return this._providers.get(id)
  }

  require(id: string): IMStickerProvider {
    const provider = this.get(id)
    if (!provider) throw new Error(`sticker provider is not registered: ${id}`)
    return provider
  }

  get entries(): Array<[string, IMStickerProvider]> {
    return [...this._providers.entries()]
  }

  get ids(): string[] {
    return [...this._providers.keys()]
  }
}

export class IMStickerService extends Service {
  readonly registry = new StickerProviderRegistry()

  constructor(ctx: Context) {
    super(ctx, 'imSticker')
  }

  register(provider: IMStickerProvider, id: string): Unsubscribe {
    return this.ctx.effect(
      () => this.registry.register(id, provider),
      `imSticker.register(${id})`,
    )
  }

  touch(id: string, platformSessionId?: string): void {
    this.registry.touch(id, platformSessionId)
  }

  releaseSession(platformSessionId: string): void {
    this.registry.releaseSession(platformSessionId)
  }

  get(id: string): IMStickerProvider | undefined {
    return this.registry.get(id)
  }

  require(id: string): IMStickerProvider {
    return this.registry.require(id)
  }

  get ids(): string[] {
    return this.registry.ids
  }
}
