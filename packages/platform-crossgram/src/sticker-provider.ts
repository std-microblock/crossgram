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

  /**
   * Expression-CDN measurements for store faces the account also favorited,
   * keyed by favorite res id. QQ publishes the size of an asset only through
   * this probe, and clients need it to schedule the download at all.
   */
  private readonly favoriteAssets = new Map<string, { url: string, size: number, mimeType?: string }>()

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
    const favorite = await this.servableFavoriteAsset(sticker)
    const mapped: IMSticker = {
      providerId: this.providerId,
      stickerId: sticker.stickerId,
      packId: sticker.packId,
      title: sticker.title,
      format: sticker.format,
      mimeType: favorite?.mimeType ?? sticker.mimeType,
      width: sticker.width,
      height: sticker.height,
      size: favorite?.size ?? sticker.size,
      version: sticker.version,
      locator: (favorite?.reference ?? reference) as unknown as JsonValue,
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

  /**
   * Store face the account favorited: QQ keeps it as a market reference, but
   * the market path needs a native download slot (tens of seconds) and answers
   * "file is missing" in this headless environment, so every client cell stayed
   * empty. The same face is still on QQ's expression CDN under the favorite res
   * id — the URL shape plain favorites already carry — and the bridge streams a
   * favorite reference from that URL, so publish the favorite copy instead.
   */
  private async servableFavoriteAsset(
    sticker: WireSticker,
  ): Promise<{ reference: QQStickerReference, size: number, mimeType?: string } | undefined> {
    const reference = sticker.reference
    if (reference.kind !== 'market') return undefined
    const resId = reference.favoriteResId
    if (!resId) return undefined
    const url = favoriteStickerUrl(resId)
    if (!url) return undefined
    const cached = this.favoriteAssets.get(resId)
    const measured = cached ?? await this.measureFavoriteAsset(resId, url)
    if (!measured) return undefined
    return {
      reference: {
        kind: 'favorite', resId, url, path: '',
        name: reference.name, animated: reference.animated,
        mimeType: stickerImageMimeType(measured.mimeType) ?? reference.mimeType,
        width: reference.width, height: reference.height,
        size: measured.size,
      },
      size: measured.size,
      mimeType: measured.mimeType ?? reference.mimeType,
    }
  }

  private async measureFavoriteAsset(
    resId: string,
    url: string,
  ): Promise<{ url: string, size: number, mimeType?: string } | undefined> {
    const measured = await this.client.probeRemoteSticker(url).catch(() => undefined)
    if (!measured) return undefined
    const entry = { url, ...measured }
    this.favoriteAssets.set(resId, entry)
    while (this.favoriteAssets.size > 512) {
      this.favoriteAssets.delete(this.favoriteAssets.keys().next().value!)
    }
    return entry
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

/** Image MIME types a favorite reference may carry. */
function stickerImageMimeType(
  value: string | undefined,
): 'image/gif' | 'image/apng' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp' | undefined {
  switch (value) {
    case 'image/gif':
    case 'image/apng':
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/bmp':
      return value
    default:
      return undefined
  }
}

/**
 * QQ's expression CDN address of a favorite, the same URL the bridge reports for
 * plain favorites: `<uin>_...` res ids are account scoped, and the CDN serves
 * the file at index 0.
 */
export function favoriteStickerUrl(resId: string): string | undefined {
  const [uin] = resId.split('_')
  if (!uin || !/^\d+$/.test(uin)) return undefined
  if (!/^[\w-]+$/.test(resId)) return undefined
  return `https://p.qpic.cn/qq_expression/${uin}/${resId}/0`
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
