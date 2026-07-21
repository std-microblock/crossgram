import type { tl } from '@mtcute/core'
import Long from 'long'
import { readFileSync } from 'node:fs'
import { RpcError } from '@mtproto-relay/mtproto'
import { stableId } from './dialogs.js'
import type {
  IMMessage, IMPlatform, IMReactionContext, IMReactionDefinition, IMReactionResource, PlatformSession,
} from './platform.js'

const DOCUMENT_DATE = 1_700_000_000
const CATALOG_VERSION = 1

const standardCatalog = [
  ['👍', 'Like', 'like.webp'],
  ['❤️', 'Love', 'heart.webp'],
  ['😂', 'Laugh', 'laugh.webp'],
  ['😢', 'Sad', 'sad.webp'],
  ['🔥', 'Fire', 'fire.webp'],
  ['🎉', 'Party', 'partyemoji.webp'],
  ['👏', 'Clap', 'clap.webp'],
  ['🤔', 'Thinking', 'think.webp'],
  ['🤯', 'Mind Blown', 'mindblown.webp'],
] as const

const standardAssets = new Map(standardCatalog.map(([emoji, title, file]) => [
  emoji,
  {
    title,
    bytes: new Uint8Array(readFileSync(new URL(`./assets/reactions/${file}`, import.meta.url))),
  },
]))

interface CustomEntry {
  conversationId: string
  definition: IMReactionDefinition & { presentation: { type: 'custom', alt: string, resource: IMReactionResource } }
}

export class ReactionRpc {
  private readonly _custom = new Map<number, CustomEntry>()

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _dcId = 1,
  ) {}

  availableCatalog(): tl.messages.RawAvailableReactions {
    return {
      _: 'messages.availableReactions',
      hash: stableId([...standardAssets.keys()].join('\u0000')),
      reactions: standardCatalog.map(([emoji, title]) => {
        const document = this._standardDocument(emoji)
        return {
          _: 'availableReaction',
          reaction: emoji,
          title,
          staticIcon: document,
          appearAnimation: document,
          selectAnimation: document,
          activateAnimation: document,
          effectAnimation: document,
          aroundAnimation: document,
          centerIcon: document,
        }
      }),
    }
  }

  topReactions(limit: number): tl.messages.RawReactions {
    const reactions = standardCatalog.slice(0, Math.max(0, limit))
      .map(([emoticon]) => ({ _: 'reactionEmoji', emoticon }) as tl.RawReactionEmoji)
    return {
      _: 'messages.reactions',
      hash: Long.fromNumber(stableId(reactions.map((item) => item.emoticon).join('\u0000'))),
      reactions,
    }
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

  messageReactions(conversationId: string, message: IMMessage): tl.RawMessageReactions {
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
          peerId: { _: 'peerUser', userId: stableId(`peer:${actor.userId}`) },
          date: actor.timestamp ?? message.timestamp,
          reaction: this.toTlReaction(conversationId, definition),
        })) : []
      }),
    }
  }

  toTlReaction(conversationId: string, definition: IMReactionDefinition): tl.TypeReaction {
    if (definition.presentation.type === 'emoji') {
      if (!standardAssets.has(definition.presentation.emoticon)) {
        throw new RpcError(400, 'REACTION_INVALID')
      }
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

  async getFile(documentId: number, offset: number, limit: number): Promise<Uint8Array | undefined> {
    const standard = [...standardAssets].find(([emoji]) => this._standardDocumentId(emoji) === documentId)
    if (standard) return standard[1].bytes.subarray(offset, offset + limit)
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
    return output
  }

  private _standardDocument(emoji: string): tl.RawDocument {
    const asset = standardAssets.get(emoji)!
    const id = this._standardDocumentId(emoji)
    return {
      _: 'document', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
      fileReference: new TextEncoder().encode(`bridge-native-reaction:${emoji}`),
      date: DOCUMENT_DATE, mimeType: 'image/webp', size: asset.bytes.length,
      thumbs: [], dcId: this._dcId,
      attributes: [{
        _: 'documentAttributeSticker', alt: emoji, stickerset: { _: 'inputStickerSetEmpty' },
      }, { _: 'documentAttributeImageSize', w: 512, h: 512 }],
    }
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
    }
    return {
      _: 'document', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
      fileReference: new TextEncoder().encode(`bridge-reaction-resource:${id}:${resource.version}`),
      date: DOCUMENT_DATE, mimeType: resource.mimeType, size: resource.size ?? 0,
      thumbs: [], dcId: this._dcId, attributes,
    }
  }

  private _standardDocumentId(emoji: string): number {
    return stableId(`native-reaction-document:v${CATALOG_VERSION}:${emoji}`)
  }

  private _customSetId(): number {
    return stableId(`platform-reaction-set:v${CATALOG_VERSION}:${this._session.platformSessionId}`)
  }
}
