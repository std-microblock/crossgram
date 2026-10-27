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
import { SEARCH_KIND } from './message-search.js'
import type { IMConversation, IMMedia, IMMessage, IMPlatform, PlatformSession } from './platform.js'

/**
 * 打开一个消息量很大的群时，客户端会把整批共享媒体请求一起发过来：
 * `messages.getSearchCounters` 一次 9 个过滤器、`messages.getSearchResultsPositions` 若干次，
 * 同时还要 `messages.getHistory` 拿首屏。
 *
 * 按「一个过滤器一次全量扫描」实现时，线上 16 万条消息的群一次打开要扫十几遍（每遍 4~5 秒），
 * 数据库被读满，`messages.getHistory` 排在后面拿不到连接，客户端只能反复重试——
 * 这就是会话「一直转圈打不开」的现场。这个 e2e 固定住两件事：
 * ① 一整批共享媒体请求只允许扫一次库；② 同一批请求的重试不再产生新的扫描。
 * 顺带确认这条路返回的内容仍然和逐条统计的答案一致，且同批的 `getHistory` 正常返回。
 */

const session: PlatformSession = {
  platformSessionId: 'shared-media-budget', platformId: 'budget', userId: 'self', credentials: {}, metadata: {},
}

const conversation: IMConversation = { id: 'meme-group', kind: 'group', title: '蔚蓝 memeNet' }

const BASE = 1_790_000_000

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function image(id: string, mimeType = 'image/png'): IMMedia {
  return { id, kind: 'image', name: `${id}.png`, mimeType, size: 10, width: 10, height: 10, locator: { id } }
}

function file(id: string, mimeType: string, voice = false): IMMedia {
  return { id, kind: 'file', name: `${id}.bin`, mimeType, size: 10, voice, locator: { id } }
}

/** 每 3 条一张图片、每 5 条一个文档、每 11 条一个语音，夹着一条相册和一条链接。 */
function seed(): IMMessage[] {
  const messages: IMMessage[] = []
  for (let index = 0; index < 600; index++) {
    const id = `m-${index}`
    const timestamp = BASE + index
    const parts: Array<{ type: 'media', media: IMMedia } | { type: 'text', text: string }> = []
    if (index % 3 === 0) parts.push({ type: 'media', media: image(`photo-${index}`) })
    if (index % 5 === 0) parts.push({ type: 'media', media: file(`doc-${index}`, 'application/pdf') })
    if (index % 11 === 0 && index > 0) parts.push({ type: 'media', media: file(`voice-${index}`, 'audio/ogg', true) })
    if (!parts.length) parts.push({ type: 'text', text: index % 17 === 0 ? `see https://example.com/${index}` : `meme ${index}` })
    messages.push({ id, conversationId: conversation.id, senderId: 'alice', timestamp, content: { parts } })
  }
  messages.push({
    id: 'album', conversationId: conversation.id, senderId: 'alice', timestamp: BASE + 700,
    content: { parts: [
      { type: 'media', media: image('album-1') },
      { type: 'media', media: image('album-2') },
      { type: 'media', media: file('album-doc', 'application/pdf') },
    ] },
  })
  return messages
}

/** 只统计共享媒体索引那种「带 searchKinds 谓词」的整表读取，别把 history 的小查询算进去。 */
function countingDatabase(database: Database) {
  const counts = { indexScans: 0 }
  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      const bound = value.bind(target)
      if (property !== 'get') return bound
      return (table: string, where?: unknown, ...rest: unknown[]) => {
        if (table === 'mtproto_im_message' && where && typeof where === 'object' && 'searchKinds' in where) {
          counts.indexScans++
        }
        return (bound as (...args: unknown[]) => unknown)(table, where, ...rest)
      }
    },
  })
  return { database: proxy as Database, counts }
}

async function setup() {
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
  const messages = seed()
  await store.ingestMany(session, conversation, messages, { allocation: 'history' })

  const getHistory = async () => ({ messages: messages.slice(-50).reverse() })
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
      conversations: { groups: true, channels: true, subchannels: true },
    },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
    async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
    getHistory,
    async getUser(_session, id) { return { id, firstName: id } },
  }
  const rpc = new DialogRpc(platform, session, store)
  await rpc.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  })
  const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO }
  return { ctx, rpc, peer, counts: counted.counts }
}

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

function roundTrip<T>(object: T): T {
  return new TlBinaryReader(__tlReaderMap, TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject))
    .object() as T
}

describe('shared media RPC budget e2e', () => {
  it('serves a whole create-chat burst, including getHistory, off one index scan', async () => {
    const { rpc, peer, counts } = await setup()
    const positionsFilter: tl.TypeMessagesFilter = { _: 'inputMessagesFilterPhotoVideo' }

    const before = counts.indexScans
    const [counters, positions, photos, history] = await Promise.all([
      rpc.getSearchCounters({ _: 'messages.getSearchCounters', peer, filters }),
      rpc.getSearchResultsPositions({
        _: 'messages.getSearchResultsPositions', peer, filter: positionsFilter, offsetId: 0, limit: 100,
      }),
      rpc.search({
        _: 'messages.search', peer, q: '', filter: { _: 'inputMessagesFilterPhotos' },
        minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 30, maxId: 0, minId: 0, hash: Long.ZERO,
      }),
      rpc.getHistory({
        _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }),
    ])

    // 一次打开只允许扫一遍共享媒体索引。
    expect(counts.indexScans - before).toBe(1)

    // 计数与种子数据一致：600 条里 index%3===0 的 200 条带图片、index%5===0 的 120 条带文档、
    // index%11===0 的 54 条带语音，另有一条三张分片的相册（两张图片 + 一份文档）。
    expect(counters[4].count).toBe(202) // Photos
    expect(counters[0].count).toBe(202) // PhotoVideo
    expect(counters[1].count).toBe(121) // Document
    expect(counters[2].count).toBe(54) // RoundVoice
    expect(counters[7].count).toBe(54) // Voice
    expect(counters[3].count).toBeGreaterThan(0) // 带链接的文本消息
    expect(counters[5].count).toBe(0) // 没有视频
    expect(counters[6].count).toBe(0) // 没有 GIF
    expect(counters[8].count).toBe(0) // 没有音乐

    expect(positions.count).toBe(202)
    if (photos._ !== 'messages.messagesNotModified') expect(photos.messages.length).toBeGreaterThan(0)
    if (history._ !== 'messages.messagesNotModified') expect(history.messages.length).toBeGreaterThan(0)
    expect(() => roundTrip(positions)).not.toThrow()
  })

  it('does not rescan when the client retries the same burst', async () => {
    const { rpc, peer, counts } = await setup()
    const first = await rpc.getSearchCounters({ _: 'messages.getSearchCounters', peer, filters })
    const scansAfterFirst = counts.indexScans

    const [retry, positions] = await Promise.all([
      rpc.getSearchCounters({ _: 'messages.getSearchCounters', peer, filters }),
      rpc.getSearchResultsPositions({
        _: 'messages.getSearchResultsPositions', peer,
        filter: { _: 'inputMessagesFilterPhotoVideo' }, offsetId: 0, limit: 100,
      }),
    ])
    expect(counts.indexScans).toBe(scansAfterFirst)
    expect(retry).toEqual(first)
    expect(positions.count).toBe(first[0].count)
  })
})
