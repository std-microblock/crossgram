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
    private readonly logger?: QQStickerLogger,
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
    const stickers = await mapConcurrent(page.stickers, 4, async (sticker) => {
      try {
        return await this.mapSticker(sticker)
      } catch (error) {
        this.logger?.warn(
          'Skipping QQ saved sticker %s because its asset could not be prepared: %s',
          sticker.stickerId,
          error instanceof Error ? error.message : String(error),
        )
      }
    })
    return {
      stickers: stickers.filter((sticker): sticker is IMSticker => sticker !== undefined),
      nextCursor: page.nextCursor,
    }
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference) throw new Error(`QQ sticker ${sticker.stickerId} has no native reference`)
    if (reference.deferred) return emptyStickerAsset(sticker)
    const original = this.originalAsset(sticker, reference)
    return this.mediaCache
      ? this.mediaCache.openSticker({ ...sticker, format: reference.animated ? 'animated' : 'static' }, original)
      : { ...original, mimeType: sticker.mimeType }
  }

  async openThumbnail(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null> {
    return this.mediaCache?.openStickerThumbnail(sticker) ?? null
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
    const stickers = await mapConcurrent(pack.stickers, 4, (sticker) => this.mapSticker(sticker))
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
    return this.mediaCache.prepareSticker(mapped, this.originalAsset(mapped, sticker.reference))
  }

  private originalAsset(sticker: IMSticker, reference: QQStickerReference): IMStickerAsset {
    return {
      source: this.client.stickerSource(reference, sticker.size),
      mimeType: reference.animated ? 'image/gif' : 'image/png',
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
    }
  }
}

function emptyStickerAsset(sticker: IMSticker): IMStickerAsset {
  return {
    source: {
      size: 0,
      async *stream() {},
    },
    mimeType: sticker.mimeType,
    size: 0,
    width: sticker.width,
    height: sticker.height,
  }
}

interface QQStickerLogger {
  warn(format: string, ...args: unknown[]): void
}

async function mapConcurrent<T, U>(
  input: readonly T[],
  concurrency: number,
  transform: (item: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(input.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (cursor < input.length) {
      const index = cursor++
      output[index] = await transform(input[index]!)
    }
  })
  await Promise.all(workers)
  return output
}
