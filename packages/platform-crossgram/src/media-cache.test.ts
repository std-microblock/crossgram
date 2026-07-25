import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import sharp from 'sharp'
import { expandTelegramStrippedThumbnail, type IMMediaSource, type IMSticker } from '@mtproto-relay/bridge'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'

const temporaryDirectories: string[] = []
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  sharp.cache(false)
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true, maxRetries: 20, retryDelay: 25,
  })))
})

describe('QQMediaCache', () => {
  it('automatically projects GIF/APNG stickers as cached WebM', async () => {
    const path = await temporaryDirectory()
    const gif = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 20, g: 80, b: 220, alpha: 1 } },
    }).gif().toBuffer()
    let opens = 0
    const source = countedSource(gif, () => opens++)
    const cache = new QQMediaCache({ path })
    const sticker: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'animated-1', format: 'animated',
      mimeType: 'image/gif', width: 16, height: 12, locator: { id: 'opaque' },
    }

    expect(cache.projectSticker(sticker)).toMatchObject({ format: 'video', mimeType: 'video/webm' })
    const first = await cache.openSticker(sticker, { source, mimeType: 'image/gif', width: 16, height: 12 })
    const second = await cache.openSticker(sticker, { source, mimeType: 'image/gif', width: 16, height: 12 })
    const bytes = await collect(first.source.stream())
    await collect(second.source.stream())

    expect(first).toMatchObject({ mimeType: 'video/webm', width: 16, height: 12 })
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    const projected = await cache.restoreStickerThumbnail(cache.projectSticker(sticker))
    const thumbnail = await cache.openStickerThumbnail(projected)
    if (!thumbnail) throw new Error('missing animated sticker thumbnail')
    const thumbnailBytes = await collect(thumbnail.source.stream())

    expect(projected).toMatchObject({
      outline: expect.any(Uint8Array),
      thumbnail: {
        mimeType: 'image/webp', width: 16, height: 12,
        locator: { cacheKey: expect.any(String) },
      },
    })
    expect(projected.outline!.byteLength).toBeGreaterThan(0)
    expect(thumbnailBytes.subarray(8, 12).toString()).toBe('WEBP')
    expect(opens).toBe(2)
  }, 30_000)

  it('keeps original image bytes and stores compact previews separately', async () => {
    const path = await temporaryDirectory()
    const png = await sharp({
      create: { width: 20, height: 10, channels: 4, background: { r: 220, g: 50, b: 30, alpha: 1 } },
    }).png().toBuffer()
    let opens = 0
    const cache = new QQMediaCache({ path, previewMaxDimension: 8 })
    const media = {
      id: 'image-opaque', kind: 'image' as const, mimeType: 'image/png', size: png.length,
      width: 20, height: 10,
      locator: mediaLocator({ messageId: 'first-message', md5: 'AABBCC' }),
    }

    expect(await cache.restoreInitialMedia(media)).toBeUndefined()
    expect(opens).toBe(0)
    const prepared = await cache.prepareMedia(media, countedSource(png, () => opens++))
    const restored = await cache.restoreInitialMedia({
      ...media, id: 'restored-without-source',
      locator: mediaLocator({ messageId: 'restored-message', md5: 'aabbcc' }),
    })
    const sameHash = await cache.prepareMedia({
      ...media, id: 'different-id',
      locator: mediaLocator({ messageId: 'different-message', md5: 'aabbcc' }),
    }, countedSource(png, () => opens++))
    const complete = await collect(cache.download(prepared, countedSource(png, () => opens++)))
    const range = await collect(cache.download(sameHash, countedSource(png, () => opens++), { offset: 4, limit: 8 }))
    const preview = prepared.preview!
    const previewBytes = await collect(cache.download({
      ...prepared, size: preview.size, width: preview.width, height: preview.height,
      locator: preview.locator,
    }, countedSource(png, () => opens++)))

    expect(prepared).toMatchObject({
      mimeType: 'image/png', width: 20, height: 10,
      locator: expect.not.objectContaining({ cachedPath: expect.anything() }),
      strippedThumbnail: expect.any(Uint8Array),
      preview: { mimeType: 'image/webp', width: 8, height: 4, locator: { previewKey: expect.any(String) } },
    })
    expect(restored).toMatchObject({
      id: 'restored-without-source',
      preview: { mimeType: 'image/webp', width: 8, height: 4, locator: { previewKey: expect.any(String) } },
    })
    expect(await sharp(expandTelegramStrippedThumbnail(prepared.strippedThumbnail!)).metadata())
      .toMatchObject({ format: 'jpeg', width: 8, height: 4 })
    expect(complete).toEqual(png)
    expect(range).toEqual(png.subarray(4, 12))
    expect(previewBytes.subarray(8, 12).toString()).toBe('WEBP')
    expect(opens).toBe(4)
  })

  it('can disable previews without disabling animated-image preparation', async () => {
    const cache = new QQMediaCache({
      path: await temporaryDirectory(), generatePreviews: false,
    })
    expect(cache.shouldPrepare({ id: 'jpeg', kind: 'image', mimeType: 'image/jpeg' })).toBe(false)
    expect(cache.shouldPrepare({ id: 'gif', kind: 'image', mimeType: 'image/gif' })).toBe(true)
    expect(cache.shouldPrepare({ id: 'png', kind: 'image', mimeType: 'image/png' })).toBe(true)
    expect(cache.shouldPrepare({ id: 'file', kind: 'file', mimeType: 'application/octet-stream' })).toBe(false)
  })

  it('converts received GIF/APNG images to WebM and keeps a static WebP preview', async () => {
    const path = await temporaryDirectory()
    const gif = await sharp({
      create: { width: 18, height: 12, channels: 4, background: { r: 130, g: 40, b: 210, alpha: 1 } },
    }).gif().toBuffer()
    let opens = 0
    const cache = new QQMediaCache({ path, previewMaxDimension: 9 })
    const prepared = await cache.prepareMedia({
      id: 'animated-image', kind: 'image', name: 'animated.gif', mimeType: 'image/gif',
      size: gif.length, width: 18, height: 12, locator: mediaLocator({ md5: 'animated-hash' }),
    }, countedSource(gif, () => opens++))
    const video = await collect(cache.download(prepared, countedSource(gif, () => opens++)))
    const preview = prepared.preview!
    const previewBytes = await collect(cache.download({
      ...prepared, size: preview.size, locator: preview.locator,
    }, countedSource(gif, () => opens++)))

    expect(prepared).toMatchObject({
      id: 'animated-image:webm-v1', kind: 'file', name: 'animated.webm', mimeType: 'video/webm',
      locator: { cachedPath: expect.stringMatching(/\.webm$/) },
      preview: { mimeType: 'image/webp', width: 9, height: 6, locator: { previewKey: expect.any(String) } },
    })
    expect([...video.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(previewBytes.subarray(8, 12).toString()).toBe('WEBP')
    expect(opens).toBe(1)
  }, 30_000)

  it('detects APNG content disguised as an ordinary PNG', async () => {
    const path = await temporaryDirectory()
    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    let opens = 0
    const cache = new QQMediaCache({ path, previewMaxDimension: 6 })
    const prepared = await cache.prepareMedia({
      id: 'disguised-apng', kind: 'image', name: 'ordinary.png', mimeType: 'image/png',
      size: apng.length, width: 12, height: 8, locator: mediaLocator({ md5: 'disguised-apng' }),
    }, countedSource(apng, () => opens++))
    const video = await collect(cache.download(prepared, countedSource(apng, () => opens++)))

    expect(prepared).toMatchObject({
      kind: 'file', name: 'ordinary.webm', mimeType: 'video/webm',
      size: expect.any(Number), width: 12, height: 8,
      preview: { mimeType: 'image/webp' },
    })
    expect([...video.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(opens).toBe(2)
  }, 30_000)

  it('persists generated reaction WebM files across adapter instances', async () => {
    const path = await temporaryDirectory()
    const gif = await sharp({
      create: { width: 24, height: 16, channels: 4, background: { r: 40, g: 200, b: 80, alpha: 1 } },
    }).gif().toBuffer()
    let opens = 0
    const original = {
      source: countedSource(gif, () => opens++), mimeType: 'image/apng', width: 24, height: 16,
    }

    const first = await new QQMediaCache({ path }).openReaction('1:14', 123, 'video', original)
    const second = await new QQMediaCache({ path }).openReaction('1:14', 123, 'video', original)
    const firstBytes = await collect(first.source.stream())
    const secondBytes = await collect(second.source.stream())

    expect(first).toMatchObject({ mimeType: 'video/webm', width: 100, height: 100 })
    expect([...firstBytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(secondBytes).toEqual(firstBytes)
    expect(opens).toBe(1)
  }, 30_000)

  it('range-probes static PNG once and reuses the persisted non-animated decision', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineQQMediaCacheModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })
    const png = await sharp({
      create: { width: 10, height: 6, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png().toBuffer()
    const media = {
      id: 'static-png', kind: 'image' as const, name: 'static.png', mimeType: 'image/png',
      size: png.length, width: 10, height: 6, locator: mediaLocator({ md5: 'STATIC-PNG' }),
    }
    let fullDownloads = 0
    let probes = 0
    const cache = new QQMediaCache({
      path: await temporaryDirectory(), database: ctx.database, generatePreviews: false,
    })

    const initial = await cache.prepareInitialMedia(media, countedSource(png, () => fullDownloads++))
    const upgraded = await cache.prepareAnimatedUpgrade(
      media,
      countedSource(png, () => fullDownloads++),
      { read: async function* ({ offset, limit }) {
        probes++
        yield png.subarray(offset, offset + limit)
      } },
    )
    const restarted = new QQMediaCache({
      path: await temporaryDirectory(), database: ctx.database, generatePreviews: false,
    })
    const cachedDecision = await restarted.prepareAnimatedUpgrade(
      media,
      countedSource(png, () => fullDownloads++),
      { read() { throw new Error('persisted animation decision should avoid another range request') } },
    )

    expect(initial).toEqual(media)
    expect(upgraded).toBeUndefined()
    expect(cachedDecision).toBeUndefined()
    expect(probes).toBe(1)
    expect(fullDownloads).toBe(0)
    expect(await ctx.database.get('mtproto_qqnt_media_animation', {})).toMatchObject([{ animated: false }])
  })

  it('indexes logical cache keys containing NUL separators in SQLite', async () => {
    const path = await temporaryDirectory()
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineQQMediaCacheModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    }).png().toBuffer()
    const cache = new QQMediaCache({ path, database: ctx.database })

    await cache.openReaction('1:14', 123, 'static', {
      source: countedSource(png, () => undefined), mimeType: 'image/png', width: 8, height: 8,
    })
    const media = await cache.prepareMedia({
      id: 'db-preview', kind: 'image', name: 'preview.jpg', mimeType: 'image/jpeg',
      size: png.length, width: 8, height: 8, locator: mediaLocator({ md5: 'db-preview' }),
    }, countedSource(png, () => undefined))

    const [row] = await ctx.database.get('mtproto_qqnt_media_cache', {})
    expect(row).toMatchObject({ mimeType: 'image/webp', width: 100, height: 100 })
    expect(row!.key).toMatch(/^[a-f0-9]{64}$/)
    expect(row!.key).not.toContain('\0')
    const [preview] = await ctx.database.get('mtproto_qqnt_media_preview', {})
    expect(preview).toMatchObject({ mimeType: 'image/webp', width: 8, height: 8, size: expect.any(Number) })
    expect(new Uint8Array(preview!.bytes).subarray(8, 12).toString()).toBe('87,69,66,80')
    expect(new Uint8Array(preview!.strippedBytes!)).toEqual(media.strippedThumbnail)
    expect(media.preview?.locator).toMatchObject({ previewKey: preview!.key })

    await ctx.database.set('mtproto_qqnt_media_preview', { key: preview!.key }, { strippedBytes: null })
    const restored = await new QQMediaCache({ path, database: ctx.database }).prepareMedia({
      id: 'db-preview-restored', kind: 'image', name: 'preview.jpg', mimeType: 'image/jpeg',
      size: png.length, width: 8, height: 8, locator: mediaLocator({ md5: 'db-preview' }),
    }, countedSource(png, () => undefined))
    const [backfilled] = await ctx.database.get('mtproto_qqnt_media_preview', { key: preview!.key })
    expect(restored.strippedThumbnail).toEqual(new Uint8Array(backfilled!.strippedBytes!))
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qqnt-media-cache-'))
  temporaryDirectories.push(path)
  return path
}

function countedSource(bytes: Uint8Array, opened: () => void): IMMediaSource {
  return {
    size: bytes.length,
    async *stream() {
      opened()
      yield bytes
    },
  }
}

function mediaLocator(overrides: Partial<import('./protocol.js').QQMediaLocator> = {}) {
  return {
    messageId: 'message', elementId: 'element', chatType: 1 as const, peerUid: 'peer',
    kind: 'image' as const, fileName: 'image.png', ...overrides,
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
