import type { Database } from '@cordisjs/plugin-database'
import type {
  IMMediaSource, IMSticker, IMStickerAsset, IMStickerPack, IMStickerPackSummary, IMStickerProvider,
  StickerPageQuery, StickerProviderContext,
} from '@mtproto-relay/bridge'
import type { HostedTelegramBotApi, ImportedSticker, ImportedStickerSet } from './api.js'

export const TELEGRAM_STICKER_IMPORTER_PROVIDER_ID = 'telegram-sticker-importer'

type FileLocator = { fileId: string }

function parseStickerId(stickerId: string): { shortName: string, fileUniqueId: string } | undefined {
  try {
    const value: unknown = JSON.parse(stickerId)
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string'
      || JSON.stringify(value) !== stickerId) return
    return { shortName: value[0], fileUniqueId: value[1] }
  } catch {
    return
  }
}

export class TelegramStickerImporterProvider implements IMStickerProvider {
  readonly capabilities = { canonicalLookup: true }

  constructor(
    private readonly _database: Database,
    private readonly _api: HostedTelegramBotApi,
    private readonly _providerId = TELEGRAM_STICKER_IMPORTER_PROVIDER_ID,
  ) {}

  async listPacks(context: StickerProviderContext, query: StickerPageQuery = {}) {
    const rows = await this._database.get('telegram_sticker_import', {
      platformSessionId: context.session.platformSessionId,
    })
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    const limit = Math.max(1, Math.min(query.limit ?? 200, 200))
    const page = rows.sort((left, right) => left.shortName.localeCompare(right.shortName)).slice(start, start + limit)
    return {
      packs: page.map((row): IMStickerPackSummary => ({
        providerId: this._providerId,
        packId: row.shortName,
        shortName: row.shortName,
        title: row.title,
        count: row.count,
        version: row.version,
      })),
      nextCursor: start + page.length < rows.length ? String(start + page.length) : undefined,
    }
  }

  async getPack(context: StickerProviderContext, packId: string): Promise<IMStickerPack | null> {
    const row = await this._summary(context.session.platformSessionId, packId)
    if (!row) return null
    return this._pack(row.payload as unknown as ImportedStickerSet)
  }

  async getSticker(context: StickerProviderContext, stickerId: string): Promise<IMSticker | null> {
    const parsed = parseStickerId(stickerId)
    if (!parsed || !await this._summary(context.session.platformSessionId, parsed.shortName)) return null
    const pack = await this.getPack(context, parsed.shortName)
    return pack?.stickers.find((item) => item.stickerId === stickerId) ?? null
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const locator = sticker.locator as unknown as FileLocator | undefined
    if (!locator?.fileId) throw new Error(`Imported Telegram sticker ${sticker.stickerId} has no file reference.`)
    return {
      source: this._source(locator.fileId, sticker.size),
      mimeType: sticker.mimeType,
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
    }
  }

  async openThumbnail(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null> {
    const locator = sticker.thumbnail?.locator as unknown as FileLocator | undefined
    if (!locator?.fileId || !sticker.thumbnail) return null
    return {
      source: this._source(locator.fileId, sticker.thumbnail.size),
      mimeType: sticker.thumbnail.mimeType,
      size: sticker.thumbnail.size,
      width: sticker.thumbnail.width,
      height: sticker.thumbnail.height,
    }
  }

  async upsert(platformSessionId: string, set: ImportedStickerSet, database: Database = this._database): Promise<void> {
    await database.upsert('telegram_sticker_import', [{
      platformSessionId,
      shortName: set.shortName,
      title: set.title,
      count: set.count,
      version: set.version,
      payload: set as unknown as import('@mtproto-relay/bridge').JsonValue,
      updatedAt: new Date(),
    }], ['platformSessionId', 'shortName'])
  }

  async hasPack(platformSessionId: string, shortName: string): Promise<boolean> {
    return !!await this._summary(platformSessionId, shortName)
  }

  async countPacks(platformSessionId: string): Promise<number> {
    return (await this._database.get('telegram_sticker_import', { platformSessionId })).length
  }

  private async _summary(platformSessionId: string, shortName: string) {
    const [row] = await this._database.get('telegram_sticker_import', { platformSessionId, shortName })
    return row
  }

  private _pack(set: ImportedStickerSet): IMStickerPack {
    const stickers = set.stickers.map((sticker) => this._sticker(set, sticker))
    return {
      providerId: this._providerId,
      packId: set.shortName,
      shortName: set.shortName,
      title: set.title,
      count: set.count,
      version: set.version,
      cover: stickers[0] && { providerId: this._providerId, stickerId: stickers[0].stickerId },
      stickers,
    }
  }

  private _sticker(set: ImportedStickerSet, sticker: ImportedSticker): IMSticker {
    return {
      providerId: this._providerId,
      packId: set.shortName,
      stickerId: sticker.stickerId,
      title: sticker.title,
      emoji: sticker.emoji,
      format: sticker.format,
      mimeType: sticker.mimeType,
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
      version: set.version,
      locator: { fileId: sticker.fileId },
      thumbnail: sticker.thumbnail && {
        mimeType: sticker.thumbnail.mimeType,
        size: sticker.thumbnail.size,
        width: sticker.thumbnail.width,
        height: sticker.thumbnail.height,
        locator: { fileId: sticker.thumbnail.fileId },
      },
    }
  }

  private _source(fileId: string, size?: number): IMMediaSource {
    return {
      size,
      stream: (options = {}) => this._stream(fileId, options),
      streamRange: ({ offset, limit, signal }) => this._stream(fileId, { offset, limit, signal }),
    }
  }

  private async *_stream(fileId: string, options: { offset?: number, limit?: number, signal?: AbortSignal }): AsyncIterable<Uint8Array> {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit))
    if (limit === 0) return
    const response = await this._api.download(fileId, { offset, limit, signal: options.signal })
    const reader = response.body!.getReader()
    let skip = response.status === 206 ? 0 : offset
    let remaining = limit ?? Number.POSITIVE_INFINITY
    try {
      while (remaining > 0) {
        const { done, value } = await reader.read()
        if (done) return
        let chunk = value
        if (skip) {
          if (chunk.length <= skip) {
            skip -= chunk.length
            continue
          }
          chunk = chunk.subarray(skip)
          skip = 0
        }
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining)
        remaining -= chunk.length
        if (chunk.length) yield chunk
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}
