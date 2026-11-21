import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry, PlatformSubscriptionManager } from './platform-manager.js'
import type {
  IMConversation, IMEvent, IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities, PlatformSession, Unsubscribe,
} from './platform.js'

/**
 * The client learns the unread state of a chat it has no entry for through
 * `messages.getPeerDialogs` (Telegram Desktop requests it right after an
 * incoming message creates a new chat). The bridge answers from the stored
 * conversation row, so a live message that never reached that counter made the
 * client believe the brand-new chat was read: no badge, no unread divider.
 */

const session: PlatformSession = {
  platformSessionId: 'new-peer-unread-session',
  platformId: 'new-peer-unread',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const capabilities: PlatformCapabilities = {
  history: false,
  readState: { markRead: false, events: false },
  send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
  conversations: { groups: true, channels: false, subchannels: false },
}

class TestPlatform implements IMPlatform {
  readonly capabilities: PlatformCapabilities = capabilities
  private _handler?: (event: IMEvent) => void | Promise<void>

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    this._handler = handler
    return async () => { this._handler = undefined }
  }

  async sendMessage(_session: PlatformSession, _conversation: { id: string }, _content: IMMessageInput) {
    throw new Error('send is disabled')
  }

  async emit(event: IMEvent): Promise<void> {
    if (!this._handler) throw new Error('not subscribed')
    await this._handler(event)
  }
}

function firstMessage(conversationId: string): IMMessage {
  return {
    id: 'first', conversationId, senderId: conversationId, timestamp: 1_785_100_000,
    content: { parts: [{ type: 'text', text: '你好，第一次给你发消息' }] },
  }
}

function peerDialogsRequest(userId: number): tl.messages.RawGetPeerDialogsRequest {
  return {
    _: 'messages.getPeerDialogs',
    peers: [{ _: 'inputDialogPeer', peer: { _: 'inputPeerUser', userId, accessHash: Long.ZERO } }],
  }
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, database: ctx.database, store: new MessageStore(ctx.database) }
}

async function dialogOf(
  platform: TestPlatform, store: MessageStore, conversationId: string,
): Promise<tl.RawDialog> {
  const user = await store.getUser(session.platformId, conversationId)
  expect(user).toBeDefined()
  const rpc = new DialogRpc(platform, session, store)
  const result = await rpc.getPeerDialogs(peerDialogsRequest(user!.id))
  return result.dialogs[0] as tl.RawDialog
}

describe('first message of a new peer', () => {
  it('publishes the fresh chat as unread to a client that asks for its entry', async () => {
    const { ctx, database, store } = await createStore()
    const platform = new TestPlatform()
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['new-peer-unread', platform]]), store, undefined,
      async () => undefined,
      undefined, ctx,
    )
    disposals.push(() => manager.stop())
    await manager.ensure(session)

    const conversation: IMConversation = { id: 'stranger', kind: 'direct', title: 'Stranger' }
    await platform.emit({ type: 'message', conversation, message: firstMessage(conversation.id) })

    const dialog = await dialogOf(platform, store, conversation.id)

    expect(dialog.topMessage).toBeGreaterThan(0)
    expect(dialog.unreadCount).toBe(1)
    // A read boundary at the message itself is what told the client the chat
    // was read, even while the message was still unread in QQ.
    expect(dialog.readInboxMaxId).toBeLessThan(dialog.topMessage)
  })

  it('keeps the platform unread count instead of counting re-delivered backlog again', async () => {
    const { ctx, database, store } = await createStore()
    const platform = new TestPlatform()
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['new-peer-unread', platform]]), store, undefined,
      async () => undefined,
      undefined, ctx,
    )
    disposals.push(() => manager.stop())
    await manager.ensure(session)

    const conversation: IMConversation = { id: 'old-peer', kind: 'direct', title: 'Old peer' }
    const backlog = [firstMessage(conversation.id), { ...firstMessage(conversation.id), id: 'second' }]
    // The dialog snapshot QQ reports first, then the same messages delivered as
    // live events while the client reconnects.
    await store.ingestDialogs(session, [{
      conversation,
      unreadCount: 2,
      lastMessage: backlog[1],
    }])
    for (const message of backlog) {
      await platform.emit({ type: 'message', conversation, message })
    }

    expect((await store.readDialogs(session.platformSessionId, [conversation.id]))[0]?.unreadCount).toBe(2)
  })

  it('does not count an outgoing message as unread', async () => {
    const { ctx, database, store } = await createStore()
    const platform = new TestPlatform()
    const manager = new PlatformSubscriptionManager(
      database, new PlatformRegistry([['new-peer-unread', platform]]), store, undefined,
      async () => undefined,
      undefined, ctx,
    )
    disposals.push(() => manager.stop())
    await manager.ensure(session)

    const conversation: IMConversation = { id: 'sent-peer', kind: 'direct', title: 'Sent peer' }
    await platform.emit({
      type: 'message',
      conversation,
      message: { ...firstMessage(conversation.id), senderId: session.userId, outgoing: true },
    })

    expect((await store.readDialogs(session.platformSessionId, [conversation.id]))[0]?.unreadCount).toBe(0)
  })
})
