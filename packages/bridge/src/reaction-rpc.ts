import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { stableId } from './dialogs.js'
import type {
  IMMessage, IMPlatform, IMReactionContext, IMReactionDefinition, IMReactionResource, PlatformSession,
} from './platform.js'

const CATALOG_VERSION = 1
const STANDARD_REACTIONS = ['👍', '❤️', '😂', '😢', '🔥', '🎉', '👏', '🤔', '🤯'] as const

interface CustomEntry {
  conversationId: string
  definition: IMReactionDefinition & { presentation: { type: 'custom', alt: string, resource: IMReactionResource } }
}

interface RecentReaction {
  reactionType: 'emoji' | 'custom'
  reactionValue: string
  lastUsedAt: Date
}

export class ReactionRpc {
  private readonly _custom = new Map<number, CustomEntry>()
  private readonly _memoryRecent = new Map<string, RecentReaction>()
  private _recentWrite = Promise.resolve()

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

  markUsed(conversationId: string, definitions: readonly IMReactionDefinition[]): Promise<void> {
    if (!definitions.length) return Promise.resolve()
    const write = this._recentWrite.then(async () => {
      const reactions = definitions.map((definition) => this.toTlReaction(conversationId, definition))
      const existing = await this._recentRows()
      let timestamp = Math.max(Date.now(), ...existing.map((row) => row.lastUsedAt.getTime() + 1))
      for (const reaction of reactions) {
        const recent = serializeReaction(reaction, new Date(timestamp++))
        if (this._database) {
          await this._database.upsert('mtproto_reaction_recent', [{
            platformSessionId: this._session.platformSessionId,
            ...recent,
          }], ['platformSessionId', 'reactionType', 'reactionValue'])
        } else {
          this._memoryRecent.set(reactionKey(reaction), recent)
        }
      }
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

  private async _recentReactions(limit: number): Promise<tl.TypeReaction[]> {
    if (limit <= 0) return []
    await this._recentWrite
    const rows = await this._recentRows(limit)
    return rows.map((row) => row.reactionType === 'emoji'
      ? { _: 'reactionEmoji', emoticon: row.reactionValue }
      : { _: 'reactionCustomEmoji', documentId: Long.fromString(row.reactionValue) })
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

  registerContext(conversationId: string, context?: IMReactionContext): void {
    for (const definition of context?.available ?? []) {
      if (definition.presentation.type !== 'custom') continue
      this._custom.set(this.customDocumentId(conversationId, definition), {
        conversationId,
        definition: definition as CustomEntry['definition'],
      })
    }
  }

  chatReactions(conversationId: string, context?: IMReactionContext): tl.TypeChatReactions {
    this.registerContext(conversationId, context)
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
          chosenOrder: summary.selected ? 0 : undefined,
          reaction: this.toTlReaction(conversationId, definition),
          count: summary.count,
        } as tl.RawReactionCount] : []
      }),
      recentReactions: (context?.reactions ?? []).flatMap((summary) => {
        const definition = definitions.get(summary.key)
        return definition ? (summary.recentActors ?? []).map((actor): tl.RawMessagePeerReaction => ({
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
    const id = this.customDocumentId(conversationId, definition)
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
          && this.customDocumentId(conversationId, definition) === reaction.documentId.toNumber()
      }
      return false
    })
    if (!found) throw new RpcError(400, 'REACTION_INVALID')
    return found
  }

  customDocumentId(conversationId: string, definition: IMReactionDefinition): number {
    if (definition.presentation.type !== 'custom') throw new Error('not a custom reaction')
    return stableId([
      'reaction-resource', CATALOG_VERSION, this._session.platformSessionId,
      conversationId, definition.key, definition.presentation.resource.version,
    ].join(':'))
  }

  resolveCustomEmoji(documentId: number): IMReactionDefinition | undefined {
    return this._custom.get(documentId)?.definition
  }

  getCustomEmojiDocuments(ids: readonly Long[]): tl.RawDocument[] {
    return ids.flatMap((id) => {
      const entry = this._custom.get(id.toNumber())
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
    const custom = this._custom.get(documentId)
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

function reactionKey(reaction: tl.TypeReaction): string {
  if (reaction._ === 'reactionEmoji') return `emoji:${reaction.emoticon}`
  if (reaction._ === 'reactionCustomEmoji') return `custom:${reaction.documentId.toString()}`
  return 'empty'
}

function serializeReaction(reaction: tl.TypeReaction, lastUsedAt: Date): RecentReaction {
  if (reaction._ === 'reactionEmoji') {
    return { reactionType: 'emoji', reactionValue: reaction.emoticon, lastUsedAt }
  }
  if (reaction._ === 'reactionCustomEmoji') {
    return { reactionType: 'custom', reactionValue: reaction.documentId.toString(), lastUsedAt }
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
