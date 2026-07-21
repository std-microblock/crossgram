import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { stableId } from './dialogs.js'
import type { IMPlatform, PlatformSession } from './platform.js'
import type {
  IMSticker, IMStickerAsset, IMStickerPack, IMStickerProvider, IMStickerSendPlan,
  StickerProviderContext, StickerProviderRegistry,
} from './sticker-provider.js'

interface ResolvedSticker {
  providerId: string
  provider: IMStickerProvider
  sticker: IMSticker
}

const STICKER_PROJECTION_VERSION = 3
// Telegram Desktop ignores every document field when date is zero, leaving a
// zero-byte generic file. Keep synthetic sticker documents on a stable,
// non-zero epoch so they are parsed as stickers and remain cacheable.
const STICKER_DOCUMENT_DATE = 1_700_000_000

export class StickerRpc {
  private readonly _documents = new Map<number, ResolvedSticker>()
  private readonly _sets = new Map<number, { providerId: string, packId: string }>()

  constructor(
    private readonly _database: Database,
    private readonly _registry: StickerProviderRegistry,
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _dcId = 1,
  ) {}

  async getAllStickers(_req: tl.messages.RawGetAllStickersRequest): Promise<tl.messages.TypeAllStickers> {
    const packs = await this._listPacks()
    const installed = await this._installedPacks()
    packs.sort((left, right) => {
      const a = installed.get(packKey(left.pack.providerId, left.pack.packId))
      const b = installed.get(packKey(right.pack.providerId, right.pack.packId))
      if (!!a !== !!b) return a ? -1 : 1
      if (a && b) return a.sortOrder - b.sortOrder
      return 0
    })
    return {
      _: 'messages.allStickers',
      hash: Long.fromNumber(catalogHash(packs.map(({ pack }) => `${pack.providerId}:${pack.packId}:${pack.version ?? 0}`))),
      sets: packs.map(({ pack }) => this._makeSet(pack, installed.get(packKey(pack.providerId, pack.packId)))),
    }
  }

  async getStickerSet(req: tl.messages.RawGetStickerSetRequest): Promise<tl.messages.TypeStickerSet> {
    if (req.stickerset._ === 'inputStickerSetAnimatedEmoji'
      || req.stickerset._ === 'inputStickerSetDice'
      || req.stickerset._ === 'inputStickerSetEmojiDefaultStatuses'
      || req.stickerset._ === 'inputStickerSetEmojiDefaultTopicIcons') {
      return { _: 'messages.stickerSetNotModified' }
    }
    await this._listPacks()
    let ref: { providerId: string, packId: string } | undefined
    if (req.stickerset._ === 'inputStickerSetID') ref = this._sets.get(req.stickerset.id.toNumber())
    if (req.stickerset._ === 'inputStickerSetShortName') {
      const packs = await this._listPacks()
      const found = packs.find(({ pack }) => this._shortName(pack) === req.stickerset.shortName)
      if (found) ref = { providerId: found.providerId, packId: found.pack.packId }
    }
    if (!ref) throw new RpcError(400, 'STICKERSET_INVALID')
    const provider = this._registry.require(ref.providerId)
    const pack = await provider.getPack(this._context(), ref.packId)
    if (!pack) throw new RpcError(400, 'STICKERSET_INVALID')
    const normalized = normalizePack(ref.providerId, pack)
    const installed = (await this._installedPacks()).get(packKey(ref.providerId, ref.packId))
    const documents = normalized.stickers.map((sticker) => this._makeDocument({
      providerId: ref.providerId, provider, sticker,
    }))
    const byEmoji = new Map<string, Long[]>()
    for (const sticker of normalized.stickers) {
      for (const emoji of sticker.emoji ?? ['']) {
        const list = byEmoji.get(emoji) ?? []
        list.push(Long.fromNumber(this._documentId(sticker.providerId, sticker.stickerId)))
        byEmoji.set(emoji, list)
      }
    }
    return {
      _: 'messages.stickerSet',
      set: this._makeSet(normalized, installed),
      packs: [...byEmoji].map(([emoticon, documents]) => ({ _: 'stickerPack', emoticon, documents })),
      keywords: [],
      documents,
    }
  }

