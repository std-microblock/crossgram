import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { IMMediaSource, IMSticker } from '@mtproto-relay/bridge'
import { QQMediaCache } from './media-cache.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
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
