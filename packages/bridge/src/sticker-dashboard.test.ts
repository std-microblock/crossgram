import { describe, expect, it, vi } from 'vitest'
import {
  collectStickerDashboard, providerBelongsToAccount, setStickerPackAssignment,
} from './sticker-dashboard.js'
import type { IMStickerProvider, StickerProviderRegistry } from './sticker-provider.js'
import type { PlatformSession } from './platform.js'

const qqSession = {
  platformId: 'qq/primary', platformSessionId: 'qq-session', userId: '10001', credentials: {}, metadata: {},
} as PlatformSession
const staticSession = {
  platformId: 'static/demo', platformSessionId: 'static-session', userId: 'demo', credentials: {}, metadata: {},
} as PlatformSession

describe('Bridge sticker pack dashboard', () => {
  it('lists the global catalog, preserves manual assignments, and locks QQ favorites to their owner', async () => {
    const qqProvider = provider('qq/primary', [
      { providerId: 'ignored', packId: 'qq-favorites', title: 'QQ 收藏表情', automaticAssociation: 'provider-account' },
      { providerId: 'ignored', packId: 'market-1', title: 'QQ 商店包', count: 24 },
    ])
    const staticProvider = provider('static/demo', [
      { providerId: 'ignored', packId: 'stars', title: 'Stars', count: 2 },
    ], 'static')
    const registry = stickerRegistry([
      ['qq/primary:stickers', qqProvider],
      ['static/demo:stickers', staticProvider],
    ])
    const rows = [{
      platformSessionId: 'static-session', providerId: 'qq/primary:stickers', providerPackId: 'market-1',
      installedAt: new Date(), sortOrder: 0, archived: false, uninstalled: false,
    }]
    const database = { get: vi.fn(async () => rows) }

    const result = await collectStickerDashboard(database as never, registry, [
      source(qqSession, 'qq', 'QQ Alice'),
      source(staticSession, 'static', 'Static Demo'),
    ])

    expect(result.accounts.map(account => account.displayName)).toEqual(['QQ Alice', 'Static Demo'])
    expect(result.packs).toHaveLength(3)
    const favorites = result.packs.find(pack => pack.packId === 'qq-favorites')!
    expect(favorites.sourcePlatformId).toBe('qq/primary')
    expect(favorites.assignments).toEqual([
      { platformSessionId: 'qq-session', automatic: true, assigned: true },
      { platformSessionId: 'static-session', automatic: false, assigned: false },
    ])
    expect(result.packs.find(pack => pack.packId === 'market-1')!.assignments).toEqual([
      { platformSessionId: 'qq-session', automatic: false, assigned: false },
      { platformSessionId: 'static-session', automatic: false, assigned: true },
    ])
    expect(qqProvider.listPacks).toHaveBeenCalledWith(
      expect.objectContaining({ session: qqSession, platformKind: 'qq' }),
      { cursor: undefined, limit: 200 },
    )
  })

  it('loads every provider page and rejects repeated cursors', async () => {
    const paged = provider('qq/primary', [])
    vi.mocked(paged.listPacks)
      .mockResolvedValueOnce({
        packs: [{ providerId: 'ignored', packId: 'one', title: 'One' }], nextCursor: 'next',
      })
      .mockResolvedValueOnce({ packs: [{ providerId: 'ignored', packId: 'two', title: 'Two' }] })
    const database = { get: vi.fn(async () => []) }
    const accounts = [source(qqSession, 'qq', 'QQ Alice')]

    await expect(collectStickerDashboard(
      database as never, stickerRegistry([['qq:stickers', paged]]), accounts,
    )).resolves.toMatchObject({ packs: [{ packId: 'one' }, { packId: 'two' }] })

    const broken = provider('qq/primary', [])
    vi.mocked(broken.listPacks).mockResolvedValue({ packs: [], nextCursor: 'same' })
    await expect(collectStickerDashboard(
      database as never, stickerRegistry([['broken', broken]]), accounts,
    )).rejects.toThrow('sticker pack pagination repeated cursor: same')
  })

  it('upserts bridge-local account assignments without invoking a provider', async () => {
    const rows: Array<Record<string, any>> = []
    const database = {
      get: vi.fn(async (_table: string, query: Record<string, unknown>) => rows.filter(row =>
        Object.entries(query).every(([key, value]) => row[key] === value))),
      upsert: vi.fn(async (_table: string, values: Array<Record<string, any>>) => {
        const value = values[0]!
        const existing = rows.find(row => row.platformSessionId === value.platformSessionId
          && row.providerId === value.providerId && row.providerPackId === value.providerPackId)
        if (existing) Object.assign(existing, value)
        else rows.push({ id: rows.length + 1, ...value })
      }),
    }

    await setStickerPackAssignment(database as never, 'target', 'provider', 'pack', true)
    expect(rows).toMatchObject([{
      platformSessionId: 'target', providerId: 'provider', providerPackId: 'pack',
      sortOrder: 0, archived: false, uninstalled: false,
    }])
    await setStickerPackAssignment(database as never, 'target', 'provider', 'pack', false)
    expect(rows[0]).toMatchObject({ uninstalled: true })
  })

  it('distinguishes an owned provider from a foreign provider with the same platform kind', () => {
    const owned = provider('qq/primary', [])
    expect(providerBelongsToAccount(owned, 'qq/primary', 'qq')).toBe(true)
    expect(providerBelongsToAccount(owned, 'qq/secondary', 'qq')).toBe(false)
  })
})

function provider(
  ownerPlatformId: string,
  packs: Awaited<ReturnType<IMStickerProvider['listPacks']>>['packs'],
  kind = 'qq',
): IMStickerProvider {
  return {
    capabilities: { platformKinds: [kind], ownerPlatformId, sessionScoped: true },
    listPacks: vi.fn(async () => ({ packs })),
    getPack: vi.fn(async () => null),
    getSticker: vi.fn(async () => null),
    openAsset: vi.fn(async () => { throw new Error('not used') }),
  }
}

function stickerRegistry(entries: Array<[string, IMStickerProvider]>): StickerProviderRegistry {
  return { entries } as unknown as StickerProviderRegistry
}

function source(session: PlatformSession, platformKind: string, displayName: string) {
  return {
    session,
    view: {
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
      platformKind,
      displayName,
      userId: session.userId,
    },
  }
}
