import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { expandTelegramStrippedThumbnail, type IMMedia } from '@mtproto-relay/bridge'
import { QQMediaPreviewer, mediaPreviewKey } from './media-preview.js'
import type { QQMediaLocator } from './protocol.js'

function media(id = 'one'): IMMedia<QQMediaLocator> {
  return {
    id, kind: 'image', name: `${id}.png`, mimeType: 'image/png', size: 123_456,
    width: 640, height: 360,
    locator: {
      messageId: `message-${id}`, elementId: `element-${id}`, chatType: 2,
      peerUid: 'group', kind: 'image', fileName: `${id}.png`, md5: `MD5-${id}`,
    },
  }
}

async function png(width = 64, height = 40): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 1 } },
  }).png().toBuffer()
}

describe('QQMediaPreviewer', () => {
  it('is disabled by default and leaves original media untouched', async () => {
    const original = media()
    const previewer = new QQMediaPreviewer()
    expect(previewer.project(original)).toBe(original)
    await expect(previewer.prepare(original, async function* () {
      throw new Error('source must stay closed')
    })).resolves.toBe(original)
  })

  it('does not advertise a separate m-size preview or perform I/O while projecting', () => {
    const original = media()
    const previewer = new QQMediaPreviewer({ enabled: true })
    expect(previewer.project(original)).toBe(original)
    expect(mediaPreviewKey(original.locator!)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates and single-flights a tiny inline stripped JPEG in the background path', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true })
    const original = media()
    let opens = 0
    const source = async function* () {
      opens++
      yield input.subarray(0, 20)
      yield input.subarray(20)
    }

    const [first, second] = await Promise.all([
      previewer.prepare(original, source),
      previewer.prepare(original, source),
    ])

    expect(opens).toBe(1)
    expect(first.preview).toBeUndefined()
    expect(first.strippedThumbnail).toEqual(second.strippedThumbnail)
    expect(first.strippedThumbnail!.byteLength).toBeLessThan(1024)
    await expect(sharp(expandTelegramStrippedThumbnail(first.strippedThumbnail!)).metadata())
      .resolves.toMatchObject({ format: 'jpeg', width: 40, height: 25 })

    const projected = previewer.project(media())
    expect(projected.strippedThumbnail).toEqual(first.strippedThumbnail)
    expect(opens).toBe(1)
  })

  it('bounds independent inline preview work', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true, concurrency: 1 })
    const firstGate = Promise.withResolvers<void>()
    let opened = 0
    let running = 0
    let maximumRunning = 0
    const source = (gate?: Promise<void>) => async function* () {
      opened++
      running++
      maximumRunning = Math.max(maximumRunning, running)
      if (gate) await gate
      yield input
      running--
    }

    const first = previewer.prepare(media('first'), source(firstGate.promise))
    const second = previewer.prepare(media('second'), source())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toBe(1)
    firstGate.resolve()
    await Promise.all([first, second])
    expect(opened).toBe(2)
    expect(maximumRunning).toBe(1)
  })

  it('isolates decoder failures from the original media object', async () => {
    const original = media()
    const previewer = new QQMediaPreviewer({ enabled: true })
    await expect(previewer.prepare(original, async function* () {
      yield new Uint8Array([1, 2, 3])
    })).rejects.toThrow()
    expect(original.strippedThumbnail).toBeUndefined()
    expect(original.preview).toBeUndefined()
  })
})
