import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import {
  stripTelegramJpegThumbnail,
  type IMDownloadOptions, type IMMedia, type IMMediaSource, type IMSticker, type IMStickerAsset,
} from '@mtproto-relay/bridge'
import ffmpegStatic from 'ffmpeg-static'
import sharp from 'sharp'
import type { QQMediaLocator } from './protocol.js'

export interface QQMediaCacheRow {
  key: string
  path: string
  mimeType: string
  size: number
  width: number | null
  height: number | null
  updatedAt: Date
}

export interface QQMediaPreviewRow {
  key: string
  bytes: ArrayBuffer
  strippedBytes: ArrayBuffer | null
  mimeType: string
  size: number
  width: number
  height: number
  updatedAt: Date
}

export interface QQMediaAnimationRow {
  key: string
  animated: boolean
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_media_cache: QQMediaCacheRow
    mtproto_qqnt_media_preview: QQMediaPreviewRow
    mtproto_qqnt_media_animation: QQMediaAnimationRow
  }
}

export interface QQMediaCacheOptions {
  path: string
  /** Generate compact previews and keep their bytes in the database. */
  generatePreviews?: boolean
  /** Maximum width/height of generated image previews. */
  previewMaxDimension?: number
  /** Override the bundled FFmpeg executable used for GIF/APNG sticker conversion. */
  ffmpegPath?: string
  database?: Database
}

