import { describe, expect, it, vi } from 'vitest'
import type { StickerProviderContext } from '@mtproto-relay/bridge'
import { mapStickerSet } from './api.js'
import { TelegramStickerImporterProvider } from './provider.js'

const context: StickerProviderContext = {
  platformKind: 'static',
  session: { platformId: 'static', platformSessionId: 'session', userId: 'user', credentials: {}, metadata: {} },
}
const otherContext: StickerProviderContext = {
  ...context,
  session: { ...context.session, platformSessionId: 'other-session' },
}
const sticker = {
  providerId: 'telegram-sticker-importer', stickerId: 'stable', packId: 'pack', title: 'Pack',
  format: 'static' as const, mimeType: 'image/webp', size: 6, locator: { fileId: 'download-id' },
}

function provider(download: (fileId: string, options?: { offset?: number, limit?: number }) => Promise<Response>) {
  return new TelegramStickerImporterProvider({ get: vi.fn(async () => []) } as never, { download } as never)
}

async function bytes(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const result: number[] = []
  for await (const chunk of source) result.push(...chunk)
  return result
}

describe('Telegram sticker asset source', () => {
  it('uses an upstream 206 response without discarding its requested prefix', async () => {
    const download = vi.fn(async () => new Response(Uint8Array.of(3, 4), { status: 206 }))
    const asset = await provider(download).openAsset(context, sticker)

    await expect(bytes(asset.source.streamRange!({ offset: 2, limit: 2 }))).resolves.toEqual([3, 4])
    expect(download).toHaveBeenCalledWith('download-id', expect.objectContaining({ offset: 2, limit: 2 }))
  })

  it('discards the prefix and limits bytes when Telegram ignores Range with 200', async () => {
    const download = vi.fn(async () => new Response(Uint8Array.of(1, 2, 3, 4, 5, 6), { status: 200 }))
    const asset = await provider(download).openAsset(context, sticker)

    await expect(bytes(asset.source.streamRange!({ offset: 2, limit: 3 }))).resolves.toEqual([3, 4, 5])
  })

  it('returns forged or unknown pack sticker IDs without requesting Telegram', async () => {
    const set = mapStickerSet({ name: 'known', title: 'Known', stickers: [{ file_id: 'file', file_unique_id: 'unique' }] })
    const database = { get: vi.fn(async (_table: string, query: Record<string, unknown>) =>
      query.shortName === 'known' ? [{ platformSessionId: 'session', shortName: 'known', payload: set }] : []) }
    const getStickerSet = vi.fn(async () => set)
    const provider = new TelegramStickerImporterProvider(database as never, { getStickerSet } as never)

    await expect(provider.getSticker(context, 'not-json')).resolves.toBeNull()
    await expect(provider.getSticker(context, '["unknown","unique"]')).resolves.toBeNull()
    expect(getStickerSet).not.toHaveBeenCalled()
    await expect(provider.getSticker(context, set.stickers[0]!.stickerId)).resolves.toMatchObject({ stickerId: set.stickers[0]!.stickerId })
    expect(getStickerSet).not.toHaveBeenCalled()
  })

  it('keeps packs and assets isolated by platform session even with shared unique IDs', async () => {
    const first = mapStickerSet({ name: 'first', title: 'First', stickers: [{ file_id: 'first-file', file_unique_id: 'shared' }] })
    const second = mapStickerSet({ name: 'second', title: 'Second', stickers: [{ file_id: 'second-file', file_unique_id: 'shared' }] })
    const rows = [
      { platformSessionId: context.session.platformSessionId, shortName: first.shortName, title: first.title, count: 1, version: first.version, payload: first },
      { platformSessionId: otherContext.session.platformSessionId, shortName: second.shortName, title: second.title, count: 1, version: second.version, payload: second },
    ]
    const database = { get: vi.fn(async (_table: string, query: Record<string, unknown>) => rows.filter((row) =>
      Object.entries(query).every(([key, value]) => row[key as keyof typeof row] === value))) }
    const download = vi.fn(async (fileId: string) => new Response(Uint8Array.of(fileId === 'first-file' ? 1 : 2)))
    const provider = new TelegramStickerImporterProvider(database as never, {
      getStickerSet: vi.fn(async (shortName: string) => shortName === first.shortName ? first : second),
      download,
    } as never)

    await expect(provider.listPacks(context)).resolves.toMatchObject({ packs: [{ packId: 'first' }] })
    await expect(provider.listPacks(otherContext)).resolves.toMatchObject({ packs: [{ packId: 'second' }] })
    const firstPack = await provider.getPack(context, 'first')
    const secondPack = await provider.getPack(otherContext, 'second')
    if (!firstPack || !secondPack) throw new Error('missing session-scoped packs')
    expect(firstPack.stickers[0]!.stickerId).not.toBe(secondPack.stickers[0]!.stickerId)
    const firstAsset = await provider.openAsset(context, firstPack.stickers[0]!)
    const secondAsset = await provider.openAsset(otherContext, secondPack.stickers[0]!)
    await expect(bytes(firstAsset.source.stream())).resolves.toEqual([1])
    await expect(bytes(secondAsset.source.stream())).resolves.toEqual([2])
  })
})
