import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { BlockedPeerStore, type BlockedContentMode } from './blocked-peers.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { ReactionRpc } from './reaction-rpc.js'

const session: PlatformSession = {
  platformSessionId: 'blocked-dialog-session', platformId: 'blocked-dialog-platform',
  userId: 'self', credentials: {}, metadata: { firstName: 'Current' },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness(mode: BlockedContentMode) {
  const alice: IMMessage = {
    id: 'alice-message', conversationId: 'group', senderId: 'alice', timestamp: 1_700_000_000,
    content: { parts: [{ type: 'text', text: 'from Alice' }] },
  }
  const bob: IMMessage = {
    id: 'bob-message', conversationId: 'group', senderId: 'bob', timestamp: 1_700_000_100,
    content: { parts: [{ type: 'text', text: 'from Bob' }] },
    reactionContext: {
      available: [{ key: 'like', presentation: { type: 'emoji', emoticon: '👍' } }],
      maxSelected: 1,
      reactions: [{ key: 'like', count: 2, recentActors: [{ userId: 'alice' }] }],
    },
  }
  const mention: IMMessage = {
    id: 'mention-message', conversationId: 'group', senderId: 'bob', timestamp: 1_700_000_200,
    content: { parts: [{
      type: 'text', text: '@Alice hello',
      entities: [{ type: 'mention', offset: 0, length: 6, userId: 'alice' }],
    }] },
  }
  const reply: IMMessage = {
    id: 'reply-message', conversationId: 'group', senderId: 'bob', timestamp: 1_700_000_300,
    replyToId: alice.id,
    content: { parts: [{ type: 'text', text: 'replying to Alice' }] },
  }
  const messages = [alice, bob, mention, reply]
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
      conversations: { groups: true, channels: true, subchannels: false },
      reactions: { read: true, write: false, events: true, actorList: true, maxSelected: 1 },
    },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
    async getDialogs() {
      return { dialogs: [{
        conversation: { id: 'group', kind: 'group' as const, title: 'Group' },
        unreadCount: 4, lastMessage: reply,
      }] }
    },
    async getHistory() { return { messages } },
    async getUser(_session, id) { return { id, firstName: id === 'alice' ? 'Alice' : 'Bob' } },
  }
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const store = new MessageStore(ctx.database)
  const blocked = new BlockedPeerStore(ctx.database, mode)
  const rpc = new DialogRpc(
    platform, session, store, undefined, undefined, 1, undefined,
    new ReactionRpc(platform, session, 1, ctx.database),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, blocked,
  )
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const dialogs = await rpc.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }) as tl.messages.RawDialogs
  const group = dialogs.chats[0] as tl.RawChannel
  await rpc.getHistory(historyRequest(group.id))
  const aliceId = await rpc.userTlId('alice')
  return { rpc, group, aliceId }
}

function historyRequest(channelId: number): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory',
    peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ZERO },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
    maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

describe('DialogRpc blocked content', () => {
  it('implements Telegram blocklist RPCs and hides blocked messages and reaction actors', async () => {
    const { rpc, group, aliceId } = await createHarness('hide-user')
    const change = await rpc.blockPeer({
      _: 'contacts.block', id: { _: 'inputPeerUser', userId: aliceId, accessHash: Long.ZERO },
    })
    expect(change).toMatchObject({ changed: true, userId: aliceId })

    const blocked = await rpc.getBlocked({ _: 'contacts.getBlocked', offset: 0, limit: 100 })
    expect(blocked).toMatchObject({
      _: 'contacts.blocked',
      blocked: [{ peerId: { _: 'peerUser', userId: aliceId } }],
      users: [{ _: 'user', id: aliceId, firstName: 'Alice' }],
    })
    await expect(rpc.getFullUser({
      _: 'users.getFullUser', id: { _: 'inputUser', userId: aliceId, accessHash: Long.ZERO },
    })).resolves.toMatchObject({ fullUser: { blocked: true } })

    const history = await rpc.getHistory(historyRequest(group.id)) as tl.messages.RawMessages
    expect(history.messages.map((item) => item._ === 'message' ? item.message : '')).toEqual([
      'replying to Alice', '@Alice hello', 'from Bob',
    ])
    expect(history.messages.find((item) => item._ === 'message' && item.message === 'from Bob'))
      .toMatchObject({ reactions: { results: [{ count: 1 }], recentReactions: [] } })

    await rpc.unblockPeer({
      _: 'contacts.unblock', id: { _: 'inputPeerUser', userId: aliceId, accessHash: Long.ZERO },
    })
    const restored = await rpc.getHistory(historyRequest(group.id)) as tl.messages.RawMessages
    expect(restored.messages).toHaveLength(4)
  })

  it('strict mode also hides messages that mention or reply to a blocked user', async () => {
    const { rpc, group, aliceId } = await createHarness('hide-related')
    await rpc.blockPeer({
      _: 'contacts.block', id: { _: 'inputPeerUser', userId: aliceId, accessHash: Long.ZERO },
    })

    const history = await rpc.getHistory(historyRequest(group.id)) as tl.messages.RawMessages
    expect(history.messages.map((item) => item._ === 'message' ? item.message : '')).toEqual(['from Bob'])
  })
})