export function defineQQMediaCacheModel(ctx: Context): void {
  ctx.model.extend('mtproto_qqnt_media_cache', {
    key: 'string', path: 'text', mimeType: 'string', size: 'unsigned',
    width: { type: 'unsigned', nullable: true }, height: { type: 'unsigned', nullable: true },
    updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
  ctx.model.extend('mtproto_qqnt_media_preview', {
    key: 'string', bytes: 'binary', strippedBytes: { type: 'binary', nullable: true },
    mimeType: 'string', size: 'unsigned',
    width: 'unsigned', height: 'unsigned', updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
  ctx.model.extend('mtproto_qqnt_media_animation', {
    key: 'string', animated: 'boolean', updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
}

export interface QQMediaRangeSource {
  read(options: { offset: number, limit: number, signal?: AbortSignal }): AsyncIterable<Uint8Array>
}

interface CachedAsset {
  key: string
  path: string
  mimeType: string
  size: number
  width?: number
  height?: number
}

interface CachedPreview {
  key: string
  bytes: Uint8Array
  mimeType: string
  size: number
  width: number
  height: number
  strippedThumbnail?: Uint8Array
}

/** Disk-backed, single-flight transformer shared by QQ media and sticker providers. */
export class QQMediaCache {
  readonly path: string
  readonly generatePreviews: boolean
  readonly previewMaxDimension: number
  private readonly ffmpegPath: string
  private readonly active = new Map<string, Promise<CachedAsset>>()
  private readonly activePreviews = new Map<string, Promise<CachedPreview | undefined>>()
  private readonly memoryPreviews = new Map<string, CachedPreview>()
  private readonly animationDecisions = new Map<string, boolean>()

  constructor(private readonly options: QQMediaCacheOptions) {
    this.path = resolve(options.path)
    this.generatePreviews = options.generatePreviews ?? true
    this.previewMaxDimension = options.previewMaxDimension ?? 320
    this.ffmpegPath = options.ffmpegPath
      || (ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg')
    mkdirSync(this.path, { recursive: true })
  }

  projectSticker(sticker: IMSticker): IMSticker {
    if (sticker.format === 'animated' || isAnimatedImage(sticker.mimeType)) {
      return { ...sticker, format: 'video', mimeType: 'video/webm', size: undefined }
    }
    if (sticker.format === 'static') return { ...sticker, mimeType: 'image/webp', size: undefined }
    return sticker
  }

  async openSticker(sticker: IMSticker, original: IMStickerAsset): Promise<IMStickerAsset> {
    const animated = sticker.format === 'animated' || isAnimatedImage(original.mimeType)
    const thumbnail = animated
      ? this.prepareStickerThumbnail(sticker, original.source).catch(() => undefined)
      : undefined
    const kind = animated ? 'sticker-webm-v1' : 'sticker-webp-v1'
    const asset = await this.ensure(
      cacheKey(kind, sticker.providerId, sticker.stickerId, sticker.version ?? 0, sticker.locator),
      animated ? 'webm' : 'webp',
      animated ? 'video/webm' : 'image/webp',
      sticker.width, sticker.height,
      async (temporary) => {
        if (animated) await this.convertAnimated(original.source, temporary)
        else await this.convertStatic(original.source, temporary)
      },
    )
    await thumbnail
    return {
      source: fileSource(asset.path, asset.size), mimeType: asset.mimeType, size: asset.size,
      width: asset.width, height: asset.height,
    }
  }

  async restoreStickerThumbnail(sticker: IMSticker): Promise<IMSticker> {
    const preview = await this.getPreview(stickerPreviewKey(sticker))
    return preview ? attachStickerThumbnail(sticker, preview) : sticker
  }

  async prepareStickerThumbnail(sticker: IMSticker, source: IMMediaSource): Promise<IMSticker> {
    const preview = await this.ensurePreview(
      stickerPreviewLogicalKey(sticker),
      () => this.previewFromSource(source),
    )
    return preview ? attachStickerThumbnail(sticker, preview) : sticker
  }

  async openStickerThumbnail(sticker: IMSticker): Promise<IMStickerAsset | null> {
    const locator = sticker.thumbnail?.locator
    const key = locator && typeof locator === 'object' && !Array.isArray(locator)
      && typeof locator.cacheKey === 'string' ? locator.cacheKey : undefined
    if (!key) return null
    const preview = await this.getPreview(key)
    if (!preview) return null
    return {
      source: memorySource(preview.bytes), mimeType: preview.mimeType, size: preview.size,
      width: preview.width, height: preview.height,
    }
  }

  async openReaction(
    key: string,
    version: number,
    format: 'static' | 'video',
    original: IMStickerAsset,
  ): Promise<IMStickerAsset> {
    const animated = format === 'video'
    const kind = animated ? 'reaction-webm-v1' : 'reaction-webp-v1'
    const asset = await this.ensure(
      cacheKey(kind, key, version),
      animated ? 'webm' : 'webp',
      animated ? 'video/webm' : 'image/webp',
      100, 100,
      async (temporary) => {
        if (animated) await this.convertAnimated(original.source, temporary, 100)
        else await this.convertStatic(original.source, temporary, 100)
      },
    )
    return {
      source: fileSource(asset.path, asset.size), mimeType: asset.mimeType, size: asset.size,
      width: 100, height: 100,
    }
  }

  shouldPrepare(media: IMMedia): boolean {
    return media.kind === 'image' && (
      this.generatePreviews || isAnimatedMedia(media) || mayBeAnimatedPng(media)
    )
  }

  async prepareInitialMedia(
    media: IMMedia<QQMediaLocator>,
    original: IMMediaSource,
  ): Promise<IMMedia<QQMediaLocator>> {
    if (media.kind !== 'image') return media
    const ready = await this.readyAnimatedMedia(media)
    if (ready) return ready
    return this.attachPreview(media, contentIdentity(media), original)
  }

  /** Restore already prepared media without opening the upstream source. */
  async restoreInitialMedia(
    media: IMMedia<QQMediaLocator>,
  ): Promise<IMMedia<QQMediaLocator> | undefined> {
    if (media.kind !== 'image') return media
    const ready = await this.readyAnimatedMedia(media, false)
    if (ready) return ready
    if (!this.generatePreviews) return media
    const preview = await this.getPreview(createHash('sha256').update(cacheKey(
      'image-preview-db-v1', contentIdentity(media), this.previewMaxDimension,
    )).digest('hex'))
    return preview ? attachMediaPreview(media, preview) : undefined
  }

  async prepareAnimatedUpgrade(
    media: IMMedia<QQMediaLocator>,
    original: IMMediaSource,
    ranges: QQMediaRangeSource,
    signal?: AbortSignal,
  ): Promise<IMMedia<QQMediaLocator> | undefined> {
    if (media.kind !== 'image') return
    const identity = contentIdentity(media)
    let animated = isAnimatedMedia(media)
    if (!animated && mayBeAnimatedPng(media)) {
      animated = await this.isAnimatedPng(identity, ranges, signal)
    }
    if (!animated) return
    return this.prepareAnimatedImage(media, identity, original)
  }

  /** Synchronous compatibility helper used by focused transformer tests. */
  async prepareMedia(
    media: IMMedia<QQMediaLocator>,
    original: IMMediaSource,
  ): Promise<IMMedia<QQMediaLocator>> {
    const upgraded = await this.prepareAnimatedUpgrade(media, original, {
      read: ({ offset, limit, signal }) => rangedSource(original.stream({ signal }), offset, limit),
    })
    return upgraded ?? this.prepareInitialMedia(media, original)
  }

  private async readyAnimatedMedia(
    media: IMMedia<QQMediaLocator>,
    includePreview = true,
  ): Promise<IMMedia<QQMediaLocator> | undefined> {
    const identity = contentIdentity(media)
    const asset = cachedAsset(
      this.path, cacheKey('image-webm-v4', identity), 'webm', 'video/webm', media.width, media.height,
    )
    if (!asset) return
    return this.finishAnimatedMedia(media, identity, asset, undefined, includePreview)
  }

  private async prepareAnimatedImage(
    media: IMMedia<QQMediaLocator>,
    identity: string,
    original: IMMediaSource,
    originalPath?: string,
    sourceDimensions?: { width: number, height: number },
  ): Promise<IMMedia<QQMediaLocator>> {
    const asset = await this.ensure(
      cacheKey('image-webm-v4', identity),
      'webm', 'video/webm', media.width, media.height,
      (temporary) => originalPath
        ? this.convertAnimatedFile(originalPath, temporary)
        : this.convertAnimated(original, temporary),
    )
    return this.finishAnimatedMedia(media, identity, asset, sourceDimensions)
  }

  private async finishAnimatedMedia(
    media: IMMedia<QQMediaLocator>,
    identity: string,
    asset: CachedAsset,
    sourceDimensions?: { width: number, height: number },
    includePreview = true,
  ): Promise<IMMedia<QQMediaLocator>> {
    const dimensions = fitWithin(sourceDimensions ?? { width: media.width ?? 1, height: media.height ?? 1 }, 512)
    const converted: IMMedia<QQMediaLocator> = {
      ...media,
      id: `${media.id}:webm-v1`,
      kind: 'file',
      name: replaceExtension(media.name, '.webm'),
      mimeType: 'video/webm',
      size: asset.size,
      width: dimensions.width,
      height: dimensions.height,
      locator: { ...readyLocator(media.locator!), cachedPath: asset.path },
    }
    return includePreview
      ? this.attachPreview(converted, `${identity}:webm-v1`, fileSource(asset.path, asset.size), asset.path, true)
      : converted
  }

  private async isAnimatedPng(
    identity: string,
    ranges: QQMediaRangeSource,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = createHash('sha256').update(cacheKey('png-animation-v1', identity)).digest('hex')
    const memory = this.animationDecisions.get(key)
    if (memory !== undefined) return memory
    const [stored] = await this.options.database?.get('mtproto_qqnt_media_animation', { key }) ?? []
    if (stored) {
      this.animationDecisions.set(key, stored.animated)
      return stored.animated
    }
    const animated = await sniffAnimatedPng(ranges, signal)
    this.animationDecisions.set(key, animated)
    await this.options.database?.upsert('mtproto_qqnt_media_animation', [{
      key, animated, updatedAt: new Date(),
    }], ['key'])
    return animated
  }

  private async attachPreview(
    media: IMMedia<QQMediaLocator>,
    identity: string,
    source: IMMediaSource,
    sourcePath?: string,
    video = false,
  ): Promise<IMMedia<QQMediaLocator>> {
    if (!this.generatePreviews) return media
    const preview = await this.ensurePreview(
      cacheKey('image-preview-db-v1', identity, this.previewMaxDimension),
      () => video
        ? this.previewFromVideo(sourcePath!)
        : sourcePath ? this.previewFromFile(sourcePath) : this.previewFromSource(source),
    )
    if (!preview) return media
    return attachMediaPreview(media, preview)
  }

  async *download(
    media: IMMedia<QQMediaLocator>,
    original: IMMediaSource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const previewKey = media.locator?.previewKey
    if (previewKey) {
      const preview = await this.getPreview(previewKey)
      if (!preview) throw new Error(`QQ media preview is unavailable: ${previewKey}`)
      const start = Math.min(preview.size, Math.max(0, Math.trunc(options.offset ?? 0)))
      const length = rangedSize(preview.size, start, options.limit)
      if (length) yield preview.bytes.subarray(start, start + length)
      return
    }
    const cachedPath = media.locator?.cachedPath
    const source = cachedPath && existsSync(cachedPath)
      ? rangedFile(cachedPath, options.offset, options.limit)
      : rangedSource(original.stream({ signal: options.signal }), options.offset, options.limit)
    const totalBytes = rangedSize(media.size ?? 0, options.offset, options.limit) || undefined
    let transferredBytes = 0
    for await (const chunk of source) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('media download aborted')
      transferredBytes += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes,
        totalBytes,
      })
      yield chunk
    }
  }

  private async ensurePreview(
    logicalKey: string,
    create: () => Promise<{ bytes: Uint8Array, width: number, height: number }>,
  ): Promise<CachedPreview | undefined> {
    const key = createHash('sha256').update(logicalKey).digest('hex')
    const current = this.activePreviews.get(key)
    if (current) return current
    const pending = this.ensurePreviewOnce(key, create)
    this.activePreviews.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.activePreviews.get(key) === pending) this.activePreviews.delete(key)
    }
  }

  private async ensurePreviewOnce(
    key: string,
    create: () => Promise<{ bytes: Uint8Array, width: number, height: number }>,
  ): Promise<CachedPreview | undefined> {
    const memory = this.memoryPreviews.get(key)
    if (memory) return memory
    const [stored] = await this.options.database?.get('mtproto_qqnt_media_preview', { key }) ?? []
    if (stored) {
      const bytes = new Uint8Array(stored.bytes)
      const strippedThumbnail = stored.strippedBytes
        ? new Uint8Array(stored.strippedBytes)
        : await createStrippedThumbnail(bytes)
      if (!stored.strippedBytes) {
        await this.options.database?.set('mtproto_qqnt_media_preview', { key }, {
          strippedBytes: exactArrayBuffer(strippedThumbnail),
        })
      }
      return rememberPreview(this.memoryPreviews, {
        key, bytes, strippedThumbnail, mimeType: stored.mimeType,
        size: stored.size, width: stored.width, height: stored.height,
      })
    }
    const created = await create()
    if (created.bytes.byteLength > MAX_DATABASE_PREVIEW_BYTES) return
    const strippedThumbnail = await createStrippedThumbnail(created.bytes)
    const preview: CachedPreview = {
      key, bytes: created.bytes, mimeType: 'image/webp', size: created.bytes.byteLength,
      width: created.width, height: created.height, strippedThumbnail,
    }
    await this.options.database?.upsert('mtproto_qqnt_media_preview', [{
      key, bytes: exactArrayBuffer(created.bytes), strippedBytes: exactArrayBuffer(strippedThumbnail),
      mimeType: preview.mimeType, size: preview.size,
      width: preview.width, height: preview.height, updatedAt: new Date(),
    }], ['key'])
    return rememberPreview(this.memoryPreviews, preview)
  }

  private async getPreview(key: string): Promise<CachedPreview | undefined> {
    const memory = this.memoryPreviews.get(key)
    if (memory) return memory
    const [stored] = await this.options.database?.get('mtproto_qqnt_media_preview', { key }) ?? []
    if (!stored) return
    return rememberPreview(this.memoryPreviews, {
      key, bytes: new Uint8Array(stored.bytes), mimeType: stored.mimeType,
      size: stored.size, width: stored.width, height: stored.height,
    })
  }

  private async previewFromSource(source: IMMediaSource) {
    const transformer = sharp().rotate().resize({
      width: this.previewMaxDimension, height: this.previewMaxDimension,
      fit: 'inside', withoutEnlargement: true,
    }).webp({ quality: 80, effort: 4 })
    const output = transformer.toBuffer({ resolveWithObject: true })
    await pipeline(Readable.from(source.stream()), transformer)
    const { data, info } = await output
    return { bytes: new Uint8Array(data), width: info.width, height: info.height }
  }

  private async previewFromFile(path: string) {
    const { data, info } = await sharp(path).rotate().resize({
      width: this.previewMaxDimension, height: this.previewMaxDimension,
      fit: 'inside', withoutEnlargement: true,
    }).webp({ quality: 80, effort: 4 }).toBuffer({ resolveWithObject: true })
    return { bytes: new Uint8Array(data), width: info.width, height: info.height }
  }

  private async previewFromVideo(path: string) {
    const output = join(this.path, `${randomUUID()}.preview.webp`)
    try {
      await this.extractVideoPreview(path, output)
      const bytes = new Uint8Array(await readFile(output))
      const dimensions = await imageDimensions(output)
      return { bytes, width: dimensions.width, height: dimensions.height }
    } finally {
      await rm(output, { force: true }).catch(() => undefined)
    }
  }

  private async ensure(
    key: string,
    extension: string,
    mimeType: string,
    width: number | undefined,
    height: number | undefined,
    create: (temporary: string) => Promise<void>,
  ): Promise<CachedAsset> {
    const current = this.active.get(key)
    if (current) return current
    const pending = this.ensureOnce(key, extension, mimeType, width, height, create)
    this.active.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.active.get(key) === pending) this.active.delete(key)
    }
  }

  private async ensureOnce(
    key: string,
    extension: string,
    mimeType: string,
    width: number | undefined,
    height: number | undefined,
    create: (temporary: string) => Promise<void>,
  ): Promise<CachedAsset> {
    const digest = createHash('sha256').update(key).digest('hex')
    const target = join(this.path, `${digest}.${extension}`)
    if (!existsSync(target)) {
      const temporary = join(this.path, `${digest}.${randomUUID()}.${extension}.tmp`)
      try {
        await create(temporary)
        await rename(temporary, target).catch(async (error) => {
          if (!existsSync(target)) throw error
        })
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    // The logical cache key uses NUL separators to remain unambiguous. Keep
    // those out of SQL string literals and use the same stable digest that
    // names the on-disk asset for the optional database index.
    const asset = { key: digest, path: target, mimeType, size: statSync(target).size, width, height }
    await this.options.database?.upsert('mtproto_qqnt_media_cache', [{
      key: asset.key, path: target, mimeType, size: asset.size,
      width: width ?? null, height: height ?? null, updatedAt: new Date(),
    }], ['key'])
    return asset
  }

  private async convertStatic(source: IMMediaSource, output: string, squareSize?: number): Promise<void> {
    const transformer = sharp().rotate()
    if (squareSize) transformer.resize(squareSize, squareSize, { fit: 'contain' })
    await pipeline(
      Readable.from(source.stream()),
      transformer.webp({ quality: 90, effort: 4 }),
      createWriteStream(output, { flags: 'wx' }),
    )
  }

  private async convertStaticFile(source: string, output: string): Promise<void> {
    await sharp(source).rotate().webp({ quality: 90, effort: 4 }).toFile(output)
  }

  private async extractPreview(source: string, output: string): Promise<void> {
    await sharp(source).rotate().resize({
      width: this.previewMaxDimension,
      height: this.previewMaxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    }).webp({ quality: 80, effort: 4 }).toFile(output)
  }

  private async extractVideoPreview(source: string, output: string): Promise<void> {
    const scale = `scale=${this.previewMaxDimension}:${this.previewMaxDimension}:force_original_aspect_ratio=decrease`
    await runProcess(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-frames:v', '1', '-vf', scale, '-c:v', 'libwebp', '-f', 'webp', output,
    ])
  }

  private async convertAnimated(source: IMMediaSource, output: string, maxDimension = 512): Promise<void> {
    if (isAbsolute(this.ffmpegPath) && !existsSync(this.ffmpegPath)) {
      throw new Error(`FFmpeg executable is unavailable: ${this.ffmpegPath}`)
    }
    const input = join(this.path, `${randomUUID()}.animated-input`)
    try {
      await pipeline(Readable.from(source.stream()), createWriteStream(input, { flags: 'wx' }))
      await this.convertAnimatedFile(input, output, maxDimension)
    } finally {
      await rm(input, { force: true }).catch(() => undefined)
    }
  }

  private async convertAnimatedFile(source: string, output: string, maxDimension = 512): Promise<void> {
    if (isAbsolute(this.ffmpegPath) && !existsSync(this.ffmpegPath)) {
      throw new Error(`FFmpeg executable is unavailable: ${this.ffmpegPath}`)
    }
    const videoFilter = maxDimension === 512
      ? `fps=30,scale='min(${maxDimension},iw)':'min(${maxDimension},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
      : `fps=30,scale=${maxDimension}:${maxDimension}:force_original_aspect_ratio=decrease,pad=${maxDimension}:${maxDimension}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    await runProcess(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-an', '-vf', videoFilter,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
      '-b:v', '0', '-crf', '32', '-f', 'webm', output,
    ])
  }
}

