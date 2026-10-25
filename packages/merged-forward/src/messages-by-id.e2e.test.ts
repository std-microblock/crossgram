import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  platformId: 'test', platformSessionId: 'merged-forward-by-id', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const first: IMConversation = { id: 'by-id-first', kind: 'group', title: 'By-id first' }
const second: IMConversation = { id: 'by-id-second', kind: 'group', title: 'By-id second' }
const firstBundle: IMMessageBundle = {
  id: 'bundle:by-id-first', title: '第一份聊天记录', preview: 'Alice: a0', locator: { root: 'by-id-first' },
}
const secondBundle: IMMessageBundle = {
  id: 'bundle:by-id-second', title: '第二份聊天记录', preview: 'Bob: b0', locator: { root: 'by-id-second' },
}

const text = (value: string) => ({ type: 'text' as const, text: value })

/** 第一份只有一个归档消息，第二份有两个：两者的消息 ID 都从 1000 起，所以 1000 必然重号。 */
const firstArchived: IMMessageSnapshot[] = [
  { id: 'a0', senderId: 'alice', timestamp: 100, content: { parts: [text('a0')] } },
]
const secondArchived: IMMessageSnapshot[] = [
  { id: 'b0', senderId: 'bob', timestamp: 100, content: { parts: [text('b0')] } },
  { id: 'b1', senderId: 'bob', timestamp: 101, content: { parts: [text('b1')] } },
]

const firstOuterMessage: IMMessage = {
  id: 'by-id-first-message', conversationId: first.id, senderId: 'alice', timestamp: 200,
  sender: { id: 'alice', firstName: 'Alice' },
  content: { parts: [{ type: 'message-bundle', bundle: firstBundle }] },
}
const secondOuterMessage: IMMessage = {
  id: 'by-id-second-message', conversationId: second.id, senderId: 'bob', timestamp: 201,
  sender: { id: 'bob', firstName: 'Bob' },
  content: { parts: [{ type: 'message-bundle', bundle: secondBundle }] },
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
      const root = (locator as { root?: string }).root
      if (root === 'by-id-first') return firstArchived
      if (root === 'by-id-second') return secondArchived
      return []
    },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getDialogs() {
    return {
      dialogs: [
        { conversation: first, lastMessage: firstOuterMessage, unreadCount: 0 },
        { conversation: second, lastMessage: secondOuterMessage, unreadCount: 0 },
      ],
    }
  },
  async getHistory(_session, conversation) {
    if (conversation.id === first.id) return { messages: [firstOuterMessage] }
    if (conversation.id === second.id) return { messages: [secondOuterMessage] }
    return { messages: [] }
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
  let plugin = ctx.plugin(mergedForward)
  await plugin
  disposals.push(async () => {
    await plugin.dispose()
    await bridge.dispose()
    await mtproto.dispose()
    await sqlite.dispose()
    await database.dispose()
  })
  const restart = async () => {
    await plugin.dispose()
    plugin = ctx.plugin(mergedForward)
    await plugin
  }
  return { ctx, dialogs, restart }
}

function getMessagesRequest(ids: number[]) {
  return {
    _: 'messages.getMessages' as const,
    id: ids.map((id) => ({ _: 'inputMessageID' as const, id })),
  }
}

