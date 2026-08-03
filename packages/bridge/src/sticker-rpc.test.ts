import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import { StickerRpc } from './sticker-rpc.js'
import type { IMSticker, IMStickerProvider, StickerProviderRegistry } from './sticker-provider.js'
import type { IMPlatform, PlatformSession } from './platform.js'

describe('StickerRpc', () => {
  it.each([
    ['GIF', 'image/gif', 'market:11690:gif-wave'],
    ['APNG', 'image/apng', 'market:11690:apng-wave'],
  ])('projects a QQ market %s as a sticker document tied to its store pack', (
    _label,
    mimeType,
    stickerId,
  ) => {
    const { rpc } = stickerHarness()
    const sticker: IMSticker = {
      providerId: 'qq:stickers', stickerId, packId: '11690', title: 'Wave',
      format: 'animated', mimeType, width: 320, height: 180, size: 4321, version: 7,
    }

    const media = rpc.makeMessageMedia(sticker)

    expect(media._).toBe('messageMediaDocument')
    expect(media).not.toHaveProperty('photo')
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')
    expect(media.document.mimeType).toBe(mimeType)
    expect(media.document.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _: 'documentAttributeSticker',
        stickerset: expect.objectContaining({ _: 'inputStickerSetID' }),
      }),
      { _: 'documentAttributeImageSize', w: 320, h: 180 },
      { _: 'documentAttributeAnimated' },
    ]))
    expect(media.document.attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'documentAttributeVideo' }),
    ]))
    const stickerAttribute = media.document.attributes.find((attribute) =>
      attribute._ === 'documentAttributeSticker')
    if (!stickerAttribute || stickerAttribute._ !== 'documentAttributeSticker'
      || stickerAttribute.stickerset._ !== 'inputStickerSetID') {
      throw new Error('expected store sticker set ID')
    }
    expect(stickerAttribute.stickerset.id.equals(stickerAttribute.stickerset.accessHash)).toBe(true)
    expect(stickerAttribute.stickerset.id.isZero()).toBe(false)
  })

  it('rejects unsupported built-in sets instead of claiming an initial request was not modified', async () => {
    const { rpc } = stickerHarness()

    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet', stickerset: { _: 'inputStickerSetDice', emoticon: '🎲' }, hash: 0,
    })).rejects.toMatchObject({ code: 400, text: 'STICKERSET_INVALID' })
    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet', stickerset: { _: 'inputStickerSetEmojiDefaultStatuses' }, hash: 0,
    })).rejects.toMatchObject({ code: 400, text: 'STICKERSET_INVALID' })
    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet', stickerset: { _: 'inputStickerSetEmojiDefaultTopicIcons' }, hash: 0,
    })).rejects.toMatchObject({ code: 400, text: 'STICKERSET_INVALID' })
  })

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
    expect(media.document.thumbs).toEqual([
      { _: 'photoPathSize', type: 'j', bytes: expect.any(Uint8Array) },
      { _: 'photoSize', type: 'm', w: 96, h: 64, size: thumbnail.length },
    ])
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

  it('always projects an inline loading silhouette before any sticker download', () => {
    const { rpc, sticker, provider } = stickerHarness()

    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')

    expect(media.document.thumbs).toEqual([{
      _: 'photoPathSize', type: 'j', bytes: expect.any(Uint8Array),
    }])
    expect(media.document.thumbs![0]!._ === 'photoPathSize'
      && media.document.thumbs![0]!.bytes.byteLength).toBeGreaterThan(0)
    expect(provider.openAsset).not.toHaveBeenCalled()
    expect(provider.openThumbnail).not.toHaveBeenCalled()
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

  it('unions persisted installed packs with an incomplete provider catalog after restart', async () => {
    const favorite: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'favorite:one', packId: 'qq-favorites',
      title: 'Favorite', format: 'static', mimeType: 'image/png',
    }
    const market: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'market:11474:one', packId: '11474',
      title: 'Market', format: 'animated', mimeType: 'image/apng',
    }
    const provider: IMStickerProvider = {
      capabilities: { ownerPlatformId: 'qq' },
      listPacks: vi.fn(async () => ({ packs: [{
        providerId: 'qq:stickers', packId: 'qq-favorites', title: 'QQ Favorites', count: 1,
        automaticAssociation: 'provider-account' as const,
      }] })),
      getPack: vi.fn(async (_context, packId) => packId === 'qq-favorites' ? {
        providerId: 'qq:stickers', packId, title: 'QQ Favorites',
        automaticAssociation: 'provider-account' as const, stickers: [favorite],
      } : packId === '11474' ? {
        providerId: 'qq:stickers', packId, title: '股市风云', stickers: [market],
      } : null),
      getSticker: vi.fn(async () => null),
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
    const installed = [{
      id: 1, platformSessionId: 'session', providerId: 'qq:stickers', providerPackId: '11474',
      installedAt: new Date('2026-08-01T00:00:00Z'), sortOrder: 0,
      archived: false, uninstalled: false,
    }]
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) =>
        table === 'mtproto_sticker_set_install'
          ? installed.filter((row) => Object.entries(query).every(([key, value]) => (row as any)[key] === value))
          : []),
    }
    const rpc = new StickerRpc(
      database as never, registry, { platformKind: 'qq' } as IMPlatform,
      { platformId: 'qq', platformSessionId: 'session' } as PlatformSession,
    )

    const all = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    expect(all).toMatchObject({
      _: 'messages.allStickers',
      sets: [
        expect.objectContaining({ title: 'QQ Favorites', count: 1 }),
        expect.objectContaining({ title: '股市风云', count: 1 }),
      ],
    })
    if (all._ !== 'messages.allStickers') throw new Error('expected sticker catalog')
    const marketSet = all.sets.find((set) => set.title === '股市风云')!
    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet',
      stickerset: { _: 'inputStickerSetID', id: marketSet.id, accessHash: marketSet.accessHash },
      hash: 0,
    })).resolves.toMatchObject({
      _: 'messages.stickerSet', set: { title: '股市风云' },
      documents: [expect.objectContaining({ mimeType: 'image/apng' })],
    })
    expect(provider.listPacks).toHaveBeenCalledTimes(1)
    expect(provider.getPack).toHaveBeenCalledWith(expect.anything(), '11474')
  })

  it('skips stale and explicitly uninstalled persisted packs without breaking the catalog', async () => {
    const { rpc, provider, database } = stickerHarness(0)
    vi.mocked(provider.listPacks).mockResolvedValue({ packs: [] })
    vi.mocked(provider.getPack).mockRejectedValue(new Error('pack was removed upstream'))
    vi.mocked(database.get).mockResolvedValue([{
      id: 2, platformSessionId: 'session', providerId: 'qq:stickers', providerPackId: 'stale',
      installedAt: new Date(), sortOrder: 0, archived: false, uninstalled: false,
    }, {
      id: 3, platformSessionId: 'session', providerId: 'qq:stickers', providerPackId: 'removed',
      installedAt: new Date(), sortOrder: 1, archived: false, uninstalled: true,
    }] as never)

    await expect(rpc.getAllStickers({
      _: 'messages.getAllStickers', hash: Long.ZERO,
    })).resolves.toMatchObject({ _: 'messages.allStickers', sets: [] })
    expect(provider.getPack).toHaveBeenCalledTimes(1)
    expect(provider.getPack).toHaveBeenCalledWith(expect.anything(), 'stale')
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
    expect(saved.stickers).toMatchObject([{ _: 'document', size: 321 }])

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

  it('skips broken recent stickers without shifting the surviving sticker date', async () => {
    const { rpc, provider, sticker, query } = stickerHarness()
    const brokenAt = new Date('2026-08-01T11:00:00Z')
    const validAt = new Date('2026-08-01T10:00:00Z')
    vi.mocked(query.execute).mockResolvedValueOnce([{
      id: 1, platformSessionId: 'session', providerId: 'qq:stickers', providerStickerId: 'broken',
      attached: false, useCount: 9, lastUsedAt: brokenAt,
    }, {
      id: 2, platformSessionId: 'session', providerId: 'qq:stickers', providerStickerId: sticker.stickerId,
      attached: false, useCount: 3, lastUsedAt: validAt,
    }])
    vi.mocked(provider.getSticker).mockImplementation(async (_context, stickerId) => {
      if (stickerId === 'broken') throw new Error('temporary provider failure')
      return sticker
    })

    const recent = await rpc.getRecentStickers({
      _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO,
    })
    expect(recent).toMatchObject({
      _: 'messages.recentStickers', stickers: [{ _: 'document' }],
      dates: [Math.floor(validAt.getTime() / 1000)],
    })
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
    await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
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
    await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })

    expect(provider.setSavedSticker).toHaveBeenCalledTimes(1)
    expect(provider.listSavedStickers).toHaveBeenCalledTimes(2)
    expect(provider.listPacks).toHaveBeenCalledTimes(2)
  })

  it('keeps an uninstall tombstone until the sticker set is installed again', async () => {
    const { rpc, database } = stickerHarness()
    const rows: Array<Record<string, any>> = [{
      id: 1, platformSessionId: 'session', providerId: 'qq:stickers', providerPackId: '11690',
      installedAt: new Date('2025-01-01T00:00:00Z'), sortOrder: 0, archived: false, uninstalled: false,
    }]
    database.get.mockImplementation((async (_table: string, query: Record<string, unknown>) => rows.filter((row) =>
      Object.entries(query).every(([key, value]) => row[key] === value))) as never)
    database.upsert.mockImplementation((async (_table: string, values: Array<Record<string, any>>) => {
      for (const value of values) {
        const existing = rows.find((row) => row.platformSessionId === value.platformSessionId
          && row.providerId === value.providerId && row.providerPackId === value.providerPackId)
        if (existing) Object.assign(existing, value)
        else rows.push({ id: rows.length + 1, ...value })
      }
    }) as never)

    const initial = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    if (initial._ !== 'messages.allStickers') throw new Error('expected full sticker catalog')
    const input = {
      _: 'inputStickerSetID' as const,
      id: initial.sets[0]!.id,
      accessHash: initial.sets[0]!.accessHash,
    }

    await expect(rpc.uninstallStickerSet({
      _: 'messages.uninstallStickerSet', stickerset: input,
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(rows).toMatchObject([{ providerPackId: '11690', archived: false, uninstalled: true }])
    await expect(rpc.getAllStickers({
      _: 'messages.getAllStickers', hash: Long.ZERO,
    })).resolves.toMatchObject({ _: 'messages.allStickers', sets: [] })

    await expect(rpc.installStickerSet({
      _: 'messages.installStickerSet', stickerset: input, archived: false,
    })).resolves.toEqual({ _: 'messages.stickerSetInstallResultSuccess' })
    expect(rows).toMatchObject([{ providerPackId: '11690', archived: false, uninstalled: false }])
    await expect(rpc.getAllStickers({
      _: 'messages.getAllStickers', hash: Long.ZERO,
    })).resolves.toMatchObject({
      _: 'messages.allStickers',
      sets: [expect.objectContaining({ title: 'QQ Pack', installedDate: expect.any(Number) })],
    })
  })

  it('always associates an account-native favorite pack and ignores uninstall attempts', async () => {
    const { rpc, provider, database } = stickerHarness()
    database.get.mockResolvedValue([] as never)
    vi.mocked(provider.listPacks).mockResolvedValue({
      packs: [{
        providerId: 'ignored', packId: 'qq-favorites', title: 'QQ 收藏表情', count: 1,
        automaticAssociation: 'provider-account',
      }],
    })
    vi.mocked(provider.getPack).mockResolvedValue({
      providerId: 'ignored', packId: 'qq-favorites', title: 'QQ 收藏表情',
      automaticAssociation: 'provider-account', stickers: [],
    })

    const all = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    if (all._ !== 'messages.allStickers') throw new Error('expected full sticker catalog')
    expect(all.sets).toMatchObject([{
      title: 'QQ 收藏表情', installedDate: expect.any(Number), archived: undefined,
    }])
    await expect(rpc.uninstallStickerSet({
      _: 'messages.uninstallStickerSet',
      stickerset: {
        _: 'inputStickerSetID', id: all.sets[0]!.id, accessHash: all.sets[0]!.accessHash,
      },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(database.upsert).not.toHaveBeenCalled()
    await expect(rpc.getAllStickers({
      _: 'messages.getAllStickers', hash: Long.ZERO,
    })).resolves.toMatchObject({ _: 'messages.allStickers', sets: [{ title: 'QQ 收藏表情' }] })
  })

  it('uses an upload plan and bridge-local favorite state for a pack assigned across accounts', async () => {
    const { rpc, provider, sticker, database } = stickerHarness()
    ;(provider as { capabilities: IMStickerProvider['capabilities'] }).capabilities = {
      platformKinds: ['qq'], ownerPlatformId: 'qq/source', sessionScoped: true,
    }
    provider.prepareSend = vi.fn(async () => ({
      type: 'native' as const, providerId: sticker.providerId, stickerId: sticker.stickerId,
      reference: { native: true },
    }))
    const bytes = new Uint8Array([1, 2, 3])
    vi.mocked(provider.openAsset).mockResolvedValue({
      mimeType: 'image/png', size: bytes.length,
      source: { size: bytes.length, async *stream() { yield bytes } },
    })
    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')
    const input = {
      _: 'inputDocument' as const,
      id: media.document.id, accessHash: media.document.accessHash, fileReference: media.document.fileReference,
    }

    await expect(rpc.resolveSend(input)).resolves.toMatchObject({ plan: { type: 'upload' } })
    expect(provider.prepareSend).not.toHaveBeenCalled()
    await rpc.faveSticker({ _: 'messages.faveSticker', id: input, unfave: false })
    expect(provider.setSavedSticker).not.toHaveBeenCalled()
    expect(database.upsert).toHaveBeenCalled()
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
    title: 'Wave', format: 'static', mimeType: 'image/png', size: 321, version: 3,
  }
  const provider: IMStickerProvider = {
    capabilities: { platformKinds: ['qq'], ownerPlatformId: 'qq', sessionScoped: true },
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
  const installed = [{
    id: 1, platformSessionId: 'session', providerId: 'qq:stickers', providerPackId: '11690',
    installedAt: new Date('2025-01-01T00:00:00Z'), sortOrder: 0, archived: false, uninstalled: false,
  }]
  const database = {
    get: vi.fn(async (table: string, query: Record<string, unknown>) => table === 'mtproto_sticker_set_install'
      ? installed.filter((row) => Object.entries(query).every(([key, value]) => (row as any)[key] === value))
      : []),
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
  return { rpc, provider, sticker, query, database }
}
