import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { IMConversation, IMMedia, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'search-session', platformId: 'search', userId: 'self', credentials: {}, metadata: {},
}

const alice: IMConversation = { id: 'alice', kind: 'direct', title: 'Alice' }
const carol: IMConversation = { id: 'carol', kind: 'direct', title: 'Carol' }
const group: IMConversation = { id: 'group', kind: 'group', title: 'Dev group' }

const DAY = 86_400
/** 2027-01-15 00:00 UTC+8 */
const BASE = 1_800_000_000 - (1_800_000_000 + 8 * 3600) % DAY

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function text(id: string, conversation: IMConversation, timestamp: number, body: string, extra: Partial<IMMessage> = {}): IMMessage {
  return {
    id, conversationId: conversation.id, senderId: extra.outgoing ? 'self' : 'alice', timestamp,
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
  id: string, conversation: IMConversation, timestamp: number, media: IMMedia[], caption = '', extra: Partial<IMMessage> = {},
): IMMessage {
  return {
    id, conversationId: conversation.id, senderId: extra.outgoing ? 'self' : 'alice', timestamp,
    content: { parts: [
      ...(caption ? [{ type: 'text' as const, text: caption }] : []),
      ...media.map((item) => ({ type: 'media' as const, media: item })),
    ] },
    ...extra,
  }
}

async function setup(seed: Array<[IMConversation, IMMessage[]]>) {
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
  for (const [conversation, messages] of seed) {
    await store.ingestMany(session, conversation, messages, { allocation: 'history' })
  }
  const getHistory = vi.fn(async () => ({ messages: [] as IMMessage[] }))
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
      conversations: { groups: true, channels: true, subchannels: true },
    },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
    async getDialogs() {
      return { dialogs: [alice, carol, group].map((conversation) => ({ conversation, unreadCount: 0 })) }
    },
    getHistory,
    async getUser(_session, id) { return { id, firstName: id } },
  }
  const rpc = new DialogRpc(platform, session, store)
  await rpc.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  })
  getHistory.mockClear()
  const peers = {
    alice: { _: 'inputPeerUser' as const, userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
    carol: { _: 'inputPeerUser' as const, userId: rpc.peerTlId('carol'), accessHash: Long.ZERO },
    group: { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('group'), accessHash: Long.ZERO },
  }
  return { ctx, store, rpc, peers, getHistory }
}

