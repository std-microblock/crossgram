import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { IMMedia } from '@mtproto-relay/bridge'
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
  it('is disabled by default and leaves original media untouched', () => {
    const original = media()
    expect(new QQMediaPreviewer().project(original)).toBe(original)
  })

  it('projects only deterministic preview metadata without opening media bytes', () => {
    const original = media()
    const previewer = new QQMediaPreviewer({ enabled: true, maxDimension: 320 })
    const projected = previewer.project(original)

    expect(projected).toMatchObject({
      id: original.id, kind: 'image', mimeType: 'image/png', locator: original.locator,
      preview: {
        mimeType: 'image/webp', width: 320, height: 180,
        locator: {
          messageId: original.locator!.messageId,
          previewKey: mediaPreviewKey(original.locator!, 320),
        },
      },
    })
  })

  it('generates and single-flights a WebP only when its thumbnail is opened', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true })
    const projected = previewer.project(media())
    const locator = projected.preview!.locator
    let opens = 0
    const source = async function* () {
      opens++
      yield input.subarray(0, 20)
      yield input.subarray(20)
    }

    const [first, second] = await Promise.all([
      previewer.open(locator, source),
      previewer.open(locator, source),
    ])

    expect(opens).toBe(1)
    expect(second).toBe(first)
    expect(first.mimeType).toBe('image/webp')
    expect(first.size).toBe(first.bytes.byteLength)
    await expect(sharp(first.bytes).metadata()).resolves.toMatchObject({
      format: 'webp', width: 64, height: 40,
    })
    await previewer.open(locator, source)
    expect(opens).toBe(1)
  })

  it('bounds independent preview work without coupling their callers', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true, concurrency: 1 })
    const firstLocator = previewer.project(media('first')).preview!.locator
    const secondLocator = previewer.project(media('second')).preview!.locator
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

    const first = previewer.open(firstLocator, source(firstGate.promise))
    const second = previewer.open(secondLocator, source())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toBe(1)
    firstGate.resolve()
    await Promise.all([first, second])
    expect(opened).toBe(2)
    expect(maximumRunning).toBe(1)
  })

  it('rejects forged preview locators before opening the original', async () => {
    const previewer = new QQMediaPreviewer({ enabled: true })
    const locator = { ...media().locator!, previewKey: 'forged' }
    let opened = false
    await expect(previewer.open(locator, async function* () {
      opened = true
      yield await png()
    })).rejects.toThrow(/reference is invalid/)
    expect(opened).toBe(false)
  })
})
