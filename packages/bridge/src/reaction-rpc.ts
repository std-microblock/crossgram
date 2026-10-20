import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { stableId } from './dialogs.js'
import type {
  IMDirectDownload, IMMessage, IMPlatform, IMReactionContext, IMReactionDefinition, IMReactionResource,
  PlatformSession,
} from './platform.js'

const CATALOG_VERSION = 2
const STANDARD_REACTIONS = ['👍', '❤️', '😂', '😢', '🔥', '🎉', '👏', '🤔', '🤯'] as const

interface CustomEntry {
  definition: IMReactionDefinition & { presentation: { type: 'custom', alt: string, resource: IMReactionResource } }
}

interface RecentReaction {
  reactionType: 'emoji' | 'custom'
  reactionValue: string
  /** 自定义表情的平台 key；资源版本升级导致 documentId 变更时用于关联到当前版本。 */
  definitionKey?: string | null
  lastUsedAt: Date
}

export class ReactionRpc {
  private readonly _custom = new Map<number, CustomEntry>()
  /** 兼容旧版按会话维度生成的行内自定义表情 documentId，确保客户端已缓存的旧消息仍能拉取资源。 */
  private readonly _aliases = new Map<number, CustomEntry>()
  private readonly _memoryRecent = new Map<string, RecentReaction>()
  private readonly _currentByKey = new Map<string, number>()
  private _recentWrite = Promise.resolve<unknown>(undefined)

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _dcId = 1,
    private readonly _database?: Database,
  ) {}

  async topReactions(limit: number): Promise<tl.messages.RawReactions> {
    const recent = await this._recentReactions(limit)
    const keys = new Set(recent.map(reactionKey))
    const defaults = STANDARD_REACTIONS
      .map((emoticon) => ({ _: 'reactionEmoji', emoticon }) as tl.RawReactionEmoji)
      .filter((reaction) => !keys.has(reactionKey(reaction)))
    return makeReactionList([...recent, ...defaults].slice(0, Math.max(0, limit)))
  }

  async recentReactions(limit: number): Promise<tl.messages.RawReactions> {
    return makeReactionList(await this._recentReactions(limit))
  }

  /**
   * 记录一次回应使用。
   *
   * `append` 对应 `messages.sendReaction` 的 `add_to_recent`：客户端只在用户从回应面板里
   * 主动挑选时置位。没置位时（双击快速回应、气泡内联条等）只刷新列表里已有的记录，
   * 不把新的回应塞进去，避免最近使用被随手一点的默认回应刷满。
   * @returns 是否改动了列表，调用方据此决定要不要推送 `updateRecentReactions`。
   */
  markUsed(
    conversationId: string,
    definitions: readonly IMReactionDefinition[],
    options: { append?: boolean } = {},
  ): Promise<boolean> {
    if (!definitions.length) return Promise.resolve(false)
    const append = options.append ?? true
    const write = this._recentWrite.then(async () => {
      const existing = await this._recentRows()
      const trackedValues = new Set(existing.map((row) => `${row.reactionType}\u0000${row.reactionValue}`))
      const trackedKeys = new Set(existing.flatMap((row) => (row.definitionKey ? [row.definitionKey] : [])))
      const pending = definitions.map((definition) => ({
        definition,
        reaction: this.toTlReaction(conversationId, definition),
      })).filter(({ definition, reaction }) => {
        if (append) return true
        if (trackedKeys.has(definition.key)) return true
        return reaction._ === 'reactionEmoji'
          ? trackedValues.has(`emoji\u0000${reaction.emoticon}`)
          : reaction._ === 'reactionCustomEmoji'
            && trackedValues.has(`custom\u0000${reaction.documentId.toString()}`)
      })
      if (!pending.length) return false
      let timestamp = existing.reduce(
        (latest, row) => Math.max(latest, new Date(row.lastUsedAt).getTime() + 1),
        Date.now(),
      )
      for (const { definition, reaction } of pending) {
        const recent = serializeReaction(reaction, new Date(timestamp++), definition)
        if (this._database) {
          await this._database.upsert('mtproto_reaction_recent', [{
            platformSessionId: this._session.platformSessionId,
            ...recent,
          }], ['platformSessionId', 'reactionType', 'reactionValue'])
        } else {
          this._memoryRecent.set(reactionKey(reaction), recent)
        }
      }
      return true
    })
    this._recentWrite = write.catch(() => {})
    return write
  }

  async clearRecentReactions(): Promise<void> {
    await this._recentWrite
    if (this._database) {
      await this._database.remove('mtproto_reaction_recent', {
        platformSessionId: this._session.platformSessionId,
      })
    } else {
      this._memoryRecent.clear()
    }
  }

  /**
   * 获取客户端可渲染的最近使用回应。
   *
   * 自定义回应的 documentId 会随资源版本变化。解析顺序是：会话目录里出现过的 key 用当前版本；
   * 否则退回记录自带的历史定义（新设备、服务重启后还没有任何会话目录）；
   * 两者都没有时，目录已知就说明这个回应已经下架，跳过；目录未知则保留原始 id 交给客户端缓存处理。
   */
  private async _recentReactions(limit: number): Promise<tl.TypeReaction[]> {
    if (limit <= 0) return []
    await this._recentWrite
    const rows = await this._recentRows()
    const catalogKnown = this._currentByKey.size > 0
    const seen = new Set<string>()
    const seenKeys = new Set<string>()
    const reactions: tl.TypeReaction[] = []
    for (const row of rows) {
      if (reactions.length >= limit) break
      let reaction: tl.TypeReaction
      if (row.reactionType === 'emoji') {
        reaction = { _: 'reactionEmoji', emoticon: row.reactionValue }
      } else {
        const resolved = this._recentDocumentId(row, catalogKnown)
        if (resolved === undefined) continue
        // 同一个 key 的不同资源版本会留下多行，按最近时间保留一条。
        if (row.definitionKey) {
          if (seenKeys.has(row.definitionKey)) continue
          seenKeys.add(row.definitionKey)
        }
        reaction = { _: 'reactionCustomEmoji', documentId: Long.fromNumber(resolved) }
      }
      const key = reactionKey(reaction)
      if (seen.has(key)) continue
      seen.add(key)
      reactions.push(reaction)
    }
    return reactions
  }

  private _recentDocumentId(row: RecentReaction, catalogKnown: boolean): number | undefined {
    const id = Number(row.reactionValue)
    if (catalogKnown) {
      const current = this._currentDocumentId(id, row.definitionKey)
      if (current !== undefined) return current
    }
    if (this._custom.has(id)) return id
    return catalogKnown ? undefined : id
  }

  /** 把定义登记为可渲染的自定义表情，返回它对应的 documentId。 */
  private _remember(definition: IMReactionDefinition): number | undefined {
    if (definition.presentation.type !== 'custom') return undefined
    const id = this.customDocumentId(definition)
    this._custom.set(id, { definition: definition as CustomEntry['definition'] })
    return id
  }

  private _currentDocumentId(id: number, definitionKey?: string | null): number | undefined {
    const key = definitionKey ?? this._entry(id)?.definition.key
    if (key !== undefined) return this._currentByKey.get(key)
    return this._custom.has(id) ? id : undefined
  }

  private async _recentRows(limit?: number): Promise<RecentReaction[]> {
    if (!this._database) {
      return [...this._memoryRecent.values()]
        .sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime())
        .slice(0, limit)
    }
    let query = this._database.select('mtproto_reaction_recent', {
      platformSessionId: this._session.platformSessionId,
    }).orderBy('lastUsedAt', 'desc')
    if (limit !== undefined) query = query.limit(limit)
    return await query.execute()
  }

  registerContext(_conversationId: string, context?: IMReactionContext): void {
    for (const definition of context?.available ?? []) this._remember(definition)
  }

  private _registerCatalog(conversationId: string, context?: IMReactionContext): void {
    this.registerContext(conversationId, context)
    for (const definition of context?.available ?? []) {
      if (definition.presentation.type !== 'custom') continue
      this._currentByKey.set(definition.key, this.customDocumentId(definition))
    }
  }

  /** 注册行内自定义表情并返回规范 documentId，同时保留旧版按会话计算的别名 ID。 */
  registerInlineCustomEmoji(
    conversationId: string,
    definition: IMReactionDefinition,
  ): number | undefined {
    if (definition.presentation.type !== 'custom') return undefined
    const entry: CustomEntry = { definition: definition as CustomEntry['definition'] }
    const id = this.customDocumentId(entry.definition)
    this._custom.set(id, entry)
    this._aliases.set(
      legacyInlineCustomEmojiDocumentId(this._session.platformSessionId, conversationId, entry.definition),
      entry,
    )
    return id
  }

  private _entry(id: number): CustomEntry | undefined {
    return this._custom.get(id) ?? this._aliases.get(id)
  }

  chatReactions(conversationId: string, context?: IMReactionContext): tl.TypeChatReactions {
    this._registerCatalog(conversationId, context)
    if (!context?.available.length) return { _: 'chatReactionsNone' }
    return {
      _: 'chatReactionsSome',
      reactions: context.available.map((definition) => this.toTlReaction(conversationId, definition)),
    }
  }

  messageReactions(
    conversationId: string,
    message: IMMessage,
    resolveUserId?: (platformUserId: string) => number,
  ): tl.RawMessageReactions {
    const context = message.reactionContext
    this.registerContext(conversationId, context)
    const definitions = new Map((context?.available ?? []).map((item) => [item.key, item]))
    return {
      _: 'messageReactions',
      canSeeList: this._platform.capabilities.reactions?.actorList || undefined,
      results: (context?.reactions ?? []).flatMap((summary) => {
        const definition = definitions.get(summary.key)
        return definition ? [{
          _: 'reactionCount',
          chosenOrder: summary.selected ? summary.selectedOrder ?? 0 : undefined,
          reaction: this.toTlReaction(conversationId, definition),
          count: summary.count,
        } as tl.RawReactionCount] : []
      }),
      recentReactions: (context?.reactions ?? []).flatMap((summary) => {
        const definition = definitions.get(summary.key)
        return definition ? (summary.recentActors ?? []).slice(0, 3).map((actor): tl.RawMessagePeerReaction => ({
          _: 'messagePeerReaction',
          my: actor.userId === this._session.userId || undefined,
          peerId: {
            _: 'peerUser',
            userId: resolveUserId
              ? resolveUserId(actor.userId)
              : (() => { throw new Error(`missing persisted user resolver for ${actor.userId}`) })(),
          },
          date: actor.timestamp ?? message.timestamp,
          reaction: this.toTlReaction(conversationId, definition),
        })) : []
      }),
    }
  }

  toTlReaction(conversationId: string, definition: IMReactionDefinition): tl.TypeReaction {
    if (definition.presentation.type === 'emoji') {
      return { _: 'reactionEmoji', emoticon: definition.presentation.emoticon }
    }
    const id = this.customDocumentId(definition)
    this.registerContext(conversationId, {
      available: [definition], reactions: [], maxSelected: 1,
    })
    return { _: 'reactionCustomEmoji', documentId: Long.fromNumber(id) }
  }

  resolveInput(
    conversationId: string,
    reaction: tl.TypeReaction,
    context: IMReactionContext,
  ): IMReactionDefinition {
    this.registerContext(conversationId, context)
    const found = context.available.find((definition) => {
      if (reaction._ === 'reactionEmoji') {
        return definition.presentation.type === 'emoji'
          && definition.presentation.emoticon === reaction.emoticon
      }
      if (reaction._ === 'reactionCustomEmoji') {
        return definition.presentation.type === 'custom'
          && this.customDocumentId(definition) === reaction.documentId.toNumber()
      }
      return false
    })
    if (found) return found
    // 客户端可能传入旧版本资源的 documentId，通过平台 key 映射回当前版本的定义。
    if (reaction._ === 'reactionCustomEmoji') {
      const retired = this._entry(reaction.documentId.toNumber())?.definition
      const current = retired && context.available.find((definition) => definition.key === retired.key)
      if (current) return current
    }
    throw new RpcError(400, 'REACTION_INVALID')
  }

  customDocumentId(definition: IMReactionDefinition): number {
    return customReactionDocumentId(this._session.platformSessionId, definition)
  }

  resolveCustomEmoji(documentId: number): IMReactionDefinition | undefined {
    return this._entry(documentId)?.definition
  }

  getCustomEmojiDocuments(ids: readonly Long[]): tl.RawDocument[] {
    return ids.flatMap((id) => {
      const entry = this._entry(id.toNumber())
      return entry ? [this._customDocument(id.toNumber(), entry)] : []
    })
  }

  getEmojiStickers(): tl.messages.RawAllStickers {
    const entries = [...this._custom.entries()]
    if (!entries.length) return { _: 'messages.allStickers', hash: Long.ZERO, sets: [] }
    const id = this._customSetId()
    return {
      _: 'messages.allStickers',
      hash: Long.fromNumber(stableId(entries.map(([documentId]) => String(documentId)).join('\u0000'))),
      sets: [{
        _: 'stickerSet', emojis: true, id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
        title: 'Platform Reactions', shortName: `bridge_platform_reactions_${id}`,
        count: entries.length, hash: stableId(entries.map(([documentId]) => String(documentId)).join('\u0000')),
      }],
    }
  }

  getStickerSet(req: tl.messages.RawGetStickerSetRequest): tl.messages.TypeStickerSet | undefined {
    if (req.stickerset._ !== 'inputStickerSetID'
      || req.stickerset.id.toNumber() !== this._customSetId()) return
    const documents = [...this._custom].map(([id, entry]) => this._customDocument(id, entry))
    return {
      _: 'messages.stickerSet',
      set: this.getEmojiStickers().sets[0]!,
      packs: documents.map((document) => ({
        _: 'stickerPack', emoticon: '', documents: [document.id],
      })),
      keywords: [],
      documents,
    }
  }

  async getFile(
    documentId: number,
    offset: number,
    limit: number,
  ): Promise<{ bytes: Uint8Array, mimeType: IMReactionResource['mimeType'] } | undefined> {
    const custom = this._entry(documentId)
    if (!custom || !this._platform.downloadReactionResource) return
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of this._platform.downloadReactionResource(
      this._session,
      custom.definition.presentation.resource,
      { offset, limit },
    )) {
      const accepted = chunk.subarray(0, Math.max(0, limit - size))
      chunks.push(accepted)
      size += accepted.length
      if (size >= limit) break
    }
    const output = new Uint8Array(size)
    let position = 0
    for (const chunk of chunks) {
      output.set(chunk, position)
      position += chunk.length
    }
    return { bytes: output, mimeType: custom.definition.presentation.resource.mimeType }
  }

  async getFileUrl(documentId: number): Promise<IMDirectDownload | undefined> {
    const custom = this._entry(documentId)
    if (!custom || !this._platform.resolveReactionResourceUrl) return
    return this._platform.resolveReactionResourceUrl(
      this._session,
      custom.definition.presentation.resource,
    )
  }

  private _customDocument(id: number, entry: CustomEntry): tl.RawDocument {
    const { alt, resource } = entry.definition.presentation
    const attributes: tl.TypeDocumentAttribute[] = [{
      _: 'documentAttributeCustomEmoji', free: true, alt,
      stickerset: {
        _: 'inputStickerSetID',
        id: Long.fromNumber(this._customSetId()),
        accessHash: Long.fromNumber(this._customSetId()),
      },
    }]
    if (resource.format === 'video') {
      attributes.push({
        _: 'documentAttributeVideo', nosound: true, duration: 1.5,
        w: resource.width, h: resource.height,
      })
    } else {
      attributes.push({
        _: 'documentAttributeImageSize', w: resource.width, h: resource.height,
      })
      if (resource.format === 'animated') attributes.push({ _: 'documentAttributeAnimated' })
    }
    return {
      _: 'document', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
      fileReference: new TextEncoder().encode(`bridge-reaction-resource:${id}:${resource.version}`),
      date: 1_700_000_000, mimeType: resource.mimeType, size: resource.size ?? 0,
      thumbs: [], dcId: this._dcId, attributes,
    }
  }

  private _customSetId(): number {
    return stableId(`platform-reaction-set:v${CATALOG_VERSION}:${this._session.platformSessionId}`)
  }
}

