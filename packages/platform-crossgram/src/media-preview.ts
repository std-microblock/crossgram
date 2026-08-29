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
  private readonly active = new Map<string, Promise<Uint8Array>>()
  private readonly memory = new Map<string, Uint8Array>()
  private readonly waiters: Array<() => void> = []
  private running = 0

  constructor(private readonly options: QQMediaPreviewOptions = {}) {
    this.enabled = options.enabled ?? false
    this.concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? 2)))
  }

  /** Attach only an already-memory-resident inline preview; never perform I/O. */
  project(media: IMMedia<QQMediaLocator>): IMMedia<QQMediaLocator> {
    if (!this.enabled || !isInlinePreviewMedia(media) || !media.locator || media.strippedThumbnail) return media
    const bytes = this.memory.get(mediaPreviewKey(media.locator))
    return bytes ? { ...media, strippedThumbnail: remember(this.memory, mediaPreviewKey(media.locator), bytes) } : media
  }

  async prepare(
    media: IMMedia<QQMediaLocator>,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<IMMedia<QQMediaLocator>> {
    if (!this.enabled || !isInlinePreviewMedia(media) || !media.locator || media.strippedThumbnail) return media
    const key = mediaPreviewKey(media.locator)
    const bytes = await this.open(key, source, signal)
    return { ...media, strippedThumbnail: bytes }
  }

  private async open(
    key: string,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
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
  ): Promise<Uint8Array> {
    const [stored] = await this.options.database?.get('mtproto_qqnt_inline_preview', { key }) ?? []
    if (stored) return remember(this.memory, key, new Uint8Array(stored.bytes))
    return this.withSlot(async () => {
      const bytes = await this.create(source(signal), signal)
      await this.options.database?.upsert('mtproto_qqnt_inline_preview', [{
        key, bytes: exactArrayBuffer(bytes), updatedAt: new Date(),
      }], ['key'])
      return remember(this.memory, key, bytes)
    })
  }

  private async create(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
    const transformer = sharp({ limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
      .rotate()
      .resize({ width: 40, height: 40, fit: 'inside', withoutEnlargement: true })
      .jpeg({
        quality: 20, chromaSubsampling: '4:2:0', progressive: false, optimizeCoding: false,
      })
    const output = transformer.toBuffer()
    await pipeline(Readable.from(limitedSource(source, signal)), transformer)
    return stripTelegramJpegThumbnail(await output)
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

/** Images and native video thumbnails can be reduced to Telegram's inline JPEG. */
function isInlinePreviewMedia(media: Pick<IMMedia, 'kind' | 'mimeType'>): boolean {
  return media.kind === 'image' || media.mimeType?.toLowerCase().startsWith('video/') === true
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

function remember(cache: Map<string, Uint8Array>, key: string, bytes: Uint8Array): Uint8Array {
  cache.delete(key)
  cache.set(key, bytes)
  if (cache.size > MEMORY_PREVIEW_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return bytes
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
