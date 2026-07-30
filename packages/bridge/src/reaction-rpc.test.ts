import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { afterEach, describe, expect, it } from 'vitest'
import { defineModels } from './models.js'
import type {
  IMPlatform, IMReactionContext, IMReactionDefinition, IMReactionResource, PlatformSession,
} from './platform.js'
import { ReactionRpc } from './reaction-rpc.js'

const session: PlatformSession = {
  platformSessionId: 'reaction-session', platformId: 'test', userId: 'self', credentials: {}, metadata: {},
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createDatabase() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return ctx.database
}

function fixture(format: 'static' | 'video') {
  const bytes = Uint8Array.from(format === 'video' ? [0x1a, 0x45, 0xdf, 0xa3] : [0x52, 0x49, 0x46, 0x46])
  const resource: IMReactionResource = format === 'video'
    ? { version: 1, format, mimeType: 'video/webm', width: 100, height: 100, size: bytes.length }
    : { version: 1, format, mimeType: 'image/webp', width: 100, height: 100, size: bytes.length }
  const context: IMReactionContext = {
    available: [{
      key: `custom:${format}`,
      presentation: { type: 'custom', alt: '🙂', resource },
    }],
    reactions: [],
    maxSelected: 1,
  }
  const platform = {
    capabilities: { reactions: { read: true, write: true, events: true, actorList: false, maxSelected: 1 } },
    async *downloadReactionResource(
      _session: PlatformSession,
      _resource: IMReactionResource,
      options: { offset?: number, limit?: number } = {},
    ) {
      const start = options.offset ?? 0
      yield bytes.subarray(start, start + (options.limit ?? bytes.length))
    },
  } as unknown as IMPlatform
  const rpc = new ReactionRpc(platform, session)
  const reaction = rpc.toTlReaction('group', context.available[0]!)
  if (reaction._ !== 'reactionCustomEmoji') throw new Error('expected custom reaction')
  return { rpc, documentId: reaction.documentId, resource, bytes }
}

describe('ReactionRpc', () => {
  it('orders top and recent reactions by the latest successful selection and persists the order', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const fire = {
      key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' },
    }
    const laugh = {
      key: 'laugh', presentation: { type: 'emoji' as const, emoticon: '😂' },
    }
    const rpc = new ReactionRpc(platform, session, 1, database)

    await rpc.markUsed('group', [fire])
    await rpc.markUsed('group', [laugh])

    await expect(rpc.recentReactions(100)).resolves.toMatchObject({
      _: 'messages.reactions',
      reactions: [
        { _: 'reactionEmoji', emoticon: '😂' },
        { _: 'reactionEmoji', emoticon: '🔥' },
      ],
    })
    await expect(rpc.topReactions(4)).resolves.toMatchObject({
      reactions: [
        { _: 'reactionEmoji', emoticon: '😂' },
        { _: 'reactionEmoji', emoticon: '🔥' },
        { _: 'reactionEmoji', emoticon: '👍' },
        { _: 'reactionEmoji', emoticon: '❤️' },
      ],
    })

    const resumed = new ReactionRpc(platform, session, 1, database)
    await expect(resumed.recentReactions(1)).resolves.toMatchObject({
      reactions: [{ _: 'reactionEmoji', emoticon: '😂' }],
    })
    await resumed.markUsed('group', [fire])
    await expect(resumed.recentReactions(100)).resolves.toMatchObject({
      reactions: [
        { _: 'reactionEmoji', emoticon: '🔥' },
        { _: 'reactionEmoji', emoticon: '😂' },
      ],
    })
  })

  it('isolates recent reactions per platform session and clears only the active account', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const fire = {
      key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' },
    }
    const first = new ReactionRpc(platform, session, 1, database)
    const second = new ReactionRpc(platform, {
      ...session, platformSessionId: 'other-reaction-session',
    }, 1, database)

    await first.markUsed('group', [fire])
    await expect(second.recentReactions(100)).resolves.toMatchObject({ reactions: [] })
    await first.clearRecentReactions()
    await expect(first.recentReactions(100)).resolves.toMatchObject({ reactions: [] })
    await expect(first.topReactions(2)).resolves.toMatchObject({ reactions: [
      { _: 'reactionEmoji', emoticon: '👍' },
      { _: 'reactionEmoji', emoticon: '❤️' },
    ] })
  })

  it.each(['static', 'video'] as const)('describes and serves %s custom reaction resources', async (format) => {
    const { rpc, documentId, resource, bytes } = fixture(format)
    const [document] = rpc.getCustomEmojiDocuments([documentId])
    expect(document).toMatchObject({ mimeType: resource.mimeType, size: bytes.length })
    expect(document?.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'documentAttributeCustomEmoji', alt: '🙂' }),
      expect.objectContaining({
        _: format === 'video' ? 'documentAttributeVideo' : 'documentAttributeImageSize',
        w: 100,
        h: 100,
      }),
    ]))
    await expect(rpc.getFile(Long.fromValue(documentId).toNumber(), 1, 2)).resolves.toEqual({
      bytes: bytes.subarray(1, 3), mimeType: resource.mimeType,
    })
  })

  it('deduplicates the same platform reaction registered through many conversations', () => {
    const platform = { capabilities: {} } as IMPlatform
    const rpc = new ReactionRpc(platform, session)
    const definition: IMReactionContext['available'][number] = {
      key: 'platform:shared',
      presentation: {
        type: 'custom', alt: 'shared',
        resource: {
          version: 7, format: 'static', mimeType: 'image/webp',
          width: 100, height: 100, size: 4, locator: { catalogKey: 'platform:shared' },
        },
      },
    }
    const documentIds = Array.from({ length: 40 }, (_, index) => {
      const conversationId = `conversation-${index}`
      rpc.registerContext(conversationId, {
        available: [definition], reactions: [], maxSelected: 20,
      })
      const reaction = rpc.toTlReaction(conversationId, definition)
      if (reaction._ !== 'reactionCustomEmoji') throw new Error('expected custom reaction')
      return reaction.documentId.toString()
    })

    expect(new Set(documentIds)).toEqual(new Set([documentIds[0]]))
    expect(rpc.getEmojiStickers()).toMatchObject({
      _: 'messages.allStickers',
      sets: [expect.objectContaining({ title: 'Platform Reactions', count: 1 })],
    })
    const set = rpc.getEmojiStickers()
    if (set._ !== 'messages.allStickers') throw new Error('expected platform reaction set')
    const pack = rpc.getStickerSet({
      _: 'messages.getStickerSet',
      stickerset: {
        _: 'inputStickerSetID', id: set.sets[0]!.id, accessHash: set.sets[0]!.accessHash,
      },
      hash: 0,
    })
    expect(pack).toMatchObject({ _: 'messages.stickerSet', documents: { length: 1 } })
  })

  it('keeps distinct platform reaction keys and resource versions separate', () => {
    const platform = { capabilities: {} } as IMPlatform
    const rpc = new ReactionRpc(platform, session)
    const custom = (key: string, version: number): IMReactionDefinition => ({
      key,
      presentation: {
        type: 'custom', alt: key,
        resource: { version, format: 'static', mimeType: 'image/webp', width: 100, height: 100 },
      },
    })

    const ids = [custom('first', 1), custom('second', 1), custom('first', 2)]
      .map((definition) => rpc.customDocumentId(definition))

    expect(new Set(ids).size).toBe(3)
  })
})
