import { afterAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import PostgresDriver from '@cordisjs/plugin-database-postgres'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import {
  getPostgresClient,
  POSTGRES_MEDIA_CONV_INDEX,
  POSTGRES_MEDIA_SESSION_INDEX,
  POSTGRES_SEARCH_BIGRAMS_FN,
  POSTGRES_SEARCH_GIN_INDEX,
} from './postgres-search.js'
import type { IMConversation, IMMedia, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const connection = process.env.CROSSGRAM_POSTGRES_TEST_URL
const suite = connection ? describe : describe.skip

const DAY = 86_400
const BASE = 1_800_000_000 - (1_800_000_000 + 8 * 3600) % DAY

const session: PlatformSession = {
  platformSessionId: 'pg-search-e2e-session',
  platformId: 'pg-search-e2e',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const alice: IMConversation = { id: 'pg-alice', kind: 'direct', title: 'Alice' }
const group: IMConversation = { id: 'pg-group', kind: 'group', title: 'PG Test Group' }

function text(
  id: string,
  conversation: IMConversation,
  timestamp: number,
  body: string,
  extra: Partial<IMMessage> = {},
): IMMessage {
  return {
    id,
    conversationId: conversation.id,
    senderId: extra.outgoing ? 'self' : 'alice',
    timestamp,
    content: { parts: [{ type: 'text', text: body }] },
    ...extra,
  }
}

function image(id: string, name = `${id}.png`, mimeType = 'image/png'): IMMedia {
  return { id, kind: 'image', name, mimeType, size: 10, width: 10, height: 10, locator: { id } }
}

function file(id: string, name: string, mimeType: string, voice = false): IMMedia {
  return { id, kind: 'file', name, mimeType, size: 10, voice, locator: { id } }
}

function mediaMessage(
  id: string,
  conversation: IMConversation,
  timestamp: number,
  media: IMMedia[],
  caption = '',
  extra: Partial<IMMessage> = {},
): IMMessage {
  return {
    id,
    conversationId: conversation.id,
    senderId: extra.outgoing ? 'self' : 'alice',
    timestamp,
    content: {
      parts: [
        ...(caption ? [{ type: 'text' as const, text: caption }] : []),
        ...media.map((item) => ({ type: 'media' as const, media: item })),
      ],
    },
    ...extra,
  }
}

function searchRequest(
  peer: tl.TypeInputPeer,
  overrides: Partial<tl.messages.RawSearchRequest> = {},
): tl.messages.RawSearchRequest {
  return {
    _: 'messages.search',
    peer,
    q: '',
    filter: { _: 'inputMessagesFilterEmpty' },
    minDate: 0,
    maxDate: 0,
    offsetId: 0,
    addOffset: 0,
    limit: 20,
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
    ...overrides,
  }
}

function texts(result: tl.messages.TypeMessages): string[] {
  if (result._ === 'messages.messagesNotModified') return []
  return result.messages.map((message) => message._ === 'message' ? message.message : message._)
}

function ids(result: tl.messages.TypeMessages): number[] {
  if (result._ === 'messages.messagesNotModified') return []
  return result.messages.map((message) => message.id)
}

suite('PostgreSQL native search E2E', () => {
  const ctx = new Context()
  const fibers: Array<{ dispose?: () => unknown }> = []

  afterAll(async () => {
    await Promise.all(fibers.reverse().map((fiber) => Promise.resolve(fiber.dispose?.())))
  })

  it('builds bigram GIN + partial media indexes and serves exact text, high-frequency, global, and shared-media search', async () => {
    const url = new URL(connection!)
    const database = ctx.plugin(Database)
    const driver = ctx.plugin(PostgresDriver, {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      max: 4,
    })
    fibers.push(database as never, driver as never)
    await Promise.all([database, driver])
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()

    const pg = getPostgresClient(ctx.database)
    expect(pg).toBeDefined()

    // 清理上一次运行的测试数据，确保从干净状态验证。
    for (const table of [
      'mtproto_tl_message_part', 'mtproto_im_media', 'mtproto_im_message_alias',
      'mtproto_im_message_reaction', 'mtproto_message_mention', 'mtproto_im_message',
      'mtproto_im_conversation', 'mtproto_im_user',
    ]) {
      await pg!.unsafe(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`)
    }
    await pg!.unsafe(`DROP INDEX IF EXISTS "${POSTGRES_SEARCH_GIN_INDEX}"`)
    await pg!.unsafe(`DROP INDEX IF EXISTS "${POSTGRES_MEDIA_CONV_INDEX}"`)
    await pg!.unsafe(`DROP INDEX IF EXISTS "${POSTGRES_MEDIA_SESSION_INDEX}"`)

    const store = new MessageStore(ctx.database)

    // 写入 2,400 条消息到 group（超过 Stage 1 的 2,000 条探测窗口），覆盖：
    // - 最早的罕见中文/英文/标点/emoji/单字/假阳性边界消息（落在 2,000 条窗口之外，必须走 GIN）
    // - 高频词「可以」（每 25 条出现一次，最新 2,000 条内就有 80 条，命中 Stage 1 探测）
    // - 多媒体相册与全类别共享媒体
    const groupMessages: IMMessage[] = [
      text('g-ancient-cjk', group, BASE + 1, '这是一个测试消息，里面有服务器报错和蔚蓝'),
      text('g-ancient-false-pos', group, BASE + 2, 'ab xx ba 只有零散字母对'),
      text('g-ancient-true-pos', group, BASE + 3, '真正的 aba 子串'),
      text('g-ancient-punct', group, BASE + 4, 'Deploy ＲＥＬＡＹ 3.5 (approx) a+b 🎉🚀🔥'),
      text('g-ancient-single', group, BASE + 5, '这里只有一个罕见单字龘与测试'),
      text('g-ancient-deleted', group, BASE + 6, '这条测试消息稍后会被删除'),
      mediaMessage('g-album', group, BASE + 10, [
        image('p1'), image('p2'), file('doc1', 'Quarterly-Report.pdf', 'application/pdf'),
      ], '相册标题'),
      mediaMessage('g-gif', group, BASE + 20, [image('anim', 'anim.gif', 'image/gif')]),
      mediaMessage('g-video', group, BASE + 30, [file('clip', 'clip.mp4', 'video/mp4')]),
      mediaMessage('g-voice', group, BASE + 40, [file('note', 'note.ogg', 'audio/ogg', true)]),
      mediaMessage('g-music', group, BASE + 50, [file('song', 'song.mp3', 'audio/mpeg')]),
      text('g-link', group, BASE + 60, '访问 https://cordis.example/pg-test'),
      {
        id: 'g-mention', conversationId: group.id, senderId: 'bob', timestamp: BASE + 70,
        content: {
          parts: [{
            type: 'text', text: '@me 看一下这个服务器',
            entities: [{ type: 'mention', offset: 0, length: 3, userId: 'self' }],
          }],
        },
      },
      text('g-self', group, BASE + 80, '自己发的一条测试', { outgoing: true }),
    ]

    for (let i = 0; i < 2_350; i++) {
      const body = i % 25 === 0
        ? `第 ${i} 条日常聊天 可以 没问题`
        : `第 ${i} 条普通水群消息 ${i % 17}`
      groupMessages.push(text(`g-bulk-${i}`, group, BASE + 1_000 + i, body))
    }

    const aliceMessages: IMMessage[] = [
      text('a-1', alice, BASE + 500, '私聊里的测试与蔚蓝'),
      mediaMessage('a-photo', alice, BASE + 510, [image('a-p1')], '私聊图片', { outgoing: true }),
      {
        id: 'a-call-answered', conversationId: alice.id, senderId: 'alice', timestamp: BASE + 520,
        content: { parts: [], serviceAction: { type: 'phone-call', duration: 30 } },
      },
      {
        id: 'a-call-missed', conversationId: alice.id, senderId: 'alice', timestamp: BASE + 530,
        content: { parts: [], serviceAction: { type: 'phone-call' } },
      },
    ]

    // 分批写入，贴近真实 history ingest。
    for (let offset = 0; offset < groupMessages.length; offset += 500) {
      await store.ingestMany(session, group, groupMessages.slice(offset, offset + 500), { allocation: 'history' })
    }
    await store.ingestMany(session, alice, aliceMessages, { allocation: 'history' })
    await store.deleteMessages(session, group, ['g-ancient-deleted'])

    // 建立索引并验证幂等性。
    await store.ensureSearchIndexes()
    await store.ensureSearchIndexes()

    const indexRows = await pg!.unsafe<{ relname: string, indisvalid: boolean }>(
      `SELECT c.relname, i.indisvalid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])`,
      [[POSTGRES_SEARCH_GIN_INDEX, POSTGRES_MEDIA_CONV_INDEX, POSTGRES_MEDIA_SESSION_INDEX]],
    )
    expect(new Map(indexRows.map((row) => [row.relname, row.indisvalid]))).toEqual(new Map([
      [POSTGRES_SEARCH_GIN_INDEX, true],
      [POSTGRES_MEDIA_CONV_INDEX, true],
      [POSTGRES_MEDIA_SESSION_INDEX, true],
    ]))

    // 验证规划器对 2 字中文查询实际使用 bigram GIN 索引。
    const [convRow] = await ctx.database.get('mtproto_im_conversation', {
      platformSessionId: session.platformSessionId, platformConversationId: group.id,
    }, ['id'])
    const planLines = await pg!.unsafe<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT "id" FROM "mtproto_im_message"
       WHERE "conversationId" = $1
         AND "deleted" = false
         AND "searchKinds" IS NOT NULL
         AND ("searchKinds" & 128) = 0
         AND "searchText" <> ''
         AND "${POSTGRES_SEARCH_BIGRAMS_FN}"("searchText") @> $2::text[]
         AND strpos("searchText", $3) > 0
       ORDER BY "timestamp" DESC, "id" DESC
       LIMIT 21`,
      [convRow!.id, ['测试'], '测试'],
    )
    expect(planLines.map((line) => line['QUERY PLAN']).join('\n')).toContain(POSTGRES_SEARCH_GIN_INDEX)

    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
        conversations: { groups: true, channels: true, subchannels: true },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() {
        return { dialogs: [alice, group].map((conversation) => ({ conversation, unreadCount: 0 })) }
      },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id } },
    }
    const rpc = new DialogRpc(platform, session, store)
    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const peers = {
      alice: { _: 'inputPeerUser' as const, userId: rpc.peerTlId(alice.id), accessHash: Long.ZERO },
      group: { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId(group.id), accessHash: Long.ZERO },
    }

    // 1. 罕见 2 字中文（跨越 2,000 条近期探测窗口 → 走 GIN，且排除已删除消息）。
    const cjk2 = await rpc.search(searchRequest(peers.group, { q: '测试' }))
    expect(texts(cjk2)).toEqual([
      '自己发的一条测试',
      '这里只有一个罕见单字龘与测试',
      '这是一个测试消息，里面有服务器报错和蔚蓝',
    ])

    // 2. 3 字中文 + 多词 AND + 假阳性过滤（ab xx ba 不能命中 aba）。
    expect(texts(await rpc.search(searchRequest(peers.group, { q: '服务器 蔚蓝' }))))
      .toEqual(['这是一个测试消息，里面有服务器报错和蔚蓝'])
    expect(texts(await rpc.search(searchRequest(peers.group, { q: 'aba' }))))
      .toEqual(['真正的 aba 子串'])

    // 3. NFKC 全角 + 标点 + 代理对 emoji + 单字查询 + 混合（2 字 + 1 字）。
    expect(texts(await rpc.search(searchRequest(peers.group, { q: 'relay 3.5 (approx) a+b 🎉🚀' }))))
      .toEqual(['Deploy ＲＥＬＡＹ 3.5 (approx) a+b 🎉🚀🔥'])
    expect(texts(await rpc.search(searchRequest(peers.group, { q: '龘' }))))
      .toEqual(['这里只有一个罕见单字龘与测试'])
    expect(texts(await rpc.search(searchRequest(peers.group, { q: '测试 龘' }))))
      .toEqual(['这里只有一个罕见单字龘与测试'])

    // 4. 高频词「可以」（94 条命中，最新 2,000 条内就有 80 条 → 命中 Stage 1 探测）及翻页 + 精确计数。
    const commonPage1 = await rpc.search(searchRequest(peers.group, { q: '可以', limit: 10 }))
    expect(commonPage1).toMatchObject({ _: 'messages.messagesSlice', count: 94 })
    expect(texts(commonPage1)).toHaveLength(10)
    expect(texts(commonPage1)[0]).toContain('2325')
    const commonPage2 = await rpc.search(searchRequest(peers.group, {
      q: '可以', limit: 10, offsetId: ids(commonPage1).at(-1)!,
    }))
    expect(texts(commonPage2)).toHaveLength(10)
    expect(texts(commonPage2)[0]).toContain('2075')
    // limit = 0 精确计数
    const countOnly = await rpc.search(searchRequest(peers.group, { q: '可以', limit: 0 }))
    expect(countOnly).toMatchObject({ _: 'messages.messagesSlice', count: 94, messages: [] })

    // 5. fromId / minDate / maxDate / 文件名搜索
    expect(texts(await rpc.search(searchRequest(peers.group, { q: '测试', fromId: { _: 'inputPeerSelf' } }))))
      .toEqual(['自己发的一条测试'])
    expect(texts(await rpc.search(searchRequest(peers.group, { q: 'quarterly-report.pdf' }))))
      .toEqual(['相册标题'])
    expect(texts(await rpc.search(searchRequest(peers.group, { q: '测试', minDate: BASE + 1, maxDate: BASE + 80 }))))
      .toEqual(['这里只有一个罕见单字龘与测试'])

    // 6. 全局搜索 + usersOnly / groupsOnly + offsetRate 翻页
    const global1 = await rpc.searchGlobal({
      _: 'messages.searchGlobal', q: '蔚蓝', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0, offsetRate: 0, offsetPeer: { _: 'inputPeerEmpty' }, offsetId: 0, limit: 1,
    })
    expect(texts(global1)).toEqual(['私聊里的测试与蔚蓝'])
    const globalLast = (global1 as tl.messages.RawMessagesSlice).messages[0] as tl.RawMessage
    const global2 = await rpc.searchGlobal({
      _: 'messages.searchGlobal', q: '蔚蓝', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0,
      offsetRate: (global1 as tl.messages.RawMessagesSlice).nextRate!,
      offsetPeer: { _: 'inputPeerUser', userId: (globalLast.peerId as tl.RawPeerUser).userId, accessHash: Long.ZERO },
      offsetId: globalLast.id, limit: 5,
    })
    expect(texts(global2)).toEqual(['这是一个测试消息，里面有服务器报错和蔚蓝'])
    expect(texts(await rpc.searchGlobal({
      _: 'messages.searchGlobal', q: '蔚蓝', filter: { _: 'inputMessagesFilterEmpty' },
      usersOnly: true, minDate: 0, maxDate: 0, offsetRate: 0, offsetPeer: { _: 'inputPeerEmpty' }, offsetId: 0, limit: 10,
    }))).toEqual(['私聊里的测试与蔚蓝'])
    expect(texts(await rpc.searchGlobal({
      _: 'messages.searchGlobal', q: '蔚蓝', filter: { _: 'inputMessagesFilterEmpty' },
      groupsOnly: true, minDate: 0, maxDate: 0, offsetRate: 0, offsetPeer: { _: 'inputPeerEmpty' }, offsetId: 0, limit: 10,
    }))).toEqual(['这是一个测试消息，里面有服务器报错和蔚蓝'])

    // 7. searchSentMedia & 共享媒体（GROUP BY 计数、滚动条位置、日历、MyMentions、PhoneCalls）
    const sentMedia = await rpc.searchSentMedia({
      _: 'messages.searchSentMedia', q: '', filter: { _: 'inputMessagesFilterPhotos' }, limit: 10,
    })
    expect(ids(sentMedia)).toHaveLength(1)

    const counters = await rpc.getSearchCounters({
      _: 'messages.getSearchCounters',
      peer: peers.group,
      filters: [
        { _: 'inputMessagesFilterPhotos' },
        { _: 'inputMessagesFilterPhotoVideo' },
        { _: 'inputMessagesFilterDocument' },
        { _: 'inputMessagesFilterGif' },
        { _: 'inputMessagesFilterVoice' },
        { _: 'inputMessagesFilterMusic' },
        { _: 'inputMessagesFilterUrl' },
        { _: 'inputMessagesFilterMyMentions' },
      ],
    })
    expect(counters.map((counter) => counter.count)).toEqual([2, 3, 1, 1, 1, 1, 1, 1])

    const positions = await rpc.getSearchResultsPositions({
      _: 'messages.getSearchResultsPositions',
      peer: peers.group,
      filter: { _: 'inputMessagesFilterPhotoVideo' },
      offsetId: 0,
      limit: 10,
    })
    expect(positions.count).toBe(3)
    expect(positions.positions.map((position) => position.offset)).toEqual([0, 1, 2])

    const calendar = await rpc.getSearchResultsCalendar({
      _: 'messages.getSearchResultsCalendar',
      peer: peers.group,
      filter: { _: 'inputMessagesFilterPhotos' },
      offsetId: 0,
      offsetDate: 0,
    })
    expect(calendar.count).toBe(2)
    expect(calendar.periods).toHaveLength(1)

    const missedCalls = await rpc.search(searchRequest(
      { _: 'inputPeerEmpty' },
      { filter: { _: 'inputMessagesFilterPhoneCalls', missed: true } },
    ))
    expect(ids(missedCalls)).toHaveLength(1)

    // 8. 写入新消息后所有 PostgreSQL 搜索/计数缓存失效。
    await store.ingestMany(session, group, [
      text('g-live-new', group, BASE + 5_000, '最新一条测试消息'),
    ], { allocation: 'live' })
    const afterLive = await rpc.search(searchRequest(peers.group, { q: '测试' }))
    expect(texts(afterLive)[0]).toBe('最新一条测试消息')
    expect(texts(afterLive)).toHaveLength(4)
  }, 60_000)
})
