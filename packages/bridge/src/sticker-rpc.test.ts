import { describe, expect, it, vi } from 'vitest'
import { StickerRpc } from './sticker-rpc.js'
import type { IMSticker, IMStickerProvider, StickerProviderRegistry } from './sticker-provider.js'
import type { IMPlatform, PlatformSession } from './platform.js'

describe('StickerRpc', () => {
  it('resolves the set attached to a message sticker even when the pack is not listed', async () => {
    const sticker: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'market:42:wave', packId: '42',
      title: 'Wave', format: 'static', mimeType: 'image/png',
    }
    const provider: IMStickerProvider = {
      listPacks: vi.fn(async () => ({ packs: [] })),
      getPack: vi.fn(async (_context, packId) => packId === '42' ? {
        providerId: 'qq:stickers', packId, title: 'QQ Waves', stickers: [sticker],
      } : null),
      getSticker: vi.fn(async () => sticker),
      openAsset: vi.fn(async () => { throw new Error('not used') }),
    }
    const registry = {
      entries: [['qq:stickers', provider]],
      get: (id: string) => id === 'qq:stickers' ? provider : undefined,
      require: (id: string) => {
        if (id !== 'qq:stickers') throw new Error(`unknown provider ${id}`)
        return provider
      },
    } as unknown as StickerProviderRegistry
    const database = {
      get: vi.fn(async () => []),
    }
    const rpc = new StickerRpc(
      database as never,
      registry,
      { platformKind: 'qq' } as IMPlatform,
      { platformId: 'qq', platformSessionId: 'session' } as PlatformSession,
    )

    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')
    const attribute = media.document.attributes.find((item) => item._ === 'documentAttributeSticker')
    if (!attribute || attribute._ !== 'documentAttributeSticker') throw new Error('expected sticker attribute')

    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet', stickerset: attribute.stickerset, hash: 0,
    })).resolves.toMatchObject({
      _: 'messages.stickerSet', set: { title: 'QQ Waves' }, documents: [{ _: 'document' }],
    })
    expect(provider.listPacks).not.toHaveBeenCalled()
    expect(provider.getPack).toHaveBeenCalledWith(expect.anything(), '42')
  })
})