export function customReactionDocumentId(
  platformSessionId: string,
  definition: IMReactionDefinition,
): number {
  if (definition.presentation.type !== 'custom') throw new Error('not a custom reaction')
  return stableId([
    'reaction-resource', CATALOG_VERSION, platformSessionId,
    definition.key, definition.presentation.resource.version,
  ].join(':'))
}

/** 旧版实时推送路径生成的行内自定义表情 documentId（含 conversationId，使用 v1 版本号）。 */
export function legacyInlineCustomEmojiDocumentId(
  platformSessionId: string,
  conversationId: string,
  definition: IMReactionDefinition,
): number {
  if (definition.presentation.type !== 'custom') throw new Error('not a custom reaction')
  return stableId([
    'reaction-resource', 1, platformSessionId, conversationId,
    definition.key, definition.presentation.resource.version,
  ].join(':'))
}

function reactionKey(reaction: tl.TypeReaction): string {
  if (reaction._ === 'reactionEmoji') return `emoji:${reaction.emoticon}`
  if (reaction._ === 'reactionCustomEmoji') return `custom:${reaction.documentId.toString()}`
  return 'empty'
}

function serializeReaction(
  reaction: tl.TypeReaction,
  lastUsedAt: Date,
  definition: IMReactionDefinition,
): RecentReaction {
  if (reaction._ === 'reactionEmoji') {
    return { reactionType: 'emoji', reactionValue: reaction.emoticon, definitionKey: null, lastUsedAt }
  }
  if (reaction._ === 'reactionCustomEmoji') {
    return {
      reactionType: 'custom', reactionValue: reaction.documentId.toString(),
      definitionKey: definition.key, lastUsedAt,
    }
  }
  throw new RpcError(400, 'REACTION_INVALID')
}

function makeReactionList(reactions: tl.TypeReaction[]): tl.messages.RawReactions {
  return {
    _: 'messages.reactions',
    hash: Long.fromNumber(stableId(reactions.map(reactionKey).join('\u0000'))),
    reactions,
  }
}
