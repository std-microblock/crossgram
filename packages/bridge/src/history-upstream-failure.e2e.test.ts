import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'

/**
 * 上游历史读取失败不能让已经投影过的消息一起消失。
 *
 * 线上形态：QQ 在历史边界上返回 `kNoMoreMsg (2004000)`，旧版 bridge 把它抛成
 * `500 getMsgs: no any more msg!`；relay 直接把整页 `messages.getHistory` 变成 500，
 * 客户端于是认为这个群「一条历史都没有」。修好 bridge 之后仍需兜底：任何上游失败
 * 都应该退回本地投影，只有本地也没有窗口时才把错误抛给客户端。
 */

const session: PlatformSession = {
  platformSessionId: 'history-upstream-failure-session',
  platformId: 'history-upstream-failure',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const conversation: IMConversation = { id: 'failing-room', kind: 'group', title: 'Failing room' }

const messages: IMMessage[] = Array.from({ length: 4 }, (_, index) => ({
  id: `failure-message-${index}`,
  conversationId: conversation.id,
  senderId: 'alice',
  sender: { id: 'alice', firstName: 'Alice' },
  timestamp: 1_785_000_000 + index,
  content: { parts: [{ type: 'text' as const, text: `message ${index}` }] },
}))

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  async subscribe() { return () => {} },
  async getDialogs() {
    return { dialogs: [{ conversation, unreadCount: 0, lastMessage: messages.at(-1) }], total: 1 }
  },
  async getHistory() {
    throw new Error('QQNT bridge 500: getMsgs: no any more msg! (2004000)')
  },
  async sendMessage() { throw new Error('send is disabled') },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore(): Promise<MessageStore> {
  const ctx = new Context()
  const databaseFiber = ctx.plugin(Database)
  const sqliteFiber = ctx.plugin(SQLiteDriver, { path: ':memory:' })
  await databaseFiber.await()
  await sqliteFiber.await()
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    await sqliteFiber.dispose()
    await databaseFiber.dispose()
  })
  return new MessageStore(ctx.database)
}

function historyRequest(channelId: number): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory',
    peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ZERO },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

describe('history upstream failure fallback', () => {
  it('serves the stored window when the platform rejects the history page', async () => {
    const store = await createStore()
    await store.upsertConversation(session, conversation)
    await store.ingestMany(session, conversation, messages, { allocation: 'history' })
    const trace = vi.fn()
    const rpc = new DialogRpc(platform, session, store, { onTrace: trace })

    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })

    const history = await rpc.getHistory(historyRequest(rpc.peerTlId(conversation.id))) as tl.messages.RawMessages

    expect(history.messages.map((message) =>
      message._ === 'message' ? message.message : '')).toEqual(
      ['message 3', 'message 2', 'message 1', 'message 0'],
    )
    expect(trace).toHaveBeenCalledWith(
      'history upstream sync failed; serving stored window peer=%s limit=%d error=%s',
      conversation.id, 101, expect.stringContaining('2004000'),
    )
  })

  it('still reports the upstream error when nothing local can answer', async () => {
    const store = await createStore()
    await store.upsertConversation(session, conversation)
    // 会话预览本身也读不到时，本地投影是空的：这时不能把失败伪装成「没有历史」。
    const emptyPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [{ conversation, unreadCount: 0 }], total: 1 }
      },
    }
    const rpc = new DialogRpc(emptyPlatform, session, store)
    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })

    await expect(rpc.getHistory(historyRequest(rpc.peerTlId(conversation.id))))
      .rejects.toThrow('getMsgs: no any more msg! (2004000)')
  })
})
