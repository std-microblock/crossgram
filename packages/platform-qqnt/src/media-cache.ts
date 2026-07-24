import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import type { IMDownloadOptions, IMMedia, IMMediaSource, IMSticker, IMStickerAsset } from '@mtproto-relay/bridge'
import ffmpegStatic from 'ffmpeg-static'
import sharp from 'sharp'

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
  /** Convert and cache every downloaded QQ image as WebP. Disabled by default. */
  cacheAndConvertImages?: boolean
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
  readonly cacheAndConvertImages: boolean
  private readonly ffmpegPath: string
  private readonly active = new Map<string, Promise<CachedAsset>>()

  constructor(private readonly options: QQMediaCacheOptions) {
    this.path = resolve(options.path)
    this.cacheAndConvertImages = options.cacheAndConvertImages ?? false
    this.ffmpegPath = options.ffmpegPath
      || (ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg')
    mkdirSync(this.path, { recursive: true })
  }

  projectSticker(sticker: IMSticker): IMSticker {
    if (sticker.format === 'animated' || isAnimatedImage(sticker.mimeType)) {
      return { ...sticker, format: 'video', mimeType: 'video/webm', size: undefined }
    }
    if (this.cacheAndConvertImages && sticker.format === 'static') {
      return { ...sticker, mimeType: 'image/webp', size: undefined }
    }
    return sticker
  }

  async openSticker(sticker: IMSticker, original: IMStickerAsset): Promise<IMStickerAsset> {
    const animated = sticker.format === 'animated' || isAnimatedImage(original.mimeType)
    if (!animated && !this.cacheAndConvertImages) return original
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

  async *downloadImage(
    media: IMMedia,
    original: IMMediaSource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    if (!this.cacheAndConvertImages || media.kind !== 'image') {
      yield* original.stream({ signal: options.signal })
      return
    }
    const asset = await this.ensure(
      cacheKey('image-webp-v1', media.id, media.locator),
      'webp', 'image/webp', media.width, media.height,
      (temporary) => this.convertStatic(original, temporary),
    )
    let transferredBytes = 0
    for await (const chunk of rangedFile(asset.path, options.offset, options.limit)) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('image download aborted')
      transferredBytes += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes,
        totalBytes: rangedSize(asset.size, options.offset, options.limit),
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
    const asset = { key, path: target, mimeType, size: statSync(target).size, width, height }
    await this.options.database?.upsert('mtproto_qqnt_media_cache', [{
      key, path: target, mimeType, size: asset.size,
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
