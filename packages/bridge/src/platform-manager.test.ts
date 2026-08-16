import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import {
  IMPlatformService, migrateQualifiedPlatformIds, PlatformDataService, PlatformRegistry, PlatformSubscriptionManager,
} from './platform-manager.js'
import { UpdateManager } from './update-manager.js'
import type {
  IMConversation, IMEvent, IMMessage, IMMessageInput, IMPlatform, IMRequest, PlatformCapabilities,
  PlatformSession, Unsubscribe,
} from './platform.js'

const capabilities: PlatformCapabilities = {
  history: false,
  send: { text: true, images: true, files: true, mixed: true, maxTextLength: 10_000, maxMedia: 10 },
  conversations: { groups: true, channels: true, subchannels: true },
}

const session: PlatformSession = {
  platformSessionId: 'session-one', platformId: 'push', userId: 'self', credentials: {}, metadata: {},
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

class PushPlatform implements IMPlatform {
  readonly capabilities: PlatformCapabilities = {
    ...capabilities,
    send: { ...capabilities.send },
    conversations: { ...capabilities.conversations },
  }
  subscribeCalls = 0
  unsubscribeCalls = 0
  getDialogs?: IMPlatform['getDialogs']
  getRequests?: IMPlatform['getRequests']
  getHistory?: IMPlatform['getHistory']
  private _handler?: (event: IMEvent) => void | Promise<void>

  async subscribe(_session: PlatformSession, handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe> {
    this.subscribeCalls++
    this._handler = handler
    return async () => {
      this.unsubscribeCalls++
      this._handler = undefined
    }
  }

  async sendMessage(_session: PlatformSession, conversation: { id: string }, content: IMMessageInput): Promise<IMMessage> {
    return {
      id: 'sent', conversationId: conversation.id, senderId: 'self', content: content as any,
      timestamp: 200, outgoing: true,
    }
  }

  async emit(event: IMEvent): Promise<void> {
    if (!this._handler) throw new Error('not subscribed')
    await this._handler(event)
  }
}

class QQPlatform extends PushPlatform {
  readonly platformKind = 'qq'
}

function incoming(id: string, conversationId = 'room'): IMMessage {
  return {
    id, conversationId, senderId: 'alice', timestamp: Number(id.replace(/\D/g, '')) || 1,
    content: { parts: [{ type: 'text', text: `message-${id}` }] },
  }
}

describe('PlatformSubscriptionManager', () => {
  it('delivers voice calls transiently without persisting their exact platform reference', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: unknown[] = []
    const ingest = vi.spyOn(store, 'ingest')
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, value) => { committed.push(value) },
    )
    const conversation: IMConversation = { id: 'alice', kind: 'direct', title: 'Alice' }
    await manager.ensure(session)

    await platform.emit({
      type: 'voice-call', callRef: 'exact-opaque-call-ref', signal: 'incoming', media: 'voice',
      conversation, timestamp: 123,
    })

    expect(committed).toEqual([{ event: {
      type: 'voice-call', callRef: 'exact-opaque-call-ref', signal: 'incoming', media: 'voice',
      conversation, timestamp: 123,
    } }])
    expect(ingest).not.toHaveBeenCalled()
    expect(await store.readHistory(session.platformSessionId, conversation.id)).toEqual([])
    await manager.stop()
  })

  it('turns QQ deletes into idempotent strikethrough edits while other platforms still delete', async () => {
    const database = await createDatabase()
    const qq = new QQPlatform()
    const other = new PushPlatform()
    const qqSession = { ...session, platformId: 'qq' }
    const otherSession = { ...session, platformSessionId: 'other-session' }
    const registry = new PlatformRegistry([['qq', qq] as const, ['push', other] as const])
    const store = new MessageStore(database)
    const sent: tl.TypeUpdates[] = []
    let throwRecallDelivery = false
    await database.create('mtproto_auth_binding', {
      authKeyId: '0011223344556677', platformId: qqSession.platformId,
      platformSessionId: qqSession.platformSessionId,
    })
    await database.create('mtproto_auth_binding', {
      authKeyId: '8899aabbccddeeff', platformId: otherSession.platformId,
      platformSessionId: otherSession.platformSessionId,
    })
    const updates = new UpdateManager(database, registry, store, (_authKeyId, update) => {
      if (throwRecallDelivery && (update as tl.RawUpdates).updates.some((item) =>
        item._ === 'updateEditMessage' || item._ === 'updateEditChannelMessage')) {
        throwRecallDelivery = false
        throw new Error('recall delivery failed')
      }
      sent.push(update)
      return 1
    })
    const manager = new PlatformSubscriptionManager(
      database, registry, store, undefined,
      (activeSession, event, options) => updates.publish(activeSession, event, options),
    )
    const conversation: IMConversation = { id: 'recall-room', kind: 'group', title: 'Recall Room' }
    const recalled: IMMessage = {
      id: 'qq-recalled', conversationId: conversation.id, senderId: 'alice', timestamp: 1,
      content: { parts: [
        { type: 'text', text: 'first' },
        { type: 'media', media: { id: 'photo', kind: 'image' } },
        { type: 'text', text: 'second' },
      ] },
    }
    await manager.ensure(qqSession)
    await manager.ensure(otherSession)
    await qq.emit({ type: 'message', conversation, message: recalled })
    await qq.emit({
      type: 'message-delete', eventId: 'qq-recall', conversation,
      messageIds: [recalled.id], timestamp: 2,
    })

    const original = ((sent[0] as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage).message
    const edit = ((sent[1] as tl.RawUpdates).updates[0] as tl.RawUpdateEditChannelMessage).message
    expect(edit).toMatchObject({
      id: original.id,
      message: 'first\nsecond',
      entities: [
        { _: 'messageEntityStrike', offset: 0, length: 5 },
        { _: 'messageEntityStrike', offset: 6, length: 6 },
      ],
    })
    expect(await store.readHistory(qqSession.platformSessionId, conversation.id)).toMatchObject([{
      id: recalled.id,
      content: { parts: [
        { type: 'text', entities: [{ type: 'strikethrough', offset: 0, length: 5 }] },
        { type: 'media' },
        { type: 'text', entities: [{ type: 'strikethrough', offset: 0, length: 6 }] },
      ] },
    }])

    await qq.emit({
      type: 'message-delete', eventId: 'qq-recall-duplicate', conversation,
      messageIds: [recalled.id], timestamp: 3,
    })
    expect(sent).toHaveLength(2)

    const multiFirst: IMMessage = {
      id: 'qq-multi-first', conversationId: conversation.id, senderId: 'alice', timestamp: 4,
      content: { parts: [{ type: 'text', text: 'first recall target' }] },
    }
    const multiSecond: IMMessage = {
      id: 'qq-multi-second', conversationId: conversation.id, senderId: 'alice', timestamp: 5,
      content: { parts: [{ type: 'text', text: 'second recall target' }] },
    }
    await qq.emit({ type: 'message', conversation, message: multiFirst })
    await qq.emit({ type: 'message', conversation, message: multiSecond })
    const multiOriginalIds = sent.slice(-2).map((payload) =>
      ((payload as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage).message.id)
    const beforeMultiRecall = sent.length
    await qq.emit({
      type: 'message-delete', eventId: 'qq-multi-recall', conversation,
      messageIds: [multiFirst.id, multiSecond.id], timestamp: 6,
    })
    const multiEdits = sent.slice(beforeMultiRecall).map((payload) =>
      (payload as tl.RawUpdates).updates[0] as tl.RawUpdateEditChannelMessage)
    expect(multiEdits).toHaveLength(2)
    expect(multiEdits.map((update) => update.message.id).sort((left, right) => left - right))
      .toEqual(multiOriginalIds.sort((left, right) => left - right))
    expect(multiEdits.map((update) => (update.message as tl.RawMessage).entities)).toEqual([
      [{ _: 'messageEntityStrike', offset: 0, length: 'first recall target'.length }],
      [{ _: 'messageEntityStrike', offset: 0, length: 'second recall target'.length }],
    ])
    await qq.emit({
      type: 'message-delete', eventId: 'qq-multi-recall-duplicate', conversation,
      messageIds: [multiFirst.id, multiSecond.id], timestamp: 7,
    })
    expect(sent).toHaveLength(beforeMultiRecall + 2)

    const retry: IMMessage = {
      id: 'qq-retry', conversationId: conversation.id, senderId: 'alice', timestamp: 8,
      content: { parts: [{ type: 'text', text: 'retry me' }] },
    }
    const beforeRetryRecall = sent.length
    await qq.emit({ type: 'message', conversation, message: retry })
    throwRecallDelivery = true
    const retryRecall = {
      type: 'message-delete' as const, eventId: 'qq-retry-recall', conversation,
      messageIds: [retry.id], timestamp: 9,
    }
    await expect(qq.emit(retryRecall)).rejects.toThrow('recall delivery failed')
    expect(sent).toHaveLength(beforeRetryRecall + 1)
    await qq.emit(retryRecall)
    expect(sent).toHaveLength(beforeRetryRecall + 2)
    expect((sent.at(-1) as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateEditChannelMessage', message: { message: 'retry me' },
    }])
    await qq.emit({
      ...retryRecall, eventId: 'qq-retry-recall-duplicate', timestamp: 10,
    })
    expect(sent).toHaveLength(beforeRetryRecall + 2)

    const mediaOnly: IMMessage = {
      id: 'qq-media-only', conversationId: conversation.id, senderId: 'alice', timestamp: 8,
      content: { parts: [{ type: 'media', media: { id: 'photo-only', kind: 'image' } }] },
    }
    await qq.emit({ type: 'message', conversation, message: mediaOnly })
    const beforeIgnoredDeletes = sent.length
    await qq.emit({
      type: 'message-delete', eventId: 'qq-unmapped', conversation,
      messageIds: ['unmapped'], timestamp: 9,
    })
    await qq.emit({
      type: 'message-delete', eventId: 'qq-media-only', conversation,
      messageIds: [mediaOnly.id], timestamp: 10,
    })
    expect(sent).toHaveLength(beforeIgnoredDeletes)
    const storedMediaOnly = (await store.readHistory(qqSession.platformSessionId, conversation.id))
      .find((message) => message.id === mediaOnly.id)
    expect(storedMediaOnly).toMatchObject({
      id: mediaOnly.id, content: { parts: [{ type: 'media' }] },
    })

    const localDelete = incoming('qq-local-delete', conversation.id)
    await manager.ingestLocalEvent(qqSession, { type: 'message', conversation, message: localDelete }, {
      deliveredViaRpc: true,
    })
    const localReplacement = incoming('qq-local-replacement', conversation.id)
    await manager.ingestLocalEvent(qqSession, { type: 'message', conversation, message: localReplacement }, {
      deliveredViaRpc: true,
    })
    await manager.ingestLocalEvent(qqSession, {
      type: 'message-delete', eventId: 'local-delete:qq-local-delete', conversation,
      messageIds: [localDelete.id], timestamp: 11,
    }, { deliveredViaRpc: true })
    await manager.ingestLocalEvent(qqSession, {
      type: 'message-delete', eventId: 'local-edit-replace:qq-local-replacement:replacement', conversation,
      messageIds: [localReplacement.id], timestamp: 12,
    }, { deliveredViaRpc: true })
    expect((sent.at(-1) as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateDeleteChannelMessages', messages: expect.any(Array),
    }])
    expect(await store.readHistory(qqSession.platformSessionId, conversation.id)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: localDelete.id }),
      expect.objectContaining({ id: localReplacement.id }),
    ]))

    const normal = incoming('normal-delete', conversation.id)
    await other.emit({ type: 'message', conversation, message: normal })
    await other.emit({
      type: 'message-delete', eventId: 'normal-delete', conversation,
      messageIds: [normal.id], timestamp: 13,
    })
    expect((sent.at(-1) as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateDeleteChannelMessages', messages: expect.any(Array),
    }])
    expect(await store.readHistory(otherSession.platformSessionId, conversation.id)).toEqual([])
    await manager.stop()
  })

  it('subscribes once, persists before resolving, and can stop and restart one platform', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const manager = new PlatformSubscriptionManager(database, new PlatformRegistry([['push', platform]]), store)
    const conversation: IMConversation = { id: 'room', kind: 'group', title: 'Push room' }

    await Promise.all([manager.ensure(session), manager.ensure(session), manager.ensure(session)])
    expect(platform.subscribeCalls).toBe(1)
    await platform.emit({ type: 'message', conversation, message: incoming('event-1') })

    expect(await store.readHistory(session.platformSessionId, conversation.id)).toMatchObject([
      { id: 'event-1', conversationId: 'room', content: { parts: [{ type: 'text', text: 'message-event-1' }] } },
    ])
    await manager.stopPlatform(session.platformId)
    expect(platform.unsubscribeCalls).toBe(1)
    await manager.ensure(session)
    expect(platform.subscribeCalls).toBe(2)
    await manager.stop()
    expect(platform.unsubscribeCalls).toBe(2)
  })

  it('serializes concurrent callback deliveries and deduplicates repeated platform IDs', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const manager = new PlatformSubscriptionManager(database, new PlatformRegistry([['push', platform]]), store)
    const conversation: IMConversation = { id: 'channel', kind: 'channel', title: 'Channel' }
    await manager.ensure(session)

    await Promise.all([
      platform.emit({ type: 'message', conversation, message: incoming('1', 'channel') }),
      platform.emit({ type: 'message', conversation, message: incoming('2', 'channel') }),
      platform.emit({ type: 'message', conversation, message: incoming('2', 'channel') }),
    ])
    expect((await store.readHistory(session.platformSessionId, 'channel')).map((message) => message.id))
      .toEqual(['2', '1'])
    await manager.stop()
  })

  it('serializes locally produced replacement events with subscribed platform events', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: IMEvent[] = []
    const deliveryOptions: unknown[] = []
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, value, options) => {
        committed.push(value.event)
        deliveryOptions.push(options)
        return {
          _: 'updates', updates: [], users: [], chats: [],
          date: value.event.type === 'message-delete' ? 1 : 2,
          seq: value.event.type === 'message-delete' ? 1 : 2,
        } satisfies tl.RawUpdates
      },
    )
    const conversation: IMConversation = { id: 'room', kind: 'group', title: 'Room' }
    await manager.ensure(session)
    await platform.emit({ type: 'message', conversation, message: incoming('original') })
    committed.length = 0
    deliveryOptions.length = 0

    const replacement = {
      ...incoming('replacement'), outgoing: true, senderId: 'self',
      content: { parts: [{ type: 'text' as const, text: 'replacement body' }] },
    }
    const options = { excludeAuthKeyId: 'requester', deliveredViaRpc: true }
    const published = await Promise.all([
      manager.ingestLocalEvent(session, {
        type: 'message-delete', eventId: 'local-edit:original:replacement', conversation,
        messageIds: ['original'], timestamp: 2,
      }, options),
      manager.ingestLocalEvent(session, { type: 'message', conversation, message: replacement }, options),
    ])

    expect(committed.map((event) => event.type)).toEqual(['message-delete', 'message'])
    expect(deliveryOptions).toEqual([options, options])
    expect(published).toMatchObject([{ _: 'updates', seq: 1 }, { _: 'updates', seq: 2 }])
    expect(await store.readHistory(session.platformSessionId, conversation.id)).toMatchObject([
      { id: 'replacement', content: { parts: [{ type: 'text', text: 'replacement body' }] } },
    ])
    await manager.stop()
  })

  it('commits platform read events only after resolving their stored Telegram boundary', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: unknown[] = []
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, event) => { committed.push(event) },
    )
    const conversation: IMConversation = { id: 'room', kind: 'group', title: 'Room' }
    await manager.ensure(session)
    await platform.emit({ type: 'message', conversation, message: incoming('1') })
    await platform.emit({ type: 'message', conversation, message: incoming('2') })
    committed.length = 0

    await platform.emit({ type: 'read', conversationId: 'room', upToMessageId: '1' })

    expect(committed).toMatchObject([{
      event: { type: 'read', conversationId: 'room', upToMessageId: '1' },
      result: { conversation: { id: 'room' }, message: { id: '1' }, unreadCount: 1 },
    }])
    expect(await store.listDialogs(session.platformSessionId)).toMatchObject([{
      conversation: { id: 'room' }, unreadCount: 1,
    }])
    committed.length = 0
    await platform.emit({ type: 'read', conversationId: 'room', upToMessageId: 'missing' })
    expect(committed).toEqual([])
    await manager.stop()
  })

  it('serializes one thousand concurrent pushed messages without dropping database projections', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), new MessageStore(database),
    )
    const conversation: IMConversation = { id: 'burst-group', kind: 'group', title: 'Burst Group' }
    await manager.ensure(session)

    await Promise.all(Array.from({ length: 1_000 }, (_, index) => platform.emit({
      type: 'message',
      conversation,
      message: incoming(String(index + 1), conversation.id),
    })))

    expect(await database.get('mtproto_im_message', {})).toHaveLength(1_000)
    expect(await database.get('mtproto_im_message_alias', {})).toHaveLength(1_000)
    expect(await database.get('mtproto_tl_message_part', {})).toHaveLength(1_000)
    await manager.stop()
  }, 15_000)

  it('starts subscriptions for active persisted sessions only', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    await database.create('mtproto_platform_session', {
      id: session.platformSessionId, platformId: session.platformId, userId: 'self', credentials: {}, metadata: {},
      active: true, createdAt: new Date(),
    })
    await database.create('mtproto_platform_session', {
      id: 'inactive', platformId: session.platformId, userId: 'self', credentials: {}, metadata: {},
      active: false, createdAt: new Date(),
    })
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), new MessageStore(database),
    )
    await manager.startActiveSessions()
    expect(platform.subscribeCalls).toBe(1)
    await manager.stop()
  })
  it('recovers messages missed before subscription startup through the committed update pipeline', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'restart-room', kind: 'group', title: 'Restart room' }
    const store = new MessageStore(database)
    await store.ingest(session, conversation, incoming('1', conversation.id))
    platform.getDialogs = vi.fn(async () => ({
      dialogs: [{ conversation, unreadCount: 2, lastMessage: incoming('3', conversation.id) }],
    }))
    platform.getHistory = vi.fn(async () => ({
      messages: [incoming('3', conversation.id), incoming('2', conversation.id)],
    }))
    const committed: Array<{ event: IMEvent }> = []
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, event) => { committed.push(event) },
    )

    await manager.ensure(session)
    await vi.waitFor(() => expect(committed).toHaveLength(2))

    expect(committed.map(({ event }) => event.type === 'message' ? event.message.id : event.type))
      .toEqual(['2', '3'])
    expect(committed.map(({ event }) => event.type === 'message' ? event.delivery : undefined))
      .toEqual(['recovery', 'recovery'])
    await expect(store.readHistory(session.platformSessionId, conversation.id, { limit: 10 }))
      .resolves.toMatchObject([{ id: '3' }, { id: '2' }, { id: '1' }])
    await manager.stop()
  })

})

