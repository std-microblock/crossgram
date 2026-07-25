import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import { StickerRpc } from './sticker-rpc.js'
import type { IMSticker, IMStickerProvider, StickerProviderRegistry } from './sticker-provider.js'
import type { IMPlatform, PlatformSession } from './platform.js'

describe('StickerRpc', () => {
  it('projects and serves a cached first-frame thumbnail without marking the sticker as a mask', async () => {
    const thumbnail = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
    const { rpc, provider, sticker } = stickerHarness()
    sticker.thumbnail = {
      mimeType: 'image/webp', size: thumbnail.length, width: 96, height: 64,
      locator: { cacheKey: 'first-frame' },
    }
    vi.mocked(provider.openThumbnail!).mockResolvedValue({
      mimeType: 'image/webp', size: thumbnail.length, width: 96, height: 64,
      source: {
        size: thumbnail.length,
        async *stream() {
          yield thumbnail.subarray(0, 3)
          yield thumbnail.subarray(3)
        },
      },
    })

    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')
    expect(media.document.thumbs).toEqual([{
      _: 'photoSize', type: 'm', w: 96, h: 64, size: thumbnail.length,
    }])
    const attribute = media.document.attributes.find((item) => item._ === 'documentAttributeSticker')
    if (!attribute || attribute._ !== 'documentAttributeSticker') throw new Error('expected sticker attribute')
    expect(attribute.mask).toBeUndefined()
    expect(attribute.maskCoords).toBeUndefined()
    await expect(rpc.getFile(
      media.document.id.toNumber(), 2, 4, media.document.fileReference, 'm',
    )).resolves.toEqual(thumbnail.subarray(2, 6))
    expect(provider.openThumbnail).toHaveBeenCalledWith(expect.anything(), sticker)
    expect(provider.openAsset).not.toHaveBeenCalled()
  })

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

  it('serves QQNT background refreshes from one provider snapshot and honors Telegram hashes', async () => {
    const { rpc, provider } = stickerHarness()

    const all = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    expect(all._).toBe('messages.allStickers')
    if (all._ !== 'messages.allStickers') throw new Error('expected full sticker catalog')
    const set = all.sets[0]!
    expect(set.count).toBe(1)
    const pack = await rpc.getStickerSet({
      _: 'messages.getStickerSet',
      stickerset: { _: 'inputStickerSetID', id: set.id, accessHash: set.accessHash },
      hash: 0,
    })
    expect(pack._).toBe('messages.stickerSet')
    if (pack._ !== 'messages.stickerSet') throw new Error('expected full sticker set')
    const saved = await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    expect(saved._).toBe('messages.favedStickers')
    if (saved._ !== 'messages.favedStickers') throw new Error('expected full saved stickers')

    await expect(rpc.getAllStickers({
      _: 'messages.getAllStickers', hash: all.hash,
    })).resolves.toEqual({ _: 'messages.allStickersNotModified' })
    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet',
      stickerset: { _: 'inputStickerSetID', id: set.id, accessHash: set.accessHash },
      hash: pack.set.hash,
    })).resolves.toEqual({ _: 'messages.stickerSetNotModified' })
    await expect(rpc.getFavedStickers({
      _: 'messages.getFavedStickers', hash: saved.hash,
    })).resolves.toEqual({ _: 'messages.favedStickersNotModified' })

    expect(provider.listPacks).toHaveBeenCalledTimes(1)
    expect(provider.getPack).toHaveBeenCalledTimes(1)
    expect(provider.listSavedStickers).toHaveBeenCalledTimes(1)
  })

  it('coalesces summary catalogs without materializing every pack before it is opened', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const { rpc, provider } = stickerHarness(10)
    vi.mocked(provider.listPacks).mockImplementationOnce(async () => {
      await blocked
      return { packs: [{ providerId: 'ignored', packId: '11690', title: 'QQ Pack' }] }
    })

    const first = rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    const concurrent = rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    await vi.waitFor(() => expect(provider.listPacks).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, concurrent])
    expect(provider.getPack).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 15))
    await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    expect(provider.listPacks).toHaveBeenCalledTimes(2)
    expect(provider.getPack).not.toHaveBeenCalled()
  })

  it('invalidates saved stickers immediately after a favorite mutation', async () => {
    const { rpc, provider, sticker } = stickerHarness()
    await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    expect(provider.listSavedStickers).toHaveBeenCalledTimes(1)

    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')
    await rpc.faveSticker({
      _: 'messages.faveSticker', unfave: false,
      id: {
        _: 'inputDocument', id: media.document.id, accessHash: media.document.accessHash,
        fileReference: media.document.fileReference,
      },
    })
    await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })

    expect(provider.setSavedSticker).toHaveBeenCalledTimes(1)
    expect(provider.listSavedStickers).toHaveBeenCalledTimes(2)
  })

  it('restores local favorite document mappings before returning not-modified', async () => {
    const loose: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'favorite:local-only',
      title: 'Local favorite', format: 'static', mimeType: 'image/png', version: 1,
    }
    const row = { providerId: 'qq:stickers', providerStickerId: loose.stickerId }
    const first = stickerHarness()
    vi.mocked(first.provider.getSticker).mockResolvedValue(loose)
    vi.mocked(first.provider.listSavedStickers!).mockResolvedValue({ stickers: [] })
    first.query.execute.mockResolvedValue([row] as never)
    const full = await first.rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    if (full._ !== 'messages.favedStickers') throw new Error('expected full saved stickers')
    const document = full.stickers[0]!
    if (document._ !== 'document') throw new Error('expected saved sticker document')

    const resumed = stickerHarness()
    vi.mocked(resumed.provider.getSticker).mockResolvedValue(loose)
    vi.mocked(resumed.provider.listSavedStickers!).mockResolvedValue({ stickers: [] })
    resumed.query.execute.mockResolvedValue([row] as never)
    await expect(resumed.rpc.getFavedStickers({
      _: 'messages.getFavedStickers', hash: full.hash,
    })).resolves.toEqual({ _: 'messages.favedStickersNotModified' })
    await expect(resumed.rpc.faveSticker({
      _: 'messages.faveSticker', unfave: false,
      id: {
        _: 'inputDocument', id: document.id, accessHash: document.accessHash,
        fileReference: document.fileReference,
      },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(resumed.provider.setSavedSticker).toHaveBeenCalledWith(expect.anything(), loose, true)
  })

  it('recovers a historical message sticker from its file reference after the document cache is lost', async () => {
    const historical: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'favorite:historical:ebcb350f',
      title: 'Historical favorite', format: 'static', mimeType: 'image/webp', version: 1,
    }
    const projected = stickerHarness()
    const media = projected.rpc.makeMessageMedia(historical)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')

    const resumed = stickerHarness()
    vi.mocked(resumed.provider.listPacks).mockResolvedValue({ packs: [] })
    vi.mocked(resumed.provider.listSavedStickers!).mockResolvedValue({ stickers: [] })
    vi.mocked(resumed.provider.getSticker).mockImplementation(async (_context, stickerId) =>
      stickerId === historical.stickerId ? historical : null)
    const asset = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
    vi.mocked(resumed.provider.openAsset).mockResolvedValue({
      mimeType: historical.mimeType, size: asset.length,
      source: {
        size: asset.length,
        async *stream() {
          yield asset.subarray(0, 3)
          yield asset.subarray(3)
        },
      },
    })

    await expect(resumed.rpc.getFile(
      media.document.id.toNumber(), 2, 4, media.document.fileReference,
    )).resolves.toEqual(asset.subarray(2, 6))
    expect(resumed.provider.getSticker).toHaveBeenCalledWith(
      expect.anything(), historical.stickerId,
    )
    expect(resumed.provider.listPacks).not.toHaveBeenCalled()
    expect(resumed.provider.listSavedStickers).not.toHaveBeenCalled()
  })

  it('rejects a sticker file reference whose document id does not match', async () => {
    const historical: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'favorite:historical:ebcb350f',
      title: 'Historical favorite', format: 'static', mimeType: 'image/webp', version: 1,
    }
    const projected = stickerHarness()
    const media = projected.rpc.makeMessageMedia(historical)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')

    const resumed = stickerHarness()
    vi.mocked(resumed.provider.listPacks).mockResolvedValue({ packs: [] })
    vi.mocked(resumed.provider.listSavedStickers!).mockResolvedValue({ stickers: [] })

    await expect(resumed.rpc.getFile(
      media.document.id.toNumber() + 1, 0, 16, media.document.fileReference,
    )).resolves.toBeUndefined()
    expect(resumed.provider.getSticker).not.toHaveBeenCalled()
  })
})

