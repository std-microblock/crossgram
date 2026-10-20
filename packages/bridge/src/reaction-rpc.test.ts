import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { afterEach, describe, expect, it } from 'vitest'
import { defineModels } from './models.js'
import type {
  IMPlatform, IMReactionContext, IMReactionDefinition, IMReactionResource, PlatformSession,
} from './platform.js'
import {
  customReactionDocumentId, legacyInlineCustomEmojiDocumentId, ReactionRpc,
} from './reaction-rpc.js'

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
  it('resolves an inline custom emoji document under its legacy per-conversation id', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const resource: IMReactionResource = {
      version: 7, format: 'static', mimeType: 'image/png', width: 128, height: 128,
      size: bytes.length, locator: { faceId: '14' },
    }
    const definition: IMReactionDefinition = {
      key: '1:14', title: 'QQ 微笑',
      presentation: { type: 'custom', alt: '🙂', resource },
    }
    const platform = {
      capabilities: {},
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

    const documentId = rpc.registerInlineCustomEmoji('group', definition)
    expect(documentId).toBe(customReactionDocumentId(session.platformSessionId, definition))
    const legacyId = legacyInlineCustomEmojiDocumentId(session.platformSessionId, 'group', definition)
    expect(legacyId).not.toBe(documentId)

    const [document] = rpc.getCustomEmojiDocuments([Long.fromNumber(legacyId)])
    expect(document).toMatchObject({
      id: Long.fromNumber(legacyId), size: bytes.length, mimeType: 'image/png',
    })
    const file = await rpc.getFile(legacyId, 0, bytes.length)
    expect(file?.bytes).toEqual(bytes)
    expect(rpc.resolveCustomEmoji(legacyId)).toMatchObject({ key: '1:14' })
    // The retired id is an alias of the face, not a second emoji in the set.
    expect(rpc.getEmojiStickers().sets[0]).toMatchObject({ count: 1 })
  })

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

  it('only appends new reactions when the client marks the use as recent', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const fire = { key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' } }
    const laugh = { key: 'laugh', presentation: { type: 'emoji' as const, emoticon: '😂' } }
    const rpc = new ReactionRpc(platform, session, 1, database)

    // 双击快速回应不带 add_to_recent：不新增条目。
    await expect(rpc.markUsed('group', [laugh], { append: false })).resolves.toBe(false)
    await expect(rpc.recentReactions(10)).resolves.toMatchObject({ reactions: [] })

    // 从回应面板挑选才写入并刷新顺序，后用的排在前面。
    await expect(rpc.markUsed('group', [fire], { append: true })).resolves.toBe(true)
    await expect(rpc.markUsed('group', [laugh], { append: true })).resolves.toBe(true)
    await expect(rpc.recentReactions(10)).resolves.toMatchObject({
      reactions: [
        { _: 'reactionEmoji', emoticon: '😂' },
        { _: 'reactionEmoji', emoticon: '🔥' },
      ],
    })

    // 已经在列表里的回应仍然按最近使用顶到最前，但不会因为随手一点就多出条目。
    await expect(rpc.markUsed('group', [fire], { append: false })).resolves.toBe(true)
    await expect(rpc.recentReactions(10)).resolves.toMatchObject({
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

  it('preserves the selected reaction order used by Android bubble sorting', () => {
    const platform = { capabilities: { reactions: { actorList: false } } } as IMPlatform
    const rpc = new ReactionRpc(platform, session)
    const context: IMReactionContext = {
      available: [
        { key: 'old', presentation: { type: 'emoji', emoticon: '👍' } },
        { key: 'new', presentation: { type: 'emoji', emoticon: '😂' } },
      ],
      reactions: [
        { key: 'old', count: 1, selected: true, selectedOrder: 1 },
        { key: 'new', count: 1, selected: true, selectedOrder: 2 },
      ],
      maxSelected: 20,
    }
    expect(rpc.messageReactions('group', {
      id: 'message', conversationId: 'group', senderId: 'alice', timestamp: 1,
      content: { parts: [{ type: 'text', text: 'ordered' }] }, reactionContext: context,
    }).results).toMatchObject([
      { chosenOrder: 1, reaction: { _: 'reactionEmoji', emoticon: '👍' } },
      { chosenOrder: 2, reaction: { _: 'reactionEmoji', emoticon: '😂' } },
    ])
  })

  it('bounds message reaction previews to Telegram Androids three visible actors', () => {
    const platform = { capabilities: { reactions: { actorList: true } } } as IMPlatform
    const rpc = new ReactionRpc(platform, session)
    const context: IMReactionContext = {
      available: [{ key: 'like', presentation: { type: 'emoji', emoticon: '👍' } }],
      reactions: [{
        key: 'like', count: 4,
        recentActors: [
          { userId: 'alice' }, { userId: 'bob' }, { userId: 'carol' }, { userId: 'dave' },
        ],
      }],
      maxSelected: 20,
    }

    expect(rpc.messageReactions('group', {
      id: 'message', conversationId: 'group', senderId: 'sender', timestamp: 1,
      content: { parts: [{ type: 'text', text: 'preview' }] }, reactionContext: context,
    }, (id) => ({ alice: 1, bob: 2, carol: 3, dave: 4 })[id]!).recentReactions)
      .toHaveLength(3)
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

  it('resolves a retired document id to the current definition of the same key', () => {
    const platform = { capabilities: {} } as IMPlatform
    const rpc = new ReactionRpc(platform, session)
    const definition = (version: number): IMReactionDefinition => ({
      key: '1:416',
      presentation: {
        type: 'custom', alt: '🙂',
        resource: { version, format: 'static', mimeType: 'image/png', width: 128, height: 128, size: 16_477 },
      },
    })
    const current = definition(3_301_497_631)
    const context: IMReactionContext = { available: [current], reactions: [], maxSelected: 20 }
    // The client still holds the document id of the version the relay replaced.
    const retired = rpc.toTlReaction('group', definition(3_342_178_892))
    if (retired._ !== 'reactionCustomEmoji') throw new Error('expected custom reaction')
    expect(rpc.resolveInput('group', retired, context)).toBe(current)

    expect(() => rpc.resolveInput('group', {
      _: 'reactionCustomEmoji', documentId: Long.fromNumber(123),
    }, context)).toThrowError(/REACTION_INVALID/)
  })

  it('keeps recent custom reactions renderable across asset re-versions and catalog removals', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const face = (key: string, version: number): IMReactionDefinition => ({
      key,
      presentation: {
        type: 'custom', alt: '🙂',
        resource: { version, format: 'static', mimeType: 'image/png', width: 56, height: 56, size: 4 },
      },
    })
    const writer = new ReactionRpc(platform, session, 1, database)
    const oldSmile = face('1:14', 1)
    const oldRemoved = face('1:999', 1)
    const fire = { key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' } }
    await writer.markUsed('group', [oldRemoved])
    await writer.markUsed('group', [fire])
    await writer.markUsed('group', [oldSmile])

    // 还没见过任何会话目录时无从判断哪些 id 已经过期，原样返回记录里的 id。
    const cold = new ReactionRpc(platform, session, 1, database)
    await expect(cold.recentReactions(10)).resolves.toMatchObject({
      reactions: [
        { documentId: Long.fromNumber(cold.customDocumentId(oldSmile)) },
        { emoticon: '🔥' },
        { documentId: Long.fromNumber(cold.customDocumentId(oldRemoved)) },
      ],
    })

    // 平台把 1:14 重新发版、并从目录里去掉 1:999：前者换成当前版本，后者整条跳过。
    const newSmile = face('1:14', 2)
    cold.chatReactions('group', { available: [newSmile, fire], reactions: [], maxSelected: 20 })
    const recent = await cold.recentReactions(10)
    expect(recent.reactions).toEqual([
      { _: 'reactionCustomEmoji', documentId: Long.fromNumber(cold.customDocumentId(newSmile)) },
      { _: 'reactionEmoji', emoticon: '🔥' },
    ])
    // 返回的每个 id 都能解析出 document，客户端不会留下占位。
    const ids = recent.reactions.flatMap((reaction) =>
      reaction._ === 'reactionCustomEmoji' ? [reaction.documentId] : [])
    expect(cold.getCustomEmojiDocuments(ids)).toHaveLength(ids.length)
    await expect(cold.topReactions(3)).resolves.toMatchObject({
      reactions: [
        { documentId: Long.fromNumber(cold.customDocumentId(newSmile)) },
        { emoticon: '🔥' },
        { emoticon: '👍' },
      ],
    })
  })

  it('keeps one entry per platform key when a face was used across resource versions', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const face = (version: number): IMReactionDefinition => ({
      key: '1:14',
      presentation: {
        type: 'custom', alt: '🙂',
        resource: { version, format: 'static', mimeType: 'image/png', width: 56, height: 56, size: 4 },
      },
    })
    const writer = new ReactionRpc(platform, session, 1, database)
    await writer.markUsed('group', [face(1)])
    await writer.markUsed('group', [face(2)])

    const cold = new ReactionRpc(platform, session, 1, database)
    await expect(cold.recentReactions(10)).resolves.toMatchObject({
      reactions: [{ documentId: Long.fromNumber(cold.customDocumentId(face(2))) }],
    })
  })

  it('drops recent rows whose key left the catalog and re-keys the ones still present', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const face = (key: string, version: number): IMReactionDefinition => ({
      key,
      presentation: {
        type: 'custom', alt: '🙂',
        resource: { version, format: 'static', mimeType: 'image/png', width: 56, height: 56, size: 4 },
      },
    })
    // 记录里只有 key + documentId；目录里还有 1:14（新版本），'removed-face' 已经下架。
    await database.create('mtproto_reaction_recent', {
      platformSessionId: session.platformSessionId, reactionType: 'custom',
      reactionValue: String(legacyInlineCustomEmojiDocumentId(session.platformSessionId, 'group', face('1:14', 1))),
      definitionKey: '1:14', lastUsedAt: new Date(2),
    })
    await database.create('mtproto_reaction_recent', {
      platformSessionId: session.platformSessionId, reactionType: 'custom',
      reactionValue: '424242', definitionKey: 'removed-face', lastUsedAt: new Date(3),
    })
    const rpc = new ReactionRpc(platform, session, 1, database)
    rpc.chatReactions('group', { available: [face('1:14', 2)], reactions: [], maxSelected: 20 })
    await expect(rpc.recentReactions(10)).resolves.toMatchObject({
      reactions: [{ documentId: Long.fromNumber(rpc.customDocumentId(face('1:14', 2))) }],
    })
  })

  it('maps a recent row written before keys were stored through a retired inline alias', async () => {
    const database = await createDatabase()
    const platform = { capabilities: {} } as IMPlatform
    const face = (version: number): IMReactionDefinition => ({
      key: '1:14',
      presentation: {
        type: 'custom', alt: '🙂',
        resource: { version, format: 'static', mimeType: 'image/png', width: 56, height: 56, size: 4 },
      },
    })
    const legacy = legacyInlineCustomEmojiDocumentId(session.platformSessionId, 'group', face(1))
    await database.create('mtproto_reaction_recent', {
      platformSessionId: session.platformSessionId, reactionType: 'custom',
      reactionValue: String(legacy), lastUsedAt: new Date(1),
    })
    await database.create('mtproto_reaction_recent', {
      platformSessionId: session.platformSessionId, reactionType: 'custom',
      reactionValue: '123', lastUsedAt: new Date(0),
    })
    const rpc = new ReactionRpc(platform, session, 1, database)
    rpc.registerInlineCustomEmoji('group', face(1))
    rpc.chatReactions('group', { available: [face(2)], reactions: [], maxSelected: 20 })

    await expect(rpc.recentReactions(10)).resolves.toMatchObject({
      reactions: [{ documentId: Long.fromNumber(rpc.customDocumentId(face(2))) }],
    })
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
