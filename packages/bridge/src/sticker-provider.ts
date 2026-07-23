import { Service, type Context } from 'cordis'
import type {
  IMConversationRef, IMMediaSource, JsonValue, PlatformSession, Unsubscribe,
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
  sessionScoped?: boolean
  conversationScoped?: boolean
  search?: boolean
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

  register(id: string, provider: IMStickerProvider): Unsubscribe {
    if (this._providers.has(id)) throw new Error(`duplicate sticker provider ID: ${id}`)
    this._providers.set(id, provider)
    return () => {
      if (this._providers.get(id) === provider) this._providers.delete(id)
    }
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
