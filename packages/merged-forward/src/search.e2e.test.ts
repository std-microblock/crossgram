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
  platformId: 'test', platformSessionId: 'merged-forward-search', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const outer: IMConversation = { id: 'search-outer', kind: 'group', title: 'Search outer' }
const bundle: IMMessageBundle = {
  id: 'bundle:search', title: '群聊的聊天记录', preview: 'Alice: 神tm扔水里看米哈游',
  locator: { root: 'search' },
}

const text = (value: string) => ({ type: 'text' as const, text: value })

/**
 * 七条归档记录，按时间序拿到 1000..7000 的消息 ID（与 getHistory 的分页口径一致）。
 * 其中五条是生产上真实出现过的文本，一条是「查看聊天记录」占位，一条是拉丁文用于验证大小写折叠。
 */
const archived: IMMessageSnapshot[] = [
  { id: 's0', senderId: 'alice', timestamp: 100, content: { parts: [text('神tm扔水里看米哈游')] } },
  { id: 's1', senderId: 'bob', timestamp: 200, content: { parts: [text('神tm扔水里看米哈游')] } },
  { id: 's2', senderId: 'alice', timestamp: 300, content: { parts: [text('神tm扔水里看米哈游')] } },
  { id: 's3', senderId: 'bob', timestamp: 400, content: { parts: [text('神tm扔水里看米哈游')] } },
  { id: 's4', senderId: 'alice', timestamp: 500, content: { parts: [text('HELLO MixedCase')] } },
  { id: 's5', senderId: 'bob', timestamp: 600, content: { parts: [text('查看聊天记录')] } },
  { id: 's6', senderId: 'alice', timestamp: 700, content: { parts: [text('神tm扔水里看米哈游')] } },
]

const outerMessage: IMMessage = {
  id: 'search-outer-message', conversationId: outer.id, senderId: 'alice', timestamp: 800,
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
      return (locator as { root?: string }).root === 'search' ? archived : []
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

function searchRequest(peer: unknown, overrides: Record<string, unknown> = {}) {
  return {
    _: 'messages.search' as const,
    peer,
    q: '',
    filter: { _: 'inputMessagesFilterEmpty' as const },
    minDate: 0,
    maxDate: 0,
    offsetId: 0,
    addOffset: 0,
    limit: 100,
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
    ...overrides,
  }
}

describe('merged-forward transcript search', () => {
  it('filters a transcript by message text and pages it with the history cursors', async () => {
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
    const peer = { _: 'inputPeerChat' as const, chatId }

    const search = async (overrides: Record<string, unknown> = {}) => {
      const result = await ctx.mtproto.dispatch(rpc, searchRequest(peer, overrides) as never)
      if (result._ === 'mt_rpc_error') throw new Error(result.errorMessage)
      const slice = result as tl.messages.RawMessagesSlice
      return {
        ids: slice.messages.map((message) => message._ === 'message' ? message.id : 0),
        texts: slice.messages.map((message) => message._ === 'message' ? message.message : ''),
        count: slice.count,
        chats: slice.chats,
        users: slice.users,
      }
    }

    // 生产实测：七条记录里五条是「神tm扔水里看米哈游」，搜「米哈游」应得 5 条，最新在前。
    expect(await search({ q: '米哈游' })).toMatchObject({
      ids: [7000, 4000, 3000, 2000, 1000],
      count: 5,
    })
    // 中文关键字没有词边界，子串即可命中。
    expect((await search({ q: '扔水里' })).count).toBe(5)
    // 大小写不敏感。
    expect(await search({ q: 'mixedcase' })).toMatchObject({ ids: [5000], count: 1 })
    // 没有匹配时也给一个空页，而不是报错或回落。
    expect(await search({ q: '不存在的关键字' })).toMatchObject({ ids: [], count: 0 })

    // 空 query = 全部命中（有些客户端用它配合游标做范围翻页）。
    expect(await search({ q: '' })).toMatchObject({
      ids: [7000, 6000, 5000, 4000, 3000, 2000, 1000], count: 7,
    })

    // 游标语义与 messages.getHistory 完全一致：offset 排他、addOffset 偏移、max/min 是边界。
    expect(await search({ q: '米哈游', offsetId: 4000, limit: 2 })).toMatchObject({
      ids: [3000, 2000], count: 5,
    })
    // addOffset = -1 把起点挪回 offset 那一页的开头（getHistory 的页首偏移）。
    expect(await search({ q: '米哈游', offsetId: 4000, addOffset: -1, limit: 2 })).toMatchObject({
      ids: [4000, 3000], count: 5,
    })
    expect(await search({ q: '米哈游', maxId: 4000, minId: 1000 })).toMatchObject({
      ids: [3000, 2000], count: 5,
    })
    // 日期范围只影响命中集合（count 也随之变化），不影响分页游标。
    expect(await search({ q: '米哈游', minDate: 400 })).toMatchObject({ ids: [7000, 4000], count: 2 })
    expect(await search({ q: '米哈游', maxDate: 300 })).toMatchObject({
      ids: [3000, 2000, 1000], count: 3,
    })

    // 返回的实体与 getHistory 同源，客户端才能画出虚拟群与发送者头像。
    const matched = await search({ q: '米哈游' })
    expect(matched.chats).toMatchObject([{ _: 'chat', id: chatId, title: bundle.title }])
    // 归档里没有资料的发送者退化成平台用户 ID；两个发送者都要出现在 users 里。
    expect(matched.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['alice', 'bob'])

    // 不认识的 peer、非「全部消息」的 filter、以及给不出正确结果的发送者筛选，
    // 都必须原样交回默认实现（undefined），而不是自己编一份结果。
    const fallback: tl.RpcMethod[] = []
    ctx.mtproto.register('messages.search', async (_rpc, request) => {
      fallback.push(request)
      return { _: 'messages.messages', messages: [], topics: [], chats: [], users: [] }
    })
    await ctx.mtproto.dispatch(rpc, searchRequest({ _: 'inputPeerChat', chatId: 777 }) as never)
    expect(fallback).toHaveLength(1)
    await ctx.mtproto.dispatch(rpc, searchRequest({ _: 'inputPeerUser', userId: 1, accessHash: Long.ZERO }) as never)
    expect(fallback).toHaveLength(2)
    await ctx.mtproto.dispatch(rpc, searchRequest(peer, {
      filter: { _: 'inputMessagesFilterPhotos' },
    }) as never)
    expect(fallback).toHaveLength(3)
    await ctx.mtproto.dispatch(rpc, searchRequest(peer, {
      fromId: { _: 'inputPeerUser', userId: 1, accessHash: Long.ZERO },
    }) as never)
    expect(fallback).toHaveLength(4)
  })
})
