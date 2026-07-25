import type {
  IMSticker, IMStickerAsset, IMStickerPack, IMStickerProvider, JsonValue,
  StickerPageQuery, StickerProviderContext,
} from '@mtproto-relay/bridge'
import type { QQNTClient } from './client.js'
import type { QQMediaCache } from './media-cache.js'
import type { QQStickerReference, WireSticker, WireStickerPack } from './protocol.js'

/** Exposes QQ market packs and the account's QQ favorite collection. */
export class QQStickerProvider implements IMStickerProvider {
  readonly capabilities = { platformKinds: ['qq'], sessionScoped: true }

  constructor(
    private readonly client: QQNTClient,
    private readonly providerId: string,
    private readonly mediaCache?: QQMediaCache,
  ) {}

  async listPacks(_context: StickerProviderContext, query: StickerPageQuery = {}) {
    const page = await this.client.getStickerPacks(query)
    return {
      packs: page.packs.map((pack) => ({ ...pack, providerId: this.providerId })),
      nextCursor: page.nextCursor,
    }
  }

  async getPack(_context: StickerProviderContext, packId: string): Promise<IMStickerPack | null> {
    const pack = await this.client.getStickerPack(packId)
    return pack ? this.mapPack(pack) : null
  }

  async getSticker(_context: StickerProviderContext, stickerId: string): Promise<IMSticker | null> {
    const sticker = await this.client.getSticker(stickerId)
    return sticker ? this.mapSticker(sticker) : null
  }

  async listSavedStickers(_context: StickerProviderContext, query: StickerPageQuery = {}) {
    const page = await this.client.getSavedStickers(query)
    return {
      stickers: await Promise.all(page.stickers.map((sticker) => this.mapSticker(sticker))),
      nextCursor: page.nextCursor,
    }
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference) throw new Error(`QQ sticker ${sticker.stickerId} has no native reference`)
    const original: IMStickerAsset = {
      source: this.client.stickerSource(reference, sticker.size),
      mimeType: reference.animated ? 'image/gif' : 'image/png',
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
    }
    return this.mediaCache
      ? this.mediaCache.openSticker({ ...sticker, format: reference.animated ? 'animated' : 'static' }, original)
      : { ...original, mimeType: sticker.mimeType }
  }

  async openThumbnail(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null> {
    if (!this.mediaCache) return null
    const prepared = await this.prepareThumbnail(sticker)
    return this.mediaCache.openStickerThumbnail(prepared)
  }

  async prepareSend(_context: StickerProviderContext, sticker: IMSticker) {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference) return null
    return {
      type: 'native' as const,
      providerId: this.providerId,
      stickerId: sticker.stickerId,
      packId: sticker.packId,
      reference: reference as unknown as JsonValue,
    }
  }

  async setSavedSticker(_context: StickerProviderContext, sticker: IMSticker, saved: boolean): Promise<void> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference) throw new Error(`QQ sticker ${sticker.stickerId} has no native reference`)
    await this.client.setSavedSticker(reference, saved)
  }

  private async mapPack(pack: WireStickerPack): Promise<IMStickerPack> {
    const stickers = await Promise.all(pack.stickers.map((sticker) => this.mapSticker(sticker)))
    const first = stickers[0]
    if (first && this.mediaCache && !first.thumbnail) {
      try {
        stickers[0] = await this.prepareThumbnail(first)
      } catch {
        // A transient cover failure must not hide the complete sticker pack.
      }
    }
    return {
      providerId: this.providerId,
      packId: pack.packId,
      title: pack.title,
      count: pack.count,
      cover: stickers[0] && { providerId: this.providerId, stickerId: stickers[0].stickerId },
      version: pack.version,
      stickers,
    }
  }

  private async mapSticker(sticker: WireSticker): Promise<IMSticker> {
    const mapped: IMSticker = {
      providerId: this.providerId,
      stickerId: sticker.stickerId,
      packId: sticker.packId,
      title: sticker.title,
      format: sticker.format,
      mimeType: sticker.mimeType,
      width: sticker.width,
      height: sticker.height,
      size: sticker.size,
      version: sticker.version,
      locator: sticker.reference as unknown as JsonValue,
    }
    if (!this.mediaCache) return mapped
    return this.mediaCache.restoreStickerThumbnail(this.mediaCache.projectSticker(mapped))
  }

  private async prepareThumbnail(sticker: IMSticker): Promise<IMSticker> {
    if (!this.mediaCache || sticker.thumbnail) return sticker
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference) return sticker
    return this.mediaCache.prepareStickerThumbnail(
      sticker,
      this.client.stickerSource(reference, sticker.size),
    )
  }
}
