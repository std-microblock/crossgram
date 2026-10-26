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
  platformId: 'test', platformSessionId: 'merged-forward-page-e2e', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const outer: IMConversation = { id: 'page-outer', kind: 'group', title: 'Page outer' }
const bundle: IMMessageBundle = {
  id: 'bundle:page', title: '群聊的聊天记录', preview: 'Alice: m0',
  locator: { root: 'page' },
}
const nestedBundle: IMMessageBundle = {
  id: 'bundle:page-nested', title: '嵌套的聊天记录', preview: 'Carol: n0',
  locator: { root: 'page-nested' },
}

const text = (value: string) => ({ type: 'text' as const, text: value })

/**
 * Eight archived records whose timestamps only resolve to whole seconds, with
 * the nested merged forward as the second record of the first second.  QQ
 * orders a merged forward by the record order, so `r1` belongs above `r0` even
 * though both carry the same timestamp.
 */
const archived: IMMessageSnapshot[] = [
  { id: 'r0', senderId: 'alice', timestamp: 100, content: { parts: [text('m0')] } },
  { id: 'r1', senderId: 'alice', timestamp: 100, content: { parts: [{ type: 'message-bundle', bundle: nestedBundle }] } },
  { id: 'r2', senderId: 'alice', timestamp: 101, content: { parts: [text('m2')] } },
  { id: 'r3', senderId: 'alice', timestamp: 101, content: { parts: [text('m3')] } },
  { id: 'r4', senderId: 'bob', timestamp: 102, content: { parts: [text('m4')] } },
  { id: 'r5', senderId: 'bob', timestamp: 102, content: { parts: [text('m5')] } },
  { id: 'r6', senderId: 'bob', timestamp: 103, content: { parts: [text('m6')] } },
  { id: 'r7', senderId: 'bob', timestamp: 103, content: { parts: [text('m7')] } },
]

const nestedArchived: IMMessageSnapshot[] = [
  { id: 'n0', senderId: 'carol', timestamp: 200, content: { parts: [text('n0')] } },
  { id: 'n1', senderId: 'carol', timestamp: 201, content: { parts: [text('n1')] } },
  { id: 'n2', senderId: 'carol', timestamp: 202, content: { parts: [text('n2')] } },
]

