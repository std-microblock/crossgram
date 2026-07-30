import type { Database } from '@cordisjs/plugin-database'
import type { PlatformSession } from './platform.js'
import type {
  IMStickerPackSummary, IMStickerProvider, StickerProviderContext, StickerProviderRegistry,
} from './sticker-provider.js'

export interface StickerDashboardAccount {
  platformId: string
  platformSessionId: string
  platformKind: string
  displayName: string
  username?: string
  userId: string
}

export interface StickerDashboardAssignment {
  platformSessionId: string
  assigned: boolean
  automatic: boolean
}

export interface StickerDashboardPack {
  providerId: string
  packId: string
  title: string
  count?: number
  version?: number
  sourcePlatformId?: string
  sourcePlatformSessionId?: string
  assignments: StickerDashboardAssignment[]
}

export interface StickerPackDashboardData {
  stickerAccounts: StickerDashboardAccount[]
  stickerPacks: StickerDashboardPack[]
  stickerUpdatedAt: number
  refreshStickerPacks(): Promise<void>
  setStickerPackAssigned(
    platformSessionId: string,
    providerId: string,
    packId: string,
    assigned: boolean,
  ): Promise<void>
}

export interface StickerDashboardSourceAccount {
  view: StickerDashboardAccount
  session: PlatformSession
}

export async function collectStickerDashboard(
  database: Database,
  registry: StickerProviderRegistry,
  accounts: StickerDashboardSourceAccount[],
): Promise<{ accounts: StickerDashboardAccount[], packs: StickerDashboardPack[] }> {
  const rows = await database.get('mtproto_sticker_set_install', {})
  const rowByKey = new Map(rows.map((row) => [
    assignmentKey(row.platformSessionId, row.providerId, row.providerPackId), row,
  ]))
  const packs: StickerDashboardPack[] = []

  for (const [providerId, provider] of registry.entries) {
    const source = sourceAccount(provider, accounts)
    if (!source) continue
    for (const pack of await listEveryPack(provider, providerContext(source))) {
      packs.push({
        providerId,
        packId: pack.packId,
        title: pack.title,
        count: pack.count,
        version: pack.version,
        sourcePlatformId: source.view.platformId,
        sourcePlatformSessionId: source.view.platformSessionId,
        assignments: accounts.map(({ view }) => {
          const automatic = isAutomaticallyAssociated(provider, pack, view.platformId)
          const row = rowByKey.get(assignmentKey(view.platformSessionId, providerId, pack.packId))
          return {
            platformSessionId: view.platformSessionId,
            automatic,
            assigned: automatic || !!row && !row.uninstalled,
          }
        }),
      })
    }
  }

  packs.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN')
    || left.providerId.localeCompare(right.providerId)
    || left.packId.localeCompare(right.packId))
  return { accounts: accounts.map(({ view }) => view), packs }
}

export async function setStickerPackAssignment(
  database: Database,
  platformSessionId: string,
  providerId: string,
  providerPackId: string,
  assigned: boolean,
): Promise<void> {
  const query = { platformSessionId, providerId, providerPackId }
  const [existing] = await database.get('mtproto_sticker_set_install', query)
  if (!assigned && !existing) return
  const rows = assigned
    ? await database.get('mtproto_sticker_set_install', { platformSessionId })
    : []
  const sortOrder = existing?.sortOrder
    ?? rows.reduce((maximum, row) => Math.max(maximum, row.sortOrder), -1) + 1
  await database.upsert('mtproto_sticker_set_install', [{
    ...query,
    installedAt: existing?.installedAt ?? new Date(),
    sortOrder,
    archived: false,
    uninstalled: !assigned,
  }], ['platformSessionId', 'providerId', 'providerPackId'])
}

export function isAutomaticallyAssociated(
  provider: IMStickerProvider,
  pack: IMStickerPackSummary,
  targetPlatformId: string,
): boolean {
  return pack.automaticAssociation === 'provider-account'
    && provider.capabilities?.ownerPlatformId === targetPlatformId
}

export function providerBelongsToAccount(
  provider: IMStickerProvider,
  targetPlatformId: string,
  targetPlatformKind: string,
): boolean {
  const owner = provider.capabilities?.ownerPlatformId
  if (owner) return owner === targetPlatformId
  const kinds = provider.capabilities?.platformKinds
  return !kinds?.length || kinds.includes(targetPlatformKind)
}

function sourceAccount(
  provider: IMStickerProvider,
  accounts: StickerDashboardSourceAccount[],
): StickerDashboardSourceAccount | undefined {
  const owner = provider.capabilities?.ownerPlatformId
  if (owner) return accounts.find((account) => account.view.platformId === owner)
  const kinds = provider.capabilities?.platformKinds
  return accounts.find((account) => !kinds?.length || kinds.includes(account.view.platformKind))
}

function providerContext(account: StickerDashboardSourceAccount): StickerProviderContext {
  return { session: account.session, platformKind: account.view.platformKind }
}

async function listEveryPack(
  provider: IMStickerProvider,
  context: StickerProviderContext,
): Promise<IMStickerPackSummary[]> {
  const result: IMStickerPackSummary[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = await provider.listPacks(context, { cursor, limit: 200 })
    result.push(...response.packs)
    if (!response.nextCursor) return result
    if (seen.has(response.nextCursor)) throw new Error(`sticker pack pagination repeated cursor: ${response.nextCursor}`)
    seen.add(response.nextCursor)
    cursor = response.nextCursor
  }
  throw new Error('sticker pack pagination exceeded 100 pages')
}

function assignmentKey(platformSessionId: string, providerId: string, packId: string): string {
  return JSON.stringify([platformSessionId, providerId, packId])
}