function searchRequest(
  peer: tl.TypeInputPeer,
  overrides: Partial<tl.messages.RawSearchRequest> = {},
): tl.messages.RawSearchRequest {
  return {
    _: 'messages.search', peer, q: '', filter: { _: 'inputMessagesFilterEmpty' },
    minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: Long.ZERO,
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

function roundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('local message search', () => {
  it('matches every normalized term as a literal substring without asking the platform', async () => {
    const { rpc, peers, getHistory } = await setup([[alice, [
      text('a1', alice, BASE + 10, 'Deploy the ＲＥＬＡＹ tonight'),
      text('a2', alice, BASE + 20, 'relay is down'),
      text('a3', alice, BASE + 30, 'price is 3.5 (approx) a+b'),
      text('a4', alice, BASE + 40, 'price is 305 approx ab'),
    ]]])

    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'relay  DEPLOY' }))))
      .toEqual(['Deploy the ＲＥＬＡＹ tonight'])
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'relay' }))))
      .toEqual(['relay is down', 'Deploy the ＲＥＬＡＹ tonight'])
    // 正则元字符必须按字面量匹配。
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: '3.5 (approx)' }))))
      .toEqual(['price is 3.5 (approx) a+b'])
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'a+b' }))))
      .toEqual(['price is 3.5 (approx) a+b'])
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'missing' })))).toEqual([])
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('finds file names, card titles, and link targets', async () => {
    const { rpc, peers } = await setup([[alice, [
      mediaMessage('f1', alice, BASE + 1, [file('pdf', 'Quarterly-Report.pdf', 'application/pdf')]),
      {
        id: 'c1', conversationId: 'alice', senderId: 'alice', timestamp: BASE + 2,
        content: { parts: [{ type: 'card', card: { kind: 'link', title: 'Cordis handbook', url: 'https://cordis.example/doc' } }] },
      },
      {
        id: 'l1', conversationId: 'alice', senderId: 'alice', timestamp: BASE + 3,
        content: { parts: [{
          type: 'text', text: 'see here',
          entities: [{ type: 'text-link', offset: 4, length: 4, url: 'https://hidden.example/path' }],
        }] },
      },
    ]]])

    expect(await rpc.search(searchRequest(peers.alice, { q: 'quarterly' }))).toMatchObject({ messages: [{ _: 'message' }] })
    expect(await rpc.search(searchRequest(peers.alice, { q: 'handbook' }))).toMatchObject({ messages: [{ _: 'message' }] })
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'hidden.example' })))).toEqual(['see here'])
  })

  it('filters by sender, self, and an exclusive date window', async () => {
    const { rpc, peers } = await setup([[group, [
      { ...text('g1', group, BASE + 10, 'hello from alice'), senderId: 'alice' },
      { ...text('g2', group, BASE + 20, 'hello from bob'), senderId: 'bob' },
      text('g3', group, BASE + 30, 'hello from me', { outgoing: true }),
      { ...text('g4', group, BASE + 40, 'hello again bob'), senderId: 'bob' },
    ]]])
    const bob = { _: 'inputPeerUser' as const, userId: rpc.peerTlId('bob'), accessHash: Long.ZERO }

    expect(texts(await rpc.search(searchRequest(peers.group, { q: 'hello', fromId: bob }))))
      .toEqual(['hello again bob', 'hello from bob'])
    expect(texts(await rpc.search(searchRequest(peers.group, { fromId: { _: 'inputPeerSelf' } }))))
      .toEqual(['hello from me'])
    expect(texts(await rpc.search(searchRequest(peers.group, { q: 'hello', minDate: BASE + 10, maxDate: BASE + 40 }))))
      .toEqual(['hello from me', 'hello from bob'])
    // 未知用户不能退化成「不过滤」。
    expect(texts(await rpc.search(searchRequest(peers.group, {
      fromId: { _: 'inputPeerUser', userId: 123456789, accessHash: Long.ZERO },
    })))).toEqual([])
  })

  it('pages with offsetId and addOffset and reports the exact total on the first page', async () => {
    const messages = Array.from({ length: 7 }, (_, index) =>
      text(`p${index}`, alice, BASE + index, `needle ${index}`))
    const { rpc, peers } = await setup([[alice, messages]])

    const first = await rpc.search(searchRequest(peers.alice, { q: 'needle', limit: 3 }))
    expect(first).toMatchObject({ _: 'messages.messagesSlice', count: 7 })
    expect((first as tl.messages.RawMessagesSlice).inexact).toBeUndefined()
    expect(texts(first)).toEqual(['needle 6', 'needle 5', 'needle 4'])

    const second = await rpc.search(searchRequest(peers.alice, { q: 'needle', limit: 3, offsetId: ids(first).at(-1)! }))
    expect(texts(second)).toEqual(['needle 3', 'needle 2', 'needle 1'])
    expect(second).toMatchObject({ _: 'messages.messagesSlice' })

    const skipped = await rpc.search(searchRequest(peers.alice, { q: 'needle', limit: 2, addOffset: 4 }))
    expect(texts(skipped)).toEqual(['needle 2', 'needle 1'])

    const countOnly = await rpc.search(searchRequest(peers.alice, { q: 'needle', limit: 0 }))
    expect(countOnly).toMatchObject({ _: 'messages.messagesSlice', count: 7, messages: [] })

    const capped = await rpc.search(searchRequest(peers.alice, { q: 'needle', maxId: ids(first)[1], minId: ids(second)[1] }))
    expect(texts(capped)).toEqual(['needle 4', 'needle 3'])
    for (const result of [first, second, skipped, countOnly, capped]) expect(() => roundTrip(result)).not.toThrow()
  })

  it('excludes deleted messages and service tips from text search', async () => {
    const { rpc, store, peers } = await setup([[alice, [
      text('d1', alice, BASE + 1, 'secret kept'),
      text('d2', alice, BASE + 2, 'secret removed'),
      {
        id: 'tip', conversationId: 'alice', senderId: 'alice', timestamp: BASE + 3,
        content: { parts: [], serviceAction: { type: 'custom', text: 'secret service tip' } },
      },
    ]]])
    await store.deleteMessages(session, alice, ['d2'])

    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'secret' })))).toEqual(['secret kept'])
  })

  it('classifies album parts for shared media filters, counters, and positions', async () => {
    const { rpc, peers } = await setup([[alice, [
      mediaMessage('album', alice, BASE + 10, [image('img-1'), image('img-2'), file('doc', 'a.pdf', 'application/pdf')], 'trip'),
      mediaMessage('gif', alice, BASE + 20, [image('anim', 'anim.gif', 'image/gif')]),
      mediaMessage('video', alice, BASE + 30, [file('clip', 'clip.mp4', 'video/mp4')]),
      mediaMessage('voice', alice, BASE + 40, [file('note', 'note.ogg', 'audio/ogg', true)]),
      mediaMessage('song', alice, BASE + 50, [file('song', 'song.mp3', 'audio/mpeg')]),
      text('link', alice, BASE + 60, 'read https://example.com/a'),
    ]]])

    const photos = await rpc.search(searchRequest(peers.alice, { filter: { _: 'inputMessagesFilterPhotos' } }))
    expect(ids(photos)).toHaveLength(2)
    expect(ids(photos)[0]).toBeGreaterThan(ids(photos)[1])

    await expect(rpc.getSearchCounters({
      _: 'messages.getSearchCounters', peer: peers.alice,
      filters: [
        { _: 'inputMessagesFilterPhotos' },
        { _: 'inputMessagesFilterPhotoVideo' },
        { _: 'inputMessagesFilterDocument' },
        { _: 'inputMessagesFilterGif' },
        { _: 'inputMessagesFilterVoice' },
        { _: 'inputMessagesFilterMusic' },
        { _: 'inputMessagesFilterUrl' },
        { _: 'inputMessagesFilterGeo' },
      ],
    })).resolves.toEqual([
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterPhotos' }, count: 2 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterPhotoVideo' }, count: 3 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterDocument' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterGif' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterVoice' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterMusic' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterUrl' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterGeo' }, count: 0 },
    ])

    const allPositions = await rpc.getSearchResultsPositions({
      _: 'messages.getSearchResultsPositions', peer: peers.alice,
      filter: { _: 'inputMessagesFilterPhotoVideo' }, offsetId: 0, limit: 10,
    })
    expect(allPositions).toMatchObject({ _: 'messages.searchResultsPositions', count: 3 })
    expect(allPositions.positions.map((position) => position.offset)).toEqual([0, 1, 2])
    expect(allPositions.positions[0]).toMatchObject({ date: BASE + 30 })
    const later = await rpc.getSearchResultsPositions({
      _: 'messages.getSearchResultsPositions', peer: peers.alice,
      filter: { _: 'inputMessagesFilterPhotoVideo' }, offsetId: allPositions.positions[0].msgId, limit: 1,
    })
    expect(later.positions).toEqual([{ ...allPositions.positions[1] }])
    expect(() => roundTrip(allPositions)).not.toThrow()
  })

  it('groups calendar periods by day and resumes from offsetId', async () => {
    const { rpc, peers } = await setup([[alice, [
      mediaMessage('d1a', alice, BASE + 3600, [image('d1a')]),
      mediaMessage('d1b', alice, BASE + 7200, [image('d1b')]),
      mediaMessage('d2', alice, BASE + DAY + 60, [image('d2')]),
      mediaMessage('d3', alice, BASE + 3 * DAY + 60, [image('d3')]),
    ]]])

    const calendar = await rpc.getSearchResultsCalendar({
      _: 'messages.getSearchResultsCalendar', peer: peers.alice,
      filter: { _: 'inputMessagesFilterPhotos' }, offsetId: 0, offsetDate: 0,
    })
    expect(calendar).toMatchObject({ _: 'messages.searchResultsCalendar', count: 4, minDate: BASE + 3600 })
    expect(calendar.periods.map((period) => [period.date, period.count])).toEqual([
      [BASE + 3 * DAY, 1], [BASE + DAY, 1], [BASE, 2],
    ])
    expect(calendar.messages).toHaveLength(3)
    expect(calendar.periods[2].minMsgId).toBeLessThan(calendar.periods[2].maxMsgId)
    expect(calendar.minMsgId).toBe(calendar.periods[2].minMsgId)

    const resumed = await rpc.getSearchResultsCalendar({
      _: 'messages.getSearchResultsCalendar', peer: peers.alice,
      filter: { _: 'inputMessagesFilterPhotos' }, offsetId: calendar.periods[1].maxMsgId, offsetDate: 0,
    })
    expect(resumed.offsetIdOffset).toBe(2)
    expect(resumed.periods.map((period) => period.count)).toEqual([2])
    expect(() => roundTrip(calendar)).not.toThrow()
  })

  it('treats explicit @mentions and replies to own messages as MyMentions in groups only', async () => {
    const own = text('own', group, BASE + 1, 'my question', { outgoing: true })
    const { rpc, peers } = await setup([
      [group, [
        own,
        {
          id: 'mention', conversationId: 'group', senderId: 'alice', timestamp: BASE + 2,
          content: { parts: [{ type: 'text', text: '@me look', entities: [{ type: 'mention', offset: 0, length: 3, userId: 'self' }] }] },
        },
        { ...text('reply', group, BASE + 3, 'answer'), replyToId: 'own' },
        text('plain', group, BASE + 4, 'unrelated'),
      ]],
      [alice, [{
        id: 'dm-mention', conversationId: 'alice', senderId: 'alice', timestamp: BASE + 5,
        content: { parts: [{ type: 'text', text: '@me dm', entities: [{ type: 'mention', offset: 0, length: 3, userId: 'self' }] }] },
      }]],
    ])

    expect(texts(await rpc.search(searchRequest(peers.group, { filter: { _: 'inputMessagesFilterMyMentions' } }))))
      .toEqual(['answer', '@me look'])
    expect(texts(await rpc.search(searchRequest(peers.alice, { filter: { _: 'inputMessagesFilterMyMentions' } }))))
      .toEqual([])
  })

  it('lists call history through an empty peer and narrows to missed calls', async () => {
    const { rpc } = await setup([
      [alice, [
        { id: 'call-1', conversationId: 'alice', senderId: 'alice', timestamp: BASE + 1, content: { parts: [], serviceAction: { type: 'phone-call', duration: 42 } } },
        { id: 'call-2', conversationId: 'alice', senderId: 'alice', timestamp: BASE + 2, content: { parts: [], serviceAction: { type: 'phone-call' } } },
      ]],
      [carol, [
        { id: 'call-3', conversationId: 'carol', senderId: 'self', outgoing: true, timestamp: BASE + 3, content: { parts: [], serviceAction: { type: 'phone-call' } } },
      ]],
    ])

    const calls = await rpc.search(searchRequest({ _: 'inputPeerEmpty' }, { filter: { _: 'inputMessagesFilterPhoneCalls' } }))
    expect(texts(calls)).toEqual(['messageService', 'messageService', 'messageService'])
    const missed = await rpc.search(searchRequest({ _: 'inputPeerEmpty' }, { filter: { _: 'inputMessagesFilterPhoneCalls', missed: true } }))
    expect(ids(missed)).toHaveLength(1)
    expect(() => roundTrip(calls)).not.toThrow()
  })

  it('searches globally with peer-type flags and offsetRate paging', async () => {
    const { rpc } = await setup([
      [alice, [text('ga1', alice, BASE + 10, 'global word one'), text('ga2', alice, BASE + 30, 'global word three')]],
      [carol, [text('gc1', carol, BASE + 20, 'global word two')]],
      [group, [text('gg1', group, BASE + 40, 'global word four')]],
    ])
    const request = (overrides: Partial<tl.messages.RawSearchGlobalRequest> = {}): tl.messages.RawSearchGlobalRequest => ({
      _: 'messages.searchGlobal', q: 'global word', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0, offsetRate: 0, offsetPeer: { _: 'inputPeerEmpty' }, offsetId: 0, limit: 2,
      ...overrides,
    })

    const first = await rpc.searchGlobal(request())
    expect(texts(first)).toEqual(['global word four', 'global word three'])
    expect(first).toMatchObject({ _: 'messages.messagesSlice', inexact: true, nextRate: BASE + 30 })
    expect((first as tl.messages.RawMessagesSlice).chats.length).toBeGreaterThan(0)
    const last = (first as tl.messages.RawMessagesSlice).messages.at(-1) as tl.RawMessage
    const second = await rpc.searchGlobal(request({
      offsetRate: BASE + 30,
      offsetPeer: { _: 'inputPeerUser', userId: (last.peerId as tl.RawPeerUser).userId, accessHash: Long.ZERO },
      offsetId: last.id,
    }))
    expect(texts(second)).toEqual(['global word two', 'global word one'])

    expect(texts(await rpc.searchGlobal(request({ limit: 10, usersOnly: true }))))
      .toEqual(['global word three', 'global word two', 'global word one'])
    expect(texts(await rpc.searchGlobal(request({ limit: 10, groupsOnly: true })))).toEqual(['global word four'])
    expect(texts(await rpc.searchGlobal(request({ limit: 10, broadcastsOnly: true })))).toEqual([])
    expect(() => roundTrip(first)).not.toThrow()
  })

  it('returns own sent media across chats for searchSentMedia', async () => {
    const { rpc } = await setup([
      [alice, [
        mediaMessage('mine-1', alice, BASE + 1, [image('mine-1')], '', { outgoing: true }),
        mediaMessage('theirs', alice, BASE + 2, [image('theirs')]),
      ]],
      [group, [mediaMessage('mine-2', group, BASE + 3, [image('mine-2')], '', { outgoing: true })]],
    ])

    const result = await rpc.searchSentMedia({
      _: 'messages.searchSentMedia', q: '', filter: { _: 'inputMessagesFilterPhotos' }, limit: 10,
    })
    expect(result).toMatchObject({ _: 'messages.messages' })
    expect(ids(result)).toHaveLength(2)
    expect(() => roundTrip(result)).not.toThrow()
  })

  it('makes legacy rows searchable after the background rebuild', async () => {
    const { ctx, store, rpc, peers } = await setup([[alice, [text('legacy', alice, BASE, 'legacy needle')]]])
    await ctx.database.set('mtproto_im_message', {}, { searchText: '', searchKinds: null })
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'needle' })))).toEqual([])

    expect(await store.rebuildSearchFields(10)).toBe(1)
    expect(await store.rebuildSearchFields(10)).toBe(0)
    expect(texts(await rpc.search(searchRequest(peers.alice, { q: 'needle' })))).toEqual(['legacy needle'])
  })

  it('returns empty results for pinned and unsupported filters', async () => {
    const { rpc, peers } = await setup([[alice, [text('x', alice, BASE, 'anything')]]])
    for (const filter of [
      { _: 'inputMessagesFilterPinned' }, { _: 'inputMessagesFilterGeo' }, { _: 'inputMessagesFilterContacts' },
      { _: 'inputMessagesFilterChatPhotos' },
    ] as tl.TypeMessagesFilter[]) {
      expect(texts(await rpc.search(searchRequest(peers.alice, { filter })))).toEqual([])
    }
  })
})
