import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry } from './platform-manager.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { UpdateManager } from './update-manager.js'

const session: PlatformSession = {
  platformSessionId: 'updates-session', platformId: 'updates-platform', userId: 'self',
  credentials: {}, metadata: { firstName: 'Current' },
}

const platform: IMPlatform = {
  capabilities: {
    history: false,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getUser(_session, id) {
    return {
      id, firstName: `User ${id}`,
      avatar: { id: `avatar-${id}`, kind: 'image' as const, locator: { userId: id } },
    }
  },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness(updateDeliveryRetention?: number) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  await ctx.database.create('mtproto_auth_binding', {
    authKeyId: '0011223344556677', platformId: session.platformId, platformSessionId: session.platformSessionId,
  })
  await ctx.database.create('mtproto_auth_binding', {
    authKeyId: '8899aabbccddeeff', platformId: session.platformId, platformSessionId: 'other-session',
  })
  const sent: Array<{ authKeyId: Uint8Array, update: tl.TypeUpdates }> = []
  const store = new MessageStore(ctx.database, updateDeliveryRetention)
  const manager = new UpdateManager(
    ctx.database, new PlatformRegistry([[session.platformId, platform]]), store,
    (authKeyId, update) => sent.push({ authKeyId, update }),
  )
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store, manager, sent }
}

function roundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('UpdateManager', () => {
  it('advances persisted state and targets only auth keys bound to the source platform session', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = {
      id: 'group', kind: 'group', title: 'Group',
      avatar: { id: 'avatar-group', kind: 'image', locator: { conversationId: 'group' } },
    }
    const message: IMMessage = {
      id: 'incoming', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_000,
      sender: {
        id: 'alice',
        firstName: 'Group Alias',
        avatar: { id: 'avatar-alias', kind: 'image', locator: { userId: 'alice' } },
      },
      content: { parts: [{ type: 'text', text: 'pushed' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0].authKeyId).toString('hex')).toBe('0011223344556677')
    expect(sent[0].update).toMatchObject({
      _: 'updates', seq: 1,
      updates: [{ _: 'updateNewChannelMessage', pts: 2, ptsCount: 1, message: { message: 'pushed' } }],
      chats: [{ _: 'channel', title: 'Group', megagroup: true, photo: { _: 'chatPhoto', dcId: 1 } }],
      users: [
        { _: 'user', self: true },
        { _: 'user', firstName: 'Group Alias', photo: { _: 'userProfilePhoto', dcId: 1 } },
      ],
    })
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })
    expect(() => roundTrip(sent[0].update)).not.toThrow()

    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(sent).toHaveLength(1)
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })
  })

  it('emits one update per mixed-media projection without an invalid Telegram album', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'channel', kind: 'channel', title: 'Channel' }
    const message: IMMessage = {
      id: 'album', conversationId: conversation.id, senderId: 'alice', timestamp: 10,
      content: {
        parts: [
          { type: 'text', text: 'caption' },
          { type: 'media', media: { id: 'one', kind: 'image', locator: null } },
          { type: 'media', media: { id: 'two', kind: 'file', name: 'two.bin', locator: null } },
        ],
      },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    const payload = sent[0].update as tl.RawUpdates
    expect(payload.updates).toHaveLength(2)
    expect(payload.updates.map((update) => update._)).toEqual([
      'updateNewChannelMessage', 'updateNewChannelMessage',
    ])
    const messages = payload.updates.map((update) => (update as tl.RawUpdateNewChannelMessage).message as tl.RawMessage)
    expect(messages.map((item) => item.groupedId)).toEqual([undefined, undefined])
    expect(messages.map((item) => item.message)).toEqual(['caption', ''])
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 3, seq: 1 })
  })

  it('publishes subchannel events through the parent forum and topic root', async () => {
    const { store, manager, sent } = await createHarness()
    const parent: IMConversation = { id: 'general', kind: 'channel', title: 'General' }
    const thread: IMConversation = {
      id: 'support', kind: 'channel', title: 'Support', parentId: parent.id, spaceId: 'guild',
    }
    await store.upsertConversation(session, parent)
    const root: IMMessage = {
      id: 'thread-root', conversationId: thread.id, senderId: 'alice', timestamp: 10,
      content: { parts: [{ type: 'text', text: 'root' }] },
    }
    const rootResult = await store.ingest(session, thread, root)
    await manager.publish(session, { event: { type: 'message', conversation: thread, message: root }, result: rootResult })
    const reply: IMMessage = {
      id: 'thread-reply', conversationId: thread.id, senderId: 'alice', timestamp: 11,
      content: { parts: [{ type: 'text', text: 'reply' }] },
    }
    const replyResult = await store.ingest(session, thread, reply)
    await manager.publish(session, { event: { type: 'message', conversation: thread, message: reply }, result: replyResult })

    const rootId = rootResult.projection[0].tlMessageId
    expect(sent[0].update).toMatchObject({
      updates: [{
        _: 'updateNewChannelMessage',
        message: { id: rootId, peerId: { _: 'peerChannel', channelId: stableId('peer:general') } },
      }],
      chats: [{ _: 'channel', id: stableId('peer:general'), title: 'General', forum: true }],
    })
    expect(sent[1].update).toMatchObject({
      updates: [{
        _: 'updateNewChannelMessage',
        message: {
          peerId: { _: 'peerChannel', channelId: stableId('peer:general') },
          replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToTopId: rootId },
        },
      }],
    })
    expect(() => roundTrip(sent[1].update)).not.toThrow()
  })

  it('persists edits, tombstones deletes, and publishes each mutation exactly once', async () => {
    const { ctx, store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'mutations', kind: 'group', title: 'Mutations' }
    const original: IMMessage = {
      id: 'mutable-message', conversationId: conversation.id, senderId: 'alice', timestamp: 30,
      content: { parts: [{ type: 'text', text: 'original' }] },
    }
    const created = await store.ingest(session, conversation, original)
    await manager.publish(session, { event: { type: 'message', conversation, message: original }, result: created })
    const tlMessageId = created.projection[0].tlMessageId

    const edited: IMMessage = {
      ...original,
      content: { parts: [{ type: 'text', text: 'edited' }] },
      metadata: { revision: 2 },
    }
    const editResult = await store.ingest(session, conversation, edited)
    expect(editResult).toMatchObject({ created: false, changed: true })
    await manager.publish(session, {
      event: { type: 'message-edit', eventId: 'edit-2', conversation, message: edited },
      result: editResult,
    })
    expect((sent[1].update as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateEditChannelMessage', pts: 3, ptsCount: 1,
      message: { id: tlMessageId, message: 'edited' },
    }])
    expect((await store.readHistory(session.platformSessionId, conversation.id))[0])
      .toMatchObject({ id: original.id, content: edited.content })

    const duplicateEdit = await store.ingest(session, conversation, edited)
    expect(duplicateEdit.changed).toBe(false)
    await manager.publish(session, {
      event: { type: 'message-edit', eventId: 'edit-2', conversation, message: edited },
      result: duplicateEdit,
    })
    expect(sent).toHaveLength(2)

    const deleted = await store.deleteMessages(session, conversation, [original.id])
    expect(deleted).toMatchObject({ changed: true, tlMessageIds: [tlMessageId] })
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'delete-1', conversation,
        messageIds: [original.id], timestamp: 31,
      },
      result: deleted,
    })
    expect((sent[2].update as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateDeleteChannelMessages', messages: [tlMessageId], pts: 4, ptsCount: 1,
    }])
    expect(await store.readHistory(session.platformSessionId, conversation.id)).toEqual([])
    expect(await store.findProjectedByTlId(session.platformSessionId, tlMessageId, conversation.id)).toBeUndefined()
    const [stored] = await ctx.database.get('mtproto_im_message', { id: created.message.id })
    expect(stored).toMatchObject({ text: 'edited', deleted: true })

    const duplicateDelete = await store.deleteMessages(session, conversation, [original.id])
    expect(duplicateDelete).toMatchObject({ changed: false, tlMessageIds: [tlMessageId] })
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'delete-1', conversation,
        messageIds: [original.id], timestamp: 31,
      },
      result: duplicateDelete,
    })
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'delete-duplicate', conversation,
        messageIds: [original.id], timestamp: 31,
      },
      result: duplicateDelete,
    })
    expect(sent).toHaveLength(3)
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 4, seq: 3 })
  })

  it('reuses the reserved pts and retries delivery after a send failure', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const conversation: IMConversation = { id: 'retry', kind: 'direct', title: 'Retry' }
    const message: IMMessage = {
      id: 'retry-message', conversationId: conversation.id, senderId: 'alice', timestamp: 20,
      content: { parts: [{ type: 'text', text: 'retry me' }] },
    }
    const result = await store.ingest(session, conversation, message)
    const failing = new UpdateManager(ctx.database, registry, store, () => { throw new Error('socket failed') })
    await expect(failing.publish(session, { event: { type: 'message', conversation, message }, result }))
      .rejects.toThrow('socket failed')
    expect(await failing.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })

    const retried: tl.TypeUpdates[] = []
    const retrying = new UpdateManager(ctx.database, registry, store, (_key, update) => retried.push(update))
    await retrying.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(retried).toMatchObject([{ _: 'updates', seq: 1, updates: [{ pts: 2 }] }])
    expect(await retrying.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })
  })

  it('keeps offline updates pending and replays them when a bound connection returns', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const sent: tl.TypeUpdates[] = []
    let online = false
    const manager = new UpdateManager(ctx.database, registry, store, (_key, update) => {
      if (!online) return 0
      sent.push(update)
      return 1
    })
    const conversation: IMConversation = { id: 'offline', kind: 'group', title: 'Offline' }
    const message: IMMessage = {
      id: 'offline-message', conversationId: conversation.id, senderId: 'alice', timestamp: 40,
      content: { parts: [{ type: 'text', text: 'persist before push' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent).toHaveLength(0)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toMatchObject([{
      published: false, pts: 2, payload: expect.any(String),
    }])
    online = true
    await expect(manager.retryPending(session.platformSessionId)).resolves.toBe(1)
    expect(sent).toMatchObject([{
      _: 'updates', seq: 1,
      updates: [{ _: 'updateNewChannelMessage', pts: 2, message: { message: 'persist before push' } }],
    }])
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toEqual([])
  })

  it('recovers journaled messages and mutations through updates.getDifference', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const manager = new UpdateManager(ctx.database, registry, store, () => 0)
    const conversation: IMConversation = { id: 'difference', kind: 'direct', title: 'Difference' }
    const original: IMMessage = {
      id: 'difference-message', conversationId: conversation.id, senderId: 'alice', timestamp: 50,
      content: { parts: [{ type: 'text', text: 'original' }] },
    }
    const created = await store.ingest(session, conversation, original)
    await manager.publish(session, { event: { type: 'message', conversation, message: original }, result: created })
    const edited = { ...original, content: { parts: [{ type: 'text' as const, text: 'edited' }] } }
    const changed = await store.ingest(session, conversation, edited)
    await manager.publish(session, {
      event: { type: 'message-edit', eventId: 'difference-edit', conversation, message: edited }, result: changed,
    })

    const difference = await manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })
    expect(difference).toMatchObject({
      _: 'updates.difference',
      newMessages: [{ _: 'message', message: 'original' }],
      otherUpdates: [{ _: 'updateEditMessage', message: { message: 'edited' } }],
      state: { pts: 3, seq: 2 },
    })
    expect(() => roundTrip(difference)).not.toThrow()
  })

  it('bounds the update journal and reports differenceTooLong across a pruned pts gap', async () => {
    const { ctx, store } = await createHarness(3)
    const manager = new UpdateManager(
      ctx.database,
      new PlatformRegistry([[session.platformId, platform]]),
      store,
      () => 0,
    )
    const conversation: IMConversation = { id: 'bounded', kind: 'direct', title: 'Bounded' }
    for (let index = 1; index <= 4; index++) {
      const message: IMMessage = {
        id: `bounded-${index}`,
        conversationId: conversation.id,
        senderId: 'alice',
        timestamp: 100 + index,
        content: { parts: [{ type: 'text', text: `message ${index}` }] },
      }
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    }

    const retained = await store.getUpdateDeliveriesAfter(session.platformSessionId, 1)
    expect(retained.map((delivery) => delivery.pts)).toEqual([3, 4, 5])
    await expect(manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })).resolves.toEqual({ _: 'updates.differenceTooLong', pts: 5 })
  })

  it('keeps state but reports differenceTooLong after the in-memory journal is restarted', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const manager = new UpdateManager(ctx.database, registry, store, () => 0)
    const conversation: IMConversation = { id: 'restart-gap', kind: 'direct', title: 'Restart Gap' }
    const message: IMMessage = {
      id: 'restart-gap-message', conversationId: conversation.id, senderId: 'alice', timestamp: 200,
      content: { parts: [{ type: 'text', text: 'lost with process memory' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })

    const restartedStore = new MessageStore(ctx.database)
    const restarted = new UpdateManager(ctx.database, registry, restartedStore, () => 0)
    expect(await restartedStore.getUpdateDeliveriesAfter(session.platformSessionId, 1)).toEqual([])
    await expect(restarted.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })).resolves.toEqual({ _: 'updates.differenceTooLong', pts: 2 })
  })
})
