import type {
  IMSticker, IMStickerAsset, IMStickerPack, IMStickerProvider, JsonValue,
  StickerPageQuery, StickerProviderContext,
} from '@mtproto-relay/bridge'
import type { QQNTClient } from './client.js'
import type { QQStickerReference, WireSticker, WireStickerPack } from './protocol.js'

/** Exposes QQ market packs and the account's QQ favorite collection. */
export class QQStickerProvider implements IMStickerProvider {
  readonly capabilities = { platformKinds: ['qq'], sessionScoped: true }

  constructor(
    private readonly client: QQNTClient,
    private readonly providerId: string,
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
      stickers: page.stickers.map((sticker) => this.mapSticker(sticker)),
      nextCursor: page.nextCursor,
    }
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference) throw new Error(`QQ sticker ${sticker.stickerId} has no native reference`)
    return {
      source: this.client.stickerSource(reference, sticker.size),
      mimeType: sticker.mimeType,
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
    }
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

  private mapPack(pack: WireStickerPack): IMStickerPack {
    return {
      providerId: this.providerId,
      packId: pack.packId,
      title: pack.title,
      count: pack.count,
      version: pack.version,
      stickers: pack.stickers.map((sticker) => this.mapSticker(sticker)),
    }
  }

  private mapSticker(sticker: WireSticker): IMSticker {
    return {
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
  }
}