function historyRequest(chatId: number) {
  return {
    _: 'messages.getHistory' as const,
    peer: { _: 'inputPeerChat' as const, chatId },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
    maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

describe('merged-forward messages.getMessages ownership', () => {
  it('answers only ids a single transcript owns and refuses ids two transcripts share', async () => {
    const { ctx, dialogs, restart } = await startRelay()
    const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never

    // 列表阶段会把两份转发都投影进内存缓存。
    const listed = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const chatIds = [...new Set(listed.messages.flatMap((message) => message._ === 'message'
      ? (message.entities ?? [])
        .filter((entity): entity is tl.RawMessageEntityTextUrl => entity._ === 'messageEntityTextUrl')
        .map((entity) => Number(/bridgebundle_(\d+)\//.exec(entity.url)![1]))
      : []))]
    expect(chatIds).toHaveLength(2)

    // 用各自的历史确认哪一份是「第一份」（只有 a0）哪一份是「第二份」（a0 之外还有 b1）。
    const textsByChatId = new Map<number, string[]>()
    for (const chatId of chatIds) {
      const page = await ctx.mtproto.dispatch(rpc, historyRequest(chatId) as never) as tl.messages.RawMessagesSlice
      textsByChatId.set(chatId, page.messages.map((message) => message._ === 'message' ? message.message : ''))
    }
    const secondChatId = [...textsByChatId].find(([, texts]) => texts.includes('b1'))![0]
    const firstChatId = [...textsByChatId].find(([, texts]) => !texts.includes('b1'))![0]
    expect(textsByChatId.get(firstChatId)).toEqual(['a0'])

    // 默认实现（非转发消息）的兜底路由：整条请求都不是虚拟消息时才会走到这里。
    const fallback: tl.messages.RawGetMessagesRequest[] = []
    ctx.mtproto.register('messages.getMessages', async (_rpc, request) => {
      const req = request as tl.messages.RawGetMessagesRequest
      fallback.push(req)
      return {
        _: 'messages.messages',
        messages: req.id.map((input) => ({
          _: 'message', id: input._ === 'inputMessageID' ? input.id : 0,
          peerId: { _: 'peerChat', chatId: 5 }, date: 1, message: 'ordinary',
        })),
        topics: [], chats: [], users: [],
      }
    })
    // 混合请求里剩下的 ID 由落库消息作答：记录 store 收到的 ID，确认只透传了没被认领的那些。
    const storeCalls: number[][] = []
    dialogs.getMessages = async (request) => {
      const ids = request.id.map((input) => input._ === 'inputMessageID' ? input.id : 0)
      storeCalls.push(ids)
      return {
        _: 'messages.messages',
        messages: ids.map((id) => ({
          _: 'message', id, peerId: { _: 'peerChat', chatId: 5 }, date: 1, message: 'stored',
        })),
        topics: [], chats: [], users: [],
      }
    }

    // 1000 同时属于两份转发（每份的 ID 都从 1000 起）：绝不能把其中任意一方的消息当成答案。
    const warn = vi.spyOn(ctx.logger, 'warn')
    await expect(ctx.mtproto.dispatch(rpc, getMessagesRequest([1000]) as never)).resolves.toMatchObject({
      messages: [{ _: 'messageEmpty', id: 1000 }],
    })
    expect(fallback).toHaveLength(0)
    // 歧义会留一条日志，带 ID 与所有声称拥有它的会话。
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toBe('merged-forward messages.getMessages ambiguous id=%d chats=%s')
    expect(warn.mock.calls[0]![1]).toBe(1000)
    expect(String(warn.mock.calls[0]![2]).split(',').sort()).toEqual([firstChatId, secondChatId].map(String).sort())
    warn.mockRestore()

    // 2000 只有第二份转发拥有：正常回答，peer 必须指向它自己的会话。
    await expect(ctx.mtproto.dispatch(rpc, getMessagesRequest([2000]) as never)).resolves.toMatchObject({
      messages: [{
        _: 'message', id: 2000, message: 'b1', peerId: { _: 'peerChat', chatId: secondChatId },
      }],
    })
    expect(fallback).toHaveLength(0)

    // 555 不是任何转发的虚拟消息：整条请求原样回落到默认实现。
    await expect(ctx.mtproto.dispatch(rpc, getMessagesRequest([555]) as never)).resolves.toMatchObject({
      messages: [{ _: 'message', id: 555, message: 'ordinary' }],
    })
    expect(fallback).toHaveLength(1)

    // 混合请求：虚拟 ID 由转发回答，其余交给落库消息，且只透传没被认领的 ID。
    await expect(ctx.mtproto.dispatch(rpc, getMessagesRequest([2000, 555]) as never)).resolves.toMatchObject({
      messages: [
        { _: 'message', id: 2000, message: 'b1' },
        { _: 'message', id: 555, message: 'stored' },
      ],
    })
    expect(storeCalls).toEqual([[555]])
    expect(fallback).toHaveLength(1)

    // 冷缓存（插件重启后记录被清空）时无法按 ID 反查会话，只能让默认实现回答；
    // 客户端拿到 messageEmpty 会自己重新拉历史，而不是拿到别人的会话里的消息。
    await restart()
    await expect(ctx.mtproto.dispatch(rpc, getMessagesRequest([2000]) as never)).resolves.toMatchObject({
      messages: [{ _: 'message', id: 2000, message: 'ordinary' }],
    })
  })
})
