import { createHash } from 'node:crypto'

export interface TelegramStickerFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  width?: number
  height?: number
  emoji?: string
  is_animated?: boolean
  is_video?: boolean
  thumbnail?: TelegramStickerThumbnail
  thumb?: TelegramStickerThumbnail
}

export interface TelegramStickerThumbnail {
  file_id: string
  file_unique_id: string
  file_size?: number
  width?: number
  height?: number
}

export interface TelegramStickerSet {
  name: string
  title: string
  stickers: TelegramStickerFile[]
}

export interface TelegramFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export interface ImportedSticker {
  stickerId: string
  fileId: string
  title: string
  emoji?: string[]
  format: 'static' | 'animated' | 'video'
  mimeType: string
  size?: number
  width?: number
  height?: number
  thumbnail?: {
    fileId: string
    fileUniqueId: string
    mimeType: string
    size: number
    width: number
    height: number
  }
}

export interface ImportedStickerSet {
  shortName: string
  title: string
  count: number
  version: number
  stickers: ImportedSticker[]
}

export class TelegramStickerImportError extends Error {}

/** Parse only official, whole sticker-set links. The set name remains opaque legacy data. */
export function parseStickerSetUrl(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return
  }
  if (url.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(url.hostname.toLowerCase())) return
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'addstickers') return
  try {
    const shortName = decodeURIComponent(parts[1])
    if (!shortName || shortName.length > 128 || /[\u0000-\u001f\x7f]/u.test(shortName) || /[\\/]/u.test(shortName)) return
    return shortName
  } catch {
    return
  }
}

export function importShortName(input: string): string | undefined {
  const command = /^\/import\s+(.+)$/u.exec(input.trim())
  return parseStickerSetUrl(command?.[1] ?? input)
}

export class HostedTelegramBotApi {
  private readonly _base: string

  constructor(
    private readonly _token: string,
    apiBase = 'https://api.telegram.org',
    private readonly _fetch: typeof fetch = fetch,
  ) {
    this._base = apiBase.replace(/\/$/u, '')
  }

  async getStickerSet(shortName: string, signal?: AbortSignal): Promise<ImportedStickerSet> {
    const result = await this._call<TelegramStickerSet>('getStickerSet', { name: shortName }, signal)
    return mapStickerSet(result)
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return this._call<TelegramFile>('getFile', { file_id: fileId }, signal)
  }

  async download(fileId: string, options: { offset?: number, limit?: number, signal?: AbortSignal } = {}): Promise<Response> {
    const file = await this.getFile(fileId, options.signal)
    if (!file.file_path) throw new TelegramStickerImportError('Telegram did not return a downloadable sticker file.')
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit))
    const headers: HeadersInit = {}
    if (offset || limit !== undefined) headers.range = `bytes=${offset}-${limit === undefined ? '' : offset + limit - 1}`
    const response = await this._fetch(`${this._base}/file/bot${this._token}/${file.file_path}`, {
      headers,
      signal: options.signal,
    })
    if (!response.ok) throw new TelegramStickerImportError(`Telegram sticker download failed (HTTP ${response.status}).`)
    if (!response.body) throw new TelegramStickerImportError('Telegram sticker download returned no body.')
    return response
  }

  private async _call<T>(method: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${this._base}/bot${this._token}/${method}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    let response: Response
    try {
      response = await this._fetch(url, { signal })
    } catch {
      throw new TelegramStickerImportError('Telegram Bot API request failed.')
    }
    let body: { ok?: boolean, result?: T, description?: string }
    try {
      body = await response.json() as { ok?: boolean, result?: T, description?: string }
    } catch {
      throw new TelegramStickerImportError(`Telegram Bot API request failed (HTTP ${response.status}).`)
    }
    if (!response.ok || !body.ok || body.result === undefined) {
      if (/file is too big|file is too large|20\s*MB/ui.test(body.description ?? '')) {
        throw new TelegramStickerImportError('Telegram Hosted Bot API cannot download this file because it exceeds its 20 MB limit.')
      }
      throw new TelegramStickerImportError(`Telegram Bot API request failed (HTTP ${response.status}).`)
    }
    return body.result
  }
}

export function mapStickerSet(set: TelegramStickerSet): ImportedStickerSet {
  const stickers = set.stickers.map((sticker) => mapSticker(sticker, set.name, set.title))
  return {
    shortName: set.name,
    title: set.title,
    count: stickers.length,
    version: versionOf(set.name, set.title, stickers),
    stickers,
  }
}

function mapSticker(sticker: TelegramStickerFile, shortName: string, title: string): ImportedSticker {
  const format = sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
  const thumbnail = sticker.thumbnail ?? sticker.thumb
  return {
    stickerId: JSON.stringify([shortName, sticker.file_unique_id]),
    fileId: sticker.file_id,
    title,
    emoji: sticker.emoji ? [sticker.emoji] : undefined,
    format,
    mimeType: format === 'animated' ? 'application/x-tgsticker' : format === 'video' ? 'video/webm' : 'image/webp',
    size: sticker.file_size,
    width: sticker.width,
    height: sticker.height,
    thumbnail: thumbnail && {
      fileId: thumbnail.file_id,
      fileUniqueId: thumbnail.file_unique_id,
      mimeType: 'image/webp',
      size: thumbnail.file_size ?? 0,
      width: thumbnail.width ?? 0,
      height: thumbnail.height ?? 0,
    },
  }
}

function versionOf(shortName: string, title: string, stickers: ImportedSticker[]): number {
  const canonical = JSON.stringify([
    shortName,
    title,
    stickers.length,
    stickers.map((sticker) => [
      sticker.stickerId,
      sticker.fileId,
      sticker.title,
      sticker.emoji ?? null,
      sticker.format,
      sticker.mimeType,
      sticker.size ?? null,
      sticker.width ?? null,
      sticker.height ?? null,
      sticker.thumbnail && [
        sticker.thumbnail.fileUniqueId,
        sticker.thumbnail.fileId,
        sticker.thumbnail.mimeType,
        sticker.thumbnail.size,
        sticker.thumbnail.width,
        sticker.thumbnail.height,
      ],
    ]),
  ])
  return createHash('sha256').update(canonical).digest().readUInt32BE(0)
}