describe('PlatformDataService', () => {
  it('serves persisted dialogs when the upstream bridge is temporarily unavailable', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'offline-dialog-room', kind: 'group', title: 'Offline dialog' }
    const store = new MessageStore(database)
    await store.ingest(session, conversation, incoming('stored-latest', conversation.id))
    platform.getDialogs = vi.fn(async () => { throw new Error('upstream kernel is not ready') })
    const data = new PlatformDataService(platform, session, store)

    await expect(data.getDialogsPage({ limit: 100 })).resolves.toMatchObject({
      total: 1,
      dialogs: [{
        conversation: { id: conversation.id, title: conversation.title },
        lastMessage: { id: 'stored-latest' },
      }],
    })
  })

  it('waits for the authoritative upstream page instead of returning stale persisted dialogs', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'slow-dialog-room', kind: 'group', title: 'Slow dialog' }
    const store = new MessageStore(database)
    await store.ingest(session, conversation, incoming('stored-latest', conversation.id))
    const release = Promise.withResolvers<void>()
    platform.getDialogs = vi.fn(async () => {
      await release.promise
      return { dialogs: [{ conversation, unreadCount: 0, lastMessage: incoming('fresh-latest', conversation.id) }] }
    })
    const data = new PlatformDataService(platform, session, store)

    let settled = false
    const pending = data.getDialogsPage({ limit: 100 }).finally(() => { settled = true })
    await vi.waitFor(() => expect(platform.getDialogs).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    release.resolve()

    await expect(pending).resolves.toMatchObject({
      dialogs: [{ lastMessage: { id: 'fresh-latest' } }],
    })
  })

  it('keeps dialog preview and opened history on the same recovered latest message', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'consistent-room', kind: 'group', title: 'Consistent room' }
    const store = new MessageStore(database)
    await store.ingest(session, conversation, incoming('1', conversation.id))
    platform.getDialogs = vi.fn(async () => ({
      dialogs: [{ conversation, unreadCount: 2, lastMessage: incoming('3', conversation.id) }],
    }))
    platform.getHistory = vi.fn(async () => ({
      messages: [incoming('3', conversation.id), incoming('2', conversation.id)],
    }))
    const recovered: string[] = []
    const data = new PlatformDataService(
      platform, session, store, undefined, undefined,
      async (event) => {
        recovered.push(event.message.id)
        await store.ingest(session, event.conversation, event.message)
      },
    )

    const dialogs = await data.getDialogsPage({ limit: 100 })
    const history = await data.getHistory(conversation.id, { limit: 10 })

    expect(recovered).toEqual(['2', '3'])
    expect(dialogs.dialogs[0]?.lastMessage?.id).toBe('3')
    expect(history.messages[0]?.id).toBe('3')
    expect((await store.readDialogs(session.platformSessionId, [conversation.id]))[0]?.lastMessage?.id).toBe('3')
  })

  it('opens a persisted peer dialog without waiting for an upstream dialog refresh', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    platform.getDialogs = vi.fn(async () => { throw new Error('slow upstream dialogs must not be used') })
    const conversation: IMConversation = { id: 'stored-peer-room', kind: 'group', title: 'Stored peer' }
    const store = new MessageStore(database)
    await store.ingest(session, conversation, incoming('stored-latest', conversation.id))
    const rpc = new DialogRpc(platform, session, store)

    const result = await rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs',
      peers: [{
        _: 'inputDialogPeer',
        peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId(conversation.id), accessHash: Long.ONE },
      }],
    })

    expect(result).toMatchObject({
      dialogs: [{ peer: { _: 'peerChannel' } }],
      messages: [{ _: 'message', message: 'message-stored-latest' }],
    })
    expect(platform.getDialogs).not.toHaveBeenCalled()
  })

  it('materializes a deep Android channel page at its add_offset=-1 anchor', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'android-page-room', kind: 'group', title: 'Android page room' }
    const messages = Array.from({ length: 120 }, (_, index): IMMessage => ({
      id: `history-${120 - index}`,
      conversationId: conversation.id,
      senderId: 'alice',
      sender: { id: 'alice', firstName: 'Alice' },
      timestamp: 120 - index,
      content: { parts: [{ type: 'text', text: `history ${120 - index}` }] },
    }))
    const store = new MessageStore(database)
    await store.ingestMany(session, conversation, messages, { allocation: 'history' })
    platform.getDialogs = async () => ({
      dialogs: [{ conversation, unreadCount: 0, lastMessage: messages[0] }],
    })
    platform.getHistory = async () => ({ messages: [] })
    const rpc = new DialogRpc(platform, session, store)
    const peer = {
      _: 'inputPeerChannel' as const,
      channelId: rpc.peerTlId(conversation.id),
      accessHash: Long.ONE,
    }
    const first = await rpc.getHistory({
      _: 'messages.getHistory', peer,
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50,
      maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    const anchor = first.messages.at(-1)?.id
    expect(anchor).toBeGreaterThan(0)

    const second = await rpc.getHistory({
      _: 'messages.getHistory', peer,
      offsetId: anchor!, offsetDate: 0, addOffset: -1, limit: 50,
      maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages

    expect(second.messages).toHaveLength(50)
    expect(second.messages.every((message) => message.id <= anchor!)).toBe(true)
    expect(second.messages[0]?.id).toBe(anchor)
    expect(second.messages.at(-1)!.id).toBeLessThan(anchor!)
  })

  it('fetches one requested history window at a time and persists both windows', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'history-room', kind: 'group', title: 'History room' }
    let dialogCalls = 0
    let historyCalls = 0
    platform.getDialogs = async (_session, query) => {
      dialogCalls++
      if (!query?.cursor) return {
        dialogs: [{ conversation, unreadCount: 4, lastMessage: incoming('2', conversation.id) }],
        nextCursor: 'dialogs-2',
        total: 347,
      }
      return { dialogs: [], nextCursor: undefined }
    }
    platform.getHistory = async (_session, _conversation, query) => {
      historyCalls++
      if (!query?.before) return { messages: [incoming('2', conversation.id)], nextCursor: 'history-2' }
      return { messages: [incoming('1', conversation.id)] }
    }
    const traces: Array<{ format: string, args: unknown[] }> = []
    const trace = (format: string, ...args: unknown[]) => traces.push({ format, args })
    const data = new PlatformDataService(
      platform, session, new MessageStore(database, undefined, undefined, trace), trace,
    )

    const dialogPage = await data.getDialogsPage()
    const dialogs = dialogPage.dialogs
    expect(dialogCalls).toBe(1)
    expect(dialogPage).toMatchObject({ total: 347, nextCursor: 'dialogs-2' })
    expect(dialogs).toMatchObject([{ conversation: { id: 'history-room' }, unreadCount: 4 }])
    const [persistedDialog] = await database.get('mtproto_im_conversation', {
      platformConversationId: conversation.id,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await data.getDialogsPage()
    const [unchangedDialog] = await database.get('mtproto_im_conversation', {
      platformConversationId: conversation.id,
    })
    expect(unchangedDialog.updatedAt).toEqual(persistedDialog.updatedAt)
    const history = await data.getHistory(conversation.id)
    expect(historyCalls).toBe(1)
    expect(history.messages.map((message) => message.id)).toEqual(['2'])
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        format: expect.stringContaining('message store write profile operation=%s queueWaitMs=%d executeMs=%d'),
        args: expect.arrayContaining(['history-ingest']),
      }),
      expect.objectContaining({
        format: expect.stringContaining('history data profile conversation=%s'),
        args: expect.arrayContaining([conversation.id]),
      }),
    ]))
    await data.getHistory(conversation.id, { limit: 1, before: { id: '2', timestamp: 2 } })
    expect(historyCalls).toBe(2)
    expect(await database.get('mtproto_im_message', {})).toHaveLength(2)
  })

  it('serves push-only history exclusively from previously ingested events', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const conversation: IMConversation = { id: 'push-room', kind: 'channel', title: 'Push only' }
    await store.ingest(session, conversation, incoming('9', conversation.id))
    const data = new PlatformDataService(platform, session, store)

    expect(await data.getDialogs()).toMatchObject([{ conversation: { id: 'push-room', kind: 'channel' } }])
    expect((await data.getHistory(conversation.id)).messages.map((message) => message.id)).toEqual(['9'])
  })

  it('syncs an upstream history page without performing a discarded stored read', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'sync-room', kind: 'group', title: 'Sync room' }
    platform.getHistory = async () => ({ messages: [incoming('7', conversation.id)] })
    const store = new MessageStore(database)
    await store.upsertConversation(session, conversation)
    const readHistory = vi.spyOn(store, 'readHistory')
    const data = new PlatformDataService(platform, session, store)

    await data.syncHistory(conversation.id, { limit: 50 })

    expect(readHistory).not.toHaveBeenCalled()
    expect(await database.get('mtproto_im_message', {})).toHaveLength(1)
    await expect(data.getHistory(conversation.id, { limit: 50 }))
      .resolves.toMatchObject({ messages: [{ id: '7' }] })
    expect(readHistory).toHaveBeenCalledOnce()
  })

  it('revalidates every concurrent and sequential history sync', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'revalidated-room', kind: 'group', title: 'Revalidated room' }
    const store = new MessageStore(database)
    await store.upsertConversation(session, conversation)
    const getHistory = vi.fn(async () => ({ messages: [incoming('8', conversation.id)] }))
    platform.getHistory = getHistory
    const data = new PlatformDataService(platform, session, store)

    await Promise.all([
      data.syncHistory(conversation.id, { limit: 50 }),
      data.syncHistory(conversation.id, { limit: 50 }),
      data.syncHistory(conversation.id, { limit: 50 }),
    ])
    expect(getHistory).toHaveBeenCalledTimes(3)
    expect(await database.get('mtproto_im_message', {})).toHaveLength(1)

    await data.syncHistory(conversation.id, { limit: 50 })
    expect(getHistory).toHaveBeenCalledTimes(4)
  })

  it('revalidates every exact and anchored history window', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'fresh-room', kind: 'group', title: 'Fresh room' }
    const store = new MessageStore(database)
    await store.upsertConversation(session, conversation)
    const getHistory = vi.fn<NonNullable<IMPlatform['getHistory']>>(
      async () => ({ messages: [incoming('8', conversation.id)] }),
    )
    platform.getHistory = getHistory
    const data = new PlatformDataService(platform, session, store)

    await data.syncHistory(conversation.id, { limit: 50 })
    await data.syncHistory(conversation.id, { limit: 50 })
    await data.syncHistory(conversation.id, {
      limit: 50,
      before: { id: '8', timestamp: 8 },
    })

    expect(getHistory).toHaveBeenCalledTimes(3)
    expect(getHistory.mock.calls[2]?.[2]).toMatchObject({ before: { id: '8', timestamp: 8 } })
  })

  it('does not mark a failed history sync as fresh', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'retry-room', kind: 'group', title: 'Retry room' }
    const store = new MessageStore(database)
    await store.upsertConversation(session, conversation)
    const getHistory = vi.fn()
      .mockRejectedValueOnce(new Error('temporary upstream failure'))
      .mockResolvedValueOnce({ messages: [incoming('9', conversation.id)] })
    platform.getHistory = getHistory
    const data = new PlatformDataService(platform, session, store, undefined, () => 10_000)

    await expect(data.syncHistory(conversation.id, { limit: 50 }))
      .rejects.toThrow('temporary upstream failure')
    await expect(data.syncHistory(conversation.id, { limit: 50 })).resolves.toBeUndefined()

    expect(getHistory).toHaveBeenCalledTimes(2)
  })

  it('does not chase an upstream nextCursor during a single bridge read', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    let calls = 0
    platform.getDialogs = async () => {
      calls++
      return { dialogs: [], nextCursor: 'next' }
    }
    const data = new PlatformDataService(platform, session, new MessageStore(database))
    await expect(data.getDialogs()).resolves.toEqual([])
    expect(calls).toBe(1)
  })

  it('revalidates concurrent dialog reads without an in-memory request cache', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'shared-dialog-room', kind: 'group', title: 'Shared' }
    const release = Promise.withResolvers<void>()
    const getDialogs = vi.fn(async () => {
      await release.promise
      return { dialogs: [{ conversation, unreadCount: 0, lastMessage: incoming('10', conversation.id) }] }
    })
    platform.getDialogs = getDialogs
    const store = new MessageStore(database)
    const ingestDialogs = vi.spyOn(store, 'ingestDialogs')
    const first = new PlatformDataService(platform, session, store)
    const second = new PlatformDataService(platform, session, store)

    const pages = Promise.all([
      first.getDialogsPage({ limit: 50 }),
      second.getDialogsPage({ limit: 50 }),
      first.getDialogsPage({ limit: 50 }),
    ])
    await vi.waitFor(() => expect(getDialogs).toHaveBeenCalledTimes(3))
    release.resolve()

    await expect(pages).resolves.toHaveLength(3)
    expect(ingestDialogs).toHaveBeenCalledTimes(3)
    expect(await database.get('mtproto_im_message', {})).toHaveLength(1)
  })

  it('does not return stale stored dialogs that are absent from an authoritative upstream page', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const store = new MessageStore(database)
    await store.upsertConversation(session, { id: '1:legacy-user', kind: 'direct', title: 'Legacy' })
    platform.getDialogs = async () => ({
      dialogs: [{
        conversation: { id: 'raw-user', kind: 'direct', title: 'Current' },
        unreadCount: 0,
      }],
    })
    const data = new PlatformDataService(platform, session, store)

    expect((await data.getDialogs()).map((dialog) => dialog.conversation.id)).toEqual(['raw-user'])
  })
})

