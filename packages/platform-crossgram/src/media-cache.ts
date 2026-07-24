import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import type { IMDownloadOptions, IMMedia, IMMediaSource, IMSticker, IMStickerAsset } from '@mtproto-relay/bridge'
import ffmpegStatic from 'ffmpeg-static'
import sharp from 'sharp'
import type { QQMediaLocator } from './protocol.js'

export type MediaDownloadMode = 'auto' | 'on-demand'

export interface QQMediaCacheRow {
  key: string
  path: string
  mimeType: string
  size: number
  width: number | null
  height: number | null
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_media_cache: QQMediaCacheRow
  }
}

export interface QQMediaCacheOptions {
  path: string
  /** Eagerly cache received images/small files, or fetch the original only when requested. */
  mediaDownloadMode?: MediaDownloadMode
  /** Maximum file size eagerly cached in auto mode. Images are always eligible. */
  autoDownloadFileSizeLimit?: number
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
}

interface CachedAsset {
  key: string
  path: string
  mimeType: string
  size: number
  width?: number
  height?: number
}

/** Disk-backed, single-flight transformer shared by QQ media and sticker providers. */
export class QQMediaCache {
  readonly path: string
  readonly mediaDownloadMode: MediaDownloadMode
  readonly autoDownloadFileSizeLimit: number
  readonly previewMaxDimension: number
  private readonly ffmpegPath: string
  private readonly active = new Map<string, Promise<CachedAsset>>()

  constructor(private readonly options: QQMediaCacheOptions) {
    this.path = resolve(options.path)
    this.mediaDownloadMode = options.mediaDownloadMode ?? 'on-demand'
    this.autoDownloadFileSizeLimit = options.autoDownloadFileSizeLimit ?? 10 * 1024 * 1024
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
    return {
      source: fileSource(asset.path, asset.size), mimeType: asset.mimeType, size: asset.size,
      width: asset.width, height: asset.height,
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

  shouldAutoDownload(media: IMMedia): boolean {
    return this.mediaDownloadMode === 'auto' && (
      media.kind === 'image'
      || (media.size !== undefined && media.size <= this.autoDownloadFileSizeLimit)
    )
  }

  async prepareMedia(
    media: IMMedia<QQMediaLocator>,
    original: IMMediaSource,
  ): Promise<IMMedia<QQMediaLocator>> {
    const identity = contentIdentity(media)
    if (media.kind === 'file') {
      const extension = safeExtension(media.name)
      const asset = await this.ensure(
        cacheKey('file-original-v1', identity), extension || 'bin',
        media.mimeType ?? 'application/octet-stream', media.width, media.height,
        (temporary) => pipeline(Readable.from(original.stream()), createWriteStream(temporary, { flags: 'wx' })),
      )
      return {
        ...media, size: asset.size,
        locator: { ...media.locator!, cachedPath: asset.path },
      }
    }
    const animated = isAnimatedMedia(media)
    const asset = await this.ensure(
      cacheKey(animated ? 'image-webm-v1' : 'image-webp-v2', identity),
      animated ? 'webm' : 'webp', animated ? 'video/webm' : 'image/webp', media.width, media.height,
      (temporary) => animated ? this.convertAnimated(original, temporary) : this.convertStatic(original, temporary),
    )
    const dimensions = animated
      ? { width: media.width ?? 1, height: media.height ?? 1 }
      : await imageDimensions(asset.path, media.width, media.height)
    const preview = await this.ensure(
      cacheKey('image-preview-webp-v1', identity, this.previewMaxDimension),
      'webp', 'image/webp', undefined, undefined,
      (temporary) => animated
        ? this.extractVideoPreview(asset.path, temporary)
        : this.extractPreview(asset.path, temporary),
    )
    const previewDimensions = await imageDimensions(preview.path, dimensions.width, dimensions.height)
    const name = replaceExtension(media.name, animated ? '.webm' : '.webp')
    return {
      ...media,
      kind: animated ? 'file' : 'image',
      name,
      mimeType: animated ? 'video/webm' : 'image/webp',
      size: asset.size,
      width: dimensions.width,
      height: dimensions.height,
      locator: { ...media.locator!, cachedPath: asset.path },
      preview: {
        mimeType: 'image/webp', size: preview.size,
        width: previewDimensions.width, height: previewDimensions.height,
        locator: { ...media.locator!, cachedPath: preview.path },
      },
    }
  }

  async *download(
    media: IMMedia<QQMediaLocator>,
    original: IMMediaSource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
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
      const scale = `scale=${maxDimension}:${maxDimension}:force_original_aspect_ratio=decrease`
      const videoFilter = maxDimension === 512
        ? `fps=30,${scale}`
        : `fps=30,${scale},pad=${maxDimension}:${maxDimension}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      await runProcess(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-an', '-vf', videoFilter,
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
        '-b:v', '0', '-crf', '32', '-f', 'webm', output,
      ])
    } finally {
      await rm(input, { force: true }).catch(() => undefined)
    }
  }
}

function cacheKey(...values: unknown[]): string {
  return values.map((value) => stableJson(value)).join('\u0000')
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

function contentIdentity(media: IMMedia<QQMediaLocator>): string {
  const locator = media.locator
  if (locator?.sha3) return `sha3:${locator.sha3.toLowerCase()}`
  if (locator?.sha) return `sha:${locator.sha.toLowerCase()}`
  if (locator?.md5) return `md5:${locator.md5.toLowerCase()}`
  return `locator:${stableJson(locator ?? media.id)}`
}

function safeExtension(name?: string): string {
  return extname(name ?? '').replace(/[^.a-zA-Z0-9]/g, '').slice(1, 17).toLowerCase()
}

function replaceExtension(name: string | undefined, extension: string): string | undefined {
  if (!name) return name
  const current = extname(name)
  return `${current ? name.slice(0, -current.length) : name}${extension}`
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
  yield* createReadStream(path, { start, end: start + length - 1 })
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