  async getStickers(req: tl.messages.RawGetStickersRequest): Promise<tl.messages.TypeStickers> {
    const resolved = await this._search(req.emoticon)
    return {
      _: 'messages.stickers',
      hash: Long.fromNumber(catalogHash(resolved.map((item) => `${item.providerId}:${item.sticker.stickerId}`))),
      stickers: resolved.map((item) => this._makeDocument(item)),
    }
  }

  async getRecentStickers(req: tl.messages.RawGetRecentStickersRequest): Promise<tl.messages.TypeRecentStickers> {
    const rows = await this._database.select('mtproto_sticker_recent', {
      platformSessionId: this._session.platformSessionId,
      attached: req.attached ?? false,
    }).orderBy('lastUsedAt', 'desc').limit(200).execute()
    const resolved = await this._resolveRows(rows)
    return {
      _: 'messages.recentStickers',
      hash: Long.fromNumber(catalogHash(rows.map((row) => `${row.providerId}:${row.providerStickerId}:${row.useCount}`))),
      packs: stickerPacks(resolved),
      stickers: resolved.map((item) => this._makeDocument(item)),
      dates: resolved.map((_, index) => Math.floor(rows[index]!.lastUsedAt.getTime() / 1000)),
    }
  }

  async saveRecentSticker(req: tl.messages.RawSaveRecentStickerRequest): Promise<tl.RawBool> {
    const resolved = await this._resolveInputDocument(req.id)
    if (req.unsave) {
      await this._database.remove('mtproto_sticker_recent', {
        platformSessionId: this._session.platformSessionId,
        providerId: resolved.providerId,
        providerStickerId: resolved.sticker.stickerId,
        attached: req.attached ?? false,
      })
    } else {
      await this.markUsed(resolved, req.attached ?? false)
    }
    return { _: 'boolTrue' }
  }

  async clearRecentStickers(req: tl.messages.RawClearRecentStickersRequest): Promise<tl.RawBool> {
    await this._database.remove('mtproto_sticker_recent', {
      platformSessionId: this._session.platformSessionId,
      attached: req.attached ?? false,
    })
    return { _: 'boolTrue' }
  }

  async getFavedStickers(_req: tl.messages.RawGetFavedStickersRequest): Promise<tl.messages.TypeFavedStickers> {
    const rows = await this._database.select('mtproto_sticker_favorite', {
      platformSessionId: this._session.platformSessionId,
    }).orderBy('createdAt', 'desc').limit(200).execute()
    const local = await this._resolveRows(rows)
    const provided = await this._providerSavedStickers()
    const resolved = uniqueResolved([...local, ...provided])
    return {
      _: 'messages.favedStickers',
      hash: Long.fromNumber(catalogHash(resolved.map((item) =>
        `${item.providerId}:${item.sticker.stickerId}:${item.sticker.version ?? 0}`))),
      packs: stickerPacks(resolved),
      stickers: resolved.map((item) => this._makeDocument(item)),
    }
  }

  async faveSticker(req: tl.messages.RawFaveStickerRequest): Promise<tl.RawBool> {
    const resolved = await this._resolveInputDocument(req.id)
    const query = {
      platformSessionId: this._session.platformSessionId,
      providerId: resolved.providerId,
      providerStickerId: resolved.sticker.stickerId,
    }
    if (req.unfave) await this._database.remove('mtproto_sticker_favorite', query)
    else await this._database.upsert('mtproto_sticker_favorite', [{ ...query, createdAt: new Date() }], [
      'platformSessionId', 'providerId', 'providerStickerId',
    ])
    return { _: 'boolTrue' }
  }

  async installStickerSet(
    req: tl.messages.RawInstallStickerSetRequest,
  ): Promise<tl.messages.RawStickerSetInstallResultSuccess> {
    const ref = await this._resolveSet(req.stickerset)
    const rows = await this._database.get('mtproto_sticker_set_install', {
      platformSessionId: this._session.platformSessionId,
    })
    const maxOrder = rows.reduce((value, row) => Math.max(value, row.sortOrder), -1)
    await this._database.upsert('mtproto_sticker_set_install', [{
      platformSessionId: this._session.platformSessionId,
      providerId: ref.providerId,
      providerPackId: ref.packId,
      installedAt: new Date(),
      sortOrder: maxOrder + 1,
      archived: req.archived,
    }], ['platformSessionId', 'providerId', 'providerPackId'])
    return { _: 'messages.stickerSetInstallResultSuccess' }
  }

