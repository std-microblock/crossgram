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
import type {
  IMConversation, IMEvent, IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities,
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

  it('returns a persisted first page before a slow upstream refresh finishes', async () => {
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

    const page = await Promise.race([
      data.getDialogsPage({ limit: 100 }),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('persisted dialog page exceeded 100ms')),
        100,
      )),
    ])
    expect(page.dialogs).toMatchObject([{ lastMessage: { id: 'stored-latest' } }])
    release.resolve()
    await vi.waitFor(() => expect(platform.getDialogs).toHaveBeenCalledOnce())
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

  it('coalesces concurrent syncs for the same history window', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'coalesced-room', kind: 'group', title: 'Coalesced room' }
    const store = new MessageStore(database)
    await store.upsertConversation(session, conversation)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const getHistory = vi.fn(async () => {
      await gate
      return { messages: [incoming('8', conversation.id)] }
    })
    platform.getHistory = getHistory
    let now = 10_000
    const data = new PlatformDataService(platform, session, store, undefined, () => now)

    const syncs = Promise.all([
      data.syncHistory(conversation.id, { limit: 50 }),
      data.syncHistory(conversation.id, { limit: 50 }),
      data.syncHistory(conversation.id, { limit: 50 }),
    ])
    await vi.waitFor(() => expect(getHistory).toHaveBeenCalledOnce())
    release()
    await syncs

    expect(await database.get('mtproto_im_message', {})).toHaveLength(1)
    await data.syncHistory(conversation.id, { limit: 50 })
    expect(getHistory).toHaveBeenCalledOnce()
    now += PlatformDataService.HISTORY_SYNC_FRESH_MS + 1
    await data.syncHistory(conversation.id, { limit: 50 })
    expect(getHistory).toHaveBeenCalledTimes(2)
  })

  it('only reuses a fresh sync for the exact history window', async () => {
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
    const data = new PlatformDataService(platform, session, store, undefined, () => 10_000)

    await data.syncHistory(conversation.id, { limit: 50 })
    await data.syncHistory(conversation.id, { limit: 50 })
    await data.syncHistory(conversation.id, {
      limit: 50,
      before: { id: '8', timestamp: 8 },
    })

    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(getHistory.mock.calls[1]?.[2]).toMatchObject({ before: { id: '8', timestamp: 8 } })
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

  it('coalesces dialog fetch and persistence across data-service instances', async () => {
    const database = await createDatabase()
    const platform = new PushPlatform()
    platform.capabilities.history = true
    const conversation: IMConversation = { id: 'shared-dialog-room', kind: 'group', title: 'Shared' }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const getDialogs = vi.fn(async () => {
      await gate
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
    await vi.waitFor(() => expect(getDialogs).toHaveBeenCalledOnce())
    release()

    await expect(pages).resolves.toHaveLength(3)
    expect(ingestDialogs).toHaveBeenCalledOnce()
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
