import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
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
  async getUser(_session, id) { return { id, firstName: `User ${id}` } },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness() {
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
  const store = new MessageStore(ctx.database)
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
  it('advances durable state and targets only auth keys bound to the source platform session', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'group', kind: 'group', title: 'Group' }
    const message: IMMessage = {
      id: 'incoming', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_000,
      content: { parts: [{ type: 'text', text: 'pushed' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0].authKeyId).toString('hex')).toBe('0011223344556677')
    expect(sent[0].update).toMatchObject({
      _: 'updates', seq: 1,
      updates: [{ _: 'updateNewMessage', pts: 2, ptsCount: 1, message: { message: 'pushed' } }],
      chats: [{ _: 'chat', title: 'Group' }],
      users: [{ _: 'user', self: true }, { _: 'user', firstName: 'User alice' }],
    })
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })
    expect(() => roundTrip(sent[0].update)).not.toThrow()

    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(sent).toHaveLength(1)
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })
  })

  it('emits one update per media projection with a shared grouped ID', async () => {
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
    expect(messages[0].groupedId?.toString()).toBe(messages[1].groupedId?.toString())
    expect(messages.map((item) => item.message)).toEqual(['caption', ''])
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 3, seq: 1 })
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
      _: 'updateEditMessage', pts: 3, ptsCount: 1,
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
      _: 'updateDeleteMessages', messages: [tlMessageId], pts: 4, ptsCount: 1,
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
})