  async uninstallStickerSet(req: tl.messages.RawUninstallStickerSetRequest): Promise<tl.RawBool> {
    const ref = await this._resolveSet(req.stickerset)
    await this._database.remove('mtproto_sticker_set_install', {
      platformSessionId: this._session.platformSessionId,
      providerId: ref.providerId,
      providerPackId: ref.packId,
    })
    return { _: 'boolTrue' }
  }

  async reorderStickerSets(req: tl.messages.RawReorderStickerSetsRequest): Promise<tl.RawBool> {
    await this._listPacks()
    for (const [sortOrder, id] of req.order.entries()) {
      const ref = this._sets.get(id.toNumber())
      if (!ref) continue
      await this._database.set('mtproto_sticker_set_install', {
        platformSessionId: this._session.platformSessionId,
        providerId: ref.providerId,
        providerPackId: ref.packId,
      }, { sortOrder })
    }
    return { _: 'boolTrue' }
  }

  async toggleStickerSets(req: tl.messages.RawToggleStickerSetsRequest): Promise<tl.RawBool> {
    for (const input of req.stickersets) {
      const ref = await this._resolveSet(input)
      const query = {
        platformSessionId: this._session.platformSessionId,
        providerId: ref.providerId,
        providerPackId: ref.packId,
      }
      if (req.uninstall) {
        await this._database.remove('mtproto_sticker_set_install', query)
      } else {
        const [existing] = await this._database.get('mtproto_sticker_set_install', query)
        await this._database.upsert('mtproto_sticker_set_install', [{
          ...query,
          installedAt: existing?.installedAt ?? new Date(),
          sortOrder: existing?.sortOrder ?? 0,
          archived: req.archive ? true : req.unarchive ? false : existing?.archived ?? false,
        }], ['platformSessionId', 'providerId', 'providerPackId'])
      }
    }
    return { _: 'boolTrue' }
  }

  async resolveSend(id: tl.TypeInputDocument): Promise<{
    providerId: string
    stickerId: string
    plan: IMStickerSendPlan
  } | undefined> {
    if (id._ !== 'inputDocument') return
    const resolved = await this._resolveInputDocument(id).catch(() => undefined)
    if (!resolved) return
    const context = this._context()
    let plan = await resolved.provider.prepareSend?.(context, resolved.sticker)
    if (!plan) {
      const asset = await resolved.provider.openAsset(context, resolved.sticker)
      plan = uploadPlan(resolved, asset)
    }
    return { providerId: resolved.providerId, stickerId: resolved.sticker.stickerId, plan }
  }

  async markUsedByRef(providerId: string, stickerId: string, attached = false): Promise<void> {
    const query = {
      platformSessionId: this._session.platformSessionId,
      providerId,
      providerStickerId: stickerId,
      attached,
    }
    const [existing] = await this._database.get('mtproto_sticker_recent', query)
    await this._database.upsert('mtproto_sticker_recent', [{
      ...query, useCount: (existing?.useCount ?? 0) + 1, lastUsedAt: new Date(),
    }], ['platformSessionId', 'providerId', 'providerStickerId', 'attached'])
  }

  private async markUsed(resolved: ResolvedSticker, attached = false): Promise<void> {
    await this.markUsedByRef(resolved.providerId, resolved.sticker.stickerId, attached)
  }

  async getFile(documentId: number, offset: number, limit: number): Promise<Uint8Array | undefined> {
    const resolved = await this._resolveDocument(documentId)
    if (!resolved) return
    const asset = await resolved.provider.openAsset(this._context(), resolved.sticker)
    const chunks: Uint8Array[] = []
    let skipped = 0
    let size = 0
    for await (const chunk of asset.source.stream()) {
      if (skipped + chunk.length <= offset) {
        skipped += chunk.length
        continue
      }
      const start = Math.max(0, offset - skipped)
      const accepted = chunk.subarray(start, start + Math.max(0, limit - size))
      chunks.push(accepted)
      size += accepted.length
      skipped += chunk.length
      if (size >= limit) break
    }
    const output = new Uint8Array(size)
    let position = 0
    for (const chunk of chunks) {
      output.set(chunk, position)
      position += chunk.length
    }
    return output
  }

