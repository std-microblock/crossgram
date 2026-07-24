import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import sharp from 'sharp'
import type { IMMediaSource, IMSticker } from '@mtproto-relay/bridge'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'

const temporaryDirectories: string[] = []
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
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
    expect(opens).toBe(1)
  }, 30_000)

  it('optionally caches all downloaded images as WebP and honors ranges', async () => {
    const path = await temporaryDirectory()
    const png = await sharp({
      create: { width: 20, height: 10, channels: 4, background: { r: 220, g: 50, b: 30, alpha: 1 } },
    }).png().toBuffer()
    let opens = 0
    const cache = new QQMediaCache({ path, cacheAndConvertImages: true })
    const media = {
      id: 'image-opaque', kind: 'image' as const, mimeType: 'image/png', size: png.length,
      width: 20, height: 10, locator: { path: '/opaque' },
    }

    const complete = await collect(cache.downloadImage(media, countedSource(png, () => opens++)))
    const range = await collect(cache.downloadImage(media, countedSource(png, () => opens++), { offset: 4, limit: 8 }))

    expect(complete.subarray(0, 4).toString()).toBe('RIFF')
    expect(complete.subarray(8, 12).toString()).toBe('WEBP')
    expect(range).toEqual(complete.subarray(4, 12))
    expect(opens).toBe(1)
  })

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

    const [row] = await ctx.database.get('mtproto_qqnt_media_cache', {})
    expect(row).toMatchObject({ mimeType: 'image/webp', width: 100, height: 100 })
    expect(row!.key).toMatch(/^[a-f0-9]{64}$/)
    expect(row!.key).not.toContain('\0')
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

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
