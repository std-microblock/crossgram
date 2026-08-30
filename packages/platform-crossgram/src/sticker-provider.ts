import type {
  IMSticker, IMStickerAsset, IMStickerPack, IMStickerProvider, JsonValue,
  StickerPageQuery, StickerProviderContext,
} from '@mtproto-relay/bridge'
import type { QQNTClient } from './client.js'
import type { QQStickerReference, WireSticker, WireStickerPack } from './protocol.js'

/** Exposes QQ market packs and the account's QQ favorite collection. */
export class QQStickerProvider implements IMStickerProvider {
  readonly capabilities

  constructor(
    private readonly client: QQNTClient,
    private readonly providerId: string,
    _removedMediaCache?: unknown,
    private readonly logger?: QQStickerLogger,
    ownerPlatformId?: string,
  ) {
    this.capabilities = { platformKinds: ['qq'], sessionScoped: true, ownerPlatformId }
  }

  async listPacks(_context: StickerProviderContext, query: StickerPageQuery = {}) {
    const page = await this.client.getStickerPacks(query)
    return {
      packs: page.packs.map((pack) => ({
        ...pack,
        providerId: this.providerId,
        automaticAssociation: pack.packId === 'qq-favorites' ? 'provider-account' as const : undefined,
      })),
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
    return { ...this.originalAsset(sticker, reference), mimeType: sticker.mimeType }
  }

  async openThumbnail(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference || reference.kind !== 'market' || !reference.animated || !sticker.thumbnail) return null
    // QQ market stickers expose a static type-3 asset alongside the animated
    // original. Serve that asset as Telegram's lowest-tier `m` thumbnail so
    // clients can keep their normal preview/loading pipeline.
    const thumbnailReference: QQStickerReference = {
      ...reference,
      animated: false,
      mimeType: 'image/png',
    }
    return {
      source: this.client.stickerSource(thumbnailReference, sticker.thumbnail.size),
      mimeType: sticker.thumbnail.mimeType,
      size: sticker.thumbnail.size,
      width: sticker.thumbnail.width,
      height: sticker.thumbnail.height,
    }
  }

  async resolveAssetUrl(_context: StickerProviderContext, sticker: IMSticker) {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!reference || reference.deferred) return
    if (reference.kind === 'favorite' && reference.locator) {
      return this.client.resolveFileUrlForDirectDownload(reference.locator)
    }
    const url = reference.kind === 'sysface'
      ? reference.url
      : reference.kind === 'favorite'
        ? reference.url ?? reference.path
        : reference.animated ? reference.dynamicPath : reference.staticPath
    if (!isHttpUrl(url)) return
    return this.client.inspectDirectUrl(url, Date.now() + 5 * 60_000)
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
    const mapped = await mapConcurrent(pack.stickers, 4, async (sticker) => {
      try {
        return await this.mapSticker(sticker)
      } catch (error) {
        this.logger?.warn(
          'Skipping QQ sticker %s from pack %s because its asset could not be prepared: %s',
          sticker.stickerId,
          pack.packId,
          error instanceof Error ? error.message : String(error),
        )
      }
    })
    const stickers = mapped.filter((sticker): sticker is IMSticker => sticker !== undefined)
    return {
      providerId: this.providerId,
      packId: pack.packId,
      title: pack.title,
      count: stickers.length,
      cover: stickers[0] && { providerId: this.providerId, stickerId: stickers[0].stickerId },
      version: pack.version,
      automaticAssociation: pack.packId === 'qq-favorites' ? 'provider-account' : undefined,
      stickers,
    }
  }

  private async mapSticker(sticker: WireSticker): Promise<IMSticker> {
    const reference = sticker.reference
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
      locator: reference as unknown as JsonValue,
      thumbnail: reference.kind === 'market' && reference.animated
        && reference.staticPath && Number.isSafeInteger(reference.staticSize) && reference.staticSize > 0
        ? {
            mimeType: 'image/png', size: reference.staticSize,
            width: reference.width, height: reference.height,
            locator: { ...reference, animated: false } as unknown as JsonValue,
          }
        : undefined,
    }
    return mapped
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

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
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