  async getSetThumb(
    input: tl.TypeInputStickerSet,
    offset: number,
    limit: number,
  ): Promise<Uint8Array | undefined> {
    const ref = await this._resolveSet(input).catch(() => undefined)
    if (!ref) return
    const provider = this._registry.get(ref.providerId)
    if (!provider) return
    const pack = await provider.getPack(this._context(), ref.packId)
    const sticker = pack?.stickers[0]
    if (!sticker) return
    const asset = await provider.openAsset(this._context(), { ...sticker, providerId: ref.providerId })
    return readAssetRange(asset, offset, limit)
  }

  makeMessageMedia(sticker: IMSticker, providerId = sticker.providerId): tl.RawMessageMediaDocument {
    const provider = this._registry.get(providerId)
    if (provider) this._documents.set(this._documentId(providerId, sticker.stickerId), {
      providerId, provider, sticker: { ...sticker, providerId },
    })
    return { _: 'messageMediaDocument', document: this._makeDocument({
      providerId, provider: provider ?? missingProvider(), sticker: { ...sticker, providerId },
    }) }
  }

  private async _listPacks(): Promise<Array<{ providerId: string, provider: IMStickerProvider, pack: IMStickerPack }>> {
    const result: Array<{ providerId: string, provider: IMStickerProvider, pack: IMStickerPack }> = []
    for (const [providerId, provider] of this._activeProviders()) {
      const page = await provider.listPacks(this._context(), { limit: 200 })
      for (const summary of page.packs) {
        const pack = await provider.getPack(this._context(), summary.packId)
        if (!pack) continue
        const normalized = normalizePack(providerId, pack)
        result.push({ providerId, provider, pack: normalized })
        this._sets.set(this._setId(providerId, normalized.packId), {
          providerId, packId: normalized.packId,
        })
        for (const sticker of normalized.stickers) {
          this._documents.set(this._documentId(providerId, sticker.stickerId), {
            providerId, provider, sticker,
          })
        }
      }
    }
    return result
  }

  private async _search(emoji: string): Promise<ResolvedSticker[]> {
    const result: ResolvedSticker[] = []
    for (const [providerId, provider] of this._activeProviders()) {
      if (provider.search) {
        const page = await provider.search(this._context(), { emoji, limit: 100 })
        result.push(...page.stickers.map((sticker) => ({
          providerId, provider, sticker: { ...sticker, providerId },
        })))
        continue
      }
      const packs = await provider.listPacks(this._context(), { limit: 200 })
      for (const summary of packs.packs) {
        const pack = await provider.getPack(this._context(), summary.packId)
        for (const sticker of pack?.stickers ?? []) {
          if (!emoji || sticker.emoji?.includes(emoji)) {
            result.push({ providerId, provider, sticker: { ...sticker, providerId } })
          }
        }
      }
    }
    for (const item of result) this._documents.set(
      this._documentId(item.providerId, item.sticker.stickerId), item,
    )
    return result
  }

  private async _resolveRows(rows: Array<{ providerId: string, providerStickerId: string }>): Promise<ResolvedSticker[]> {
    const result: ResolvedSticker[] = []
    for (const row of rows) {
      const provider = this._registry.get(row.providerId)
      if (!provider || !this._isActive(provider)) continue
      const sticker = await provider.getSticker(this._context(), row.providerStickerId)
      if (sticker) result.push({ providerId: row.providerId, provider, sticker: { ...sticker, providerId: row.providerId } })
    }
    return result
  }

  private async _resolveInputDocument(input: tl.TypeInputDocument): Promise<ResolvedSticker> {
    if (input._ !== 'inputDocument') throw new RpcError(400, 'DOCUMENT_INVALID')
    const resolved = await this._resolveDocument(input.id.toNumber())
    if (!resolved) throw new RpcError(400, 'DOCUMENT_INVALID')
    return resolved
  }

