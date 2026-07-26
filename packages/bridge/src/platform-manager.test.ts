import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import {
  migrateQualifiedPlatformIds, PlatformDataService, PlatformRegistry, PlatformSubscriptionManager,
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
    const data = new PlatformDataService(platform, session, new MessageStore(database))

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
