import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession, StickerProviderContext } from '@mtproto-relay/bridge'
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

  it('maps saved sticker metadata without opening or preparing any asset bytes', async () => {
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
    const logger = { warn: vi.fn() }
    const provider = new QQStickerProvider(client as never, 'qq:stickers', undefined, logger)

    await expect(provider.listSavedStickers(context)).resolves.toMatchObject({
      nextCursor: 'next-page',
      stickers: [
        { stickerId: 'favorite:corrupt', mimeType: 'image/png' },
        { stickerId: 'favorite:first', mimeType: 'image/png' },
        { stickerId: 'favorite:second', mimeType: 'image/png' },
        { stickerId: 'favorite:third', mimeType: 'image/png' },
        { stickerId: 'favorite:after-corrupt', mimeType: 'image/png' },
      ],
    })
    expect(client.stickerSource).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns a complete pack without server-side asset validation', async () => {
    const pack = {
      packId: 'qq-favorites', title: 'QQ 收藏表情', count: 3, version: 7,
      stickers: [favorite('stale'), favorite('first'), favorite('second')],
    }
    const client = {
      getStickerPack: vi.fn(async () => pack),
      stickerSource: vi.fn(() => ({ async *stream() { yield new Uint8Array([1, 2, 3]) } })),
    }
    const logger = { warn: vi.fn() }
    const provider = new QQStickerProvider(client as never, 'qq:stickers', undefined, logger)

    await expect(provider.getPack(context, 'qq-favorites')).resolves.toMatchObject({
      packId: 'qq-favorites', count: 3,
      cover: { stickerId: 'favorite:stale' },
      stickers: [
        { stickerId: 'favorite:stale', mimeType: 'image/png' },
        { stickerId: 'favorite:first', mimeType: 'image/png' },
        { stickerId: 'favorite:second', mimeType: 'image/png' },
      ],
    })
    expect(client.stickerSource).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
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

  it('resolves favorite and URL-backed sticker assets directly, and falls back for local market paths', async () => {
    const client = {
      resolveFileUrlForDirectDownload: vi.fn(async () => ({
        url: 'https://cdn.example.test/favorite.gif', expiresAt: Date.now() + 60_000, supportsRange: true,
      })),
      inspectDirectUrl: vi.fn(async (url: string, expiresAt: number) => ({ url, expiresAt, supportsRange: true })),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')
    const favoriteSticker = {
      ...favorite('direct'), providerId: 'qq:stickers', format: 'animated' as const, mimeType: 'image/gif',
      locator: {
        kind: 'favorite', resId: 'direct', path: '/saved/direct.gif', name: 'direct.gif', animated: true,
        locator: {
          messageId: 'm', elementId: 'e', chatType: 2, peerUid: 'g', kind: 'image',
          fileName: 'direct.gif', fileUuid: 'uuid',
        },
      },
    }
    await expect(provider.resolveAssetUrl(context, favoriteSticker)).resolves.toMatchObject({
      url: 'https://cdn.example.test/favorite.gif', supportsRange: true,
    })
    await expect(provider.resolveAssetUrl(context, {
      ...favorite('system'), providerId: 'qq:stickers', locator: {
        kind: 'sysface', faceId: '1', faceType: 3, name: 'system', animated: true,
        url: 'https://cdn.example.test/system.apng',
      },
    })).resolves.toMatchObject({ url: 'https://cdn.example.test/system.apng' })
    await expect(provider.resolveAssetUrl(context, {
      ...favorite('favorite-url'), providerId: 'qq:stickers', locator: {
        kind: 'favorite', resId: 'favorite-url', path: '/saved/favorite-url.gif',
        name: 'favorite-url.gif', animated: true, url: 'https://cdn.example.test/favorite-url.gif',
      },
    })).resolves.toMatchObject({ url: 'https://cdn.example.test/favorite-url.gif' })
    await expect(provider.resolveAssetUrl(context, {
      ...favorite('market'), providerId: 'qq:stickers', locator: {
        kind: 'market', packageId: 'pack', stickerId: 'market', name: 'market', key: 'key',
        width: 16, height: 12, animated: false, staticPath: 'C:/QQ/local.png',
      },
    })).resolves.toBeUndefined()
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

describe('QQStickerProvider market previews', () => {
  it('maps animated market static previews to Telegram thumbnails', async () => {
    const reference = {
      kind: 'market' as const,
      packageId: '42', stickerId: 'emoji-a', name: 'Wave', key: 'secret',
      width: 320, height: 180, animated: true,
      staticPath: '/cache/emoji-a.png', staticSize: 6,
      dynamicPath: '/cache/emoji-a.gif.encrypt',
    }
    const client = {
      getStickerPack: vi.fn(async () => ({
        packId: '42', title: 'Waves', stickers: [{
          stickerId: 'market:42:emoji-a', packId: '42', title: 'Wave',
          format: 'animated' as const, mimeType: 'image/gif', width: 320, height: 180,
          size: 24, reference,
        }],
      })),
      stickerSource: vi.fn((value: unknown, size?: number) => ({ size, stream: async function* () { yield value } })),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')
    const pack = await provider.getPack({ session: {} as never, platformKind: 'qq' }, '42')
    const sticker = pack!.stickers[0]!
    expect(sticker.thumbnail).toMatchObject({ mimeType: 'image/png', size: 6, width: 320, height: 180 })
    const thumbnail = await provider.openThumbnail({ session: {} as never, platformKind: 'qq' }, sticker)
    expect(thumbnail).toMatchObject({ mimeType: 'image/png', size: 6, width: 320, height: 180 })
    expect(client.stickerSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'market', animated: false, staticPath: reference.staticPath }), 6,
    )
  })
})
