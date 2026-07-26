import { describe, expect, it, vi } from 'vitest'
import type { IMSticker, PlatformSession, StickerProviderContext } from '@mtproto-relay/bridge'
import type { WireSticker } from './protocol.js'
import { QQStickerProvider } from './sticker-provider.js'

const context: StickerProviderContext = {
  platformKind: 'qq',
  session: {
    platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
  } satisfies PlatformSession,
}

describe('QQStickerProvider saved stickers', () => {
  it('skips only corrupt saved sticker assets and preserves healthy prepared stickers', async () => {
    const saved = [
      favorite('corrupt'),
      favorite('first'),
      favorite('second'),
      favorite('third'),
      favorite('after-corrupt'),
    ]
    const client = {
      getSavedStickers: vi.fn(async () => ({ stickers: saved, nextCursor: 'next-page' })),
      stickerSource: vi.fn(() => ({ async *stream() { yield new Uint8Array([1, 2, 3]) } })),
    }
    const mediaCache = {
      prepareSticker: vi.fn(async (sticker: IMSticker) => {
        if (sticker.stickerId === 'favorite:corrupt') throw new Error('Invalid frame data')
        return { ...sticker, mimeType: 'image/webp', size: 321 }
      }),
    }
    const logger = { warn: vi.fn() }
    const provider = new QQStickerProvider(client as never, 'qq:stickers', mediaCache as never, logger)

    await expect(provider.listSavedStickers(context)).resolves.toMatchObject({
      nextCursor: 'next-page',
      stickers: [
        { stickerId: 'favorite:first', mimeType: 'image/webp', size: 321 },
        { stickerId: 'favorite:second', mimeType: 'image/webp', size: 321 },
        { stickerId: 'favorite:third', mimeType: 'image/webp', size: 321 },
        { stickerId: 'favorite:after-corrupt', mimeType: 'image/webp', size: 321 },
      ],
    })
    expect(mediaCache.prepareSticker).toHaveBeenCalledTimes(5)
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping QQ saved sticker %s because its asset could not be prepared: %s',
      'favorite:corrupt',
      'Invalid frame data',
    )
  })

  it('still rejects when the saved-sticker catalog itself cannot be loaded', async () => {
    const client = {
      getSavedStickers: vi.fn(async () => { throw new Error('QQNT unavailable') }),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')

    await expect(provider.listSavedStickers(context)).rejects.toThrow('QQNT unavailable')
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
