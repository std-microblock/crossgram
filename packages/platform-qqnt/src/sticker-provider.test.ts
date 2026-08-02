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
  it('declares the synthetic QQ favorites pack as owned by its QQNT account', async () => {
    const client = {
      getStickerPacks: vi.fn(async () => ({
        packs: [
          { packId: 'qq-favorites', title: 'QQ 收藏表情', version: 1 },
          { packId: 'market-1', title: '商店表情', version: 1 },
        ],
      })),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers', undefined, undefined, 'qq/primary')

    await expect(provider.listPacks(context)).resolves.toMatchObject({
      packs: [
        { packId: 'qq-favorites', automaticAssociation: 'provider-account' },
        { packId: 'market-1', automaticAssociation: undefined },
      ],
    })
    expect(provider.capabilities.ownerPlatformId).toBe('qq/primary')
  })

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

  it('keeps a sticker pack usable when one native asset is stale', async () => {
    const pack = {
      packId: 'qq-favorites', title: 'QQ 收藏表情', count: 3, version: 7,
      stickers: [favorite('stale'), favorite('first'), favorite('second')],
    }
    const client = {
      getStickerPack: vi.fn(async () => pack),
      stickerSource: vi.fn(() => ({ async *stream() { yield new Uint8Array([1, 2, 3]) } })),
    }
    const mediaCache = {
      prepareSticker: vi.fn(async (sticker: IMSticker) => {
        if (sticker.stickerId === 'favorite:stale') throw new Error('QQNT bridge 404')
        return { ...sticker, mimeType: 'image/webp', size: 321 }
      }),
    }
    const logger = { warn: vi.fn() }
    const provider = new QQStickerProvider(client as never, 'qq:stickers', mediaCache as never, logger)

    await expect(provider.getPack(context, 'qq-favorites')).resolves.toMatchObject({
      packId: 'qq-favorites', count: 2,
      cover: { stickerId: 'favorite:first' },
      stickers: [
        { stickerId: 'favorite:first', mimeType: 'image/webp', size: 321 },
        { stickerId: 'favorite:second', mimeType: 'image/webp', size: 321 },
      ],
    })
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping QQ sticker %s from pack %s because its asset could not be prepared: %s',
      'favorite:stale',
      'qq-favorites',
      'QQNT bridge 404',
    )
  })

  it('still rejects when the saved-sticker catalog itself cannot be loaded', async () => {
    const client = {
      getSavedStickers: vi.fn(async () => { throw new Error('QQNT unavailable') }),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')

    await expect(provider.listSavedStickers(context)).rejects.toThrow('QQNT unavailable')
  })

  it('preserves the synthetic QQ favorites pack identity on saved stickers', async () => {
    const sticker = { ...favorite('packed'), packId: 'qq-favorites' }
    const client = {
      getSavedStickers: vi.fn(async () => ({ stickers: [sticker] })),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')

    await expect(provider.listSavedStickers(context)).resolves.toMatchObject({
      stickers: [{
        providerId: 'qq:stickers', stickerId: 'favorite:packed', packId: 'qq-favorites',
      }],
    })
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