function stickerHarness(cacheTtlMs = 5 * 60_000) {
  const sticker: IMSticker = {
    providerId: 'qq:stickers', stickerId: 'market:11690:wave', packId: '11690',
    title: 'Wave', format: 'static', mimeType: 'image/png', version: 3,
  }
  const provider: IMStickerProvider = {
    capabilities: { platformKinds: ['qq'], sessionScoped: true },
    listPacks: vi.fn(async () => ({
      packs: [{ providerId: 'ignored', packId: '11690', title: 'QQ Pack', count: 1, version: 7 }],
    })),
    getPack: vi.fn(async () => ({
      providerId: 'ignored', packId: '11690', title: 'QQ Pack', version: 7, stickers: [sticker],
    })),
    getSticker: vi.fn(async () => sticker),
    listSavedStickers: vi.fn(async () => ({ stickers: [sticker] })),
    setSavedSticker: vi.fn(async () => undefined),
    openAsset: vi.fn(async () => { throw new Error('not used') }),
    openThumbnail: vi.fn(async () => null),
  }
  const registry = {
    entries: [['qq:stickers', provider]],
    get: (id: string) => id === 'qq:stickers' ? provider : undefined,
    require: (id: string) => {
      if (id !== 'qq:stickers') throw new Error(`unknown provider ${id}`)
      return provider
    },
  } as unknown as StickerProviderRegistry
  const query = {
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    execute: vi.fn(async () => []),
  }
  const database = {
    get: vi.fn(async () => []),
    select: vi.fn(() => query),
    upsert: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
  const rpc = new StickerRpc(
    database as never,
    registry,
    { platformKind: 'qq' } as IMPlatform,
    { platformId: 'qq', platformSessionId: 'session' } as PlatformSession,
    1,
    cacheTtlMs,
  )
  return { rpc, provider, sticker, query }
}
