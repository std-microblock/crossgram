import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import { stripTelegramJpegThumbnail, type IMMedia } from '@mtproto-relay/bridge'
import sharp from 'sharp'
import type { QQMediaLocator } from './protocol.js'

export interface QQMediaInlinePreviewRow {
  key: string
  bytes: ArrayBuffer
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_inline_preview: QQMediaInlinePreviewRow
  }
}

export function defineQQMediaPreviewModel(ctx: Context): void {
  ctx.model.extend('mtproto_qqnt_inline_preview', {
    key: 'string', bytes: 'binary', updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
}

export interface QQMediaPreviewOptions {
  enabled?: boolean
  concurrency?: number
  database?: Database
}

const MAX_PREVIEW_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_INPUT_PIXELS = 64 * 1024 * 1024
const MEMORY_PREVIEW_CACHE_LIMIT = 4096

/**
 * Generates Telegram's tiny photoStrippedSize payload in an isolated worker
 * path. Mapping is synchronous and memory-only; cache lookup, source download,
 * decode and persistence happen only in prepare(), which callers schedule
 * after the original history/live message has already been delivered.
 */
export class QQMediaPreviewer {
  readonly enabled: boolean
  readonly concurrency: number
  private readonly active = new Map<string, Promise<PreparedPreview>>()
  private readonly memory = new Map<string, PreparedPreview>()
  private readonly waiters: Array<() => void> = []
  private running = 0

  constructor(private readonly options: QQMediaPreviewOptions = {}) {
    this.enabled = options.enabled ?? false
    this.concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? 2)))
  }

  /** Attach only an already-memory-resident inline preview; never perform I/O. */
  project(media: IMMedia<QQMediaLocator>): IMMedia<QQMediaLocator> {
    if (!this.enabled || media.kind !== 'image' || !media.locator || media.strippedThumbnail) return media
    const key = mediaPreviewKey(media.locator)
    const preview = this.memory.get(key)
    if (!preview) return media
    const remembered = remember(this.memory, key, preview)
    return {
      ...media,
      ...(hasDimensions(media) ? {} : remembered.dimensions),
      strippedThumbnail: remembered.bytes,
    }
  }

  async prepare(
    media: IMMedia<QQMediaLocator>,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<IMMedia<QQMediaLocator>> {
    if (!this.enabled || media.kind !== 'image' || !media.locator || media.strippedThumbnail) return media
    const key = mediaPreviewKey(media.locator)
    const preview = await this.open(key, source, signal)
    return {
      ...media,
      ...(hasDimensions(media) ? {} : preview.dimensions),
      strippedThumbnail: preview.bytes,
    }
  }

  private async open(
    key: string,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<PreparedPreview> {
    const cached = this.memory.get(key)
    if (cached) return remember(this.memory, key, cached)
    const current = this.active.get(key)
    if (current) return current
    const pending = this.openOnce(key, source, signal)
    this.active.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.active.get(key) === pending) this.active.delete(key)
    }
  }

  private async openOnce(
    key: string,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<PreparedPreview> {
    const [stored] = await this.options.database?.get('mtproto_qqnt_inline_preview', { key }) ?? []
    if (stored) return remember(this.memory, key, preparedPreview(new Uint8Array(stored.bytes)))
    return this.withSlot(async () => {
      const preview = await this.create(source(signal), signal)
      await this.options.database?.upsert('mtproto_qqnt_inline_preview', [{
        key, bytes: exactArrayBuffer(preview.bytes), updatedAt: new Date(),
      }], ['key'])
      return remember(this.memory, key, preview)
    })
  }

  private async create(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<PreparedPreview> {
    const transformer = sharp({ limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
      .rotate()
      .resize({ width: 40, height: 40, fit: 'inside', withoutEnlargement: true })
      .jpeg({
        quality: 20, chromaSubsampling: '4:2:0', progressive: false, optimizeCoding: false,
      })
    const output = transformer.toBuffer()
    const metadata = transformer.metadata()
    await pipeline(Readable.from(limitedSource(source, signal)), transformer)
    const [bytes, input] = await Promise.all([output, metadata])
    return {
      bytes: stripTelegramJpegThumbnail(bytes),
      dimensions: validDimensions(input.autoOrient?.width, input.autoOrient?.height)
        ?? validDimensions(input.width, input.height)
        ?? dimensionsFromStripped(bytes),
    }
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.running++
    try {
      return await run()
    } finally {
      this.running--
      this.waiters.shift()?.()
    }
  }
}

export function mediaPreviewKey(locator: QQMediaLocator): string {
  const raw = rawLocator(locator)
  const identity = raw.sha3
    ? `sha3:${raw.sha3.toLowerCase()}`
    : raw.sha
      ? `sha:${raw.sha.toLowerCase()}`
      : raw.md5
        ? `md5:${raw.md5.toLowerCase()}`
        : `locator:${stableJson(raw)}`
  return createHash('sha256').update(`qq-inline-preview-v1\0${identity}`).digest('hex')
}

function rawLocator(locator: QQMediaLocator): QQMediaLocator {
  const { cachedPath: _cachedPath, previewKey: _previewKey, deferred: _deferred, ...raw } = locator
  return raw
}

async function* limitedSource(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let total = 0
  for await (const chunk of source) {
    if (signal?.aborted) throw signal.reason ?? new Error('inline preview generation aborted')
    total += chunk.byteLength
    if (total > MAX_PREVIEW_SOURCE_BYTES) {
      throw new Error(`QQ inline preview source exceeds ${MAX_PREVIEW_SOURCE_BYTES} bytes`)
    }
    yield chunk
  }
}

interface PreparedPreview {
  bytes: Uint8Array
  dimensions: { width: number, height: number }
}

function preparedPreview(bytes: Uint8Array): PreparedPreview {
  return { bytes, dimensions: dimensionsFromStripped(bytes) }
}

function dimensionsFromStripped(bytes: Uint8Array): { width: number, height: number } {
  // Telegram's stripped JPEG envelope stores height then width after its 0x01 marker.
  return validDimensions(bytes[2], bytes[1]) ?? { width: 1, height: 1 }
}

function validDimensions(width: number | undefined, height: number | undefined): { width: number, height: number } | undefined {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : undefined
}

function hasDimensions(media: Pick<IMMedia<QQMediaLocator>, 'width' | 'height'>): boolean {
  return validDimensions(media.width, media.height) !== undefined
}

function remember(cache: Map<string, PreparedPreview>, key: string, preview: PreparedPreview): PreparedPreview {
  cache.delete(key)
  cache.set(key, preview)
  if (cache.size > MEMORY_PREVIEW_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return preview
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}
