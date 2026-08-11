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
import { QQNTPlatform } from '../../platform-crossgram/src/index.js'

const session: PlatformSession = {
  platformSessionId: 'conversation-performance-session',
  platformId: 'qqnt-performance',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const conversation: IMConversation = {
  id: '1002974327', kind: 'group', title: 'Performance room',
  metadata: { qqPeerUid: '1002974327', qq: '1002974327', chatType: 2 },
}
const dialogConversations: IMConversation[] = [
  conversation,
  ...Array.from({ length: 99 }, (_, index) => ({
    id: `performance-dialog-${index + 1}`,
    kind: index < 54 ? 'direct' as const : 'group' as const,
    title: `Performance dialog ${index + 1}`,
    metadata: {
      qqPeerUid: `performance-dialog-${index + 1}`,
      qq: `performance-dialog-${index + 1}`,
      chatType: index < 54 ? 1 : 2,
    },
  })),
]

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
  await Promise.all(dialogConversations.slice(1).map((dialog, index) => store.ingest(session, dialog, {
    id: `dialog-preview-${index + 1}`,
    sourceIds: [`dialog-preview-alias-${index + 1}`],
    conversationId: dialog.id,
    senderId: `member-${index % 10}`,
    timestamp: 1_000 + index,
    content: { parts: [{ type: 'text', text: `dialog preview ${index + 1}` }] },
  })))
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
  it('keeps revalidated dialogs, peer entry, and first-screen history bounded', async () => {
    const store = await createStore()
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    })
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: dialogConversations.map((dialog, index) => ({
        id: dialog.id,
        kind: dialog.kind === 'direct' ? 'direct' as const : 'group' as const,
        title: dialog.title,
        peerUid: dialog.id,
        peerUin: dialog.id,
        chatType: dialog.kind === 'direct' ? 1 as const : 2 as const,
        unreadCount: 0,
        lastMessage: index === 0 ? {
          id: 'stored-120', conversationId: dialog.id,
          senderId: 'member-0', timestamp: 120, outgoing: false,
          parts: [{ type: 'text' as const, text: 'stored message 120' }],
        } : {
          id: `dialog-preview-${index}`, conversationId: dialog.id,
          senderId: `member-${(index - 1) % 10}`, timestamp: 999 + index, outgoing: false,
          parts: [{ type: 'text' as const, text: `dialog preview ${index}` }],
        },
      })),
      total: 100,
    }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [] }))
    const unsubscribe = await platform.subscribe(session, () => {})
    disposals.push(async () => { await unsubscribe() })
    await vi.waitFor(() => expect(platform.client.getDialogs).toHaveBeenCalled())

    const upsertUsers = vi.spyOn(store, 'upsertUsers')
    const readProjected = vi.spyOn(store, 'readProjectedByPlatformIds')
    const dialogsRpc = new DialogRpc(platform, session, store)
    const dialogsStarted = performance.now()
    const dialogs = await dialogsRpc.getDialogs({
      _: 'messages.getDialogs', excludePinned: false,
      offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
      limit: 100, hash: Long.ZERO,
    })
    const dialogsMs = performance.now() - dialogsStarted
    const repeatedDialogsStarted = performance.now()
    const repeatedDialogs = await dialogsRpc.getDialogs({
      _: 'messages.getDialogs', excludePinned: false,
      offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
      limit: 100, hash: Long.ZERO,
    })
    const repeatedDialogsMs = performance.now() - repeatedDialogsStarted

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

    expect(dialogs._ === 'messages.dialogsNotModified' ? [] : dialogs.dialogs).toHaveLength(100)
    expect(repeatedDialogs._ === 'messages.dialogsNotModified' ? [] : repeatedDialogs.dialogs).toHaveLength(100)
    expect(peerDialogs.dialogs).toHaveLength(1)
    expect(history._ === 'messages.messagesNotModified' ? [] : history.messages).toHaveLength(50)
    expect(dialogsMs).toBeLessThan(250)
    expect(repeatedDialogsMs).toBeLessThan(250)
    expect(peerMs).toBeLessThan(100)
    expect(historyMs).toBeLessThan(100)
    expect(upsertUsers).not.toHaveBeenCalled()
    expect(readProjected).toHaveBeenCalledTimes(2)

  })
})
