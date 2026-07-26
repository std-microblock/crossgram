import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { IMMediaSource, PlatformSession, StickerProviderContext } from '@mtproto-relay/bridge'
import { QQMediaCache } from './media-cache.js'
import type { QQStickerReference, WireSticker } from './protocol.js'
import { QQStickerProvider } from './sticker-provider.js'

const context: StickerProviderContext = {
  platformKind: 'qq',
  session: {
    platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
  } satisfies PlatformSession,
}
const temporaryDirectories: string[] = []

afterEach(async () => {
  sharp.cache(false)
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true, maxRetries: 20, retryDelay: 25,
  })))
})

describe('QQStickerProvider saved-sticker pipeline', () => {
  it('materializes valid assets while isolating an image decoder failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mtproto-relay-qq-sticker-provider-'))
    temporaryDirectories.push(directory)
    const validPng = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 20, g: 80, b: 220, alpha: 1 } },
    }).png().toBuffer()
    const corruptImage = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff])
    const assets = new Map([
      ['bad', corruptImage],
      ['good', new Uint8Array(validPng)],
    ])
    const client = {
      getSavedStickers: vi.fn(async () => ({
        stickers: [favorite('bad'), favorite('good')],
      })),
      stickerSource: vi.fn((reference: QQStickerReference) => source(assets.get(
        reference.kind === 'favorite' ? reference.resId : reference.stickerId,
      )!)),
    }
    const logger = { warn: vi.fn() }
    const provider = new QQStickerProvider(
      client as never,
      'qq:stickers',
      new QQMediaCache({ path: directory, generatePreviews: false }),
      logger,
    )

    const result = await provider.listSavedStickers(context)

    expect(result.stickers).toMatchObject([{
      providerId: 'qq:stickers', stickerId: 'favorite:good',
      format: 'static', mimeType: 'image/webp', width: 16, height: 12,
    }])
    expect(result.stickers[0]!.size).toBeGreaterThan(0)
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping QQ saved sticker %s because its asset could not be prepared: %s',
      'favorite:bad',
      expect.any(String),
    )
  })
})

function favorite(id: string): WireSticker {
  return {
    stickerId: `favorite:${id}`,
    title: id,
    format: 'static',
    mimeType: 'image/png',
    width: 16,
    height: 12,
    reference: {
      kind: 'favorite', resId: id, path: `/saved/${id}.png`, name: `${id}.png`, animated: false,
    },
  }
}

function source(bytes: Uint8Array): IMMediaSource {
  return {
    size: bytes.length,
    async *stream() { yield bytes },
  }
}
