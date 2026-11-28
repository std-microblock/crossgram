import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { defineModels } from '../../bridge/src/models.js'
import type { PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-bot-markdown-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

// Shape of a QQ official-bot menu as recorded from production: the keyboard,
// a markdown body led by an empty template-metadata link, then QQ's plain-text
// fallback for clients without markdown support.
const menuMessage = {
  id: 'qq-bot-menu', conversationId: 'menu-group', senderId: 'bot', timestamp: 1_800_000_000, outgoing: false,
  msgSeq: '1884646', telegramMessageId: 1884646,
  sender: { id: 'bot', name: '橘波特', numericId: '3889020080', bot: true },
  parts: [
    { type: 'inline-keyboard', keyboard: {
      botAppid: '102106848',
      rows: [{ buttons: [
        {
          id: 'ac.status', label: '服务器状态', visitedLabel: '服务器状态', style: 1, type: 1,
          clickLimit: 0, unsupportTips: '', data: 'BOT1.0_status',
          atBotShowChannelList: false, permissionType: 2, specifyRoleIds: [], specifyTinyids: [],
        },
        {
          id: 'config', label: '修改配置', visitedLabel: '修改配置', style: 0, type: 0,
          clickLimit: 0, unsupportTips: '', data: 'https://autochess.microblock.cc/',
          atBotShowChannelList: false, permissionType: 2, specifyRoleIds: [], specifyTinyids: [],
        },
      ] }],
    } },
    { type: 'markdown', content: '[](%7B%22version%22%3A2%7D)\n\n卫戍协议控制台\n私聊 /token 可获取设置页 JWT。\n' },
    { type: 'text', text: '卫戍协议控制台\n私聊 /token 可获取设置页 JWT。' },
  ],
}
// QQ group msgSeq values are per group, so another group reuses the id.
const otherMessage = {
  id: 'qq-other', conversationId: 'other-group', senderId: 'alice', timestamp: 1_800_000_100, outgoing: false,
  msgSeq: '1884646', telegramMessageId: 1884646,
  parts: [{ type: 'text', text: '我还没试过' }],
}

/**
 * An entity list as `_:slice` pairs, so a case states what Telegram draws
 * instead of only the offsets it draws it at.
 */
function entitySlices(message: tl.RawMessage): string[] {
  return (message.entities ?? []).map((entity) =>
    `${entity._}:${(message.message ?? '').slice(entity.offset, entity.offset + entity.length)}`)
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

describe('QQNT bot markdown E2E', () => {
  it('renders the markdown body once and routes a button click to the tapped group', async () => {
    const clicks: unknown[] = []
    const server: Server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = request.url ?? ''
      const history = /^\/v1\/conversations\/([^/]+)\/history/.exec(url)
      if (history) {
        const id = decodeURIComponent(history[1]!)
        response.end(JSON.stringify({
          messages: [menuMessage, otherMessage].filter((message) => message.conversationId === id),
        }))
        return
      }
      if (url.startsWith('/v1/dialogs')) {
        response.end(JSON.stringify({ conversations: ['menu-group', 'other-group'].map((id) => ({
          id, kind: 'group', title: id, peerUid: id, peerUin: id, chatType: 2, unreadCount: 0,
        })) }))
        return
      }
      if (url === '/v1/messages/get') {
        const body = await readJson(request)
        const message = [menuMessage, otherMessage].find((candidate) =>
          candidate.conversationId === body.conversationId && candidate.id === body.messageId)
        response.statusCode = message ? 200 : 404
        response.end(JSON.stringify(message ?? { error: 'not found' }))
        return
      }
      if (url === '/v1/messages/inline-keyboard/click') {
        clicks.push(await readJson(request))
        response.end(JSON.stringify({ status: 0, promptText: '', promptType: 0, promptIcon: 0 }))
        return
      }
      if (url === '/v1/reactions/catalog') {
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 20 }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    })

    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const store = new MessageStore(ctx.database)
    const menuConversation = { id: 'menu-group', kind: 'group' as const, title: 'menu-group' }
    const otherConversation = { id: 'other-group', kind: 'group' as const, title: 'other-group' }
    const [menu] = (await platform.getHistory(session, menuConversation)).messages
    const [other] = (await platform.getHistory(session, otherConversation)).messages
    const menuProjection = await store.ingest(session, menuConversation, menu!, { allocation: 'history' })
    const otherProjection = await store.ingest(session, otherConversation, other!, { allocation: 'history' })
    const msgId = menuProjection.projection[0]!.tlMessageId
    expect(otherProjection.projection[0]!.tlMessageId).toBe(msgId)

    const rpc = new DialogRpc(platform, session, store)
    const menuPeer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('menu-group'), accessHash: Long.ZERO }
    const otherPeer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('other-group'), accessHash: Long.ZERO }
    let users: tl.TypeUser[] = []
    const read = async (peer: tl.TypeInputChannel | typeof menuPeer) => {
      const result = await rpc.getHistory({
        _: 'messages.getHistory', peer: peer as tl.TypeInputPeer, offsetId: 0, offsetDate: 0, addOffset: 0,
        limit: 20, maxId: 0, minId: 0, hash: Long.ZERO,
      }) as tl.messages.RawChannelMessages
      users = result.users
      return result.messages.find((message): message is tl.RawMessage => message._ === 'message' && message.id === msgId)!
    }
    const projected = await read(menuPeer)
    // The QQ robot flag reaches Telegram clients as a real bot user.
    const sender = users.find((user): user is tl.RawUser =>
      user._ === 'user' && projected.fromId?._ === 'peerUser' && user.id === projected.fromId.userId)
    expect(sender).toMatchObject({ bot: true, firstName: '橘波特' })
    expect(projected.message).toBe('卫戍协议控制台\n私聊 /token 可获取设置页 JWT。')
    expect(projected.replyMarkup).toMatchObject({
      _: 'replyInlineMarkup',
      rows: [{ buttons: [
        { text: '服务器状态', type: { _: 'inlineButtonTypeCallback' } },
        { text: '修改配置', type: { _: 'inlineButtonTypeUrl', url: 'https://autochess.microblock.cc/' } },
      ] }],
    })
    // Materialize the colliding message last so the in-memory id cache
    // points at the other group, exactly like a client browsing both chats.
    expect((await read(otherPeer)).message).toBe('我还没试过')

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', peer: menuPeer, msgId, data: Buffer.from('BOT1.0_status'),
    })).resolves.toMatchObject({ _: 'messages.botCallbackAnswer', cacheTime: 0 })
    expect(clicks).toEqual([{
      conversationId: 'menu-group', messageId: 'qq-bot-menu', messageSequence: '1884646',
      buttonId: 'ac.status', callbackData: 'BOT1.0_status', botAppid: '102106848',
    }])
  })

  it('relays a quoted QQ bot reply as a Telegram quote, not as markdown source', async () => {
    // A QQ bot reply as recorded from production: QQ's reply box travels as a
    // markdown blockquote line, then the body, then QQ's plain-text fallback for
    // clients without markdown support.
    const replyMessage = {
      id: 'qq-bot-reply', conversationId: 'reply-group', senderId: 'bot', timestamp: 1_800_000_200,
      outgoing: false, msgSeq: '1884647', telegramMessageId: 1884647,
      sender: { id: 'bot', name: '橘波特', numericId: '3889020080', bot: true },
      parts: [
        {
          type: 'markdown', content: '> 小明：今天上午的航班在哪里看\n\n'
            + '顺手修了两处 [PR #7](https://github.com/std-microblock/crossgram/pull/7) 已提 **加粗**\n',
        },
        {
          type: 'text', text: '小明：今天上午的航班在哪里看\n\n'
            + '顺手修了两处 PR #7 已提 加粗',
        },
      ],
    }
    const server: Server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = request.url ?? ''
      if (url.startsWith('/v1/conversations/reply-group/history')) {
        response.end(JSON.stringify({ messages: [replyMessage] }))
        return
      }
      if (url.startsWith('/v1/dialogs')) {
        response.end(JSON.stringify({ conversations: [{
          id: 'reply-group', kind: 'group', title: 'reply-group',
          peerUid: 'reply-group', peerUin: 'reply-group', chatType: 2, unreadCount: 0,
        }] }))
        return
      }
      if (url === '/v1/reactions/catalog') {
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 20 }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    })

    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const store = new MessageStore(ctx.database)
    const conversation = { id: 'reply-group', kind: 'group' as const, title: 'reply-group' }
    const [reply] = (await platform.getHistory(session, conversation)).messages
    await store.ingest(session, conversation, reply!, { allocation: 'history' })

    const rpc = new DialogRpc(platform, session, store)
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('reply-group'), accessHash: Long.ZERO }
    const result = await rpc.getHistory({
      _: 'messages.getHistory', peer: peer as tl.TypeInputPeer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawChannelMessages
    const projected = result.messages.find((message): message is tl.RawMessage => message._ === 'message')
    // The blockquote line reaches the client as its own entity, so the text is
    // the body without the `>` markers and QQ's fallback copy is not doubled.
    expect(projected?.message).toBe(
      '小明：今天上午的航班在哪里看\n\n顺手修了两处 PR #7 已提 加粗',
    )
    expect(projected?.entities).toEqual([
      { _: 'messageEntityBlockquote', offset: 0, length: 14 },
      {
        _: 'messageEntityTextUrl', offset: 23, length: 5,
        url: 'https://github.com/std-microblock/crossgram/pull/7',
      },
      { _: 'messageEntityBold', offset: 32, length: 2 },
    ])
  })

  it('relays a whole QQ bot markdown body, every construct at once', async () => {
    // The whole body of a QQ markdown message is markdown, so a client gets one
    // Telegram message whose text is the rendered body and whose entities carry
    // the quote, the list bullets, the table as monospace and the inline markup.
    const document = [
      '> 小明：今天上午的航班在哪里看',
      '',
      '顺手修了两处 [PR #7](https://github.com/std-microblock/crossgram/pull/7) 已提 **加粗** 和 `码`',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '| 名字 | 数量 |',
      '| --- | --- |',
      '| 橘子 | 3 |',
      '',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n')
    const markdownMessage = {
      id: 'qq-bot-document', conversationId: 'doc-group', senderId: 'bot', timestamp: 1_800_000_300,
      outgoing: false, msgSeq: '1884648', telegramMessageId: 1884648,
      sender: { id: 'bot', name: '橘波特', numericId: '3889020080', bot: true },
      parts: [
        { type: 'markdown', content: `${document}\n` },
        // QQ's plain-text rendition of the same body, which is dropped: QQ
        // renders the body (its template links disappear from recorded
        // renditions) and only the layout markers differ from what we draw.
        {
          type: 'text',
          text: '小明：今天上午的航班在哪里看\n\n'
            + '顺手修了两处 PR #7 已提 加粗 和 码\n\n'
            + '• 第一项\n• 第二项\n\n名字 数量\n橘子 3\n\nconst a = 1',
        },
      ],
    }
    const server: Server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = request.url ?? ''
      if (url.startsWith('/v1/conversations/doc-group/history')) {
        response.end(JSON.stringify({ messages: [markdownMessage] }))
        return
      }
      if (url.startsWith('/v1/dialogs')) {
        response.end(JSON.stringify({ conversations: [{
          id: 'doc-group', kind: 'group', title: 'doc-group',
          peerUid: 'doc-group', peerUin: 'doc-group', chatType: 2, unreadCount: 0,
        }] }))
        return
      }
      if (url === '/v1/reactions/catalog') {
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 20 }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    })

    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const store = new MessageStore(ctx.database)
    const conversation = { id: 'doc-group', kind: 'group' as const, title: 'doc-group' }
    const [message] = (await platform.getHistory(session, conversation)).messages
    await store.ingest(session, conversation, message!, { allocation: 'history' })

    const rpc = new DialogRpc(platform, session, store)
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('doc-group'), accessHash: Long.ZERO }
    const result = await rpc.getHistory({
      _: 'messages.getHistory', peer: peer as tl.TypeInputPeer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawChannelMessages
    const projected = result.messages.find((message): message is tl.RawMessage => message._ === 'message')!
    expect(projected.message).toBe([
      '小明：今天上午的航班在哪里看',
      '',
      '顺手修了两处 PR #7 已提 加粗 和 码',
      '',
      '• 第一项',
      '• 第二项',
      '',
      '名字 | 数量',
      '橘子 | 3',
      '',
      'const a = 1',
    ].join('\n'))
    // The same body reaches the client as a rich message too, tables included:
    // entities cannot carry one.
    expect(projected.richMessage?.blocks.map((block) => block._)).toEqual([
      'pageBlockBlockquote',
      'pageBlockParagraph',
      'pageBlockList',
      'pageBlockTable',
      'pageBlockPreformatted',
    ])
    const table = projected.richMessage?.blocks[3] as tl.RawPageBlockTable
    expect(table.rows.map((row) => row.cells.map((cell) => (cell.text as tl.RawTextPlain).text))).toEqual([
      ['名字', '数量'],
      ['橘子', '3'],
    ])
    expect(table.rows[0]!.cells.map((cell) => cell.header)).toEqual([true, true])
    expect(entitySlices(projected)).toEqual([
      'messageEntityBlockquote:小明：今天上午的航班在哪里看',
      'messageEntityTextUrl:PR #7',
      'messageEntityBold:加粗',
      'messageEntityCode:码',
      'messageEntityPre:名字 | 数量\n橘子 | 3',
      // The fenced body keeps its trailing newline in the entity source, which
      // the message's trailing-trim then clips: the reader sees the code line.
      'messageEntityPre:const a = 1',
    ])
  })

  it('embeds QQ bot markdown images as richMessage photos and serves them via upload.getFile', async () => {
    const imageUrl = 'https://qqbot.ugcimg.cn/1906562192/qqbot-media/preview-test.png'
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const markdown = [
      '**📄 第10章作业** · 第 1 版',
      '离散数学 · 学习通 · 1题 · 草稿 `#13`',
      '',
      '> 💬 回复本图提修改意见，确认无误点下方提交',
      '',
      `![preview #922px #2875px](${imageUrl})`,
      '',
      '审核：[@MicroBlock](mqqapi://markdown/mention?at_type=1&at_tinyid=1715311957)',
    ].join('\n')
    const markdownMessage = {
      id: 'qq-bot-inline-image', conversationId: 'img-group', senderId: 'bot', timestamp: 1_800_000_400,
      outgoing: false, msgSeq: '405', telegramMessageId: 405,
      sender: { id: 'bot', name: '作业助手', numericId: '1906562192', bot: true },
      parts: [
        { type: 'markdown', content: markdown },
        // QQ's plain-text fallback omits embedded images and mention targets.
        {
          type: 'text',
          text: '📄 第10章作业 · 第 1 版\n离散数学 · 学习通 · 1题 · 草稿 #13\n> 💬 回复本图提修改意见，确认无误点下方提交\n审核：',
        },
      ],
    }
    const server: Server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = request.url ?? ''
      if (url.startsWith('/v1/conversations/img-group/history')) {
        response.end(JSON.stringify({ messages: [markdownMessage] }))
        return
      }
      if (url.startsWith('/v1/dialogs')) {
        response.end(JSON.stringify({ conversations: [{
          id: 'img-group', kind: 'group', title: 'img-group',
          peerUid: 'img-group', peerUin: 'img-group', chatType: 2, unreadCount: 0,
        }] }))
        return
      }
      if (url === '/v1/reactions/catalog') {
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 20 }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    })

    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const store = new MessageStore(ctx.database)
    const conversation = { id: 'img-group', kind: 'group' as const, title: 'img-group' }
    const [message] = (await platform.getHistory(session, conversation)).messages
    await store.ingest(session, conversation, message!, { allocation: 'history' })

    const rpc = new DialogRpc(platform, session, store)
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('img-group'), accessHash: Long.ZERO }
    const result = await rpc.getHistory({
      _: 'messages.getHistory', peer: peer as tl.TypeInputPeer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawChannelMessages
    const projected = result.messages.find((item): item is tl.RawMessage => item._ === 'message')!

    // Plain-text fallback is deduplicated even though it omits the image alt text.
    expect(projected.message.split('第10章作业')).toHaveLength(2)
    expect(projected.richMessage?.blocks.map((block) => block._)).toEqual([
      'pageBlockParagraph',
      'pageBlockBlockquote',
      'pageBlockPhoto',
      'pageBlockParagraph',
    ])
    const photoBlock = projected.richMessage?.blocks[2] as tl.RawPageBlockPhoto
    const photo = projected.richMessage?.photos[0] as tl.RawPhoto
    expect(photo).toBeDefined()
    expect(photoBlock.photoId.equals(photo.id)).toBe(true)
    expect(photo.sizes).toEqual([
      { _: 'photoSize', type: 'y', w: 410, h: 1280, size: 0 },
      { _: 'photoSize', type: 'w', w: 922, h: 2875, size: 0 },
    ])

    const originalFetch = globalThis.fetch
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (target === imageUrl) {
        return new Response(imageBytes, {
          headers: { 'content-type': 'image/png', 'content-length': String(imageBytes.length) },
        })
      }
      return originalFetch(input, init)
    })
    disposals.push(async () => { fetchMock.mockRestore() })

    const file = await rpc.getFile({
      _: 'upload.getFile',
      location: {
        _: 'inputPhotoFileLocation',
        id: photo.id,
        accessHash: photo.accessHash,
        fileReference: photo.fileReference,
        thumbSize: 'y',
      },
      offset: 0,
      limit: 64,
    }) as tl.upload.RawFile
    expect(file.type).toEqual({ _: 'storage.filePng' })
    expect(file.bytes).toEqual(imageBytes)
  })
})