function cacheKey(...values: unknown[]): string {
  return values.map((value) => stableJson(value)).join('\u0000')
}

function stickerPreviewLogicalKey(sticker: IMSticker): string {
  return cacheKey(
    'sticker-preview-db-v1', sticker.providerId, sticker.stickerId,
    sticker.version ?? 0, sticker.locator,
  )
}

function stickerPreviewKey(sticker: IMSticker): string {
  return createHash('sha256').update(stickerPreviewLogicalKey(sticker)).digest('hex')
}

function attachStickerThumbnail(sticker: IMSticker, preview: CachedPreview): IMSticker {
  return {
    ...sticker,
    thumbnail: {
      mimeType: preview.mimeType, size: preview.size, width: preview.width, height: preview.height,
      locator: { cacheKey: preview.key },
    },
  }
}

function attachMediaPreview(
  media: IMMedia<QQMediaLocator>,
  preview: CachedPreview,
): IMMedia<QQMediaLocator> {
  return {
    ...media,
    locator: readyLocator(media.locator!),
    strippedThumbnail: preview.strippedThumbnail,
    preview: {
      mimeType: preview.mimeType, size: preview.size, width: preview.width, height: preview.height,
      locator: { ...readyLocator(media.locator!), cachedPath: undefined, previewKey: preview.key },
    },
  }
}

