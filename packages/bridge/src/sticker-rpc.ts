import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { stableId } from './dialogs.js'
import { telegramStickerPlaceholder } from './sticker-outline.js'
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

const STICKER_PROJECTION_VERSION = 5
const STICKER_PROVIDER_CACHE_TTL_MS = 5 * 60_000
// Telegram Desktop ignores every document field when date is zero, leaving a
// zero-byte generic file. Keep synthetic sticker documents on a stable,
// non-zero epoch so they are parsed as stickers and remain cacheable.
const STICKER_DOCUMENT_DATE = 1_700_000_000

export class StickerRpc {
  private readonly _documents = new Map<number, ResolvedSticker>()
  private readonly _sets = new Map<number, { providerId: string, packId: string }>()
  private readonly _providerCache = new Map<string, {
    expiresAt: number
    value: Promise<unknown>
  }>()

  constructor(
    private readonly _database: Database,
    private readonly _registry: StickerProviderRegistry,
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _dcId = 1,
    private readonly _providerCacheTtlMs = STICKER_PROVIDER_CACHE_TTL_MS,
  ) {}

  async getAllStickers(req: tl.messages.RawGetAllStickersRequest): Promise<tl.messages.TypeAllStickers> {
    const packs = await this._listPacks()
    const installed = await this._installedPacks()
    packs.sort((left, right) => {
      const a = installed.get(packKey(left.pack.providerId, left.pack.packId))
      const b = installed.get(packKey(right.pack.providerId, right.pack.packId))
      if (!!a !== !!b) return a ? -1 : 1
      if (a && b) return a.sortOrder - b.sortOrder
      return 0
    })
    const hash = Long.fromNumber(catalogHash(
      packs.map(({ pack }) => `${pack.providerId}:${pack.packId}:${pack.version ?? 0}`),
    ))
    if (hashMatches(req.hash, hash)) return { _: 'messages.allStickersNotModified' }
    return {
      _: 'messages.allStickers',
      hash,
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
    const ref = await this._resolveSet(req.stickerset)
    const provider = this._registry.require(ref.providerId)
    const pack = await this._getPack(ref.providerId, provider, ref.packId)
    if (!pack) throw new RpcError(400, 'STICKERSET_INVALID')
    const normalized = pack
    const hash = catalogHash(normalized.stickers.map((sticker) => `${sticker.stickerId}:${sticker.version ?? 0}`))
    if (hashMatches(req.hash, hash)) return { _: 'messages.stickerSetNotModified' }
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

  async saveRecentSticker(req: tl.messages.RawSaveRecentStickerRequest): Promise<tl.TlObject> {
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
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async clearRecentStickers(req: tl.messages.RawClearRecentStickersRequest): Promise<tl.TlObject> {
    await this._database.remove('mtproto_sticker_recent', {
      platformSessionId: this._session.platformSessionId,
      attached: req.attached ?? false,
    })
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async getFavedStickers(req: tl.messages.RawGetFavedStickersRequest): Promise<tl.messages.TypeFavedStickers> {
    const rows = await this._database.select('mtproto_sticker_favorite', {
      platformSessionId: this._session.platformSessionId,
    }).orderBy('createdAt', 'desc').limit(200).execute()
    const local = await this._resolveRows(rows)
    const provided = await this._providerSavedStickers()
    const resolved = uniqueResolved([...local, ...provided])
    for (const item of resolved) {
      this._documents.set(this._documentId(item.providerId, item.sticker.stickerId), item)
    }
    const hash = Long.fromNumber(catalogHash(resolved.map((item) =>
      `${item.providerId}:${item.sticker.stickerId}:${item.sticker.version ?? 0}`)))
    if (hashMatches(req.hash, hash)) return { _: 'messages.favedStickersNotModified' }
    return {
      _: 'messages.favedStickers',
      hash,
      packs: stickerPacks(resolved),
      stickers: resolved.map((item) => this._makeDocument(item)),
    }
  }

  async faveSticker(req: tl.messages.RawFaveStickerRequest): Promise<tl.TlObject> {
    const resolved = await this._resolveInputDocument(req.id)
    await resolved.provider.setSavedSticker?.(this._context(), resolved.sticker, !req.unfave)
    this._providerCache.delete('saved')
    const query = {
      platformSessionId: this._session.platformSessionId,
      providerId: resolved.providerId,
      providerStickerId: resolved.sticker.stickerId,
    }
    if (req.unfave) await this._database.remove('mtproto_sticker_favorite', query)
    else await this._database.upsert('mtproto_sticker_favorite', [{ ...query, createdAt: new Date() }], [
      'platformSessionId', 'providerId', 'providerStickerId',
    ])
    return { _: 'boolTrue' } as unknown as tl.TlObject
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

  async uninstallStickerSet(req: tl.messages.RawUninstallStickerSetRequest): Promise<tl.TlObject> {
    const ref = await this._resolveSet(req.stickerset)
    await this._database.remove('mtproto_sticker_set_install', {
      platformSessionId: this._session.platformSessionId,
      providerId: ref.providerId,
      providerPackId: ref.packId,
    })
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async reorderStickerSets(req: tl.messages.RawReorderStickerSetsRequest): Promise<tl.TlObject> {
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
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async toggleStickerSets(req: tl.messages.RawToggleStickerSetsRequest): Promise<tl.TlObject> {
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
    return { _: 'boolTrue' } as unknown as tl.TlObject
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
    }], ['platformSessionId', 'providerId', 'providerStickerId', 'attached'] as any)
  }

  private async markUsed(resolved: ResolvedSticker, attached = false): Promise<void> {
    await this.markUsedByRef(resolved.providerId, resolved.sticker.stickerId, attached)
  }

  async getFile(
    documentId: number,
    offset: number,
    limit: number,
    fileReference?: Uint8Array,
    thumbSize?: string,
  ): Promise<Uint8Array | undefined> {
    const resolved = await this._resolveDocument(documentId, fileReference)
    if (!resolved) return
    const asset = thumbSize
      ? await resolved.provider.openThumbnail?.(this._context(), resolved.sticker)
      : await resolved.provider.openAsset(this._context(), resolved.sticker)
    if (!asset) return
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
    const pack = await this._getPack(ref.providerId, provider, ref.packId)
    const sticker = pack && packCover(pack)
    if (!sticker) return
    const normalized = { ...sticker, providerId: ref.providerId }
    const asset = await provider.openThumbnail?.(this._context(), normalized)
      ?? await provider.openAsset(this._context(), normalized)
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
    return this._cached('catalog', async () => {
      const result: Array<{ providerId: string, provider: IMStickerProvider, pack: IMStickerPack }> = []
      for (const [providerId, provider] of this._activeProviders()) {
        const page = await provider.listPacks(this._context(), { limit: 200 })
        for (const summary of page.packs) {
          const pack = await this._getPack(providerId, provider, summary.packId)
          if (pack) result.push({ providerId, provider, pack })
        }
      }
      return result
    })
  }

  private async _getPack(
    providerId: string,
    provider: IMStickerProvider,
    packId: string,
  ): Promise<IMStickerPack | null> {
    const pack = await this._cached(`pack:${packKey(providerId, packId)}`, async () => {
      const loaded = await provider.getPack(this._context(), packId)
      return loaded ? normalizePack(providerId, loaded) : null
    })
    if (pack) this._rememberPack(providerId, provider, pack)
    return pack
  }

  private _rememberPack(providerId: string, provider: IMStickerProvider, pack: IMStickerPack): void {
    this._sets.set(this._setId(providerId, pack.packId), { providerId, packId: pack.packId })
    for (const sticker of pack.stickers) {
      this._documents.set(this._documentId(providerId, sticker.stickerId), {
        providerId, provider, sticker,
      })
    }
  }

  private async _cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this._providerCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value as Promise<T>
    const value = load()
    const entry = { expiresAt: Date.now() + this._providerCacheTtlMs, value }
    this._providerCache.set(key, entry)
    try {
      return await value
    } catch (error) {
      if (this._providerCache.get(key) === entry) this._providerCache.delete(key)
      throw error
    }
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
      const packs = await this._listPacks()
      for (const item of packs) {
        if (item.providerId !== providerId) continue
        for (const sticker of item.pack.stickers) {
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

  private async _resolveDocument(
    id: number,
    fileReference?: Uint8Array,
  ): Promise<ResolvedSticker | undefined> {
    let resolved = this._documents.get(id)
    if (resolved) return resolved
    resolved = await this._resolveDocumentReference(id, fileReference)
    if (resolved) return resolved
    await this._listPacks()
    resolved = this._documents.get(id)
    if (!resolved) {
      const saved = await this._providerSavedStickers()
      resolved = saved.find((item) => this._documentId(item.providerId, item.sticker.stickerId) === id)
    }
    return resolved
  }

  private async _resolveDocumentReference(
    id: number,
    fileReference?: Uint8Array,
  ): Promise<ResolvedSticker | undefined> {
    if (!fileReference?.byteLength) return
    let reference: string
    try {
      reference = new TextDecoder('utf-8', { fatal: true }).decode(fileReference)
    } catch {
      return
    }
    const prefix = 'bridge-sticker:'
    if (!reference.startsWith(prefix)) return
    const body = reference.slice(prefix.length)
    for (const [providerId, provider] of [...this._activeProviders()]
      .sort(([left], [right]) => right.length - left.length)) {
      const providerPrefix = `${providerId}:`
      if (!body.startsWith(providerPrefix)) continue
      const versionSeparator = body.lastIndexOf(':')
      if (versionSeparator < providerPrefix.length || !/^\d+$/.test(body.slice(versionSeparator + 1))) {
        return
      }
      const stickerId = body.slice(providerPrefix.length, versionSeparator)
      if (!stickerId || this._documentId(providerId, stickerId) !== id) return
      const sticker = await provider.getSticker(this._context(), stickerId)
      if (!sticker || sticker.stickerId !== stickerId) return
      const resolved = { providerId, provider, sticker: { ...sticker, providerId } }
      this._documents.set(id, resolved)
      return resolved
    }
  }

  private _makeSet(
    pack: IMStickerPack,
    installed?: import('./models.js').StickerSetInstallRow,
  ): tl.RawStickerSet {
    const id = this._setId(pack.providerId, pack.packId)
    const cover = packCover(pack)
    const coverMetadata = cover?.thumbnail ?? cover
    this._sets.set(id, { providerId: pack.providerId, packId: pack.packId })
    return {
      _: 'stickerSet',
      installedDate: installed && !installed.archived
        ? Math.floor(installed.installedAt.getTime() / 1000)
        : undefined,
      archived: installed?.archived || undefined,
      id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
      title: pack.title, shortName: this._shortName(pack), count: pack.stickers.length,
      thumbs: cover && coverMetadata ? [{
        _: 'photoSize', type: 'm',
        w: coverMetadata.width ?? 100,
        h: coverMetadata.height ?? 100,
        size: Math.min(coverMetadata.size ?? 0, 0x7fffffff),
      }] : undefined,
      thumbDcId: cover ? this._dcId : undefined,
      thumbVersion: cover ? STICKER_PROJECTION_VERSION : undefined,
      thumbDocumentId: cover
        ? Long.fromNumber(this._documentId(pack.providerId, cover.stickerId))
        : undefined,
      hash: catalogHash(pack.stickers.map((sticker) => `${sticker.stickerId}:${sticker.version ?? 0}`)),
    }
  }

  private _makeDocument(item: ResolvedSticker): tl.RawDocument {
    const { sticker } = item
    const id = this._documentId(item.providerId, sticker.stickerId)
    this._documents.set(id, item)
    if (sticker.packId) {
      this._sets.set(this._setId(item.providerId, sticker.packId), {
        providerId: item.providerId,
        packId: sticker.packId,
      })
    }
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
      // photoPathSize is Telegram's inline sticker silhouette. Desktop paints
      // a moving gradient through it before either thumbnail or asset arrives.
      thumbs: [{
        _: 'photoPathSize', type: 'j',
        bytes: sticker.outline ?? telegramStickerPlaceholder(sticker.width ?? 512, sticker.height ?? 512),
      }, ...(sticker.thumbnail ? [{
        _: 'photoSize' as const, type: 'm', w: sticker.thumbnail.width, h: sticker.thumbnail.height,
        size: Math.min(sticker.thumbnail.size, 0x7fffffff),
      }] : [])],
      dcId: this._dcId, attributes,
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
    if (input._ === 'inputStickerSetID') {
      const ref = this._sets.get(input.id.toNumber())
      if (ref) return ref
    }
    const packs = await this._listPacks()
    if (input._ === 'inputStickerSetID') {
      const ref = this._sets.get(input.id.toNumber())
      if (ref) return ref
    } else if (input._ === 'inputStickerSetShortName') {
      const found = packs.find(({ pack }) => this._shortName(pack) === input.shortName)
      if (found) return { providerId: found.providerId, packId: found.pack.packId }
    }
    throw new RpcError(400, 'STICKERSET_INVALID')
  }

  private async _providerSavedStickers(): Promise<ResolvedSticker[]> {
    return this._cached('saved', async () => {
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
    })
  }
}

function normalizePack(providerId: string, pack: IMStickerPack): IMStickerPack {
  return {
    ...pack,
    providerId,
    cover: pack.cover && { ...pack.cover, providerId },
    stickers: pack.stickers.map((sticker) => ({ ...sticker, providerId, packId: pack.packId })),
  }
}

function packCover(pack: IMStickerPack): IMSticker | undefined {
  const cover = pack.cover
  if (!cover) return pack.stickers[0]
  return pack.stickers.find((sticker) =>
    sticker.providerId === cover.providerId && sticker.stickerId === cover.stickerId)
    ?? pack.stickers[0]
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

function hashMatches(input: number | Long, hash: number | Long): boolean {
  const inputLong = Long.isLong(input) ? input : Long.fromNumber(input)
  const hashLong = Long.isLong(hash) ? hash : Long.fromNumber(hash)
  return !inputLong.isZero() && inputLong.equals(hashLong)
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
