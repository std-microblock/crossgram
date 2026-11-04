import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type {
  IMConversation, IMHistoryPage, IMHistoryQuery, IMMessage, IMPlatform, PlatformSession,
} from './platform.js'

/**
 * 客户端的历史分页契约（`core.telegram.org/api/offsets`）：
 * `offset = max(0, offsetFromID(offset_id) + add_offset)`，其中 `offsetFromID(x) = #{id >= x}`，
 * 返回从该位置起往更早方向的 `limit` 条。负的 `add_offset` 因此把窗口往**更新**方向挪。
 *
 * 客户端往更新方向翻页时把「本机最大消息 ID + 1」当锚点（Telegram Desktop 的
 * `loadMessagesDown`、TDLib 的 `get_next_server_message_id` 都是这么发的），这个 ID 本身不是
 * 一条消息。服务端必须把它解析成插入位置，返回紧挨着锚点的一页；退化成「一整页最新消息」
 * 会让客户端把最新一页接到本地列表末尾，中间留下永远补不上的断层。
 */

const session: PlatformSession = {
  platformSessionId: 'history-paging-session',
  platformId: 'history-paging',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const conversation: IMConversation = { id: 'history-peer', kind: 'group', title: 'History peer' }

const CORPUS_SIZE = 1_000

function message(index: number): IMMessage {
  return {
    id: `m-${index}`,
    conversationId: conversation.id,
    senderId: 'alice',
    timestamp: 1_700_000_000 + index,
    content: { parts: [{ type: 'text', text: `message ${index}` }] },
  }
}

const corpus = Array.from({ length: CORPUS_SIZE }, (_, index) => message(index))

/** 上游平台：只按 `before`/`after`/最新一页取，和真实平台一样不去理解 `offset_id`。 */
function makePlatform(options: { recalled?: readonly number[] } = {}): {
  platform: IMPlatform
  calls: IMHistoryQuery[]
} {
  const calls: IMHistoryQuery[] = []
  const recalled = new Set(options.recalled ?? [])
  const upstream = corpus.filter((entry) => !recalled.has(Number(entry.id.slice(2))))
  const indexOf = (id: string | undefined) =>
    id === undefined ? -1 : upstream.findIndex((entry) => entry.id === id)
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
      conversations: { groups: true, channels: false, subchannels: false },
    },
    async subscribe() { return () => {} },
    async getDialogs() { return { dialogs: [], total: 0 } },
    async getHistory(_session, _conversation, query: IMHistoryQuery = {}): Promise<IMHistoryPage> {
      calls.push({ ...query })
      const limit = query.limit ?? 50
      let page: IMMessage[]
      if (query.after) {
        const index = indexOf(query.after.id)
        page = index < 0 ? [] : upstream.slice(index + 1, index + 1 + limit)
      } else if (query.before) {
        const index = indexOf(query.before.id)
        page = index < 0 ? [] : upstream.slice(Math.max(0, index - limit), index)
      } else {
        page = upstream.slice(-limit)
      }
      // 平台按「最新在前」返回一页，存储层自己会排序。
      return { messages: page.slice().reverse() }
    },
    async sendMessage() { throw new Error('send is disabled') },
  }
  return { platform, calls }
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
  return new MessageStore(ctx.database)
}

function historyRequest(
  peerId: number,
  overrides: Partial<tl.messages.RawGetHistoryRequest> = {},
): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory',
    peer: { _: 'inputPeerChannel', channelId: peerId, accessHash: Long.ONE },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50,
    maxId: 0, minId: 0, hash: Long.ZERO,
    ...overrides,
  }
}

function pageIds(result: Awaited<ReturnType<DialogRpc['getHistory']>>): number[] {
  if (result._ === 'messages.messagesNotModified') return []
  return result.messages.flatMap((entry) => entry._ === 'message' ? [entry.id] : [])
}

