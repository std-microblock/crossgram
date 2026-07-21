import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import type { IMConversation, IMMessage, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'platform-session',
  platformId: 'test',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore() {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Database),
    ctx.plugin(SQLiteDriver, { path: ':memory:' }),
  ]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store: new MessageStore(ctx.database) }
}

describe('MessageStore', () => {
  it('reserves RPC pts without advancing the push sequence', async () => {
    const { store } = await createStore()
    await store.prepareUpdateDelivery('push-1', session.platformSessionId, 2, 1_800_000_000)

    await expect(store.advancePts(session.platformSessionId, 3, 1_800_000_001)).resolves.toMatchObject({
      pts: 6, seq: 1, date: 1_800_000_001,
    })
    await expect(store.advancePts(session.platformSessionId, 0, 1_800_000_002))
      .rejects.toThrow('positive integer')
  })

  it('persists arbitrarily long platform IDs, aliases, ordered content, and media metadata', async () => {
    const { ctx, store } = await createStore()
    const conversationId = `conversation:${'c'.repeat(32_768)}`
    const logicalId = `logical:${'m'.repeat(65_536)}`
    const physicalIds = [`photo:${'p'.repeat(24_000)}`, `file:${'f'.repeat(24_000)}`]
    const conversation: IMConversation = {
      id: conversationId,
      kind: 'channel',
      title: 'Long identifiers',
      parentId: 'category:root',
      spaceId: 'guild:one',
    }
    const message: IMMessage = {
      id: logicalId,
      sourceIds: physicalIds,
      conversationId,
      senderId: `sender:${'s'.repeat(16_000)}`,
      timestamp: 1_800_000_001,
      groupId: `album:${'g'.repeat(16_000)}`,
      content: {
        parts: [
          { type: 'text', text: 'caption' },
          {
            type: 'media',
            media: {
              id: physicalIds[0], kind: 'image', name: 'photo.png', mimeType: 'image/png',
              size: 123, width: 640, height: 480, locator: { token: 'photo-token' },
            },
          },
          {
            type: 'media',
            media: {
              id: physicalIds[1], kind: 'file', name: 'report.bin',
              size: 456, locator: { token: 'file-token' },
            },
          },
        ],
      },
    }

    const first = await store.ingest(session, conversation, message)
    expect(first.created).toBe(true)
    expect(first.message).toMatchObject({
      primaryPlatformMessageId: logicalId,
      text: 'caption',
      content: message.content,
      platformGroupId: message.groupId,
    })
    expect(first.projection).toMatchObject([
      { tlMessageId: 0x40000000, groupedId: null, ordinal: 0 },
      { tlMessageId: 0x40000001, groupedId: null, ordinal: 1 },
    ])

    const [storedConversation] = await ctx.database.get('mtproto_im_conversation', {
      platformSessionId: session.platformSessionId,
    })
    expect(storedConversation).toMatchObject({
      platformConversationId: conversationId,
      kind: 'channel',
      parentPlatformConversationId: 'category:root',
      spacePlatformId: 'guild:one',
    })
    expect(await ctx.database.get('mtproto_im_message_alias', { messageId: first.message.id }))
      .toMatchObject([
        { platformMessageId: logicalId, ordinal: 0 },
        { platformMessageId: physicalIds[0], ordinal: 1 },
        { platformMessageId: physicalIds[1], ordinal: 2 },
      ])
    expect(await ctx.database.get('mtproto_im_media', { messageId: first.message.id }))
      .toMatchObject([
        { ordinal: 0, partIndex: 1, platformMediaId: physicalIds[0], kind: 'image' },
        { ordinal: 1, partIndex: 2, platformMediaId: physicalIds[1], kind: 'file' },
      ])
    expect((await store.findByExternalId(session.platformSessionId, conversationId, physicalIds[1]))?.id)
      .toBe(first.message.id)
  })

  it('merges repeated history and event deliveries through any physical alias', async () => {
    const { ctx, store } = await createStore()
    const conversation: IMConversation = { id: 'room', kind: 'group', title: 'Room' }
    const initial: IMMessage = {
      id: 'album', sourceIds: ['physical-1', 'physical-2'], conversationId: 'room', senderId: 'alice',
      timestamp: 100,
      content: { parts: [
        { type: 'text', text: 'initial' },
        {
          type: 'media',
          media: {
            id: 'physical-1', kind: 'image', mimeType: 'image/png', size: 8,
            locator: { token: 'old' },
          },
        },
      ] },
    }
    const first = await store.ingest(session, conversation, initial)
    const repeated = await store.ingest(session, conversation, {
      ...initial,
      id: 'physical-2',
      sourceIds: ['album', 'physical-1'],
      timestamp: 101,
      content: { parts: [
        { type: 'text', text: 'updated' },
        {
          type: 'media',
          media: {
            id: 'physical-1', kind: 'image', mimeType: 'image/png', size: 68,
            locator: { token: 'current' },
          },
        },
      ] },
    })

    expect(repeated.created).toBe(false)
    expect(repeated.message.id).toBe(first.message.id)
    expect(repeated.message).toMatchObject({ text: 'updated', timestamp: 101 })
    expect(await ctx.database.get('mtproto_im_message', {})).toHaveLength(1)
    expect(await ctx.database.get('mtproto_im_message_alias', {})).toHaveLength(3)
    expect(repeated.projection).toEqual(first.projection)
    expect(await ctx.database.get('mtproto_im_media', { messageId: first.message.id })).toMatchObject([{
      id: first.projection[0].mediaId, size: 68, locator: { token: 'current' },
    }])
  })

  it('allocates consecutive signed-int IDs independently per durable scope', async () => {
    const { store } = await createStore()
    expect(await store.allocateIds('account:one', 3)).toEqual([1, 2, 3])
    expect(await store.allocateIds('channel:one', 2)).toEqual([1, 2])
    expect(await store.allocateIds('account:one', 2)).toEqual([4, 5])
    await expect(store.allocateIds('account:one', 0)).rejects.toThrow('positive integer')
  })

  it('allocates message IDs account-wide but isolates channel ID scopes', async () => {
    const { store } = await createStore()
    const direct = { id: 'direct', kind: 'direct' as const, title: 'Direct' }
    const group = { id: 'group', kind: 'group' as const, title: 'Group' }
    const channel = { id: 'channel', kind: 'channel' as const, title: 'Channel' }
    const make = (id: string, conversationId: string): IMMessage => ({
      id, conversationId, senderId: 'sender', timestamp: 1,
      content: { parts: [{ type: 'text', text: id }] },
    })
    expect((await store.ingest(session, direct, make('direct-1', 'direct'))).projection[0].tlMessageId).toBe(0x40000000)
    expect((await store.ingest(session, group, make('group-1', 'group'))).projection[0].tlMessageId).toBe(0x40000001)
    expect((await store.ingest(session, channel, make('channel-1', 'channel'))).projection[0].tlMessageId).toBe(0x40000000)
    expect((await store.ingest(session, channel, make('channel-2', 'channel'))).projection[0].tlMessageId).toBe(0x40000001)
  })

  it('allocates backward history IDs and returns bounded database pages', async () => {
    const { store } = await createStore()
    const conversation = { id: 'paged', kind: 'direct' as const, title: 'Paged' }
    const make = (id: string, timestamp: number): IMMessage => ({
      id, conversationId: conversation.id, senderId: 'sender', timestamp,
      content: { parts: [{ type: 'text', text: id }] },
    })
    const live = await store.ingest(session, conversation, make('latest', 100))
    const older = await store.ingest(session, conversation, make('older', 90), { allocation: 'history' })
    const oldest = await store.ingest(session, conversation, make('oldest', 80), { allocation: 'history' })
    expect([live, older, oldest].map((item) => item.projection[0].tlMessageId))
      .toEqual([0x40000000, 0x3fffffff, 0x3ffffffe])
    expect((await store.readProjectedHistory(session.platformSessionId, conversation.id, { limit: 2 }))
      .map((item) => item.source.id)).toEqual(['latest', 'older'])
    expect((await store.readProjectedHistory(session.platformSessionId, conversation.id, {
      limit: 2, beforeTimestamp: 90,
    })).map((item) => item.source.id)).toEqual(['oldest'])
  })

  it('serializes concurrent allocations without duplicate IDs', async () => {
    const { store } = await createStore()
    const pages = await Promise.all(Array.from({ length: 12 }, () => store.allocateIds('concurrent', 2)))
    const ids = pages.flat().sort((left, right) => left - right)
    expect(ids).toEqual(Array.from({ length: 24 }, (_, index) => index + 1))
  })

  it('allocates independent outbox rows while deduplicating by event key', async () => {
    const { ctx, store } = await createStore()
    const first = await store.prepareUpdateDelivery('event:first', session.platformSessionId, 1, 100)
    const second = await store.prepareUpdateDelivery('event:second', session.platformSessionId, 2, 101)
    const repeated = await store.prepareUpdateDelivery('event:first', session.platformSessionId, 1, 100)

    expect(first).toMatchObject({ messageId: 1, eventKey: 'event:first', pts: 2, seq: 1 })
    expect(second).toMatchObject({ messageId: 2, eventKey: 'event:second', pts: 4, seq: 2 })
    expect(repeated).toEqual(first)
    expect(await ctx.database.get('mtproto_update_delivery', {})).toHaveLength(2)
  })

  it('rejects mismatched conversation payloads without writing partial rows', async () => {
    const { ctx, store } = await createStore()
    await expect(store.ingest(session, { id: 'one', kind: 'direct', title: 'One' }, {
      id: 'message', conversationId: 'two', senderId: 'sender', timestamp: 1,
      content: { parts: [{ type: 'text', text: 'invalid' }] },
    })).rejects.toThrow('does not match')
    expect(await ctx.database.get('mtproto_im_conversation', {})).toEqual([])
    expect(await ctx.database.get('mtproto_im_message', {})).toEqual([])
  })
})
