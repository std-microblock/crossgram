import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { SEARCH_KIND } from './message-search.js'
import type { IMConversation, IMMedia, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'index-session', platformId: 'index', userId: 'self', credentials: {}, metadata: {},
}

const alice: IMConversation = { id: 'alice', kind: 'direct', title: 'Alice' }

const BASE = 1_800_000_000

const disposals: Array<() => Promise<void>> = []
const nowSpy: Array<ReturnType<typeof vi.spyOn>> = []

afterEach(async () => {
  for (const spy of nowSpy.splice(0)) spy.mockRestore()
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function text(id: string, timestamp: number, body: string): IMMessage {
  return {
    id, conversationId: alice.id, senderId: 'alice', timestamp,
    content: { parts: [{ type: 'text', text: body }] },
  }
}

function image(id: string, mimeType = 'image/png'): IMMedia {
  return { id, kind: 'image', name: `${id}.png`, mimeType, size: 10, width: 10, height: 10, locator: { id } }
}

function file(id: string, mimeType: string, voice = false): IMMedia {
  return { id, kind: 'file', name: `${id}.bin`, mimeType, size: 10, voice, locator: { id } }
}

function media(id: string, timestamp: number, media: IMMedia[]): IMMessage {
  return {
    id, conversationId: alice.id, senderId: 'alice', timestamp,
    content: { parts: media.map((item) => ({ type: 'media' as const, media: item })) },
  }
}

/** 统计访问 `mtproto_im_message` 的次数：一次全量扫描就是一次，用来验证「一次扫描回答多个过滤器」。 */
function countingDatabase(database: Database) {
  const counts = { messageScans: 0, partQueries: 0, countQueries: 0 }
  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      const bound = value.bind(target)
      if (property === 'eval') {
        return (...rest: unknown[]) => {
          counts.countQueries++
          return (bound as (...args: unknown[]) => unknown)(...rest)
        }
      }
      if (property !== 'get') return bound
      return (table: string, ...rest: unknown[]) => {
        if (table === 'mtproto_im_message') counts.messageScans++
        if (table === 'mtproto_tl_message_part') counts.partQueries++
        return (bound as (...args: unknown[]) => unknown)(table, ...rest)
      }
    },
  })
  return { database: proxy as Database, counts }
}

async function setup(seed: IMMessage[]) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const counted = countingDatabase(ctx.database)
  const store = new MessageStore(counted.database)
  // 同一套数据再开一个没有缓存的 store，用来给出「不经缓存」的参考答案。
  const reference = new MessageStore(ctx.database)
  await store.ingestMany(session, alice, seed, { allocation: 'history' })
  return { ctx, store, reference, counts: counted.counts }
}

const query = { platformConversationIds: [alice.id], terms: [] as string[] }

