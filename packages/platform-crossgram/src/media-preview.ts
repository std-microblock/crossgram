import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import type { IMMedia } from '@mtproto-relay/bridge'
import sharp from 'sharp'
import type { QQMediaLocator } from './protocol.js'

export interface QQMediaPreviewRowV2 {
  key: string
  bytes: ArrayBuffer
  mimeType: string
  size: number
  width: number
  height: number
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_media_preview_v2: QQMediaPreviewRowV2
  }
}

export function defineQQMediaPreviewModel(ctx: Context): void {
  ctx.model.extend('mtproto_qqnt_media_preview_v2', {
    key: 'string', bytes: 'binary', mimeType: 'string', size: 'unsigned',
    width: 'unsigned', height: 'unsigned', updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
}

export interface QQMediaPreviewOptions {
  enabled?: boolean
  maxDimension?: number
  concurrency?: number
  database?: Database
}

interface CachedPreview {
  key: string
  bytes: Uint8Array
  mimeType: string
  size: number
  width: number
  height: number
}

const MAX_DATABASE_PREVIEW_BYTES = 256 * 1024
const MAX_PREVIEW_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_INPUT_PIXELS = 64 * 1024 * 1024
const MEMORY_PREVIEW_CACHE_LIMIT = 256

/**
 * Lazy, isolated thumbnail generator.
 *
 * Projection is synchronous and metadata-only. Original bytes are not opened
 * until upload.getFile asks for thumb_size=m, so history and live-message
 * delivery can never wait for download, decoding, resizing, or database I/O.
 */
export class QQMediaPreviewer {
  readonly enabled: boolean
  readonly maxDimension: number
  readonly concurrency: number
  private readonly active = new Map<string, Promise<CachedPreview>>()
  private readonly memory = new Map<string, CachedPreview>()
  private readonly waiters: Array<() => void> = []
  private running = 0

  constructor(private readonly options: QQMediaPreviewOptions = {}) {
    this.enabled = options.enabled ?? false
    this.maxDimension = Math.max(32, Math.min(1024, Math.trunc(options.maxDimension ?? 320)))
    this.concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? 2)))
  }

  project(media: IMMedia<QQMediaLocator>): IMMedia<QQMediaLocator> {
    if (!this.enabled || media.kind !== 'image' || !media.locator || media.preview) return media
    const dimensions = fitWithin({ width: media.width ?? 1, height: media.height ?? 1 }, this.maxDimension)
    const locator = rawLocator(media.locator)
    return {
      ...media,
      preview: {
        mimeType: 'image/webp',
        // Telegram uses this as a scheduling hint. The real size is returned
        // by upload.getFile after lazy generation.
        size: Math.max(1, Math.min(media.size ?? 64 * 1024, MAX_DATABASE_PREVIEW_BYTES)),
        width: dimensions.width,
        height: dimensions.height,
        locator: { ...locator, previewKey: mediaPreviewKey(locator, this.maxDimension) },
      },
    }
  }

  async open(
    locator: QQMediaLocator,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<CachedPreview> {
    const key = locator.previewKey
    if (!this.enabled || !key) throw new Error('QQ media preview generation is disabled')
    const expected = mediaPreviewKey(rawLocator(locator), this.maxDimension)
    if (key !== expected) throw new Error('QQ media preview reference is invalid')
    const cached = this.memory.get(key)
    if (cached) return remember(this.memory, cached)
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
  ): Promise<CachedPreview> {
    const [stored] = await this.options.database?.get('mtproto_qqnt_media_preview_v2', { key }) ?? []
    if (stored) return remember(this.memory, {
      key, bytes: new Uint8Array(stored.bytes), mimeType: stored.mimeType,
      size: stored.size, width: stored.width, height: stored.height,
    })
    return this.withSlot(async () => {
      const created = await this.create(source(signal), signal)
      if (created.bytes.byteLength > MAX_DATABASE_PREVIEW_BYTES) {
        throw new Error(`QQ media preview exceeds ${MAX_DATABASE_PREVIEW_BYTES} bytes`)
      }
      const preview: CachedPreview = {
        key, bytes: created.bytes, mimeType: 'image/webp', size: created.bytes.byteLength,
        width: created.width, height: created.height,
      }
      await this.options.database?.upsert('mtproto_qqnt_media_preview_v2', [{
        key, bytes: exactArrayBuffer(preview.bytes), mimeType: preview.mimeType,
        size: preview.size, width: preview.width, height: preview.height, updatedAt: new Date(),
      }], ['key'])
      return remember(this.memory, preview)
    })
  }

  private async create(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    const transformer = sharp({ limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
      .rotate()
      .resize({
        width: this.maxDimension, height: this.maxDimension,
        fit: 'inside', withoutEnlargement: true,
      })
      .webp({ quality: 80, effort: 4 })
    const output = transformer.toBuffer({ resolveWithObject: true })
    await pipeline(Readable.from(limitedSource(source, signal)), transformer)
    const { data, info } = await output
    return { bytes: new Uint8Array(data), width: info.width, height: info.height }
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.running++
    try {
      return await run()
    } finally {
      this.running--
      this.waiters.shift()?.()
    }
  }
}

export function mediaPreviewKey(locator: QQMediaLocator, maxDimension: number): string {
  const identity = locator.sha3
    ? `sha3:${locator.sha3.toLowerCase()}`
    : locator.sha
      ? `sha:${locator.sha.toLowerCase()}`
      : locator.md5
        ? `md5:${locator.md5.toLowerCase()}`
        : `locator:${stableJson(rawLocator(locator))}`
  return createHash('sha256').update(`qq-preview-v2\0${identity}\0${maxDimension}`).digest('hex')
}

function rawLocator(locator: QQMediaLocator): QQMediaLocator {
  const { cachedPath: _cachedPath, previewKey: _previewKey, deferred: _deferred, ...raw } = locator
  return raw
}

function fitWithin(dimensions: { width: number, height: number }, maximum: number) {
  const width = Number.isFinite(dimensions.width) && dimensions.width > 0 ? dimensions.width : 1
  const height = Number.isFinite(dimensions.height) && dimensions.height > 0 ? dimensions.height : 1
  const ratio = Math.min(1, maximum / width, maximum / height)
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

async function* limitedSource(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let total = 0
  for await (const chunk of source) {
    if (signal?.aborted) throw signal.reason ?? new Error('preview generation aborted')
    total += chunk.byteLength
    if (total > MAX_PREVIEW_SOURCE_BYTES) {
      throw new Error(`QQ media preview source exceeds ${MAX_PREVIEW_SOURCE_BYTES} bytes`)
    }
    yield chunk
  }
}

function remember(cache: Map<string, CachedPreview>, preview: CachedPreview): CachedPreview {
  cache.delete(preview.key)
  cache.set(preview.key, preview)
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