describe('IMPlatformService', () => {
  it('publishes active session replacements and committed events to independent plugins', () => {
    const ctx = new Context()
    const service = new IMPlatformService(ctx)
    const first = new PushPlatform()
    const second = new PushPlatform()
    const replacement = { ...session, platformSessionId: 'session-two' }
    const lifecycle: Array<{ event: string, sessionId: string }> = []
    const committed: string[] = []
    service.onSessionChange((event, binding) => {
      lifecycle.push({ event, sessionId: binding.session.platformSessionId })
    })
    service.onCommittedEvent((_activeSession, value) => {
      if (value.event.type === 'message') committed.push(value.event.message.id)
    })

    service.activateSession('push', first, session)
    service.activateSession('push', second, replacement)
    service.emitCommittedEvent(replacement, {
      event: {
        type: 'message', conversation: { id: 'room', kind: 'group', title: 'Room' },
        message: incoming('committed'),
      },
      result: {
        created: true,
        changed: true,
        projection: [],
        addedTlMessageIds: [],
        removedTlMessageIds: [],
        message: {
          id: 1,
          platformSessionId: replacement.platformSessionId,
          conversationId: 1,
          primaryPlatformMessageId: 'committed',
          senderUserId: 1,
          text: 'message-committed',
          content: {},
          timestamp: 1,
          outgoing: false,
          deleted: false,
          platformGroupId: null,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    })
    service.deactivateSession('push', first)
    expect(service.sessions).toEqual([{ registrationId: 'push', platform: second, session: replacement }])
    service.deactivateSession('push', second)

    expect(lifecycle).toEqual([
      { event: 'activate', sessionId: 'session-one' },
      { event: 'deactivate', sessionId: 'session-one' },
      { event: 'activate', sessionId: 'session-two' },
      { event: 'deactivate', sessionId: 'session-two' },
    ])
    expect(committed).toEqual(['committed'])
    expect(service.sessions).toEqual([])
  })
})

describe('PlatformRegistry', () => {
  it('rejects duplicate IDs and resolves independent adapters', () => {
    const first = new PushPlatform()
    expect(() => new PlatformRegistry([
      ['push', first], ['push', new PushPlatform()],
    ])).toThrow('duplicate IM platform ID')
    const registry = new PlatformRegistry([['push', first]])
    expect(registry.require('push')).toBe(first)
    expect(() => registry.require('missing')).toThrow('not registered')

    const second = new PushPlatform()
    const unregister = registry.register('second', second)
    expect(registry.ids).toEqual(['push', 'second'])
    unregister()
    expect(registry.get('second')).toBeUndefined()
  })

  it('cold-syncs requests without requiring dialog history support', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const request: IMRequest = {
      id: 'cold-request', kind: 'group-join', state: 'pending',
      requester: { id: 'alice', firstName: 'Alice' },
      group: { id: 'group-1', kind: 'group', title: 'Group 1' },
    }
    platform.getRequests = vi.fn(async () => ({ requests: [request] }))
    const manager = new PlatformSubscriptionManager(database, new PlatformRegistry([['push', platform]]), store)

    await manager.ensure(session)
    await vi.waitFor(async () => {
      expect(await store.getRequest(session.platformSessionId, 'cold-request')).toMatchObject({
        id: 'cold-request', state: 'pending',
      })
    })

    expect(platform.getRequests).toHaveBeenCalledWith(session, { limit: 500, cursor: undefined })
    await manager.stop()
  })

  it('does not let stale cold pending requests overwrite a live terminal request', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: IMEvent[] = []
    const cold = Promise.withResolvers<{ requests: IMRequest[] }>()
    platform.getRequests = vi.fn(async () => cold.promise)
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, value) => { committed.push(value.event) },
    )
    const pending: IMRequest = {
      id: 'racing-request', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }

    await manager.ensure(session)
    await vi.waitFor(() => expect(platform.getRequests).toHaveBeenCalledTimes(1))
    await platform.emit({ type: 'request', request: { ...pending, state: 'accepted' } })
    cold.resolve({ requests: [pending] })
    await vi.waitFor(async () => {
      expect(await store.getRequest(session.platformSessionId, pending.id)).toMatchObject({ state: 'accepted' })
    })

    const [inboxMessage] = await store.readHistory(session.platformSessionId, 'bridge:request-inbox')
    expect(inboxMessage).toMatchObject({ metadata: { bridgeRequestId: pending.id } })
    expect(inboxMessage?.content.inlineKeyboard).toBeUndefined()
    expect((await store.readDialogs(session.platformSessionId, ['bridge:request-inbox']))[0]?.unreadCount).toBe(0)
    expect(committed.map((event) => event.type)).toEqual(['message'])
    await manager.stop()
  })

  it('cold-syncs each request ID once and stops on a repeated request cursor', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const first: IMRequest = {
      id: 'cursor-request-1', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const second: IMRequest = {
      id: 'cursor-request-2', kind: 'group-join', state: 'pending', createdAt: 101,
      requester: { id: 'bob', firstName: 'Bob' },
      group: { id: 'group-2', kind: 'group', title: 'Group 2' },
    }
    platform.getRequests = vi.fn(async (_session, query) => query?.cursor
      ? { requests: [{ ...first, state: 'accepted' as const }, second], nextCursor: 'cursor-2' }
      : { requests: [first], nextCursor: 'cursor-2' })
    const manager = new PlatformSubscriptionManager(database, new PlatformRegistry([['push', platform]]), store)

    await manager.ensure(session)
    await vi.waitFor(async () => {
      expect(await store.getRequest(session.platformSessionId, second.id)).toMatchObject({ state: 'pending' })
    })

    expect(platform.getRequests).toHaveBeenNthCalledWith(1, session, { limit: 500, cursor: undefined })
    expect(platform.getRequests).toHaveBeenNthCalledWith(2, session, { limit: 500, cursor: 'cursor-2' })
    expect(platform.getRequests).toHaveBeenCalledTimes(2)
    expect(await store.getRequest(session.platformSessionId, first.id)).toMatchObject({ state: 'accepted' })
    expect(await store.readHistory(session.platformSessionId, 'bridge:request-inbox')).toHaveLength(2)
    await manager.stop()
  })

  it('re-delivers an unchanged persisted request only through recovery events', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: IMEvent[] = []
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, value) => { committed.push(value.event) },
    )
    const request: IMRequest = {
      id: 'recovery-request', kind: 'friend', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    await store.ingestRequest(session, request)
    await manager.ensure(session)

    await manager.ingestLocalEvent(session, { type: 'request', request })
    expect(committed).toEqual([])
    await manager.ingestLocalEvent(session, { type: 'request', request, delivery: 'recovery' })

    expect(committed).toMatchObject([{
      type: 'message-edit', conversation: { id: 'bridge:request-inbox' }, message: {
        metadata: { bridgeRequestId: request.id },
      },
    }])
    expect((committed[0] as Extract<IMEvent, { type: 'message-edit' }>).message.content.inlineKeyboard)
      .toBeUndefined()
    await manager.stop()
  })

  it('persists and projects request events independently from system messages', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: any[] = []
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, value) => { committed.push(value) },
    )
    const pending: IMRequest = {
      id: 'request-1', kind: 'friend', state: 'pending',
      requester: { id: 'alice', firstName: 'Alice' }, message: 'hello', createdAt: 100,
    }
    await manager.ensure(session)
    await platform.emit({ type: 'request', request: pending })

    expect(await database.get('mtproto_im_request', {
      platformSessionId: session.platformSessionId, platformRequestId: pending.id,
    })).toMatchObject([{ kind: 'friend', state: 'pending', request: pending }])
    expect(await store.readDialogs(session.platformSessionId, ['bridge:request-inbox'])).toMatchObject([{
      conversation: { id: 'bridge:request-inbox', metadata: { bridgeOwned: true, readOnly: true, requestInbox: true } },
      unreadCount: 1,
    }])
    expect(await store.readHistory(session.platformSessionId, 'bridge:request-inbox')).toMatchObject([{
      id: 'bridge:request:request-1', metadata: { bridgeRequestId: 'request-1' },
      content: { inlineKeyboard: { rows: [{ buttons: [{ text: '接受' }, { text: '拒绝' }] }] } },
    }])
    await platform.emit({ type: 'request', request: pending })
    await platform.emit({ type: 'request', request: { ...pending, state: 'accepted' } })

    expect(committed.map(({ event }) => event.type)).toEqual(['message', 'message-edit'])
    expect((await store.readHistory(session.platformSessionId, 'bridge:request-inbox'))[0].content.inlineKeyboard)
      .toBeUndefined()
    expect((await store.readDialogs(session.platformSessionId, ['bridge:request-inbox']))[0].unreadCount).toBe(1)
    await manager.stop()
  })

  it('persists canonical request state independently across sessions with a stable generated creation time', async () => {
    const database = await createDatabase()
    const store = new MessageStore(database)
    const initial: IMRequest = {
      id: 'stable-request', kind: 'friend', state: 'pending',
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const otherSession = { ...session, platformSessionId: 'session-two' }

    const first = await store.upsertRequest(session, initial)
    expect(first).toMatchObject({ created: true, changed: true, previous: undefined })
    expect(first.request.createdAt).toEqual(expect.any(Number))
    expect(first.request.createdAt).toBeGreaterThan(0)
    const createdAt = first.request.createdAt

    const replay = await store.upsertRequest(session, initial)
    expect(replay).toMatchObject({ created: false, changed: false })
    expect(replay.request.createdAt).toBe(createdAt)
    const transitioned = await store.upsertRequest(session, { ...initial, state: 'accepted' })
    expect(transitioned).toMatchObject({
      created: false, changed: true, previous: { state: 'pending', createdAt },
      request: { state: 'accepted', createdAt },
    })
    await expect(store.upsertRequest(session, initial)).resolves.toMatchObject({
      changed: false, previous: { state: 'accepted' }, request: { state: 'accepted', createdAt },
    })
    await expect(store.upsertRequest(session, { ...initial, state: 'rejected' })).resolves.toMatchObject({
      changed: false, previous: { state: 'accepted' }, request: { state: 'accepted', createdAt },
    })

    await store.upsertRequest(otherSession, { ...initial, state: 'rejected' })
    await expect(store.getRequest(session.platformSessionId, initial.id)).resolves.toMatchObject({
      state: 'accepted', createdAt,
    })
    await expect(store.getRequest(otherSession.platformSessionId, initial.id)).resolves.toMatchObject({
      state: 'rejected', createdAt: expect.any(Number),
    })
  })

  it('repairs a request persisted before its inbox projection without duplicating the replay', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    const store = new MessageStore(database)
    const committed: IMEvent[] = []
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['push', platform]]), store, undefined,
      (_session, value) => { committed.push(value.event) },
    )
    const request: IMRequest = {
      id: 'replay-request', kind: 'friend', state: 'pending',
      requester: { id: 'alice', firstName: 'Alice' },
    }
    await store.upsertRequest(session, request)
    await manager.ensure(session)

    await platform.emit({ type: 'request', request })
    await platform.emit({ type: 'request', request })

    expect(committed.map((event) => event.type)).toEqual(['message'])
    expect((await store.readHistory(session.platformSessionId, 'bridge:request-inbox'))).toHaveLength(1)
    expect((await store.readDialogs(session.platformSessionId, ['bridge:request-inbox']))[0]?.unreadCount).toBe(1)
    await manager.stop()
  })

  it('returns only the inbox at limit one while retaining the upstream dialog total', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const store = new MessageStore(database)
    const inboxRequest: IMRequest = {
      id: 'dialog-request', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const manager = new PlatformSubscriptionManager(database, new PlatformRegistry([['push', platform]]), store)
    await manager.ensure(session)
    await platform.emit({ type: 'request', request: inboxRequest })
    const upstream = {
      conversation: { id: 'upstream-1', kind: 'direct' as const, title: 'Upstream 1' }, unreadCount: 0,
    }
    platform.getDialogs = vi.fn(async () => ({ dialogs: [upstream], total: 7, nextCursor: 'upstream-next' }))
    const data = new PlatformDataService(platform, session, store)

    await expect(data.getDialogsPage({ limit: 1 })).resolves.toMatchObject({
      dialogs: [{ conversation: { id: 'bridge:request-inbox' } }],
      total: 8,
      nextCursor: 'upstream-next',
    })
    await manager.stop()
  })

  it('starts the page after the inbox at the upstream homepage', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const store = new MessageStore(database)
    const manager = new PlatformSubscriptionManager(database, new PlatformRegistry([['push', platform]]), store)
    await manager.ensure(session)
    await platform.emit({ type: 'request', request: {
      id: 'after-inbox-request', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    } })
    platform.getDialogs = vi.fn(async () => ({ dialogs: [{
      conversation: { id: 'upstream-first', kind: 'direct' as const, title: 'Upstream first' }, unreadCount: 0,
    }], total: 1 }))
    const data = new PlatformDataService(platform, session, store)

    await expect(data.getDialogsPage({ limit: 2, afterId: 'bridge:request-inbox' })).resolves.toMatchObject({
      dialogs: [{ conversation: { id: 'upstream-first' } }], total: 2,
    })
    expect(platform.getDialogs).toHaveBeenCalledWith(session, { limit: 2, afterId: undefined })
    await manager.stop()
  })

  it('continues every bridge-owned system dialog before entering upstream pages', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const store = new MessageStore(database)
    await store.upsertConversation(session, { id: 'bridge:botfather', kind: 'direct', title: 'BotFather', metadata: { bridgeOwned: true } })
    await store.upsertConversation(session, { id: 'bridge:bot:one', kind: 'direct', title: 'Bot One', metadata: { bridgeOwned: true } })
    await store.upsertConversation(session, { id: 'bridge:bot:two', kind: 'direct', title: 'Bot Two', metadata: { bridgeOwned: true } })
    platform.getDialogs = vi.fn(async () => ({ dialogs: [
      { conversation: { id: 'upstream-1', kind: 'direct' as const, title: 'Upstream 1' }, unreadCount: 0 },
      { conversation: { id: 'upstream-2', kind: 'direct' as const, title: 'Upstream 2' }, unreadCount: 0 },
    ], total: 2 }))
    const data = new PlatformDataService(platform, session, store)
    const first = await data.getDialogsPage({ limit: 1 })
    const second = await data.getDialogsPage({ limit: 1, afterId: first.dialogs[0].conversation.id })
    const third = await data.getDialogsPage({ limit: 1, afterId: second.dialogs[0].conversation.id })
    const upstream = await data.getDialogsPage({ limit: 2, afterId: third.dialogs[0].conversation.id })
    expect([first, second, third].map((page) => page.dialogs[0].conversation.id)).toEqual([
      'bridge:bot:two', 'bridge:bot:one', 'bridge:botfather',
    ])
    expect(first.total).toBe(5)
    expect(upstream.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['upstream-1', 'upstream-2'])
  })

  it('paginates more than 500 bridge-owned dialogs without duplicates', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const store = new MessageStore(database)
    for (let index = 0; index < 501; index++) {
      await store.upsertConversation(session, {
        id: `bridge:bot:${String(index).padStart(3, '0')}`,
        kind: 'direct', title: `Bot ${index}`, metadata: { bridgeOwned: true, localOnly: true },
      })
    }
    const sameSecond = new Date(1_700_000_000_000)
    for (const conversation of await database.get('mtproto_im_conversation', { platformSessionId: session.platformSessionId })) {
      await database.set('mtproto_im_conversation', { id: conversation.id }, { updatedAt: sameSecond })
    }
    platform.getDialogs = vi.fn(async () => ({ dialogs: [
      { conversation: { id: 'upstream-1', kind: 'direct' as const, title: 'Upstream 1' }, unreadCount: 0 },
    ], total: 1 }))
    const data = new PlatformDataService(platform, session, store)
    const first = await data.getDialogsPage({ limit: 501 })
    expect(first.dialogs).toHaveLength(501)
    expect(new Set(first.dialogs.map((dialog) => dialog.conversation.id)).size).toBe(501)
    expect(first.dialogs.every((dialog) => dialog.conversation.metadata?.bridgeOwned === true)).toBe(true)
    expect(first.total).toBe(502)

    const localFirstPage = await data.getDialogsPage({ limit: 100 })
    const localSecondPage = await data.getDialogsPage({
      limit: 100, afterId: localFirstPage.dialogs.at(-1)!.conversation.id,
    })
    expect(localSecondPage.dialogs).toHaveLength(100)
    expect(localSecondPage.total).toBe(502)

    const upstream = await data.getDialogsPage({ limit: 1, afterId: first.dialogs.at(-1)!.conversation.id })
    expect(upstream.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['upstream-1'])
    expect(platform.getDialogs).toHaveBeenLastCalledWith(session, { limit: 1, afterId: undefined })
  })

  it('migrates loader-qualified platform IDs across sessions and auth bindings', async () => {
    const database = await createDatabase()
    const legacyId = 'parent-group:static'
    await database.create('mtproto_platform_session', {
      id: 'legacy-session', platformId: legacyId, userId: 'self', credentials: {}, metadata: {},
      active: true, createdAt: new Date(),
    })
    await database.create('mtproto_auth_session', {
      id: 'legacy-auth', virtualPhone: '99900001', totpSecret: '11'.repeat(20),
      platformId: legacyId, platformSessionId: 'legacy-session',
    })
    await database.create('mtproto_auth_binding', {
      authKeyId: '0011223344556677', platformId: legacyId, platformSessionId: 'legacy-session',
    })

    await expect(migrateQualifiedPlatformIds(database, 'static')).resolves.toBe(1)
    expect(await database.get('mtproto_platform_session', { id: 'legacy-session' }))
      .toMatchObject([{ platformId: 'static' }])
    expect(await database.get('mtproto_auth_session', { id: 'legacy-auth' }))
      .toMatchObject([{ platformId: 'static' }])
    expect(await database.get('mtproto_auth_binding', { authKeyId: '0011223344556677' }))
      .toMatchObject([{ platformId: 'static' }])
  })
})