  private async _resolveDocument(id: number): Promise<ResolvedSticker | undefined> {
    let resolved = this._documents.get(id)
    if (resolved) return resolved
    await this._listPacks()
    resolved = this._documents.get(id)
    if (!resolved) {
      const saved = await this._providerSavedStickers()
      resolved = saved.find((item) => this._documentId(item.providerId, item.sticker.stickerId) === id)
    }
    return resolved
  }

  private _makeSet(
    pack: IMStickerPack,
    installed?: import('./models.js').StickerSetInstallRow,
  ): tl.RawStickerSet {
    const id = this._setId(pack.providerId, pack.packId)
    this._sets.set(id, { providerId: pack.providerId, packId: pack.packId })
    return {
      _: 'stickerSet',
      installedDate: installed && !installed.archived
        ? Math.floor(installed.installedAt.getTime() / 1000)
        : undefined,
      archived: installed?.archived || undefined,
      id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
      title: pack.title, shortName: this._shortName(pack), count: pack.stickers.length,
      thumbs: pack.stickers[0] ? [{
        _: 'photoSize', type: 'm',
        w: pack.stickers[0].width ?? 100,
        h: pack.stickers[0].height ?? 100,
        size: Math.min(pack.stickers[0].size ?? 0, 0x7fffffff),
      }] : undefined,
      thumbDcId: pack.stickers[0] ? this._dcId : undefined,
      thumbVersion: pack.stickers[0] ? STICKER_PROJECTION_VERSION : undefined,
      thumbDocumentId: pack.stickers[0]
        ? Long.fromNumber(this._documentId(pack.providerId, pack.stickers[0].stickerId))
        : undefined,
      hash: catalogHash(pack.stickers.map((sticker) => `${sticker.stickerId}:${sticker.version ?? 0}`)),
    }
  }

  private _makeDocument(item: ResolvedSticker): tl.RawDocument {
    const { sticker } = item
    const id = this._documentId(item.providerId, sticker.stickerId)
    this._documents.set(id, item)
    const attributes: tl.TypeDocumentAttribute[] = [{
      _: 'documentAttributeSticker',
      alt: sticker.emoji?.[0] ?? '',
      stickerset: sticker.packId
        ? {
            _: 'inputStickerSetID',
            id: Long.fromNumber(this._setId(item.providerId, sticker.packId)),
            accessHash: Long.fromNumber(this._setId(item.providerId, sticker.packId)),
          }
        : { _: 'inputStickerSetEmpty' },
    }, {
      _: 'documentAttributeImageSize', w: sticker.width ?? 512, h: sticker.height ?? 512,
    }]
    if (sticker.format === 'animated') attributes.push({ _: 'documentAttributeAnimated' })
    if (sticker.format === 'video') {
      attributes.push({
        _: 'documentAttributeVideo', nosound: true, duration: 0,
        w: sticker.width ?? 512, h: sticker.height ?? 512,
      })
    }
    return {
      _: 'document', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
      fileReference: new TextEncoder().encode(`bridge-sticker:${item.providerId}:${sticker.stickerId}:${sticker.version ?? 0}`),
      date: STICKER_DOCUMENT_DATE, mimeType: sticker.mimeType, size: sticker.size ?? 0,
      thumbs: [], dcId: this._dcId, attributes,
    }
  }

  private _activeProviders(): Array<[string, IMStickerProvider]> {
    return this._registry.entries.filter(([, provider]) => this._isActive(provider))
  }

  private _isActive(provider: IMStickerProvider): boolean {
    const kinds = provider.capabilities?.platformKinds
    return !kinds?.length || kinds.includes(this._platform.platformKind ?? this._session.platformId)
  }

  private _context(): StickerProviderContext {
    return {
      session: this._session,
      platformKind: this._platform.platformKind ?? this._session.platformId,
    }
  }

  private _setId(providerId: string, packId: string): number {
    return stableId(`sticker-set:v${STICKER_PROJECTION_VERSION}:${providerId}:${packId}`)
  }

  private _documentId(providerId: string, stickerId: string): number {
    return stableId(`sticker-document:v${STICKER_PROJECTION_VERSION}:${providerId}:${stickerId}`)
  }