describe('shared media part index', () => {
  it('answers every requested mask from a single table scan and matches uncached results', async () => {
    const { store, reference, counts } = await setup([
      media('album', BASE + 10, [image('p1'), image('p2'), file('doc', 'application/pdf')]),
      media('gif', BASE + 20, [image('anim', 'image/gif')]),
      media('video', BASE + 30, [file('clip', 'video/mp4')]),
      media('voice', BASE + 40, [file('note', 'audio/ogg', true)]),
      media('song', BASE + 50, [file('song', 'audio/mpeg')]),
      text('link', BASE + 60, 'read https://example.com/a'),
      text('plain', BASE + 70, 'nothing special'),
    ])

    const masks = [
      SEARCH_KIND.PHOTO,
      SEARCH_KIND.PHOTO | SEARCH_KIND.VIDEO,
      SEARCH_KIND.DOCUMENT,
      SEARCH_KIND.GIF,
      SEARCH_KIND.VOICE,
      SEARCH_KIND.MUSIC,
      SEARCH_KIND.URL,
      SEARCH_KIND.PHONE_CALL,
    ]
    const before = counts.messageScans
    const batch = await store.searchPartIndexMany(session.platformSessionId, query, masks)
    expect(counts.messageScans - before).toBe(1)

    expect(batch).toHaveLength(masks.length)
    for (const [index, mask] of masks.entries()) {
      const expected = await reference.searchPartIndex(session.platformSessionId, {
        ...query, kinds: mask || undefined,
      })
      expect(batch[index]).toEqual(expected)
    }
    // 相册里两个图片分片与一个文档分片分别计入各自类别。
    expect(batch[0]).toHaveLength(2)
    expect(batch[2]).toHaveLength(1)
    expect(batch[7]).toHaveLength(0)
  })

  it('keeps the unfiltered mask correct even when it rides along with media masks', async () => {
    const { store, reference } = await setup([
      media('album', BASE + 10, [image('p1'), image('p2'), file('doc', 'application/pdf')]),
      text('plain', BASE + 70, 'nothing special'),
    ])

    const [photos, unfiltered] = await store.searchPartIndexMany(session.platformSessionId, query, [
      SEARCH_KIND.PHOTO, 0,
    ])
    // 不过滤类别时只保留首个分片（一条消息一个条目），连没有媒体的纯文本也要算进来。
    expect(unfiltered).toHaveLength(2)
    expect(unfiltered).toEqual([
      await reference.searchPartIndex(session.platformSessionId, { ...query, kinds: undefined }),
    ].flat())
    expect(photos).toHaveLength(2)
    expect(photos).toEqual(await reference.searchPartIndex(session.platformSessionId, {
      ...query, kinds: SEARCH_KIND.PHOTO,
    }))
  })

  it('reuses one scan for masks that the cached scan already covers, and rescans for wider ones', async () => {
    const { store, counts } = await setup([
      media('photo', BASE + 10, [image('p1')]),
      media('video', BASE + 30, [file('clip', 'video/mp4')]),
    ])

    const photoOnly = await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO })
    expect(photoOnly).toHaveLength(1)
    const scansAfterFirst = counts.messageScans

    // 只扫过照片的缓存回答不了「照片 + 视频」。
    const both = await store.searchPartIndex(session.platformSessionId, {
      ...query, kinds: SEARCH_KIND.PHOTO | SEARCH_KIND.VIDEO,
    })
    expect(both).toHaveLength(2)
    expect(counts.messageScans).toBe(scansAfterFirst + 1)

    // 更宽的缓存可以直接回答它的子集，不再扫表。
    const videoOnly = await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.VIDEO })
    expect(videoOnly).toEqual([both[0]])
    expect(counts.messageScans).toBe(scansAfterFirst + 1)
  })

  it('shares one in-flight scan between identical concurrent requests', async () => {
    const { store, counts } = await setup([media('photo', BASE + 10, [image('p1')])])
    const before = counts.messageScans
    const [first, second] = await Promise.all([
      store.searchPartIndexMany(session.platformSessionId, query, [SEARCH_KIND.PHOTO, SEARCH_KIND.VIDEO]),
      store.searchPartIndexMany(session.platformSessionId, query, [SEARCH_KIND.PHOTO, SEARCH_KIND.VIDEO]),
    ])
    expect(counts.messageScans - before).toBe(1)
    expect(first).toEqual(second)
  })

  it('drops the cached index when messages are ingested or deleted', async () => {
    const { store, counts } = await setup([media('photo', BASE + 10, [image('p1')])])

    expect(await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO }))
      .toHaveLength(1)
    const scans = counts.messageScans

    await store.ingestMany(session, alice, [media('photo-2', BASE + 20, [image('p2')])], { allocation: 'live' })
    expect(await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO }))
      .toHaveLength(2)
    expect(counts.messageScans).toBe(scans + 1)

    await store.deleteMessages(session, alice, ['photo-2'])
    expect(await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO }))
      .toHaveLength(1)
    expect(counts.messageScans).toBe(scans + 2)
  })

  it('rescans after the cache TTL expires', async () => {
    const { store, counts } = await setup([media('photo', BASE + 10, [image('p1')])])
    const realNow = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow)
    nowSpy.push(spy)

    await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO })
    const scans = counts.messageScans
    spy.mockReturnValue(realNow + 1_000)
    await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO })
    expect(counts.messageScans).toBe(scans)

    spy.mockReturnValue(realNow + 60_000)
    await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO })
    expect(counts.messageScans).toBe(scans + 1)
  })

  it('does not leak messages from another session that reuses the same platform conversation id', async () => {
    const { store } = await setup([media('photo', BASE + 10, [image('p1')])])
    // 单会话查询不再带 platformSessionId（它会挡住覆盖索引），隔离完全依赖会话行号；
    // 这里用两个平台会话下的同名会话把它钉住。
    const otherSession = { ...session, platformSessionId: 'index-session-other' }
    await store.ingestMany(otherSession, alice, [media('photo-2', BASE + 20, [image('p2')])], {
      allocation: 'history',
    })

    const ours = await store.searchPartIndex(session.platformSessionId, { ...query, kinds: SEARCH_KIND.PHOTO })
    const theirs = await store.searchPartIndex(otherSession.platformSessionId, {
      ...query, kinds: SEARCH_KIND.PHOTO,
    })
    expect(ours).toHaveLength(1)
    expect(theirs).toHaveLength(1)
    expect(ours[0].messageId).not.toBe(theirs[0].messageId)
  })

  it('caches the exact text-search count so client retries do not rescan the conversation', async () => {
    const { store, counts } = await setup([
      text('t1', BASE + 1, 'hello relay'),
      text('t2', BASE + 2, 'relay again'),
      text('t3', BASE + 3, 'nothing here'),
    ])
    const searchQuery = { platformConversationIds: [alice.id], terms: ['relay'] }

    expect(await store.countSearchMessages(session.platformSessionId, searchQuery)).toBe(2)
    expect(counts.countQueries).toBe(1)

    // 客户端在等应答时会按 1.5 秒重发同一条搜索，切标签页也会重问：都必须命中缓存。
    expect(await store.countSearchMessages(session.platformSessionId, searchQuery)).toBe(2)
    expect(counts.countQueries).toBe(1)

    // 换一个词就要重新数。
    expect(await store.countSearchMessages(session.platformSessionId, { ...searchQuery, terms: ['again'] }))
      .toBe(1)
    expect(counts.countQueries).toBe(2)

    // 会话里进了新消息，旧计数作废。
    await store.ingestMany(session, alice, [text('t4', BASE + 4, 'relay too')], { allocation: 'live' })
    expect(await store.countSearchMessages(session.platformSessionId, searchQuery)).toBe(3)
    expect(counts.countQueries).toBe(3)
  })

  it('keeps the shared media counters working off one scan for the whole filter list', async () => {
    const { ctx, store, reference, counts } = await setup([
      media('album', BASE + 10, [image('p1'), image('p2'), file('doc', 'application/pdf')]),
      media('gif', BASE + 20, [image('anim', 'image/gif')]),
      media('video', BASE + 30, [file('clip', 'video/mp4')]),
      media('voice', BASE + 40, [file('note', 'audio/ogg', true)]),
      media('song', BASE + 50, [file('song', 'audio/mpeg')]),
      text('link', BASE + 60, 'read https://example.com/a'),
    ])
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
        conversations: { groups: true, channels: true, subchannels: true },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() {
        return { dialogs: [{ conversation: alice, unreadCount: 0 }] }
      },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id } },
    }
    const rpc = new DialogRpc(platform, session, store)
    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const peer = { _: 'inputPeerUser' as const, userId: rpc.peerTlId(alice.id), accessHash: Long.ZERO }
    const filters: tl.TypeMessagesFilter[] = [
      { _: 'inputMessagesFilterPhotoVideo' },
      { _: 'inputMessagesFilterDocument' },
      { _: 'inputMessagesFilterRoundVoice' },
      { _: 'inputMessagesFilterUrl' },
      { _: 'inputMessagesFilterPhotos' },
      { _: 'inputMessagesFilterVideo' },
      { _: 'inputMessagesFilterGif' },
      { _: 'inputMessagesFilterVoice' },
      { _: 'inputMessagesFilterMusic' },
    ]
    // 上一次扫描来自会话列表/资料预热，这里只统计计数器这一次调用。
    const scans = counts.messageScans
    const counters = await rpc.getSearchCounters({
      _: 'messages.getSearchCounters', peer, filters,
    })
    expect(counts.messageScans - scans).toBe(1)
    expect(counters.map((counter) => counter.count)).toEqual([3, 1, 1, 1, 2, 1, 1, 1, 1])

    // 与逐个过滤器单独扫描（无缓存）的结果一致。
    for (const [index, filter] of filters.entries()) {
      const kinds = [SEARCH_KIND.PHOTO | SEARCH_KIND.VIDEO, SEARCH_KIND.DOCUMENT, SEARCH_KIND.VOICE,
        SEARCH_KIND.URL, SEARCH_KIND.PHOTO, SEARCH_KIND.VIDEO, SEARCH_KIND.GIF, SEARCH_KIND.VOICE,
        SEARCH_KIND.MUSIC][index]
      const entries = await reference.searchPartIndex(session.platformSessionId, { ...query, kinds })
      expect(counters[index].count).toBe(entries.length)
    }
    expect(ctx).toBeTruthy()
  })
})
