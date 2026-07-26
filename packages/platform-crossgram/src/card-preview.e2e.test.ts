import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { defineModels } from '../../bridge/src/models.js'
import type { PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-card-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe('QQNT card preview E2E', () => {
  it('carries a bridge HTTP card through the adapter, durable store, and Telegram projection', async () => {
    let server: Server | undefined
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url?.startsWith('/v1/conversations/card-room/history')) {
        response.end(JSON.stringify({ messages: [{
          id: 'qq-card-message', conversationId: 'card-room', senderId: 'alice',
          timestamp: 1_800_000_000, outgoing: false,
          parts: [{ type: 'card', card: {
            kind: 'link', source: '示例资讯', title: '完整分享标题', description: '完整分享摘要',
            url: 'https://example.com/articles/42', thumbnailUrl: 'https://cdn.example.com/cover.jpg',
          } }],
        }] }))
        return
      }
      if (request.url?.startsWith('/v1/dialogs')) {
        response.end(JSON.stringify({ conversations: [{
          id: 'card-room', kind: 'direct', title: 'Card room',
          peerUid: 'card-room', peerUin: '10001', chatType: 1, unreadCount: 0,
        }] }))
        return
      }
      if (request.url === '/v1/reactions/catalog') {
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
      if (!server?.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
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
    const conversation = { id: 'card-room', kind: 'direct' as const, title: 'Card room' }
    const history = await platform.getHistory(session, conversation)
    expect(history.messages[0].content.parts[0]).toMatchObject({
      type: 'card', card: { title: '完整分享标题', thumbnailUrl: 'https://cdn.example.com/cover.jpg' },
    })

    const store = new MessageStore(ctx.database)
    const ingested = await store.ingest(session, conversation, history.messages[0], { allocation: 'history' })
    const rpc = new DialogRpc(platform, session, store)
    const result = await rpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: ingested.projection[0].tlMessageId }],
    }) as tl.messages.RawMessages
    const projected = result.messages[0] as tl.RawMessage

    expect(projected).toMatchObject({
      _: 'message', message: '分享 · 示例资讯\n打开链接',
      entities: [{
        _: 'messageEntityTextUrl', offset: '分享 · 示例资讯\n'.length, length: '打开链接'.length,
        url: 'https://example.com/articles/42',
      }],
      media: { _: 'messageMediaWebPage', manual: true, safe: true, webpage: {
        _: 'webPage', url: 'https://example.com/articles/42', displayUrl: 'example.com',
        type: 'article', siteName: '示例资讯', title: '完整分享标题', description: '完整分享摘要',
        photo: { _: 'photo', dcId: 1, sizes: [{ _: 'photoSize', type: 'x' }] },
      } },
    })

    const media = projected.media as tl.RawMessageMediaWebPage
    if (media.webpage._ !== 'webPage' || media.webpage.photo?._ !== 'photo') {
      throw new Error('expected a downloadable card thumbnail')
    }
    const thumbnail = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(thumbnail, {
      headers: { 'content-type': 'image/jpeg' },
    }))
    const file = await rpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPhotoFileLocation', id: media.webpage.photo.id,
        accessHash: media.webpage.photo.accessHash,
        fileReference: media.webpage.photo.fileReference, thumbSize: 'x',
      },
      offset: 0, limit: 1024,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/cover.jpg', expect.objectContaining({
      redirect: 'manual',
    }))
    expect(file).toMatchObject({ _: 'upload.file', type: { _: 'storage.fileJpeg' }, bytes: thumbnail })
  })
})
