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
      sender: {
        id: `sender:${'s'.repeat(16_000)}`,
        firstName: 'Conversation Alias',
        username: '1715311957',
        avatar: {
          id: 'avatar:user:sender',
          kind: 'image',
          locator: { avatarUin: '1715311957' },
        },
      },
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
    const [storedSender] = await ctx.database.get('mtproto_im_user', {
      platformId: session.platformId,
      platformUserId: message.senderId,
    })
    expect(storedSender).toMatchObject({
      id: first.message.senderUserId,
      firstName: 'Conversation Alias',
      username: '1715311957',
      avatar: { id: 'avatar:user:sender', locator: { avatarUin: '1715311957' } },
    })
    expect((await store.findByExternalId(session.platformSessionId, conversationId, physicalIds[1]))?.id)
      .toBe(first.message.id)
    const hydrated = await store.readHistory(session.platformSessionId, conversationId)
    expect(hydrated).toMatchObject([{
      sender: {
        id: message.senderId,
        firstName: 'Conversation Alias',
        username: '1715311957',
        avatar: { locator: { avatarUin: '1715311957' } },
      },
      metadata: {},
    }])
    await store.ingest(session, conversation, hydrated[0])
    await expect(store.getUser(session.platformId, message.senderId)).resolves.toMatchObject({
      firstName: 'Conversation Alias', username: '1715311957',
    })
  })

  it('uses one auto-increment Telegram user ID across sessions of the same platform entry', async () => {
    const { ctx, store } = await createStore()
    const first = await store.upsertUser(session, { id: 'opaque-alice', firstName: 'opaque-alice' })
    const refreshed = await store.upsertUser({
      ...session, platformSessionId: 'replacement-session',
    }, {
      id: 'opaque-alice', firstName: 'Alice', username: '1715311957',
      avatar: { id: 'avatar:alice', kind: 'image', locator: { avatarUin: '1715311957' } },
      metadata: { qq: '1715311957' },
    })
    const otherPlatform = await store.upsertUser({
      ...session, platformId: 'other-platform', platformSessionId: 'other-session',
    }, { id: 'opaque-alice', firstName: 'Other Alice' })

    expect(first.id).toBe(refreshed.id)
    expect(otherPlatform.id).not.toBe(first.id)
    expect(await store.getUserByTlId(session.platformId, first.id)).toMatchObject({
      platformId: session.platformId,
      platformUserId: 'opaque-alice',
      firstName: 'Alice',
      username: '1715311957',
      avatar: { id: 'avatar:alice', locator: { avatarUin: '1715311957' } },
      metadata: { qq: '1715311957' },
    })
    expect(await ctx.database.get('mtproto_im_user', { platformUserId: 'opaque-alice' }))
      .toHaveLength(2)
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

  it('switches a projection to upgraded media without invalidating the original media ID', async () => {
    const { ctx, store } = await createStore()
    const conversation: IMConversation = { id: 'animated-room', kind: 'group', title: 'Animated room' }
    const original: IMMessage = {
      id: 'animated-message', conversationId: conversation.id, senderId: 'alice', timestamp: 100,
      content: { parts: [{
        type: 'media',
        media: {
          id: 'qq-image:original-v1', kind: 'image', name: 'animation.gif', mimeType: 'image/gif',
          size: 120, width: 64, height: 48, locator: { nativeUrl: 'https://example.test/original' },
        },
      }] },
    }

    const first = await store.ingest(session, conversation, original)
    const originalMediaId = first.projection[0].mediaId!
    const edited = await store.ingest(session, conversation, {
      ...original,
      content: { parts: [{
        type: 'media',
        media: {
          id: 'qq-image:original-v1:webm-v1', kind: 'file', name: 'animation.webm', mimeType: 'video/webm',
          size: 80, width: 64, height: 48, locator: { cachedPath: 'cache/animation.webm' },
        },
      }] },
    })
    const upgradedMediaId = edited.projection[0].mediaId!

    expect(edited.created).toBe(false)
    expect(edited.projection[0].tlMessageId).toBe(first.projection[0].tlMessageId)
    expect(upgradedMediaId).not.toBe(originalMediaId)
    expect(await ctx.database.get('mtproto_im_media', { messageId: first.message.id })).toMatchObject([
      { id: originalMediaId, platformMediaId: 'qq-image:original-v1', mimeType: 'image/gif' },
      { id: upgradedMediaId, platformMediaId: 'qq-image:original-v1:webm-v1', mimeType: 'video/webm' },
    ])
    await expect(store.getMedia(session.platformSessionId, originalMediaId)).resolves.toMatchObject({
      media: { id: 'qq-image:original-v1', mimeType: 'image/gif', locator: { nativeUrl: expect.any(String) } },
    })
    await expect(store.getMedia(session.platformSessionId, upgradedMediaId)).resolves.toMatchObject({
      media: { id: 'qq-image:original-v1:webm-v1', mimeType: 'video/webm', locator: { cachedPath: expect.any(String) } },
    })
    await expect(store.findProjectedByTlId(
      session.platformSessionId, first.projection[0].tlMessageId, conversation.id,
    )).resolves.toMatchObject({
      parts: [{ mediaId: upgradedMediaId }],
      source: { content: { parts: [{ media: { id: 'qq-image:original-v1:webm-v1' } }] } },
    })
  })

  it('allocates consecutive signed-int IDs independently per durable scope', async () => {
    const { store } = await createStore()
    expect(await store.allocateIds('account:one', 3)).toEqual([1, 2, 3])
    expect(await store.allocateIds('channel:one', 2)).toEqual([1, 2])
    expect(await store.allocateIds('account:one', 2)).toEqual([4, 5])
    await expect(store.allocateIds('account:one', 0)).rejects.toThrow('positive integer')
  })

  it('isolates direct, group, and channel message ID scopes', async () => {
    const { store } = await createStore()
    const direct = { id: 'direct', kind: 'direct' as const, title: 'Direct' }
    const group = { id: 'group', kind: 'group' as const, title: 'Group' }
    const channel = { id: 'channel', kind: 'channel' as const, title: 'Channel' }
    const make = (id: string, conversationId: string): IMMessage => ({
      id, conversationId, senderId: 'sender', timestamp: 1,
      content: { parts: [{ type: 'text', text: id }] },
    })
    expect((await store.ingest(session, direct, make('direct-1', 'direct'))).projection[0].tlMessageId).toBe(0x40000000)
    expect((await store.ingest(session, group, make('group-1', 'group'))).projection[0].tlMessageId).toBe(0x40000000)
    expect((await store.ingest(session, channel, make('channel-1', 'channel'))).projection[0].tlMessageId).toBe(0x40000000)
    expect((await store.ingest(session, channel, make('channel-2', 'channel'))).projection[0].tlMessageId).toBe(0x40000001)
  })

  it('uses the timestamp mapping instead of a platform-provided raw Telegram message ID', async () => {
    const { store } = await createStore()
    const group = { id: 'group', kind: 'group' as const, title: 'Group' }
    const source: IMMessage = {
      id: 'opaque-message', conversationId: 'group', senderId: 'sender', timestamp: 1,
      content: { parts: [{ type: 'text', text: 'hello' }] },
    }
    const projected = await store.ingest(session, group, {
      ...source, metadata: { telegramMessageId: 5_850_634 },
    })
    expect(projected.projection[0]).toMatchObject({
      tlMessageId: 0x40000000,
      scope: `channel:${session.platformSessionId}:group`,
    })
  })

  it('persists independent timestamp epochs for account and channel scopes', async () => {
    const { ctx, store } = await createStore()
    const group = { id: 'group-slots', kind: 'group' as const, title: 'Group slots' }
    const direct = { id: 'direct-slots', kind: 'direct' as const, title: 'Direct slots' }
    const make = (id: string, conversationId: string): IMMessage => ({
      id, conversationId, senderId: 'sender', timestamp: 1,
      metadata: { qqMsgSeq: '1000000', telegramMessageId: 1_000_000 },
      content: { parts: [{ type: 'text', text: id }] },
    })

    const groupResult = await store.ingest(session, group, make('group-message', group.id))
    const directResult = await store.ingest(session, direct, make('direct-message', direct.id))

    expect(groupResult.projection[0]).toMatchObject({
      tlMessageId: 0x40000007,
      nativeSequence: 1_000_000,
      allocationVersion: 1,
      scope: `channel:${session.platformSessionId}:${group.id}`,
    })
    expect(directResult.projection[0]).toMatchObject({
      tlMessageId: 0x40000007,
      nativeSequence: 1_000_000,
      scope: `account:${session.platformSessionId}`,
    })
    expect(await ctx.database.get('mtproto_message_id_epoch', {})).toHaveLength(2)
  })

  it('fills all sixteen slots in a second and probes nearby seconds in both directions', async () => {
    const { store } = await createStore()
    const live = { id: 'slot-live', kind: 'group' as const, title: 'Live slots' }
    const history = { id: 'slot-history', kind: 'group' as const, title: 'History slots' }
    const make = (conversationId: string, index: number): IMMessage => ({
      id: `${conversationId}:${index}`, conversationId, senderId: 'sender', timestamp: 100,
      metadata: { qqMsgSeq: '100' },
      content: { parts: [{ type: 'text', text: String(index) }] },
    })

    const liveIds: number[] = []
    const historyIds: number[] = []
    for (let index = 0; index < 17; index++) {
      liveIds.push((await store.ingest(session, live, make(live.id, index))).projection[0].tlMessageId)
      historyIds.push((await store.ingest(
        session, history, make(history.id, index), { allocation: 'history' },
      )).projection[0].tlMessageId)
    }
    expect(liveIds[0]).toBe(0x40000007)
    expect(historyIds[0]).toBe(0x40000007)
    expect(new Set(liveIds.slice(0, 16))).toEqual(new Set(
      Array.from({ length: 16 }, (_, index) => 0x40000000 + index),
    ))
    expect(new Set(historyIds.slice(0, 16))).toEqual(new Set(
      Array.from({ length: 16 }, (_, index) => 0x40000000 + index),
    ))
    expect(liveIds[16]).toBe(0x40000017)
    expect(historyIds[16]).toBe(0x3ffffff7)
  })

  it('keeps private-chat IDs unique across the whole account when preferred buckets collide', async () => {
    const { store } = await createStore()
    const first = { id: 'direct-one', kind: 'direct' as const, title: 'Direct one' }
    const second = { id: 'direct-two', kind: 'direct' as const, title: 'Direct two' }
    const make = (conversationId: string): IMMessage => ({
      id: `${conversationId}:message`, conversationId, senderId: 'sender', timestamp: 100,
      content: { parts: [{ type: 'text', text: conversationId }] },
    })
    const firstResult = await store.ingest(session, first, make(first.id))
    const secondResult = await store.ingest(session, second, make(second.id))
    const ids = [firstResult, secondResult].map((item) => item.projection[0].tlMessageId)

    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([0x40000000, 0x40000001])
    expect(firstResult.projection[0].scope).toBe(`account:${session.platformSessionId}`)
    expect(secondResult.projection[0].scope).toBe(`account:${session.platformSessionId}`)
  })

  it('keeps historical and live QQ messages ordered regardless of ingestion order', async () => {
    const { store } = await createStore()
    const conversation = { id: 'ordered-qq', kind: 'group' as const, title: 'Ordered QQ' }
    const make = (sequence: number): IMMessage => ({
      id: `message-${sequence}`, conversationId: conversation.id, senderId: 'sender', timestamp: sequence,
      metadata: { qqMsgSeq: String(sequence) },
      content: { parts: [{ type: 'text', text: String(sequence) }] },
    })
    const newest = await store.ingest(session, conversation, make(102))
    const oldest = await store.ingest(session, conversation, make(100), { allocation: 'history' })
    const middle = await store.ingest(session, conversation, make(101), { allocation: 'history' })
    expect([oldest, middle, newest].map((item) => item.projection[0].tlMessageId))
      .toEqual([0x3fffffe7, 0x3ffffff7, 0x40000007])
  })

  it('keeps midpoint slots open for same-second native sequences delivered out of order', async () => {
    const { store } = await createStore()
    const conversation = { id: 'same-second-order', kind: 'group' as const, title: 'Same second order' }
    const make = (sequence: number): IMMessage => ({
      id: `same-second-${sequence}`, conversationId: conversation.id, senderId: 'sender', timestamp: 100,
      metadata: { qqMsgSeq: String(sequence) },
      content: { parts: [{ type: 'text', text: String(sequence) }] },
    })

    const lower = await store.ingest(session, conversation, make(100))
    const upper = await store.ingest(session, conversation, make(102))
    const middle = await store.ingest(session, conversation, make(101))
    const ids = [lower, middle, upper].map((item) => item.projection[0].tlMessageId)

    expect(ids).toEqual([0x40000007, 0x40000009, 0x4000000b])
    expect(ids[0]).toBeLessThan(ids[1])
    expect(ids[1]).toBeLessThan(ids[2])
  })

  it('falls back to a nearby free slot when legacy adjacent IDs leave no ordered gap', async () => {
    const { ctx, store } = await createStore()
    const conversation = { id: 'legacy-tight-gap', kind: 'group' as const, title: 'Legacy tight gap' }
    const make = (sequence: number): IMMessage => ({
      id: `legacy-tight-${sequence}`, conversationId: conversation.id, senderId: 'sender', timestamp: 100,
      metadata: { qqMsgSeq: String(sequence) },
      content: { parts: [{ type: 'text', text: String(sequence) }] },
    })
    const lower = await store.ingest(session, conversation, make(100))
    const upper = await store.ingest(session, conversation, make(102))
    await ctx.database.set('mtproto_tl_message_part', { id: lower.projection[0].id }, {
      tlMessageId: 0x40000000,
    })
    await ctx.database.set('mtproto_tl_message_part', { id: upper.projection[0].id }, {
      tlMessageId: 0x40000001,
    })

    const middle = await store.ingest(session, conversation, make(101))

    expect(middle.projection).toMatchObject([{
      tlMessageId: 0x40000008, nativeSequence: 101, allocationVersion: 1,
    }])
    expect(await ctx.database.get('mtproto_im_message', { conversationId: middle.message.conversationId }))
      .toHaveLength(3)
  })

  it('uses free slots beside a sequenced message for gray service rows without msgSeq', async () => {
    const { store } = await createStore()
    const conversation = { id: 'gray-slots', kind: 'group' as const, title: 'Gray slots' }
    const sequenced: IMMessage = {
      id: 'content', conversationId: conversation.id, senderId: 'sender', timestamp: 100,
      metadata: { qqMsgSeq: '100' },
      content: { parts: [{ type: 'text', text: 'content' }] },
    }
    expect((await store.ingest(session, conversation, sequenced)).projection[0].tlMessageId).toBe(0x40000007)
    const grayIds: number[] = []
    for (let index = 0; index < 16; index++) {
      grayIds.push((await store.ingest(session, conversation, {
        id: `gray-${index}`, conversationId: conversation.id, senderId: 'system', timestamp: 100,
        content: { serviceAction: { type: 'custom', text: `gray ${index}` }, parts: [] },
      })).projection[0].tlMessageId)
    }
    expect(grayIds).toEqual([
      ...Array.from({ length: 7 }, (_, index) => 0x40000000 + index),
      ...Array.from({ length: 9 }, (_, index) => 0x40000008 + index),
    ])
  })

  it('migrates a legacy projection into the timestamp allocation version', async () => {
    const { ctx, store } = await createStore()
    const conversation = { id: 'migration', kind: 'group' as const, title: 'Migration' }
    const source: IMMessage = {
      id: 'message', conversationId: conversation.id, senderId: 'sender', timestamp: 1,
      metadata: { telegramMessageId: 100 },
      content: { parts: [{ type: 'text', text: 'message' }] },
    }
    const initial = await store.ingest(session, conversation, source)
    await ctx.database.set('mtproto_tl_message_part', { id: initial.projection[0].id }, {
      tlMessageId: 100,
      allocationVersion: null,
    })
    const migrated = await store.ingest(session, conversation, {
      ...source, metadata: { telegramMessageId: 100, qqMsgSeq: '100' },
    })
    expect(migrated.projection[0]).toMatchObject({
      tlMessageId: 0x40000007, nativeSequence: 100, allocationVersion: 1,
    })
    await expect(store.findProjectedByTlId(session.platformSessionId, 100, conversation.id)).resolves.toBeUndefined()
    await expect(store.findProjectedByNativeSequence(session.platformSessionId, conversation.id, 100))
      .resolves.toMatchObject({ source: { id: source.id } })
  })

  it('keeps duplicate platform-provided group IDs addressable with a synthetic fallback', async () => {
    const { store } = await createStore()
    const group = { id: 'group', kind: 'group' as const, title: 'Group' }
    const make = (id: string): IMMessage => ({
      id, conversationId: 'group', senderId: 'sender', timestamp: 1,
      metadata: { telegramMessageId: 5_850_634 },
      content: { parts: [{ type: 'text', text: id }] },
    })

    const first = await store.ingest(session, group, make('content-message'), { allocation: 'history' })
    const duplicate = await store.ingest(session, group, make('duplicate-event'), { allocation: 'history' })
    expect(first.projection[0].tlMessageId).toBe(0x40000000)
    expect(duplicate.projection[0].tlMessageId).toBe(0x40000001)
    await expect(store.readProjectedHistory(session.platformSessionId, 'group', { limit: 10 }))
      .resolves.toHaveLength(2)
  })

  it('disambiguates equal direct and group IDs by conversation kind', async () => {
    const { store } = await createStore()
    const direct = { id: 'direct', kind: 'direct' as const, title: 'Direct' }
    const group = { id: 'group', kind: 'group' as const, title: 'Group' }
    const make = (id: string, conversationId: string): IMMessage => ({
      id, conversationId, senderId: 'sender', timestamp: 1,
      content: { parts: [{ type: 'text', text: id }] },
    })
    const directResult = await store.ingest(session, direct, make('direct-message', 'direct'))
    await store.ingest(session, group, {
      ...make('group-message', 'group'), metadata: { telegramMessageId: directResult.projection[0].tlMessageId },
    })

    await expect(store.findProjectedByTlId(
      session.platformSessionId, directResult.projection[0].tlMessageId, undefined, 'direct',
    )).resolves.toMatchObject({ source: { id: 'direct-message' } })
    await expect(store.findProjectedByTlId(
      session.platformSessionId, directResult.projection[0].tlMessageId, undefined, 'group',
    )).resolves.toMatchObject({ source: { id: 'group-message' } })
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
      .toEqual([0x40000000, 0x3fffff60, 0x3ffffec0])
    expect((await store.readProjectedHistory(session.platformSessionId, conversation.id, { limit: 2 }))
      .map((item) => item.source.id)).toEqual(['latest', 'older'])
    expect((await store.readProjectedHistory(session.platformSessionId, conversation.id, {
      limit: 2, beforeTimestamp: 90,
    })).map((item) => item.source.id)).toEqual(['oldest'])
  })

  it('ingests a history page as one ordered batch', async () => {
    const { ctx, store } = await createStore()
    const conversation = { id: 'batch', kind: 'direct' as const, title: 'Batch' }
    const messages = Array.from({ length: 50 }, (_, index): IMMessage => ({
      id: `message-${index}`,
      conversationId: conversation.id,
      senderId: 'sender',
      timestamp: 100 - index,
      content: { parts: [{ type: 'text', text: `message ${index}` }] },
    }))

    const results = await store.ingestMany(session, conversation, messages, { allocation: 'history' })

    expect(results).toHaveLength(50)
    expect(await ctx.database.get('mtproto_im_conversation', {})).toHaveLength(1)
    expect(await ctx.database.get('mtproto_im_message', {})).toHaveLength(50)
    expect((await store.readHistory(session.platformSessionId, conversation.id, { limit: 50 }))
      .map((message) => message.id)).toEqual(messages.map((message) => message.id))
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
    expect(await store.getUpdateDeliveriesAfter(session.platformSessionId, 1)).toEqual([first, second])
    expect(await ctx.database.get('mtproto_update_delivery', {})).toEqual([])
  })

  it('persists and hydrates content.serviceAction', async () => {
    const { ctx, store } = await createStore()
    const conversation: IMConversation = { id: 'direct', kind: 'direct', title: 'Direct' }
    const message: IMMessage = {
      id: 'service', conversationId: conversation.id, senderId: 'alice', timestamp: 1,
      content: { serviceAction: { type: 'custom', text: 'Alice sent a message' }, parts: [] },
      metadata: { source: 'qq' },
    }

    const result = await store.ingest(session, conversation, message)
    expect(result.projection).toHaveLength(1)
    const [stored] = await ctx.database.get('mtproto_im_message', { id: result.message.id })
    expect(stored).toMatchObject({ content: message.content, metadata: { source: 'qq' } })
    const [hydrated] = await store.readHistory(session.platformSessionId, conversation.id)
    expect(hydrated).toMatchObject({ id: message.id, content: message.content, metadata: { source: 'qq' } })
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