/** 本地投影里已经存在的消息：平台消息序号 → Telegram 消息 ID。 */
async function projectedIds(
  store: MessageStore,
): Promise<{ tlId: (index: number) => number, indexOf: (tlId: number) => number }> {
  const stored = await store.readAllProjectedHistory(session.platformSessionId, conversation.id)
  const tlId = new Map(stored.map((entry) => [entry.source.id, entry.parts[0].tlMessageId]))
  const reverse = new Map([...tlId].map(([id, value]) => [value, Number(id.slice(2))]))
  return {
    tlId: (index) => tlId.get(`m-${index}`)!,
    indexOf: (value) => reverse.get(value)!,
  }
}

async function seed(store: MessageStore, indexes: readonly number[]): Promise<void> {
  await store.upsertConversation(session, conversation)
  await store.upsertUser(session, { id: 'alice', firstName: 'Alice' })
  await store.ingestMany(
    session, conversation, indexes.map((index) => corpus[index]),
    { allocation: 'history' },
  )
}

/** 一页必须是「从某条消息开始、逐条往更早」的连续区间，否则客户端就看到断层。 */
function expectPageEndingAt(
  page: readonly number[],
  projected: Awaited<ReturnType<typeof projectedIds>>,
  oldestIndex: number,
): void {
  expect(page).toEqual(
    Array.from(
      { length: page.length },
      (_, offset) => projected.tlId(oldestIndex + page.length - 1 - offset),
    ),
  )
}

