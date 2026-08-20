import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { StickerRpc } from './sticker-rpc.js'
import { StickerProviderRegistry, type IMSticker, type IMStickerProvider } from './sticker-provider.js'
import type { IMPlatform, PlatformSession } from './platform.js'

describe('StickerRpc', () => {
  it('releases only the deactivated session revision', () => {
    const registry = new StickerProviderRegistry()
    registry.register('provider', { } as IMStickerProvider)
    registry.touch('provider', 'first')
    registry.touch('provider', 'second')
    const second = registry.revisionFor('second')

    registry.releaseSession('first')

    expect(registry.revisionFor('first')).toBe('1:0')
    expect(registry.revisionFor('second')).toBe(second)
    registry.touch('provider', 'first')
    expect(registry.revisionFor('first')).toBe('1:1')
  })

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

    const media = wireRoundTrip(rpc.makeMessageMedia(sticker))

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
    ]))
    expect(media.document.attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'documentAttributeAnimated' }),
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

  it('rotates synthetic sticker IDs so clients discard cached square dimensions', () => {
    const { rpc, sticker } = stickerHarness()
    sticker.width = 512
    sticker.height = 286

    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')
    const stickerAttribute = media.document.attributes.find((attribute) =>
      attribute._ === 'documentAttributeSticker')
    if (!stickerAttribute || stickerAttribute._ !== 'documentAttributeSticker'
      || stickerAttribute.stickerset._ !== 'inputStickerSetID') throw new Error('expected sticker set ID')

    expect(media.document.id.toNumber()).toBe(testStickerProjectionId(
      `sticker-document:v9:${sticker.providerId}:${sticker.stickerId}`,
    ))
    expect(media.document.id.toNumber()).not.toBe(testStickerProjectionId(
      `sticker-document:v8:${sticker.providerId}:${sticker.stickerId}`,
    ))
    expect(stickerAttribute.stickerset.id.toNumber()).toBe(testStickerProjectionId(
      `sticker-set:v9:${sticker.providerId}:${sticker.packId}`,
    ))
    expect(media.document.attributes).toContainEqual({
      _: 'documentAttributeImageSize', w: 512, h: 286,
    })
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

  it('delegates document ranges to a provider-native range stream', async () => {
    const { rpc, sticker, provider } = stickerHarness()
    const asset = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    const stream = vi.fn(async function* () { yield asset })
    const streamRange = vi.fn(async function* ({ offset, limit }: { offset: number, limit: number }) {
      yield asset.subarray(offset, offset + limit)
    })
    vi.mocked(provider.openAsset).mockResolvedValue({
      mimeType: 'image/png', size: asset.length, source: { size: asset.length, stream, streamRange },
    })
    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')

    await expect(rpc.getFile(
      media.document.id.toNumber(), 2, 4, media.document.fileReference,
    )).resolves.toEqual(asset.subarray(2, 6))

    expect(streamRange).toHaveBeenCalledWith({ offset: 2, limit: 4 })
    expect(stream).not.toHaveBeenCalled()
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
      revisionFor: () => '0:0',
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
      revisionFor: () => '0:0',
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

  it('serves QQNT favorites only through the account-owned sticker set and honors Telegram hashes', async () => {
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
    expect(saved).toMatchObject({ packs: [], stickers: [] })

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
    expect(provider.listSavedStickers).not.toHaveBeenCalled()
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
    if (recent._ !== 'messages.recentStickers' || recent.stickers[0]?._ !== 'document') {
      throw new Error('expected full recent stickers')
    }
    expect(recent.packs[0]?.documents[0]?.equals(recent.stickers[0].id)).toBe(true)
  })

  it('resolves recent sticker rows with bounded concurrency and reuses provider results', async () => {
    const { rpc, provider, sticker, query } = stickerHarness()
    const rows = Array.from({ length: 24 }, (_, index) => ({
      id: index + 1,
      platformSessionId: 'session',
      providerId: 'qq:stickers',
      providerStickerId: `recent:${index}`,
      attached: false,
      useCount: 1,
      lastUsedAt: new Date(1_700_000_000_000 - index * 1_000),
    }))
    vi.mocked(query.execute).mockResolvedValue(rows)
    let active = 0
    let maximum = 0
    vi.mocked(provider.getSticker).mockImplementation(async (_context, stickerId) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { ...sticker, stickerId }
    })

    await rpc.getRecentStickers({ _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO })
    expect(provider.getSticker).toHaveBeenCalledTimes(rows.length)
    expect(maximum).toBe(8)

    await rpc.getRecentStickers({ _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO })
    expect(provider.getSticker).toHaveBeenCalledTimes(rows.length)
  })

  it('uses wide document IDs in non-QQ favorite sticker packs', async () => {
    const sticker: IMSticker = {
      providerId: 'importer', stickerId: 'favorite:wide', title: 'Wide favorite',
      emoji: ['🙂'], format: 'static', mimeType: 'image/webp',
    }
    const provider: IMStickerProvider = {
      listPacks: vi.fn(async () => ({ packs: [] })),
      getPack: vi.fn(async () => null),
      getSticker: vi.fn(async (_context, stickerId) => stickerId === sticker.stickerId ? sticker : null),
      openAsset: vi.fn(async () => ({ mimeType: sticker.mimeType, source: { async *stream() {} } })),
    }
    const registry = new StickerProviderRegistry()
    registry.register('importer', provider)
    const query = {
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      execute: vi.fn(async () => [{
        id: 1, platformSessionId: 'session', providerId: 'importer',
        providerStickerId: sticker.stickerId, createdAt: new Date(),
      }]),
    }
    const rpc = new StickerRpc(
      { select: vi.fn(() => query), get: vi.fn(async () => []) } as never,
      registry,
      { platformKind: 'static' } as IMPlatform,
      { platformId: 'static', platformSessionId: 'session' } as PlatformSession,
    )

    const favorite = await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    if (favorite._ !== 'messages.favedStickers' || favorite.stickers[0]?._ !== 'document') {
      throw new Error('expected full favorite stickers')
    }
    expect(favorite.stickers[0].id.greaterThan(Long.fromNumber(0x7fff_ffff))).toBe(true)
    expect(favorite.packs[0]?.documents[0]?.equals(favorite.stickers[0].id)).toBe(true)
  })

  it('deduplicates recent aliases by canonical sticker ID and honors Telegram document hashes', async () => {
    const { rpc, provider, sticker, query } = stickerHarness()
    const second: IMSticker = {
      ...sticker, stickerId: 'market:11690:second', title: 'Second',
    }
    const newestAt = new Date('2026-08-02T11:00:00Z')
    const secondAt = new Date('2026-08-02T10:30:00Z')
    const olderAt = new Date('2026-08-02T10:00:00Z')
    vi.mocked(query.execute).mockResolvedValue([{
      id: 1, platformSessionId: 'session', providerId: 'qq:stickers', providerStickerId: 'favorite:md5-alias',
      attached: false, useCount: 4, lastUsedAt: newestAt,
    }, {
      id: 2, platformSessionId: 'session', providerId: 'qq:stickers', providerStickerId: second.stickerId,
      attached: false, useCount: 3, lastUsedAt: secondAt,
    }, {
      id: 3, platformSessionId: 'session', providerId: 'qq:stickers', providerStickerId: sticker.stickerId,
      attached: false, useCount: 2, lastUsedAt: olderAt,
    }])
    vi.mocked(provider.getSticker).mockImplementation(async (_context, stickerId) =>
      stickerId === second.stickerId ? second : sticker)

    const recent = await rpc.getRecentStickers({
      _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO,
    })
    expect(recent._).toBe('messages.recentStickers')
    if (recent._ !== 'messages.recentStickers') throw new Error('expected full recent stickers')
    expect(recent.stickers).toHaveLength(2)
    expect(recent.dates).toEqual([
      Math.floor(newestAt.getTime() / 1000),
      Math.floor(secondAt.getTime() / 1000),
    ])
    const expectedHash = telegramDocumentHash(recent.stickers.map((item) => item.id))
    expect(recent.hash.equals(expectedHash)).toBe(true)

    await expect(rpc.getRecentStickers({
      _: 'messages.getRecentStickers', attached: false, hash: expectedHash,
    })).resolves.toEqual({ _: 'messages.recentStickersNotModified' })
  })

  it('gives every pack cover a distinct desktop cache version and serves that pack first sticker', async () => {
    const first: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'market:100:first', packId: '100',
      format: 'static', mimeType: 'image/png', version: 1,
    }
    const second: IMSticker = {
      providerId: 'qq:stickers', stickerId: 'market:200:first', packId: '200',
      format: 'static', mimeType: 'image/png', version: 1,
    }
    const packs = new Map([
      ['100', { providerId: 'qq:stickers', packId: '100', title: 'First', version: 1, stickers: [first] }],
      ['200', { providerId: 'qq:stickers', packId: '200', title: 'Second', version: 1, stickers: [second] }],
    ])
    const provider: IMStickerProvider = {
      listPacks: vi.fn(async () => ({ packs: [...packs.values()].map(({ stickers, ...pack }) => ({
        ...pack, count: stickers.length,
      })) })),
      getPack: vi.fn(async (_context, packId) => packs.get(packId) ?? null),
      getSticker: vi.fn(async (_context, stickerId) => [first, second].find((item) => item.stickerId === stickerId) ?? null),
      openAsset: vi.fn(async (_context, sticker) => {
        const bytes = Uint8Array.of(sticker.stickerId === first.stickerId ? 1 : 2)
        return { mimeType: 'image/png', size: bytes.length, source: {
          size: bytes.length, async *stream() { yield bytes },
        } }
      }),
    }
    const registry = {
      revisionFor: () => '0:0',
      entries: [['qq:stickers', provider]],
      get: (id: string) => id === 'qq:stickers' ? provider : undefined,
      require: (id: string) => {
        if (id !== 'qq:stickers') throw new Error(`unknown provider ${id}`)
        return provider
      },
    } as unknown as StickerProviderRegistry
    const installed = [...packs.keys()].map((providerPackId, index) => ({
      id: index + 1, platformSessionId: 'session', providerId: 'qq:stickers', providerPackId,
      installedAt: new Date('2026-08-02T00:00:00Z'), sortOrder: index, archived: false, uninstalled: false,
    }))
    const database = {
      get: vi.fn(async (table: string) => table === 'mtproto_sticker_set_install' ? installed : []),
    }
    const rpc = new StickerRpc(
      database as never,
      registry,
      { platformKind: 'qq' } as IMPlatform,
      { platformId: 'qq', platformSessionId: 'session' } as PlatformSession,
    )

    const all = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    expect(all._).toBe('messages.allStickers')
    if (all._ !== 'messages.allStickers') throw new Error('expected sticker catalog')
    const full = await Promise.all(all.sets.map(async (set) => {
      const result = await rpc.getStickerSet({
        _: 'messages.getStickerSet',
        stickerset: { _: 'inputStickerSetID', id: set.id, accessHash: set.accessHash },
        hash: 0,
      })
      if (result._ !== 'messages.stickerSet') throw new Error('expected full sticker set')
      return result
    }))
    expect(full[0]!.set.thumbVersion).not.toBe(full[1]!.set.thumbVersion)
    for (const set of full) {
      expect(set.set.thumbDocumentId?.equals(set.documents[0]!.id)).toBe(true)
    }
    await expect(rpc.getSetThumb({
      _: 'inputStickerSetID', id: full[0]!.set.id, accessHash: full[0]!.set.accessHash,
    }, 0, 1)).resolves.toEqual(Uint8Array.of(1))
    await expect(rpc.getSetThumb({
      _: 'inputStickerSetID', id: full[1]!.set.id, accessHash: full[1]!.set.accessHash,
    }, 0, 1)).resolves.toEqual(Uint8Array.of(2))
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

  it('refreshes a cached catalog immediately after its provider is touched', async () => {
    const { rpc, provider, touch } = stickerHarness()
    const initial = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    if (initial._ !== 'messages.allStickers') throw new Error('expected full sticker catalog')
    vi.mocked(provider.listPacks).mockResolvedValue({
      packs: [{ providerId: 'ignored', packId: '11690', title: 'Imported revision', count: 1, version: 8 }],
    })

    touch()
    const refreshed = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: initial.hash })

    expect(provider.listPacks).toHaveBeenCalledTimes(2)
    expect(refreshed).toMatchObject({ _: 'messages.allStickers', sets: [{ title: 'Imported revision' }] })
  })

  it('maps QQ favorite mutations to QQNT and refreshes the account-owned pack without filling Telegram favorites', async () => {
    const { rpc, provider, sticker } = stickerHarness()
    await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    await rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    expect(provider.listSavedStickers).not.toHaveBeenCalled()

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
    expect(provider.setSavedSticker).toHaveBeenCalledWith(expect.anything(), sticker, true)
    expect(provider.listSavedStickers).not.toHaveBeenCalled()
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

  it('uses an upload plan but rejects Telegram-local favorites for a pack assigned across QQ accounts', async () => {
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
    await expect(rpc.faveSticker({ _: 'messages.faveSticker', id: input, unfave: false }))
      .rejects.toMatchObject({ code: 400, text: 'STICKER_FAVORITES_UNSUPPORTED' })
    expect(provider.setSavedSticker).not.toHaveBeenCalled()
    expect(database.upsert).not.toHaveBeenCalled()
  })

  it('ignores legacy bridge-local QQ favorite rows in favor of the QQ favorite set', async () => {
    const row = { providerId: 'qq:stickers', providerStickerId: 'favorite:local-only' }
    const first = stickerHarness()
    first.query.execute.mockResolvedValue([row] as never)
    const full = await first.rpc.getFavedStickers({ _: 'messages.getFavedStickers', hash: Long.ZERO })
    if (full._ !== 'messages.favedStickers') throw new Error('expected full saved stickers')
    expect(full).toMatchObject({ packs: [], stickers: [] })
    expect(first.database.select).not.toHaveBeenCalled()

    const resumed = stickerHarness()
    resumed.query.execute.mockResolvedValue([row] as never)
    await expect(resumed.rpc.getFavedStickers({
      _: 'messages.getFavedStickers', hash: full.hash,
    })).resolves.toEqual({ _: 'messages.favedStickersNotModified' })
    expect(resumed.database.select).not.toHaveBeenCalled()
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

  it('does not use a cached document after its provider unregisters', async () => {
    const sticker: IMSticker = {
      providerId: 'temporary', stickerId: 'sticker', title: 'Temporary', format: 'static', mimeType: 'image/webp',
    }
    const provider: IMStickerProvider = {
      listPacks: vi.fn(async () => ({ packs: [] })), getPack: vi.fn(async () => null),
      getSticker: vi.fn(async () => sticker),
      openAsset: vi.fn(async () => ({ mimeType: sticker.mimeType, source: { async *stream() { yield Uint8Array.of(1) } } })),
    }
    const registry = new StickerProviderRegistry()
    const unregister = registry.register('temporary', provider)
    const rpc = new StickerRpc({ get: vi.fn(async () => []) } as never, registry, { platformKind: 'static' } as never,
      { platformId: 'static', platformSessionId: 'session' } as PlatformSession)
    const media = rpc.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected document')

    unregister()

    await expect(rpc.getFile(media.document.id.toNumber(), 0, 1, media.document.fileReference)).resolves.toBeUndefined()
    expect(provider.openAsset).not.toHaveBeenCalled()
  })

  it('uses distinct wide document IDs for legacy stableId collision inputs and resolves each file reference', async () => {
    const first: IMSticker = {
      providerId: 'importer', stickerId: '_G6Nrw_pWDbJj7gS', title: 'First', format: 'static', mimeType: 'image/webp',
    }
    const second: IMSticker = {
      providerId: 'importer', stickerId: 'PNvAxey3RRfHHagZ', title: 'Second', format: 'static', mimeType: 'image/webp',
    }
    const provider: IMStickerProvider = {
      listPacks: vi.fn(async () => ({ packs: [] })), getPack: vi.fn(async () => null),
      getSticker: vi.fn(async (_context, stickerId) => stickerId === first.stickerId ? first : stickerId === second.stickerId ? second : null),
      openAsset: vi.fn(async (_context, sticker) => ({
        mimeType: sticker.mimeType,
        source: { async *stream() { yield Uint8Array.of(sticker.stickerId === first.stickerId ? 1 : 2) } },
      })),
    }
    const registry = new StickerProviderRegistry()
    registry.register('importer', provider)
    const session = { platformId: 'static', platformSessionId: 'session' } as PlatformSession
    const rpc = new StickerRpc({ get: vi.fn(async () => []) } as never, registry, { platformKind: 'static' } as never, session)
    const firstMedia = rpc.makeMessageMedia(first)
    const secondMedia = rpc.makeMessageMedia(second)
    if (!firstMedia.document || firstMedia.document._ !== 'document'
      || !secondMedia.document || secondMedia.document._ !== 'document') throw new Error('expected documents')

    expect(firstMedia.document.id.equals(secondMedia.document.id)).toBe(false)
    await expect(rpc.getFile(firstMedia.document.id.toNumber(), 0, 1, firstMedia.document.fileReference)).resolves.toEqual(Uint8Array.of(1))
    await expect(rpc.getFile(secondMedia.document.id.toNumber(), 0, 1, secondMedia.document.fileReference)).resolves.toEqual(Uint8Array.of(2))
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
  let revision = 0
  const registry = {
    revisionFor: () => `0:${revision}`,
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
  return { rpc, provider, sticker, query, database, touch: () => { revision++ } }
}

function testStickerProjectionId(value: string): number {
  const hash = createHash('sha256').update(value).digest()
  return 1 + hash.readUInt32BE(0) * 0x10_0000 + (hash.readUInt32BE(4) & 0x0f_ffff)
}

function telegramDocumentHash(ids: Long[]): Long {
  let hash = Long.ZERO
  for (const id of ids) {
    hash = hash.xor(hash.shiftRightUnsigned(21))
    hash = hash.xor(hash.shiftLeft(35))
    hash = hash.xor(hash.shiftRightUnsigned(4))
    hash = hash.add(id)
  }
  return hash
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}
