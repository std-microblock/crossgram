import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry } from './platform-manager.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { MessageProjectionPipeline } from './message-projection.js'
import { UpdateManager } from './update-manager.js'

/**
 * 客户端落后到补不上连续的一段频道更新时，服务端必须按 `updates.channelDifferenceTooLong` 的契约
 * 让它重建频道，而不是把保留窗口里最旧的一页当作「后续更新」发出去。
 *
 * 后者会让客户端把 pts 静默跳到页尾：中间那段消息永久丢失（用户看到「少了几千条」），
 * 而且客户端会继续逐页消费几千条陈旧更新——生产抓包里 20 秒收到 28 页、2546 条消息、182 次
 * `upload.getFile`，期间用户向上翻历史会被反复拉回底部。
 */

const session: PlatformSession = {
  platformSessionId: 'channel-reset-session',
  platformId: 'channel-reset',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const conversation = { id: 'reset-room', kind: 'group' as const, title: 'Reset room' }

const messages: IMMessage[] = Array.from({ length: 6 }, (_, index) => ({
  id: `reset-message-${index}`,
  conversationId: conversation.id,
  senderId: 'alice',
  sender: { id: 'alice', firstName: 'Alice' },
  timestamp: 1_785_000_000 + index,
  content: { parts: [{ type: 'text' as const, text: `message ${index}` }] },
}))

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: {
      text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0,
    },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  async subscribe() { return () => {} },
  async getDialogs() {
    return {
      dialogs: [{ conversation, unreadCount: 0, lastMessage: messages.at(-1) }],
      total: 1,
    }
  },
  async getHistory() { return { messages: [] } },
  async sendMessage() { throw new Error('send is disabled') },
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
  return { ctx, store: new MessageStore(ctx.database) }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('channel difference reset', () => {
  it('publishes a dialog the client can reset the channel with instead of skipping pruned pts', async () => {
    const { ctx, store } = await createStore()
    const projection = new MessageProjectionPipeline(new Context())
    const rpc = new DialogRpc(platform, session, store)
    const updates = new UpdateManager(
      ctx.database,
      new PlatformRegistry([[session.platformId, platform]]),
      store,
      () => 0,
      1, undefined, undefined, undefined, undefined, projection,
    )

    await store.ingestDialogs(session, [{
      conversation, unreadCount: 0, lastMessage: messages.at(-1),
    }])
    await store.ingestMany(session, conversation, messages, { allocation: 'history' })
    const channelId = rpc.peerTlId(conversation.id)
    // 频道的 pts 已经推进到 1202，但 delivery 只有最后一条：客户端 pts = 1 时缺口无法补齐。
    const delivery = await store.prepareUpdateDelivery(
      'reset-channel-update', session.platformSessionId, 1_201, messages.at(-1)!.timestamp, channelId,
    )
    await store.setUpdatePayload('reset-channel-update', {
      _: 'updates', updates: [], users: [], chats: [], date: delivery.date, seq: delivery.seq,
    })

    const result = await updates.getChannelDifference(
      session.platformSessionId,
      {
        _: 'updates.getChannelDifference',
        channel: { _: 'inputChannel', channelId, accessHash: Long.ZERO },
        filter: { _: 'channelMessagesFilterEmpty' },
        pts: 1,
        limit: 100,
      },
      (requestedChannelId, latestPts) => rpc.channelDifferenceTooLong(requestedChannelId, latestPts),
    )

    expect(result._).toBe('updates.channelDifferenceTooLong')
    const tooLong = result as tl.updates.RawChannelDifferenceTooLong
    // 这条响应只描述频道，dialog 必然是普通 `dialog` 而不是 community 变体。
    const dialog = tooLong.dialog as tl.RawDialog
    expect(tooLong.final).toBe(true)
    // `dialog.pts` 是客户端重建后要保存的频道 pts，必须等于服务端最新值。
    expect(dialog.pts).toBe(1_202)
    expect(dialog.peer).toEqual({ _: 'peerChannel', channelId })
    expect(dialog.topMessage).toBeGreaterThan(0)
    expect(tooLong.messages.map((message) => message._ === 'message' ? message.id : 0))
      .toEqual([dialog.topMessage])
    expect(tooLong.chats).toMatchObject([{ _: 'channel', id: channelId }])
    // 客户端会把 topMessage 当普通消息解析，必须指向库里最后一条真实消息。
    expect(await store.findProjectedByTlId(
      session.platformSessionId, dialog.topMessage, conversation.id,
    )).toMatchObject({ source: { id: messages.at(-1)!.id } })
    // 响应要能按 TL 编码，客户端才拿得到。
    expect(() => wireRoundTrip(tooLong)).not.toThrow()
  })

  it('still streams a contiguous window so an up-to-date client keeps its local history', async () => {
    const { ctx, store } = await createStore()
    const projection = new MessageProjectionPipeline(new Context())
    const rpc = new DialogRpc(platform, session, store)
    const updates = new UpdateManager(
      ctx.database,
      new PlatformRegistry([[session.platformId, platform]]),
      store,
      () => 0,
      1, undefined, undefined, undefined, undefined, projection,
    )
    await store.ingestDialogs(session, [{
      conversation, unreadCount: 0, lastMessage: messages.at(-1),
    }])
    const channelId = rpc.peerTlId(conversation.id)
    const delivery = await store.prepareUpdateDelivery(
      'contiguous-channel-update', session.platformSessionId, 1, messages.at(-1)!.timestamp, channelId,
    )
    await store.setUpdatePayload('contiguous-channel-update', {
      _: 'updates', updates: [], users: [], chats: [], date: delivery.date, seq: delivery.seq,
    })

    const result = await updates.getChannelDifference(
      session.platformSessionId,
      {
        _: 'updates.getChannelDifference',
        channel: { _: 'inputChannel', channelId, accessHash: Long.ZERO },
        filter: { _: 'channelMessagesFilterEmpty' },
        pts: 1,
        limit: 100,
      },
      (requestedChannelId, latestPts) => rpc.channelDifferenceTooLong(requestedChannelId, latestPts),
    )

    expect(result._).toBe('updates.channelDifference')
    expect(() => wireRoundTrip(result)).not.toThrow()
  })
})