const outerMessage: IMMessage = {
  id: 'page-outer-message', conversationId: outer.id, senderId: 'alice', timestamp: 300,
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
      const root = (locator as { root?: string }).root
      if (root === 'page') return archived
      if (root === 'page-nested') return nestedArchived
      return []
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

function historyRequest(peer: unknown, overrides: Record<string, number> = {}) {
  return {
    _: 'messages.getHistory' as const,
    peer,
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
    maxId: 0, minId: 0, hash: Long.ZERO,
    ...overrides,
  }
}

describe('merged-forward transcript history pages', () => {
  it('pages by message id, orders same-second records by the archive and opens nested transcripts', async () => {
    const { ctx, dialogs } = await startRelay()
    const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never

    const listed = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const projectedOuter = listed.messages.find((item) => item._ === 'message') as tl.RawMessage
    const entity = projectedOuter.entities?.find(
      (item): item is tl.RawMessageEntityTextUrl => item._ === 'messageEntityTextUrl',
    )
    if (!entity) throw new Error('merged-forward projection did not create a deep link')
    const chatId = Number(/bridgebundle_(\d+)\//.exec(entity.url)![1])
    const peer = { _: 'inputPeerChat' as const, chatId }

    const page = async (overrides: Record<string, number> = {}) => {
      const result = await ctx.mtproto.dispatch(rpc, historyRequest(peer, overrides) as never)
      if (result._ === 'mt_rpc_error') throw new Error(result.errorMessage)
      const slice = result as tl.messages.RawMessagesSlice
      return {
        ids: slice.messages.map((message) => message._ === 'message' ? message.id : 0),
        texts: slice.messages.map((message) => message._ === 'message' ? message.message : ''),
        count: slice.count,
      }
    }

    // Ids are handed out in the transcript's chronological order: the oldest
    // archived record owns 1000 and the newest 8000.  Records sharing a
    // timestamp keep the order the archive stored them in, so `r1` (the nested
    // card) sits above `r0` and `r7` above `r6`.
    expect(await page()).toEqual({
      ids: [8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000],
      texts: ['m7', 'm6', 'm5', 'm4', 'm3', 'm2', '查看聊天记录', 'm0'],
      count: 8,
    })

    // A page of the ids a client holds continues with exactly the next older
    // messages: `max_id`/`min_id` bound the transcript by id, and a page never
    // skips or repeats a message.
    expect(await page({ offsetId: 6000, limit: 3 })).toMatchObject({
      ids: [5000, 4000, 3000], texts: ['m4', 'm3', 'm2'],
    })
    expect(await page({ offsetId: 6000, addOffset: -1, limit: 3 })).toMatchObject({
      ids: [6000, 5000, 4000], texts: ['m5', 'm4', 'm3'],
    })
    expect(await page({ maxId: 5000 })).toMatchObject({
      ids: [4000, 3000, 2000, 1000], texts: ['m3', 'm2', '查看聊天记录', 'm0'],
    })
    expect(await page({ minId: 5000 })).toMatchObject({
      ids: [8000, 7000, 6000], texts: ['m7', 'm6', 'm5'],
    })
    expect(await page({ maxId: 7000, minId: 3000 })).toMatchObject({
      ids: [6000, 5000, 4000], texts: ['m5', 'm4', 'm3'],
    })
    // 已经越过最新一条的「向更新方向」请求必须回空页：tdesktop 的 loadMessagesDown 只有拿到
    // 空 slice 才会把 loadedAtBottom 置上，回一页重复消息会让它无限重拉（窗口永远打不开）。
    expect(await page({ offsetId: 8001, addOffset: -3, limit: 3 })).toMatchObject({
      ids: [], texts: [], count: 8,
    })
    // The deep link anchors at the first message, so the window a client opens
    // around that anchor has to contain it.
    expect(await page({ offsetId: 1000, addOffset: -25, limit: 50 })).toMatchObject({
      ids: [8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000],
    })
    // Offset id 1 is the client's "beginning of the history" sentinel; it is
    // below every transcript id and answers with the oldest records.
    expect(await page({ offsetId: 1, limit: 1 })).toMatchObject({ ids: [1000], texts: ['m0'] })
    expect(await page({ offsetId: 1, limit: 2 })).toMatchObject({ ids: [2000, 1000] })

    // The nested card inside the transcript carries its own durable link, and
    // the nested transcript pages the same way.
    const nestedCard = await ctx.mtproto.dispatch(rpc, historyRequest(peer) as never)
    const nestedUrl = (nestedCard as tl.messages.RawMessagesSlice).messages
      .flatMap((message) => message._ === 'message' ? message.entities ?? [] : [])
      .find((item): item is tl.RawMessageEntityTextUrl =>
        item._ === 'messageEntityTextUrl' && item.url.includes('bridgebundle_'))
    if (!nestedUrl) throw new Error('nested merged-forward link was not projected')
    const nestedChatId = Number(/bridgebundle_(\d+)\//.exec(nestedUrl.url)![1])
    expect(nestedChatId).not.toBe(chatId)
    const nestedPeerId = Number(/bridgebundle_\d+\/(\d+)$/.exec(nestedUrl.url)![1])
    expect(nestedPeerId).toBe(1000)
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'contacts.resolveUsername', username: `bridgebundle_${nestedChatId}`,
    } as never)).resolves.toMatchObject({
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: nestedChatId },
      chats: [{ _: 'chat', id: nestedChatId, title: nestedBundle.title }],
    })
    const nestedPage = await ctx.mtproto.dispatch(rpc, historyRequest(
      { _: 'inputPeerChat', chatId: nestedChatId },
    ) as never) as tl.messages.RawMessagesSlice
    expect(nestedPage.messages.map((message) => message._ === 'message' ? message.id : 0))
      .toEqual([3000, 2000, 1000])
    expect(nestedPage.messages.map((message) => message._ === 'message' ? message.message : ''))
      .toEqual(['n2', 'n1', 'n0'])

    // 客户端缓存里还留着基址为 2^31 的旧链接（`2^31 + row * 1024 + pathCode`）。旧基址产出的 ID
    // 全部低于新基址，两个区间互不相交，所以旧链接仍要解析成同一份聊天记录，而不是落到默认的
    // USERNAME_NOT_OCCUPIED 让客户端把链接记成死链。
    const [storedOuter] = await ctx.database.get('mtproto_im_message', {
      primaryPlatformMessageId: outerMessage.id,
    })
    const legacyChatId = 2 ** 31 + storedOuter!.id * 1024
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'contacts.resolveUsername', username: `bridgebundle_${legacyChatId}`,
    } as never)).resolves.toMatchObject({
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: legacyChatId },
      chats: [{ _: 'chat', id: legacyChatId, title: bundle.title }],
    })
    // 旧 ID 与新 ID 指向同一份历史，分页结果必须一致。
    const legacyPage = await ctx.mtproto.dispatch(rpc, historyRequest({
      _: 'inputPeerChat', chatId: legacyChatId,
    }) as never) as tl.messages.RawMessagesSlice
    expect(legacyPage.messages.map((message) => message._ === 'message' ? message.id : 0))
      .toEqual([8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000])
  })
})