describe('messages.getHistory paging around a jumped-to message', () => {
  it('returns the page that continues the loaded window when the client scrolls down', async () => {
    const store = await createStore()
    // 整个会话都已在本地投影里：往下翻不该受影响。
    await seed(store, Array.from({ length: 200 }, (_, index) => index))
    const { platform } = makePlatform()
    const rpc = new DialogRpc(platform, session, store)
    const peerId = rpc.peerTlId(conversation.id)
    const projected = await projectedIds(store)

    const jump = await rpc.getHistory(historyRequest(peerId, {
      offsetId: projected.tlId(50), addOffset: -25, limit: 50,
    }))
    const jumpIds = pageIds(jump)
    expect(jumpIds).toHaveLength(50)
    expect(jumpIds).toContain(projected.tlId(50))
    // 锚点周围的页面必须先按顺序返回（客户端按到达顺序追加）。
    expect(jumpIds).toEqual(jumpIds.slice().sort((left, right) => right - left))

    const loadedTop = Math.max(...jumpIds)
    const down = await rpc.getHistory(historyRequest(peerId, {
      offsetId: loadedTop + 1, addOffset: -50, limit: 50,
    }))
    // 往下翻必须接着已经加载的窗口，不能直接跳到最新一页。
    expect(pageIds(down)).toHaveLength(50)
    expectPageEndingAt(pageIds(down), projected, projected.indexOf(loadedTop) + 1)
  })

  it('fetches the messages right after the loaded top instead of re-reading the latest page', async () => {
    const store = await createStore()
    // 投影里只有跳转窗口和一小段更早同步下来的最新消息，中间那一大段都还没有。
    await seed(store, [
      ...Array.from({ length: 50 }, (_, offset) => 150 + offset),
      ...Array.from({ length: 100 }, (_, offset) => 900 + offset),
    ])
    const { platform, calls } = makePlatform()
    const rpc = new DialogRpc(platform, session, store)
    const peerId = rpc.peerTlId(conversation.id)
    const projected = await projectedIds(store)

    const jump = await rpc.getHistory(historyRequest(peerId, {
      offsetId: projected.tlId(174), addOffset: -25, limit: 50,
    }))
    const jumpIds = pageIds(jump)
    expect(jumpIds).toHaveLength(50)
    expect(jumpIds).toContain(projected.tlId(174))

    const loadedTop = Math.max(...jumpIds)
    const loadedTopIndex = projected.indexOf(loadedTop)
    const mark = calls.length
    // 连翻三页：每一页都必须紧接上一页，任何一页偏到最新端都会在客户端留下断层。
    let current = projected
    for (let round = 0; round < 3; round++) {
      const down = await rpc.getHistory(historyRequest(peerId, {
        offsetId: current.tlId(loadedTopIndex + round * 50) + 1, addOffset: -50, limit: 50,
      }))
      const grown = await projectedIds(store)
      expect(pageIds(down)).toHaveLength(50)
      expectPageEndingAt(pageIds(down), grown, loadedTopIndex + round * 50 + 1)
      current = grown
    }
    // 接着客户端手上最新那条往后取，而不是又读一遍最新一页。
    const downCalls = calls.slice(mark)
    expect(downCalls.some((call) => call.after?.id === `m-${loadedTopIndex}`)).toBe(true)
    expect(downCalls.every((call) => !call.latest)).toBe(true)
  })

  it('floors the window at the newest page instead of answering with an empty one', async () => {
    const store = await createStore()
    await seed(store, Array.from({ length: CORPUS_SIZE }, (_, index) => index))
    const { platform } = makePlatform()
    const rpc = new DialogRpc(platform, session, store)
    const peerId = rpc.peerTlId(conversation.id)
    const projected = await projectedIds(store)
    const newest = projected.tlId(CORPUS_SIZE - 1)

    // 跳到一条已经不存在的消息（链接里的旧 ID）：契约把窗口夹到最新一页，绝不是空页——
    // 空页会让客户端把 `addOlderSlice` 当成「已经到顶」而什么都不显示。
    const jump = await rpc.getHistory(historyRequest(peerId, {
      offsetId: newest + 100_000, addOffset: -25, limit: 50,
    }))
    expect(pageIds(jump)).toHaveLength(50)
    expectPageEndingAt(pageIds(jump), projected, CORPUS_SIZE - 50)

    // 已经在最新一条上再往下翻：同样夹到最新一页（客户端按 ID 去重后会标记到底）。
    const bottom = await rpc.getHistory(historyRequest(peerId, {
      offsetId: newest + 1, addOffset: -50, limit: 50,
    }))
    expect(pageIds(bottom)).toEqual(
      Array.from({ length: 50 }, (_, offset) => projected.tlId(CORPUS_SIZE - 1 - offset)),
    )
  })

  it('keeps paging across a recalled message at the loaded top', async () => {
    const store = await createStore()
    // 客户端手上的最大一条刚被撤回：分片行还在，但消息行已经标成删除。
    await seed(store, [
      ...Array.from({ length: 50 }, (_, offset) => 150 + offset),
      ...Array.from({ length: 100 }, (_, offset) => 900 + offset),
    ])
    const { platform } = makePlatform({ recalled: [199] })
    const rpc = new DialogRpc(platform, session, store)
    const peerId = rpc.peerTlId(conversation.id)
    const projected = await projectedIds(store)
    await store.deleteMessages(session, conversation, ['m-199'])

    const down = await rpc.getHistory(historyRequest(peerId, {
      offsetId: projected.tlId(199) + 1, addOffset: -50, limit: 50,
    }))
    const grown = await projectedIds(store)
    // 锚点落到还活着的 m-198 上，页面从它后面接着往下走，而不是跳回最新一页。
    expect(pageIds(down)).toHaveLength(50)
    expectPageEndingAt(pageIds(down), grown, 200)
  })

  it('resolves the anchor below an id that was never handed out', async () => {
    const store = await createStore()
    await seed(store, Array.from({ length: 20 }, (_, index) => index))
    const projected = await projectedIds(store)

    // 客户端锚点通常正好是本机最大 ID + 1；这里让「减一」落空，走兜底查询。
    await expect(store.findProjectedBeforeTlId(
      session.platformSessionId, conversation.id, projected.tlId(10) + 3,
    )).resolves.toMatchObject({ source: { id: 'm-10' } })
    await expect(store.findProjectedBeforeTlId(
      session.platformSessionId, conversation.id, projected.tlId(0),
    )).resolves.toBeUndefined()
  })
})