function readyLocator(locator: QQMediaLocator): QQMediaLocator {
  const { deferred: _deferred, ...ready } = locator
  return ready
}

function memorySource(bytes: Uint8Array): IMMediaSource {
  return {
    size: bytes.byteLength,
    async *stream() {
      yield bytes
    },
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function isAnimatedImage(mimeType: string): boolean {
  return mimeType === 'image/gif' || mimeType === 'image/apng'
}

function isAnimatedMedia(media: IMMedia): boolean {
  return isAnimatedImage(media.mimeType ?? '') || /\.(?:gif|apng)$/i.test(media.name ?? '')
}

function mayBeAnimatedPng(media: IMMedia): boolean {
  return media.mimeType === 'image/png' || /\.png$/i.test(media.name ?? '')
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_SNIFF_CHUNK_BYTES = 64 * 1024
const MAX_PNG_SNIFF_BYTES = 1024 * 1024
const MAX_DATABASE_PREVIEW_BYTES = 256 * 1024
const MEMORY_PREVIEW_CACHE_LIMIT = 1024

function fitWithin(dimensions: { width: number, height: number }, maximum: number) {
  const ratio = Math.min(1, maximum / dimensions.width, maximum / dimensions.height)
  return {
    width: Math.max(2, Math.floor(dimensions.width * ratio / 2) * 2),
    height: Math.max(2, Math.floor(dimensions.height * ratio / 2) * 2),
  }
}

function contentIdentity(media: IMMedia<QQMediaLocator>): string {
  const locator = media.locator
  if (locator?.sha3) return `sha3:${locator.sha3.toLowerCase()}`
  if (locator?.sha) return `sha:${locator.sha.toLowerCase()}`
  if (locator?.md5) return `md5:${locator.md5.toLowerCase()}`
  return `locator:${stableJson(locator ?? media.id)}`
}

function cachedAsset(
  directory: string,
  logicalKey: string,
  extension: string,
  mimeType: string,
  width?: number,
  height?: number,
): CachedAsset | undefined {
  const key = createHash('sha256').update(logicalKey).digest('hex')
  const path = join(directory, `${key}.${extension}`)
  if (!existsSync(path)) return
  return { key, path, mimeType, size: statSync(path).size, width, height }
}

async function sniffAnimatedPng(ranges: QQMediaRangeSource, signal?: AbortSignal): Promise<boolean> {
  let bytes = Buffer.alloc(0)
  for (let offset = 0; offset < MAX_PNG_SNIFF_BYTES; offset += PNG_SNIFF_CHUNK_BYTES) {
    const chunks: Buffer[] = []
    for await (const chunk of ranges.read({ offset, limit: PNG_SNIFF_CHUNK_BYTES, signal })) {
      chunks.push(Buffer.from(chunk))
    }
    const next = Buffer.concat(chunks)
    if (!next.length) throw new Error('PNG animation probe ended before IDAT')
    bytes = Buffer.concat([bytes, next])
    const decision = pngAnimationDecision(bytes)
    if (decision !== undefined) return decision
    if (next.length < PNG_SNIFF_CHUNK_BYTES) break
  }
  throw new Error(`PNG animation probe exceeded ${MAX_PNG_SNIFF_BYTES} bytes before IDAT`)
}

function pngAnimationDecision(bytes: Buffer): boolean | undefined {
  if (bytes.length < PNG_SIGNATURE.length) return
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false
  let position = PNG_SIGNATURE.length
  while (position + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(position)
    if (length > MAX_PNG_SNIFF_BYTES) throw new Error(`PNG chunk is too large to probe: ${length}`)
    const end = position + 12 + length
    if (end > bytes.length) return
    const type = bytes.toString('ascii', position + 4, position + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    position = end
  }
}

function replaceExtension(name: string | undefined, extension: string): string | undefined {
  if (!name) return name
  const current = extname(name)
  return `${current ? name.slice(0, -current.length) : name}${extension}`
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function createStrippedThumbnail(input: Uint8Array): Promise<Uint8Array> {
  const jpeg = await sharp(input).resize({
    width: 40, height: 40, fit: 'inside', withoutEnlargement: true,
  }).jpeg({
    quality: 20, chromaSubsampling: '4:2:0', progressive: false, optimizeCoding: false,
  }).toBuffer()
  return stripTelegramJpegThumbnail(jpeg)
}

function rememberPreview(cache: Map<string, CachedPreview>, preview: CachedPreview): CachedPreview {
  cache.set(preview.key, preview)
  if (cache.size > MEMORY_PREVIEW_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return preview
}

async function imageDimensions(
  path: string,
  fallbackWidth?: number,
  fallbackHeight?: number,
): Promise<{ width: number, height: number }> {
  const metadata = await sharp(path).metadata()
  return {
    width: metadata.width ?? fallbackWidth ?? 1,
    height: metadata.height ?? fallbackHeight ?? 1,
  }
}

function fileSource(path: string, size: number): IMMediaSource {
  return { size, stream: () => createReadStream(path) }
}

async function* rangedFile(path: string, offset = 0, limit?: number): AsyncIterable<Uint8Array> {
  const size = statSync(path).size
  const start = Math.min(size, Math.max(0, Math.trunc(offset)))
  const length = rangedSize(size, start, limit)
  if (!length) return
  const stream = createReadStream(path, { start, end: start + length - 1 })
  try {
    for await (const chunk of stream) yield chunk
  } finally {
    if (!stream.closed) {
      stream.destroy()
      await once(stream, 'close').catch(() => undefined)
    }
  }
}

async function* rangedSource(
  source: AsyncIterable<Uint8Array>,
  offset = 0,
  limit?: number,
): AsyncIterable<Uint8Array> {
  let skipped = 0
  let emitted = 0
  const start = Math.max(0, Math.trunc(offset))
  const maximum = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit))
  if (!maximum) return
  for await (const chunk of source) {
    if (skipped + chunk.length <= start) {
      skipped += chunk.length
      continue
    }
    const chunkStart = Math.max(0, start - skipped)
    const accepted = chunk.subarray(chunkStart, chunkStart + maximum - emitted)
    skipped += chunk.length
    if (accepted.length) {
      emitted += accepted.length
      yield accepted
    }
    if (emitted >= maximum) return
  }
}

function rangedSize(size: number, offset = 0, limit?: number): number {
  const available = Math.max(0, size - Math.max(0, Math.trunc(offset)))
  return limit === undefined ? available : Math.min(available, Math.max(0, Math.trunc(limit)))
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const errors: Buffer[] = []
    child.stderr.on('data', (chunk) => {
      errors.push(Buffer.from(chunk))
      if (errors.reduce((size, item) => size + item.length, 0) > 64 * 1024) errors.shift()
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`FFmpeg failed (${code ?? signal}): ${Buffer.concat(errors).toString('utf8').trim()}`))
    })
  })
}
