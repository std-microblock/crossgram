import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import {
  defineModels, HistorySyncService, IMPlatformService, MessageStore,
  type IMConversation, type IMHistoryQuery, type IMMessage, type IMPlatform, type PlatformSession,
} from '@mtproto-relay/bridge'
import { apply } from './index.js'
import { HistoryBackfillWorker } from './worker.js'
import type { HistoryBackfillData } from './types.js'

const session: PlatformSession = {
  platformSessionId: 'backfill-session', platformId: 'qq', userId: 'self', credentials: {}, metadata: {},
}
const room: IMConversation = { id: 'room', kind: 'group', title: 'Room' }
const BASE = 1_800_000_000

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function message(sequence: number, extra: Partial<IMMessage> = {}): IMMessage {
  return {
    id: `msg-${sequence}`, conversationId: room.id, senderId: 'alice', timestamp: BASE + sequence,
    content: { parts: [{ type: 'text', text: `history line ${sequence}` }] },
    metadata: { qqMsgSeq: String(sequence) },
    ...extra,
  }
}

async function setup(upstreamMax: number, stored: number[], recalled: number[] = []) {
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
  const queries: IMHistoryQuery[] = []
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      sequenceHistory: 'group',
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 1, maxMedia: 1 },
      conversations: { groups: true, channels: true, subchannels: true },
    },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
    async getDialogs() { return { dialogs: [{ conversation: room, unreadCount: 0, lastMessage: message(upstreamMax) }] } },
    async getHistory(_session, _conversation, query = {}) {
      queries.push(query)
      if (!query.beforeSequence) throw new Error('backfill must request by sequence')
      const high = Number(query.beforeSequence)
      const sequences: number[] = []
      for (let sequence = high; sequence >= 1 && sequences.length < (query.limit ?? 50); sequence--) {
        sequences.push(sequence)
      }
      return {
        messages: sequences.filter((sequence) => !recalled.includes(sequence)).map((sequence) => message(sequence)),
        ...(sequences.length
          ? { coverage: { minSequence: String(sequences.at(-1)), maxSequence: String(sequences[0]) } }
          : {}),
      }
    },
  }
  await store.ingestDialogs(session, [{ conversation: room, unreadCount: 3, lastMessage: message(upstreamMax) }])
  await store.ingestMany(session, room, stored.map((sequence) => message(sequence)), { allocation: 'history' })
  const platforms = new IMPlatformService(ctx)
  platforms.activateSession('qq', platform, session)
  const sync = new HistorySyncService(ctx, store, platforms)
  return { ctx, store, sync, queries }
}

describe('history backfill e2e', () => {
  it('fills missing group history into SQLite by msgSeq without touching unread state', async () => {
    const { ctx, store, sync, queries } = await setup(60, [60, 30, 31, 32], [45])
    const worker = new HistoryBackfillWorker(sync, {
      enabled: true, idleAfterMs: 1_000, intervalMs: 10, pageSize: 10, dailyRequestCap: 100, maxAgeDays: 0,
    })
    const stateBefore = await store.getUpdateState(session.platformSessionId)

    for (let index = 0; index < 50 && await worker.tick(); index++) { /* drain */ }

    expect(queries[0]).toEqual({ beforeSequence: '59', limit: 10 })
    const stored = await store.readNativeSequences(session.platformSessionId, room.id, { limit: 1000 })
    expect(stored).toEqual(Array.from({ length: 60 }, (_, index) => 60 - index).filter((value) => value !== 45))
    const snapshot = worker.snapshot().sessions[0].conversations[0]
    expect(snapshot).toMatchObject({ gapCount: 0, floorReached: true, floorReason: 'start', covered: 60 })
    expect(snapshot.inserted).toBe(55)
    // 回填不影响会话未读数，也不产生 update 投递。
    const [conversation] = await ctx.database.get('mtproto_im_conversation', { platformConversationId: room.id })
    expect(conversation.unreadCount).toBe(3)
    expect(await store.getUpdateState(session.platformSessionId)).toEqual(stateBefore)
    // 回填进来的消息立即可被本地搜索命中。
    const found = await store.searchMessages(session.platformSessionId, {
      platformConversationIds: [room.id], terms: ['line 7'], limit: 10,
    })
    expect(found.messages.map((item) => item.source.id)).toEqual(['msg-7'])
  })

  it('reports activity only for RPCs that mean someone is using a client', async () => {
    const { sync } = await setup(5, [5])
    // 客户端挂着时的周期性轮询：实测每分钟都会出现，不能当成「有人在用」。
    for (const method of [
      'updates.getDifference', 'updates.getChannelDifference', 'account.updateStatus',
      'messages.getPeerDialogs', 'messages.getMessagesReactions', 'messages.getTopReactions',
      'crossgram.getFileUrl', 'upload.getFile', 'stories.getPeerStories', 'help.getConfig',
    ]) sync.touch(session.platformSessionId, method)
    expect(sync.lastActivityAt(session.platformSessionId)).toBeUndefined()
    // 打开会话、搜索、发送、刷新会话列表这类会竞争数据库或上游的调用仍算活跃。
    for (const method of ['messages.getHistory', 'messages.search', 'messages.sendMessage', 'messages.getDialogs']) {
      sync.touch(session.platformSessionId, method)
      expect(sync.lastActivityAt(session.platformSessionId)).toBeTypeOf('number')
    }
  })

  it('runs as a plugin loop with a WebUI switch and live snapshot', async () => {
    vi.useFakeTimers()
    let data!: HistoryBackfillData
    let routes: string[] = []
    const cleanups: Array<() => void> = []
    const tick = vi.fn(async () => false)
    const historySync = {
      sessions: () => [],
      lastActivityAt: () => undefined,
    }
    vi.spyOn(HistoryBackfillWorker.prototype, 'tick').mockImplementation(tick)
    const fake = {
      historySync,
      logger: () => ({ info() {}, warn() {}, debug() {} }),
      webui: {
        addEntry(files: { routes: string[] }, value: HistoryBackfillData) {
          routes = files.routes
          data = value
          return { mutate(callback: (target: HistoryBackfillData) => void) { callback(data) } }
        },
      },
      effect(callback: () => () => void) {
        cleanups.push(callback())
      },
    }

    apply(fake as never, { intervalMs: 1_000, enabled: false })
    expect(routes).toEqual(['/history-backfill'])
    expect(data.snapshot).toMatchObject({ enabled: false, settings: { intervalMs: 1_000 } })

    await vi.advanceTimersByTimeAsync(1_600)
    expect(tick).toHaveBeenCalledTimes(1)

    await data.setEnabled(true)
    expect(data.snapshot.enabled).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(2)

    cleanups.forEach((cleanup) => cleanup())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