  private _shortName(pack: IMStickerPack): string {
    return pack.shortName ?? `bridge_${this._setId(pack.providerId, pack.packId)}`
  }

  private async _installedPacks() {
    const rows = await this._database.get('mtproto_sticker_set_install', {
      platformSessionId: this._session.platformSessionId,
    })
    return new Map(rows.map((row) => [packKey(row.providerId, row.providerPackId), row]))
  }

  private async _resolveSet(input: tl.TypeInputStickerSet): Promise<{ providerId: string, packId: string }> {
    await this._listPacks()
    if (input._ === 'inputStickerSetID') {
      const ref = this._sets.get(input.id.toNumber())
      if (ref) return ref
    } else if (input._ === 'inputStickerSetShortName') {
      const packs = await this._listPacks()
      const found = packs.find(({ pack }) => this._shortName(pack) === input.shortName)
      if (found) return { providerId: found.providerId, packId: found.pack.packId }
    }
    throw new RpcError(400, 'STICKERSET_INVALID')
  }

  private async _providerSavedStickers(): Promise<ResolvedSticker[]> {
    const result: ResolvedSticker[] = []
    for (const [providerId, provider] of this._activeProviders()) {
      if (!provider.listSavedStickers) continue
      const page = await provider.listSavedStickers(this._context(), { limit: 200 })
      for (const sticker of page.stickers) {
        const resolved = { providerId, provider, sticker: { ...sticker, providerId } }
        this._documents.set(this._documentId(providerId, sticker.stickerId), resolved)
        result.push(resolved)
      }
    }
    return result
  }
}

function normalizePack(providerId: string, pack: IMStickerPack): IMStickerPack {
  return {
    ...pack,
    providerId,
    stickers: pack.stickers.map((sticker) => ({ ...sticker, providerId, packId: pack.packId })),
  }
}

function uploadPlan(resolved: ResolvedSticker, asset: IMStickerAsset): IMStickerSendPlan {
  return {
    type: 'upload', providerId: resolved.providerId, stickerId: resolved.sticker.stickerId,
    packId: resolved.sticker.packId,
    format: resolved.sticker.format, mimeType: asset.mimeType,
    emoji: resolved.sticker.emoji, width: asset.width ?? resolved.sticker.width,
    height: asset.height ?? resolved.sticker.height, source: asset.source,
  }
}

function stickerPacks(items: ResolvedSticker[]): tl.RawStickerPack[] {
  const result = new Map<string, Long[]>()
  for (const item of items) {
    for (const emoji of item.sticker.emoji ?? ['']) {
      const documents = result.get(emoji) ?? []
      documents.push(Long.fromNumber(stableId(
        `sticker-document:v${STICKER_PROJECTION_VERSION}:${item.providerId}:${item.sticker.stickerId}`,
      )))
      result.set(emoji, documents)
    }
  }
  return [...result].map(([emoticon, documents]) => ({ _: 'stickerPack', emoticon, documents }))
}

function catalogHash(values: string[]): number {
  return stableId(values.join('\u0000'))
}

function packKey(providerId: string, packId: string): string {
  return `${providerId}\u0000${packId}`
}

function uniqueResolved(items: ResolvedSticker[]): ResolvedSticker[] {
  return [...new Map(items.map((item) => [
    `${item.providerId}\u0000${item.sticker.stickerId}`,
    item,
  ])).values()]
}

function missingProvider(): IMStickerProvider {
  return {
    async listPacks() { return { packs: [] } },
    async getPack() { return null },
    async getSticker() { return null },
    async openAsset() { throw new Error('sticker provider unavailable') },
  }
}

async function readAssetRange(
  asset: IMStickerAsset,
  offset: number,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let skipped = 0
  let size = 0
  for await (const chunk of asset.source.stream()) {
    if (skipped + chunk.length <= offset) {
      skipped += chunk.length
      continue
    }
    const start = Math.max(0, offset - skipped)
    const accepted = chunk.subarray(start, start + Math.max(0, limit - size))
    chunks.push(accepted)
    size += accepted.length
    skipped += chunk.length
    if (size >= limit) break
  }
  const output = new Uint8Array(size)
  let position = 0
  for (const chunk of chunks) {
    output.set(chunk, position)
    position += chunk.length
  }
  return output
}
