import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  DialogRpc,
  MessageProjectionPipeline,
  MessageStore,
  MtprotoBridgeService,
  defineModels,
  type BridgeSessionState,
  type IMConversation,
  type IMMessage,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type IMPlatform,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'merged-forward-history-tail', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const outer: IMConversation = { id: 'tail-outer', kind: 'group', title: 'Tail outer' }
const bundle: IMMessageBundle = {
  id: 'bundle:tail', title: '群聊的聊天记录', preview: 'Alice: m0', locator: { root: 'tail' },
}

const text = (value: string) => ({ type: 'text' as const, text: value })

/** 七条归档记录，消息 ID 依次是 1000..7000（深链锚点就是最早那条 1000）。 */
const archived: IMMessageSnapshot[] = Array.from({ length: 7 }, (_, index) => ({
  id: `t${index}`,
  senderId: index % 2 ? 'bob' : 'alice',
  timestamp: 100 + index,
  content: { parts: [text(`m${index}`)] },
}))

const outerMessage: IMMessage = {
  id: 'tail-outer-message', conversationId: outer.id, senderId: 'alice', timestamp: 800,
  sender: { id: 'alice', firstName: 'Alice' },
  content: { parts: [{ type: 'message-bundle', bundle }] },
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    readState: { markRead: false, events: false },
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  messageBundles: {
    async load(_session, locator) {
      return (locator as { root?: string }).root === 'tail' ? archived : []
    },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getDialogs() {
    return { dialogs: [{ conversation: outer, lastMessage: outerMessage, unreadCount: 0 }] }
  },
  async getHistory(_session, conversation) {
    return { messages: conversation.id === outer.id ? [outerMessage] : [] }
  },
  async getUser(_session, id) { return { id, firstName: id } },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

async function startRelay() {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: ':memory:' })
  await Promise.all([database, sqlite])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const mtproto = ctx.plugin(Mtproto, { host: '127.0.0.1', port: 0 })
  await mtproto
  const pipeline = new MessageProjectionPipeline(ctx)
  const store = new MessageStore(ctx.database, undefined, undefined, undefined, pipeline)
  const dialogs = new DialogRpc(
    platform, session, store,
    undefined, undefined, 1,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    pipeline,
  )
  const bridge = ctx.plugin((scope) => {
    new MtprotoBridgeService(scope, async () => ({
      generation: {}, platform, session, projection: pipeline, dialogs, stickers: {} as never,
    } satisfies BridgeSessionState))
  })
  await bridge
  const plugin = ctx.plugin(mergedForward)
  await plugin
  disposals.push(async () => {
    await plugin.dispose()
    await bridge.dispose()
    await mtproto.dispose()
    await sqlite.dispose()
    await database.dispose()
  })
  return { ctx, dialogs }
}

function historyRequest(chatId: number, overrides: Record<string, number> = {}) {
  return {
    _: 'messages.getHistory' as const,
    peer: { _: 'inputPeerChat' as const, chatId },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
    maxId: 0, minId: 0, hash: Long.ZERO,
    ...overrides,
  }
}

describe('merged-forward transcript tail', () => {
  it('stops the loadMessagesDown loop instead of repeating the newest page', async () => {
    const { ctx, dialogs } = await startRelay()
    const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never

    const listed = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const chatId = Number(/bridgebundle_(\d+)\//.exec(
      listed.messages
        .find((item) => item._ === 'message')!
        .entities!
        .find((item): item is tl.RawMessageEntityTextUrl => item._ === 'messageEntityTextUrl')!
        .url,
    )![1])

    const page = async (overrides: Record<string, number> = {}) => {
      const result = await ctx.mtproto.dispatch(rpc, historyRequest(chatId, overrides) as never)
      if (result._ === 'mt_rpc_error') throw new Error(result.errorMessage)
      const slice = result as tl.messages.RawMessagesSlice
      return {
        ids: slice.messages.map((message) => message._ === 'message' ? message.id : 0),
        count: slice.count,
      }
    }

    // 首屏：offset_id = 0 / add_offset = 0 仍然是最新一页。
    expect(await page({ limit: 3 })).toMatchObject({ ids: [7000, 6000, 5000], count: 7 })

    // 客户端（tdesktop 的 `HistoryWidget::loadMessagesDown()`）在 loadedAtBottom 为 false 时
    // 会以「往外更新方向要一页」的形态轮询：offset_id = maxId + 1, add_offset = -loadCount。
    // 聊天记录不会再增长，答案必须是空页——否则它拿到的永远是同一页，20ms 一次重拉、窗口打不开。
    expect(await page({ offsetId: 7001, addOffset: -50, limit: 50 })).toMatchObject({ ids: [], count: 7 })
    // 同一条请求再来一次（客户端确实会这么做）仍然是空页，循环就此结束。
    expect(await page({ offsetId: 7001, addOffset: -50, limit: 50 })).toMatchObject({ ids: [], count: 7 })

    // 反方向同理：tdesktop 往更早方向预加载（`loadMessagesUp`）用 offset_id = minMsgId、
    // add_offset = 0，落到最早一条时也必须是空页，否则同样是 20ms 一次重拉，并把视图反复拽回
    // 底部（生产实测 2840 次，用户看到的就是「一直跳到最下面、划不上去」）。
    expect(await page({ offsetId: 1000, limit: 3 })).toMatchObject({ ids: [], count: 7 })
    expect(await page({ offsetId: 1000, limit: 3 })).toMatchObject({ ids: [], count: 7 })
    // 深链开窗走的是负偏移（offset_id = anchor, add_offset = -limit/2），仍然给出含锚点那一页。
    expect(await page({ offsetId: 1000, addOffset: -25, limit: 50 })).toMatchObject({
      ids: [7000, 6000, 5000, 4000, 3000, 2000, 1000], count: 7,
    })
    // 哨兵语义不变。
    expect(await page({ offsetId: 1, limit: 1 })).toMatchObject({ ids: [1000], count: 7 })
  })
})
