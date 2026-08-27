import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { DialogRpc, stableId, type ProjectedDialogPeer } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'projected-dialog-peer', platformId: 'projected-dialog-test', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const conversation: IMConversation = {
  id: 'feature-owned-conversation', kind: 'group', title: 'Feature-owned history',
}

function message(id: string, text: string): IMMessage {
  return {
    id, conversationId: conversation.id, senderId: 'alice',
    sender: { id: 'alice', firstName: 'Alice' }, timestamp: 1_800_000_000,
    content: { parts: [{ type: 'text', text }] },
  }
}

const markRead = vi.fn(async () => {})
const platform: IMPlatform = {
  capabilities: {
    history: true,
    readState: { markRead: true, events: false },
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getDialogs() { return { dialogs: [] } },
  async getHistory() { return { messages: [] } },
  async getUser(_session, id) { return { id, firstName: id } },
  markRead,
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  markRead.mockClear()
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

function projectedPeer(): ProjectedDialogPeer {
  const chatId = stableId(`feature-peer:${conversation.id}`)
  return {
    conversation,
    peer: { _: 'peerChat', chatId },
    chat: {
      _: 'chat', left: true, id: chatId, title: conversation.title,
      photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
    },
  }
}

describe('DialogRpc explicit projected peer data plane', () => {
  it('renders history, deep-link messages, peer dialogs, and metadata from an explicit feature-owned peer', async () => {
    const store = await createStore()
    const stored = await store.ingest(session, conversation, message('inside', 'persisted transcript'))
    const targetId = stored.projection[0].tlMessageId
    const projected = projectedPeer()
    const peer = { _: 'inputPeerChat' as const, chatId: projected.chat.id }
    const rpc = new DialogRpc(platform, session, store)
    const historyRequest = {
      _: 'messages.getHistory' as const, peer,
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
      maxId: 0, minId: 0, hash: Long.ZERO,
    }

    await expect(rpc.getProjectedHistory(historyRequest, projected)).resolves.toMatchObject({
      messages: [{ _: 'message', id: targetId, peerId: projected.peer, message: 'persisted transcript' }],
      chats: [{ _: 'chat', id: projected.chat.id, title: conversation.title }],
    })
    await expect(rpc.getProjectedMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: targetId }],
    }, [projected])).resolves.toMatchObject({
      messages: [{ _: 'message', id: targetId, peerId: projected.peer, message: 'persisted transcript' }],
    })
    await expect(rpc.getProjectedPeerDialogs([projected])).resolves.toMatchObject({
      dialogs: [{ peer: projected.peer, topMessage: targetId }],
      messages: [{ _: 'message', id: targetId, message: 'persisted transcript' }],
      chats: [{ _: 'chat', id: projected.chat.id }],
    })
    await expect(rpc.getProjectedScheduledHistory(projected)).resolves.toMatchObject({
      _: 'messages.messages', messages: [], chats: [{ id: projected.chat.id }],
    })
    await expect(rpc.getProjectedPeerSettings(projected)).resolves.toMatchObject({
      _: 'messages.peerSettings', chats: [{ id: projected.chat.id }],
    })
    await expect(rpc.readProjectedHistory({
      _: 'messages.readHistory', peer, maxId: targetId,
    }, projected)).resolves.toMatchObject({ _: 'messages.affectedMessages' })
    expect(markRead).not.toHaveBeenCalled()
  })

  it('keeps ordinary messages.getMessages restricted to direct peers', async () => {
    const store = await createStore()
    const stored = await store.ingest(session, conversation, message('ordinary-group-message', 'not direct'))
    const targetId = stored.projection[0].tlMessageId
    const rpc = new DialogRpc(platform, session, store)

    await expect(rpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: targetId }],
    })).resolves.toMatchObject({ messages: [{ _: 'messageEmpty', id: targetId }] })
  })
})
