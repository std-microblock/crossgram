import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { defineModels } from '../../bridge/src/models.js'
import type { IMConversation, IMMessage, PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from '../../platform-qqnt/src/index.js'

const session: PlatformSession = {
  platformSessionId: 'conversation-performance-session',
  platformId: 'qqnt-performance',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const conversation: IMConversation = {
  id: '1002974327', kind: 'group', title: 'Performance room',
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
  const store = new MessageStore(ctx.database)
  await store.upsertUsers(session, [
    { id: session.userId, firstName: 'Self' },
    ...Array.from({ length: 3_500 }, (_, index) => ({
      id: `member-${index}`, firstName: `Member ${index}`,
    })),
  ])
  const messages = Array.from({ length: 120 }, (_, index): IMMessage => ({
    id: `stored-${120 - index}`,
    conversationId: conversation.id,
    senderId: `member-${index % 10}`,
    timestamp: 120 - index,
    content: { parts: [{ type: 'text', text: `stored message ${120 - index}` }] },
  }))
  await store.ingestMany(session, conversation, messages, { allocation: 'history' })
  return store
}

function inputPeer(rpc: DialogRpc): tl.RawInputPeerChannel {
  return { _: 'inputPeerChannel', channelId: rpc.peerTlId(conversation.id), accessHash: Long.ONE }
}

function historyRequest(peer: tl.RawInputPeerChannel): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory', peer,
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50,
    maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

describe('conversation loading performance', () => {
  it('keeps dialogs, peer entry, and stored first-screen history below 100ms', async () => {
    const store = await createStore()
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    })
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [{
        id: conversation.id,
        kind: 'group' as const,
        title: conversation.title,
        peerUid: conversation.id,
        peerUin: conversation.id,
        chatType: 2 as const,
        unreadCount: 0,
        lastMessage: {
          id: 'stored-120', conversationId: conversation.id,
          senderId: 'member-0', timestamp: 120, outgoing: false,
          parts: [{ type: 'text' as const, text: 'stored message 120' }],
        },
      }],
      total: 1,
    }))
    const releaseHistory = Promise.withResolvers<void>()
    const historyReturned = Promise.withResolvers<void>()
    platform.client.getHistory = vi.fn(async () => {
      await releaseHistory.promise
      historyReturned.resolve()
      return { messages: [] }
    })
    const unsubscribe = await platform.subscribe(session, () => {})
    disposals.push(async () => { await unsubscribe() })
    await vi.waitFor(() => expect(platform.client.getDialogs).toHaveBeenCalled())

    const dialogsRpc = new DialogRpc(platform, session, store)
    const dialogsStarted = performance.now()
    const dialogs = await dialogsRpc.getDialogs({
      _: 'messages.getDialogs', excludePinned: false,
      offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
      limit: 100, hash: Long.ZERO,
    })
    const dialogsMs = performance.now() - dialogsStarted

    const peerRpc = new DialogRpc(platform, session, store)
    const peerStarted = performance.now()
    const peerDialogs = await peerRpc.getPeerDialogs({
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer: inputPeer(peerRpc) }],
    })
    const peerMs = performance.now() - peerStarted

    const historyRpc = new DialogRpc(platform, session, store)
    const historyStarted = performance.now()
    const history = await historyRpc.getHistory(historyRequest(inputPeer(historyRpc)))
    const historyMs = performance.now() - historyStarted

    expect(dialogs._ === 'messages.dialogsNotModified' ? [] : dialogs.dialogs).toHaveLength(1)
    expect(peerDialogs.dialogs).toHaveLength(1)
    expect(history._ === 'messages.messagesNotModified' ? [] : history.messages).toHaveLength(50)
    expect(dialogsMs).toBeLessThan(100)
    expect(peerMs).toBeLessThan(100)
    expect(historyMs).toBeLessThan(100)

    releaseHistory.resolve()
    await historyReturned.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
