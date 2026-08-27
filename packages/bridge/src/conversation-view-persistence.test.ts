import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { DialogRpc, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { createTestConversationViews } from './conversation-view.test-utils.js'

const session: PlatformSession = {
  platformSessionId: 'conversation-view-persistence',
  platformId: 'conversation-view-test',
  userId: 'self',
  credentials: {},
  metadata: { firstName: 'Self' },
}

const virtual: IMConversation = {
  id: 'qqnt-multi-forward:persisted',
  kind: 'group',
  title: '聊天记录',
  metadata: { conversationView: 'merged-forward' },
}

const ordinaryGroup: IMConversation = {
  id: 'ordinary-group',
  kind: 'group',
  title: 'Ordinary group',
}

function message(conversation: IMConversation, id: string, text: string): IMMessage {
  return {
    id,
    conversationId: conversation.id,
    senderId: 'alice',
    sender: { id: 'alice', firstName: 'Alice' },
    timestamp: 1_800_000_000,
    content: { parts: [{ type: 'text', text }] },
  }
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getDialogs() { return { dialogs: [] } },
  async getHistory() { return { messages: [] } },
  async getUser(_session, id) { return { id, firstName: id } },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore(): Promise<MessageStore> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return new MessageStore(ctx.database)
}

describe('persisted conversation views', () => {
  it('rebuilds merged-forward username, history, and message ownership after restart', async () => {
    const store = await createStore()
    const stored = await store.ingest(session, virtual, message(virtual, 'inside', 'persisted transcript'))
    const targetId = stored.projection[0].tlMessageId
    const chatId = stableId(`peer:${virtual.id}`)

    // Model a full service restart: the durable store survives while the
    // process-local conversation-view registry starts empty.
    const conversationViews = createTestConversationViews()
    const rpc = new DialogRpc(
      platform, session, store,
      undefined, undefined, 1, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, conversationViews, conversationViews.messageProjection,
    )

    await expect(rpc.resolveUsername({
      _: 'contacts.resolveUsername', username: `bridgechat_${chatId}`,
    })).resolves.toMatchObject({
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId },
      chats: [{ _: 'chat', id: chatId, title: virtual.title }],
    })
    await expect(rpc.getHistory({
      _: 'messages.getHistory',
      peer: { _: 'inputPeerChat', chatId },
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
      maxId: 0, minId: 0, hash: Long.ZERO,
    })).resolves.toMatchObject({
      messages: [{ _: 'message', id: targetId, message: 'persisted transcript' }],
    })
    await expect(rpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: targetId }],
    })).resolves.toMatchObject({
      messages: [{ _: 'message', id: targetId, message: 'persisted transcript' }],
    })
  })

  it('does not expose ordinary group messages through messages.getMessages', async () => {
    const store = await createStore()
    const stored = await store.ingest(
      session, ordinaryGroup, message(ordinaryGroup, 'group-message', 'not a basic-chat view'),
    )
    const targetId = stored.projection[0].tlMessageId
    const conversationViews = createTestConversationViews()
    const rpc = new DialogRpc(
      platform, session, store,
      undefined, undefined, 1, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, conversationViews, conversationViews.messageProjection,
    )

    await expect(rpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: targetId }],
    })).resolves.toMatchObject({ messages: [{ _: 'messageEmpty', id: targetId }] })
  })
})
