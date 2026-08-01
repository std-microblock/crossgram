import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import sharp from 'sharp'
import {
  MessageStore, StickerRpc, type IngestResult, type PlatformSession, type Unsubscribe,
} from '@mtproto-relay/bridge'
import { makeTlMessageMedia } from '../../bridge/src/dialogs.js'
import { defineModels } from '../../bridge/src/models.js'
import { defineQQNTEventCheckpointModel } from './event-checkpoint.js'
import { QQNTPlatform } from './index.js'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'
import { QQStickerProvider } from './sticker-provider.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-order-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const disposals: Unsubscribe[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  sharp.cache(false)
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true, maxRetries: 20, retryDelay: 25,
  })))
})

describe('QQNT same-second message ordering E2E', () => {
  it('uses an independent WebSocket endpoint and persists 100, 102, 101 events', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    let server: Server | undefined
    const webSocketServer = new WebSocketServer({ noServer: true })
    server = createServer()
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    const connectionUrls: string[] = []
    webSocketServer.on('connection', (webSocket, request) => {
      connectionUrls.push(request.url ?? '')
      for (const [index, sequence] of [100, 102, 101].entries()) {
        webSocket.send(JSON.stringify({
          id: String(index + 1),
          event: {
            type: 'message',
            conversation: {
              id: 'same-second-group', kind: 'group', title: 'Same second group',
              peerUid: 'same-second-group', peerUin: '10000', chatType: 2,
            },
            message: {
              id: `message-${sequence}`, conversationId: 'same-second-group', senderId: 'sender',
              timestamp: 1_800_000_100, outgoing: false, msgSeq: String(sequence),
              parts: [{ type: 'text', text: String(sequence) }],
            },
          },
        }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (server?.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve())
        })
        server.closeAllConnections()
        await closed
      }
    })

    const platform = new QQNTPlatform({
      endpoint: 'http://127.0.0.1:1/v1',
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/qqnt/events`,
    })
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const store = new MessageStore(ctx.database)
    const results: IngestResult[] = []
    const complete = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (event.type !== 'message') return
      results.push(await store.ingest(session, event.conversation, event.message))
      if (results.length === 3) complete.resolve()
    })
    try {
      await Promise.race([
        complete.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('QQNT ordering E2E timed out')), 5_000)),
      ])
    } finally {
      await unsubscribe()
    }

    const bySequence = new Map(results.map((result) => [
      result.projection[0].nativeSequence,
      result.projection[0].tlMessageId,
    ]))
    expect(connectionUrls).toEqual(['/qqnt/events'])
    expect([...bySequence.keys()]).toEqual([100, 102, 101])
    expect([bySequence.get(100), bySequence.get(101), bySequence.get(102)])
      .toEqual([0x40000007, 0x40000009, 0x4000000b])
    expect(await ctx.database.get('mtproto_im_message', {})).toHaveLength(3)
    expect(await ctx.database.get('mtproto_tl_message_part', {})).toHaveLength(3)
  })

  it('closes a stale same-session WebSocket before replacing it and keeps the replacement subscribed', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    let server: Server | undefined
    const webSocketServer = new WebSocketServer({ noServer: true })
    server = createServer()
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    const lifecycle: string[] = []
    const sockets: WebSocket[] = []
    let activeConnections = 0
    let maximumActiveConnections = 0
    webSocketServer.on('connection', (webSocket) => {
      sockets.push(webSocket)
      activeConnections++
      maximumActiveConnections = Math.max(maximumActiveConnections, activeConnections)
      lifecycle.push(`open-${sockets.length}`)
      webSocket.once('close', () => {
        activeConnections--
        lifecycle.push(`close-${sockets.indexOf(webSocket) + 1}`)
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (!server?.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
      server.closeAllConnections()
      await closed
    })

    const exclusiveSession = { ...session, platformSessionId: 'qqnt-exclusive-websocket-e2e' }
    const endpoint = `ws://127.0.0.1:${address.port}/events`
    const first = new QQNTPlatform({ endpoint: 'http://127.0.0.1:1/v1', webSocketEndpoint: endpoint })
    const second = new QQNTPlatform({ endpoint: 'http://127.0.0.1:1/v1', webSocketEndpoint: endpoint })
    for (const platform of [first, second]) {
      platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
      platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    }
    const store = new MessageStore(ctx.database)
    const delivered: string[] = []
    let unsubscribeFirst: Unsubscribe | undefined
    let unsubscribeSecond: Unsubscribe | undefined
    try {
      unsubscribeFirst = await first.subscribe(exclusiveSession, () => {})
      await vi.waitFor(() => expect(lifecycle).toContain('open-1'))
      unsubscribeSecond = await second.subscribe(exclusiveSession, async (event) => {
        if (event.type !== 'message') return
        await store.ingest(exclusiveSession, event.conversation, event.message)
        delivered.push(event.message.id)
      })
      await vi.waitFor(() => expect(lifecycle).toEqual(['open-1', 'close-1', 'open-2']))
      expect(maximumActiveConnections).toBe(1)

      const send = (id: string, streamEventId: string) => sockets[1]!.send(JSON.stringify({
        id: streamEventId,
        event: {
          type: 'message',
          conversation: {
            id: 'exclusive-group', kind: 'group', title: 'Exclusive group',
            peerUid: 'exclusive-group', peerUin: '42', chatType: 2,
          },
          message: {
            id, conversationId: 'exclusive-group', senderId: 'alice', timestamp: 1,
            outgoing: false, parts: [{ type: 'text', text: id }],
          },
        },
      }))
      send('replacement-first', '1')
      await vi.waitFor(() => expect(delivered).toEqual(['replacement-first']))
      await unsubscribeFirst()
      send('replacement-after-old-unsubscribe', '2')
      await vi.waitFor(() => expect(delivered).toEqual([
        'replacement-first', 'replacement-after-old-unsubscribe',
      ]))
      expect(await ctx.database.get('mtproto_im_message', {})).toHaveLength(2)

      await unsubscribeSecond()
      await vi.waitFor(() => expect(activeConnections).toBe(0))
    } finally {
      await unsubscribeSecond?.()
      await unsubscribeFirst?.()
    }
  })
})

describe('QQNT durable event checkpoint E2E', () => {
  it('advances past an unknown reaction target and delivers the following message', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    defineQQNTEventCheckpointModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const webSocketServer = new WebSocketServer({ noServer: true })
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', (webSocket) => {
      const conversation = {
        id: 'reaction-gap-group', kind: 'group', title: 'Reaction gap group',
        peerUid: 'reaction-gap-group', peerUin: '20', chatType: 2,
      } as const
      webSocket.send(JSON.stringify({
        id: '20',
        event: {
          type: 'message-reactions', eventId: 'unknown-reaction', conversation,
          target: { messageId: 'outside-history' }, timestamp: 20,
          context: {
            available: [{ key: 'like', presentation: { type: 'emoji', emoticon: '👍' } }],
            reactions: [{ key: 'like', count: 1 }], maxSelected: 20,
          },
        },
      }))
      webSocket.send(JSON.stringify({
        id: '21',
        event: {
          type: 'message', conversation,
          message: {
            id: 'message-after-reaction-gap', conversationId: conversation.id,
            senderId: 'sender', timestamp: 21, outgoing: false,
            parts: [{ type: 'text', text: 'delivered after ignored reaction' }],
          },
        },
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing reaction gap test address')
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (!server.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      server.closeAllConnections()
      await closed
    })

    const checkpointSession = { ...session, platformSessionId: 'qqnt-reaction-gap-e2e' }
    const platform = new QQNTPlatform({
      endpoint: 'http://127.0.0.1:1/v1',
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/events`,
    }, 'qqnt:stickers', undefined, undefined, ctx.database)
    platform.client.getReactionCatalog = vi.fn(async () => ({
      available: [], reactions: [], maxSelected: 20,
    }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const store = new MessageStore(ctx.database)
    const delivered = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(checkpointSession, async (event) => {
      if (event.type === 'message-reactions') {
        await store.setReactions(checkpointSession, event.conversation, event.target, event.context)
      } else if (event.type === 'message') {
        await store.ingest(checkpointSession, event.conversation, event.message)
        delivered.resolve()
      }
    })
    try {
      await Promise.race([
        delivered.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reaction gap E2E timed out')), 5_000)),
      ])
      await vi.waitFor(async () => expect(await ctx.database.get(
        'mtproto_qqnt_event_checkpoint', { platformSessionId: checkpointSession.platformSessionId },
      )).toMatchObject([{ lastEventId: '21' }]))
      await expect(ctx.database.get('mtproto_im_message', {})).resolves.toMatchObject([{
        primaryPlatformMessageId: 'message-after-reaction-gap',
      }])
    } finally {
      await unsubscribe()
    }
  })

  it('resumes after the last committed event and never skips a failed event', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineQQNTEventCheckpointModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    let server: Server | undefined
    const webSocketServer = new WebSocketServer({ noServer: true })
    server = createServer()
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    const connectionUrls: string[] = []
    webSocketServer.on('connection', (webSocket, request) => {
      connectionUrls.push(request.url ?? '')
      const eventId = connectionUrls.length === 1 ? '7' : connectionUrls.length === 2 ? '8' : undefined
      if (!eventId) return
      webSocket.send(JSON.stringify({
        id: eventId,
        event: {
          type: 'message-delete', eventId: `delete-${eventId}`,
          conversation: {
            id: 'checkpoint-group', kind: 'group', title: 'Checkpoint group',
            peerUid: 'checkpoint-group', peerUin: '7', chatType: 2,
          },
          messageIds: [`message-${eventId}`], timestamp: Number(eventId),
        },
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing checkpoint test server address')
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (!server?.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
      server.closeAllConnections()
      await closed
    })

    const checkpointSession = { ...session, platformSessionId: 'qqnt-event-checkpoint-e2e' }
    const endpoint = `ws://127.0.0.1:${address.port}/events`
    const createPlatform = () => {
      const platform = new QQNTPlatform(
        { endpoint: 'http://127.0.0.1:1/v1', webSocketEndpoint: endpoint },
        'qqnt:stickers', undefined, undefined, ctx.database,
      )
      platform.client.getReactionCatalog = vi.fn(async () => ({
        available: [], reactions: [], maxSelected: 20,
      }))
      platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
      return platform
    }

    let unsubscribeFirst: Unsubscribe | undefined
    let unsubscribeSecond: Unsubscribe | undefined
    try {
      const first = createPlatform()
      unsubscribeFirst = await first.subscribe(checkpointSession, () => {})
      await vi.waitFor(async () => expect(await ctx.database.get(
        'mtproto_qqnt_event_checkpoint', { platformSessionId: checkpointSession.platformSessionId },
      )).toMatchObject([{ lastEventId: '7' }]))
      await unsubscribeFirst()
      unsubscribeFirst = undefined

      const second = createPlatform()
      unsubscribeSecond = await second.subscribe(checkpointSession, () => {
        throw new Error('intentional event handler failure')
      })
      await vi.waitFor(() => expect(connectionUrls).toHaveLength(3), { timeout: 5_000 })

      expect(new URL(connectionUrls[0]!, endpoint).searchParams.get('lastEventId')).toBeNull()
      expect(new URL(connectionUrls[1]!, endpoint).searchParams.get('lastEventId')).toBe('7')
      expect(new URL(connectionUrls[2]!, endpoint).searchParams.get('lastEventId')).toBe('7')
      await expect(ctx.database.get(
        'mtproto_qqnt_event_checkpoint', { platformSessionId: checkpointSession.platformSessionId },
      )).resolves.toMatchObject([{ lastEventId: '7' }])
    } finally {
      await unsubscribeSecond?.()
      await unsubscribeFirst?.()
    }
  })
})

describe('QQNT file-sent video E2E', () => {
  it('projects an extension-only file element as a streamable Telegram video and serves byte ranges', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const file = Buffer.from('abcdefgh')
    const directUrlLocators: Array<Record<string, unknown>> = []
    const ranges: Array<string | undefined> = []
    let server: Server | undefined
    const webSocketServer = new WebSocketServer({ noServer: true })
    server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/files/direct-url') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        directUrlLocators.push(JSON.parse(Buffer.concat(chunks).toString()))
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing test server address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/cdn/FILE-SENT.MP4`,
          expiresAt: Date.now() + 60_000,
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/cdn/FILE-SENT.MP4') {
        ranges.push(request.headers.range)
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
        if (!match) {
          response.writeHead(416).end()
          return
        }
        const start = Number(match[1])
        const end = Math.min(Number(match[2]), file.length - 1)
        const body = file.subarray(start, end + 1)
        response.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${file.length}`,
          'content-length': body.length,
          'content-type': 'video/mp4',
        })
        response.end(body)
        return
      }
      response.writeHead(404).end('not found')
    })
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', (webSocket) => {
      webSocket.send(JSON.stringify({
        id: 'file-video-event',
        event: {
          type: 'message',
          conversation: {
            id: 'file-video-group', kind: 'group', title: 'File video group',
            peerUid: 'file-video-group', peerUin: '10000', chatType: 2,
          },
          message: {
            id: 'file-video-message', conversationId: 'file-video-group', senderId: 'alice',
            timestamp: 1_800_000_150, outgoing: false,
            parts: [{
              type: 'media',
              media: {
                id: 'file-video', kind: 'file', name: 'FILE-SENT.MP4', size: file.length,
                locator: {
                  messageId: 'file-video-message', elementId: 'file-video', chatType: 2,
                  peerUid: 'file-video-group', kind: 'file', fileName: 'FILE-SENT.MP4',
                  fileUuid: 'file-video-uuid', file10MMd5: 'file-video-prefix-md5',
                },
              },
            }],
          },
        },
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (!server?.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
      server.closeAllConnections()
      await closed
    })

    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/events`,
    })
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const store = new MessageStore(ctx.database)
    const ingested = Promise.withResolvers<IngestResult>()
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (event.type !== 'message') return
      ingested.resolve(await store.ingest(session, event.conversation, event.message))
    })
    try {
      const result = await Promise.race([
        ingested.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('file video E2E timed out')), 5_000)),
      ])
      const mediaId = result.projection[0].mediaId!
      const [row] = await ctx.database.get('mtproto_im_media', { id: mediaId })
      expect(row).toMatchObject({
        kind: 'file', name: 'FILE-SENT.MP4', mimeType: 'video/mp4', size: file.length,
      })
      expect(makeTlMessageMedia(row!, 1_800_000_150)).toMatchObject({
        _: 'messageMediaDocument', video: true,
        document: {
          _: 'document', mimeType: 'video/mp4', size: file.length,
          attributes: expect.arrayContaining([
            { _: 'documentAttributeFilename', fileName: 'FILE-SENT.MP4' },
            expect.objectContaining({
              _: 'documentAttributeVideo', supportsStreaming: true, duration: 0, w: 1, h: 1,
            }),
          ]),
        },
      })

      const stored = await store.getMedia(session.platformSessionId, mediaId)
      expect(await collect(platform.downloadMedia(
        session, stored!.media as any, { offset: 2, limit: 4 },
      ))).toEqual(Buffer.from('cdef'))
      expect(directUrlLocators).toMatchObject([{
        fileName: 'FILE-SENT.MP4', fileUuid: 'file-video-uuid', file10MMd5: 'file-video-prefix-md5',
      }])
      expect(ranges).toEqual(['bytes=2-5'])
    } finally {
      await unsubscribe()
    }
  })
})

describe('QQNT remote media routing E2E', () => {
  it('single-flights concurrent private-file ranges and never calls removed local routes', async () => {
    let resolverRequests = 0
    let removedRouteRequests = 0
    let locatorBody: Record<string, unknown> | undefined
    const ranges: string[] = []
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/files/direct-url') {
        resolverRequests++
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        locatorBody = JSON.parse(Buffer.concat(chunks).toString())
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing test server address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/cdn/private-file`,
          expiresAt: Date.now() + 60_000,
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/cdn/private-file') {
        const range = request.headers.range ?? ''
        ranges.push(range)
        const start = range === 'bytes=0-3' ? 0 : 4
        response.writeHead(206, {
          'content-range': `bytes ${start}-${start + 3}/8`, 'content-length': '4',
        })
        response.end(start === 0 ? 'abcd' : 'efgh')
        return
      }
      if (request.url === '/v1/files/download' || request.url === '/v1/files/play-url') {
        removedRouteRequests++
      }
      response.writeHead(404).end('not found')
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
    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'bridge-token',
    })
    const media = {
      id: 'private-file', kind: 'file' as const, name: 'private.bin', size: 8,
      locator: {
        messageId: 'private-file', elementId: 'file-element', chatType: 1 as const,
        peerUid: 'friend-uid', kind: 'file' as const, fileName: 'private.bin',
        fileUuid: 'private-file-uuid', file10MMd5: 'first-10m-md5',
      },
    }
    const [first, second] = await Promise.all([
      collect(platform.downloadMedia(session, media, { offset: 0, limit: 4 })),
      collect(platform.downloadMedia(session, media, { offset: 4, limit: 4 })),
    ])

    expect(resolverRequests).toBe(1)
    expect(removedRouteRequests).toBe(0)
    expect(locatorBody).toMatchObject({
      fileUuid: 'private-file-uuid', file10MMd5: 'first-10m-md5',
    })
    expect(ranges.sort()).toEqual(['bytes=0-3', 'bytes=4-7'])
    expect(first.toString()).toBe('abcd')
    expect(second.toString()).toBe('efgh')
  })

  it('rebases an archived merged-forward file before resolving and streaming it over HTTP', async () => {
    const file = Buffer.from('merged-forward-file')
    const resolverLocators: Array<Record<string, unknown>> = []
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/reactions/catalog') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 20 }))
        return
      }
      if (request.method === 'GET' && request.url === '/v1/dialogs') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ conversations: [{
          id: 'outer-group', kind: 'group', title: 'Outer group',
          peerUid: 'physical-group-uid', peerUin: '10001', chatType: 2,
          lastMessage: {
            id: 'merged-root', conversationId: 'outer-group', senderId: 'alice', timestamp: 10, outgoing: false,
            parts: [{
              type: 'multi-forward', title: '聊天记录',
              locator: { conversationId: 'outer-group', rootMessageId: 'merged-root' },
            }],
          },
        }] }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages/multi-forward') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ messages: [{
          id: 'archived-file-message', conversationId: 'archived-source-group',
          senderId: 'bob', timestamp: 9, outgoing: false,
          parts: [{
            type: 'media',
            media: {
              id: 'file-element', kind: 'file', name: 'guide.xlsx', size: file.length,
              locator: {
                messageId: 'archived-file-message', elementId: 'file-element', chatType: 2,
                peerUid: 'archived-source-group', kind: 'file', fileName: 'guide.xlsx',
                fileUuid: '/file-uuid', fileBizId: 104,
              },
            },
          }],
        }] }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/files/direct-url') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const locator = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        resolverLocators.push(locator)
        if (locator.peerUid !== 'physical-group-uid' || locator.chatType !== 2) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'direct URL is unavailable for archived peer' }))
          return
        }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing test server address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/cdn/merged-file`, expiresAt: Date.now() + 60_000,
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/cdn/merged-file') {
        response.writeHead(200, { 'content-length': String(file.length) })
        response.end(file)
        return
      }
      response.writeHead(404).end('not found')
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

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const [dialog] = (await platform.getDialogs(session)).dialogs
    const link = dialog.lastMessage?.content.parts[0]
    if (link?.type !== 'text' || link.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('merged forward link was not mapped')
    }
    const history = await platform.getHistory(session, link.entities[0].conversation)
    const part = history.messages[0].content.parts[0]
    if (part.type !== 'media') throw new Error('merged forward file was not mapped')

    expect(await collect(platform.downloadMedia(session, part.media))).toEqual(file)
    expect(resolverLocators).toEqual([expect.objectContaining({
      chatType: 2, peerUid: 'physical-group-uid', fileUuid: '/file-uuid',
    })])
  })

  it('loads opaque reaction assets over HTTP and serves the transformed cache without local file routes', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-reaction-http-e2e-'))
    temporaryDirectories.push(cachePath)
    const png = await sharp({
      create: { width: 24, height: 18, channels: 4, background: { r: 220, g: 100, b: 40, alpha: 1 } },
    }).png().toBuffer()
    let assetBody: Record<string, unknown> | undefined
    let removedRouteRequests = 0
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/reactions/catalog') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          available: [{
            key: '1:265', title: '辣眼睛',
            presentation: {
              type: 'custom', alt: '[辣眼睛]',
              resource: {
                version: 1, format: 'static', mimeType: 'image/png',
                width: 24, height: 18, size: png.length,
                locator: { reactionKey: '1:265' },
              },
            },
          }],
          reactions: [], maxSelected: 20,
        }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/reactions/asset') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        assetBody = JSON.parse(Buffer.concat(chunks).toString())
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
        response.end(png)
        return
      }
      if (request.url === '/v1/files/download') removedRouteRequests++
      response.writeHead(404).end('not found')
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

    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'bridge-token',
    }, 'qqnt:stickers', new QQMediaCache({ path: cachePath }))
    const catalog = await platform.getAvailableReactions(session, { conversationId: '2:group' })
    const definition = catalog.available[0]!
    if (definition.presentation.type !== 'custom') throw new Error('expected custom reaction')
    const resource = definition.presentation.resource
    const bytes = await collect(platform.downloadReactionResource(session, resource, { offset: 3, limit: 7 }))

    expect(resource).toMatchObject({
      format: 'static', mimeType: 'image/webp', width: 100, height: 100,
      locator: { cacheKey: expect.any(String) },
    })
    expect(bytes).toHaveLength(7)
    expect(assetBody).toEqual({ reactionKey: '1:265' })
    expect(removedRouteRequests).toBe(0)
  })
})

describe('QQNT history media without placeholder edits E2E', () => {
  it('persists a downloadable original immediately and reuses a warmed HTTP preview on refresh', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    defineQQMediaCacheModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const jpeg = await sharp({
      create: { width: 40, height: 24, channels: 3, background: { r: 20, g: 80, b: 180 } },
    }).jpeg().toBuffer()
    const releaseImage = Promise.withResolvers<void>()
    const imageRequested = Promise.withResolvers<void>()
    let directUrlRequests = 0
    let imageRequests = 0
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/files/direct-url') {
        directUrlRequests++
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing test server address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/cdn/history.jpg`,
          expiresAt: Date.now() + 60_000,
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/cdn/history.jpg') {
        imageRequests++
        imageRequested.resolve()
        await releaseImage.promise
        response.setHeader('content-type', 'image/jpeg')
        response.setHeader('content-length', String(jpeg.length))
        response.end(jpeg)
        return
      }
      response.writeHead(404).end('not found')
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

    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-history-media-e2e-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
    }, 'qqnt:stickers', new QQMediaCache({
      path: cachePath, database: ctx.database, previewMaxDimension: 10,
    }))
    const conversation = { id: '2:history', kind: 'group' as const, title: 'History' }
    const wireMessage = {
      id: 'history-image', conversationId: conversation.id, senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: {
          id: 'history-media', kind: 'image' as const, name: 'history.jpg', mimeType: 'image/jpeg',
          size: jpeg.length, width: 40, height: 24,
          locator: {
            messageId: 'history-image', elementId: 'history-media', chatType: 2 as const,
            peerUid: 'history', kind: 'image' as const, fileName: 'history.jpg',
            fileUuid: 'history-file-uuid', md5: 'HISTORY-E2E',
          },
        },
      }],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const store = new MessageStore(ctx.database)
    const edits: unknown[] = []
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (event.type === 'message-edit') edits.push(event)
    })

    const history = await platform.getHistory(session, conversation)
    const initial = await store.ingest(session, conversation, history.messages[0], { allocation: 'history' })
    const mediaId = initial.projection[0].mediaId!
    const original = await store.getMedia(session.platformSessionId, mediaId)
    expect(original?.media).toMatchObject({
      kind: 'image', size: jpeg.length, width: 40, height: 24,
      locator: expect.not.objectContaining({ deferred: expect.anything() }),
    })

    await imageRequested.promise
    expect(directUrlRequests).toBe(1)
    expect(imageRequests).toBe(1)
    releaseImage.resolve()
    await vi.waitFor(async () => expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(1))
    const refreshedHistory = await platform.getHistory(session, conversation)
    const refreshed = await store.ingest(
      session, conversation, refreshedHistory.messages[0], { allocation: 'history' },
    )
    expect(refreshed.projection[0]).toMatchObject({
      tlMessageId: initial.projection[0].tlMessageId,
      mediaId,
    })
    const ready = await store.getMedia(session.platformSessionId, mediaId)
    expect(ready?.media).toMatchObject({
      kind: 'image', size: jpeg.length, width: 40, height: 24,
      locator: expect.not.objectContaining({ deferred: expect.anything() }),
      preview: { mimeType: 'image/webp', width: 10, height: 6 },
    })
    expect(await collect(platform.downloadMedia(session, ready!.media as any))).toEqual(jpeg)
    expect(await ctx.database.get('mtproto_im_media', {})).toHaveLength(1)
    expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(1)
    expect(edits).toEqual([])
    await unsubscribe()
  })

  it('persists a valid sticker document only after HTTP preparation, without editing the message', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    defineQQMediaCacheModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const png = await sharp({
      create: { width: 24, height: 18, channels: 4, background: { r: 40, g: 120, b: 210, alpha: 1 } },
    }).png().toBuffer()
    const releaseSticker = Promise.withResolvers<void>()
    const stickerRequested = Promise.withResolvers<void>()
    let assetRequests = 0
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/stickers/asset') {
        assetRequests++
        stickerRequested.resolve()
        await releaseSticker.promise
        response.setHeader('content-type', 'image/png')
        response.setHeader('content-length', String(png.length))
        response.end(png)
        return
      }
      response.writeHead(404).end('not found')
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

    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-history-sticker-e2e-'))
    temporaryDirectories.push(cachePath)
    const cache = new QQMediaCache({ path: cachePath, database: ctx.database, previewMaxDimension: 10 })
    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
    }, 'qqnt:stickers', cache)
    const provider = new QQStickerProvider(platform.client, 'qqnt:stickers', cache)
    const conversation = { id: '2:sticker-history', kind: 'group' as const, title: 'Sticker history' }
    const wireMessage = {
      id: 'history-sticker', conversationId: conversation.id, senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'sticker' as const,
        sticker: {
          stickerId: 'favorite:history-http', title: 'HTTP sticker',
          format: 'static' as const, mimeType: 'image/png', width: 24, height: 18, size: png.length,
          reference: {
            kind: 'favorite' as const, resId: 'history-http', path: '/saved/history.png',
            name: 'history.png', animated: false as const,
          },
        },
      }],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const store = new MessageStore(ctx.database)
    const edits: unknown[] = []
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (event.type === 'message-edit') edits.push(event)
    })

    const historyPromise = platform.getHistory(session, conversation)
    await stickerRequested.promise
    expect(assetRequests).toBe(1)
    releaseSticker.resolve()
    const history = await historyPromise
    const readyPart = history.messages[0].content.parts[0]
    if (readyPart.type !== 'sticker') throw new Error('prepared history sticker is unavailable')
    const initial = await store.ingest(session, conversation, history.messages[0], { allocation: 'history' })
    const [stored] = await store.readHistory(session.platformSessionId, conversation.id, { limit: 1 })
    const storedPart = stored?.content.parts[0]
    if (storedPart?.type !== 'sticker') throw new Error('stored history sticker is unavailable')
    expect(storedPart.sticker).toMatchObject({
      format: 'static', mimeType: 'image/webp', size: expect.any(Number),
      locator: expect.not.objectContaining({ deferred: expect.anything() }),
      thumbnail: { mimeType: 'image/webp', width: 10, height: 8 },
    })
    const readyBytes = await collect((await provider.openAsset(
      { session, platformKind: 'qq' }, storedPart.sticker,
    )).source.stream())
    expect(readyBytes.subarray(8, 12).toString()).toBe('WEBP')
    expect(assetRequests).toBe(1)
    expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(1)
    expect(initial.projection[0].tlMessageId).toBeGreaterThan(0)
    expect(edits).toEqual([])
    await unsubscribe()
  })
})

describe('QQNT animated media initial projection E2E', () => {
  it('streams APNG detection over HTTP and publishes one downloadable WebM message', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    defineQQMediaCacheModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    const rangeHeaders: Array<string | undefined> = []
    let nativeUrl = ''
    let server: Server | undefined
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/files/direct-url') {
        request.resume()
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ url: nativeUrl }))
        return
      }
      if (request.method === 'GET' && request.url === '/native.apng') {
        rangeHeaders.push(request.headers.range)
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
        const start = match ? Number(match[1]) : 0
        const requestedEnd = match?.[2] ? Number(match[2]) : apng.length - 1
        const end = Math.min(apng.length - 1, requestedEnd)
        const bytes = apng.subarray(start, end + 1)
        response.statusCode = match ? 206 : 200
        response.setHeader('accept-ranges', 'bytes')
        response.setHeader('content-length', bytes.length)
        if (match) response.setHeader('content-range', `bytes ${start}-${end}/${apng.length}`)
        response.end(bytes)
        return
      }
      response.statusCode = 404
      response.end('not found')
    })
    const webSocketServer = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', (webSocket) => {
      webSocket.send(JSON.stringify({
        id: 'animated-event',
        event: {
          type: 'message',
          conversation: {
            id: 'animated-group', kind: 'group', title: 'Animated group',
            peerUid: 'animated-group', peerUin: '10000', chatType: 2,
          },
          message: {
            id: 'animated-message', conversationId: 'animated-group', senderId: 'sender',
            timestamp: 1_800_000_200, outgoing: false,
            parts: [{
              type: 'media',
              media: {
                id: 'animated-media', kind: 'image', name: 'animation.png', mimeType: 'image/png',
                size: apng.length, width: 12, height: 8,
                locator: {
                  messageId: 'animated-message', elementId: 'animated-media', chatType: 2,
                  peerUid: 'animated-group', kind: 'image', fileName: 'animation.png', md5: 'APNG-E2E',
                  originImageUrl: 'https://multimedia.nt.qq.com.cn/download?fileid=animated',
                },
              },
            }],
          },
        },
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    nativeUrl = `http://127.0.0.1:${address.port}/native.apng`
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (server?.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve())
        })
        server.closeAllConnections()
        await closed
      }
    })

    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-media-upgrade-e2e-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/events`,
    }, 'qqnt:stickers', new QQMediaCache({ path: cachePath, database: ctx.database }))
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const store = new MessageStore(ctx.database)
    const ingested: Array<{ type: 'message' | 'message-edit', result: IngestResult }> = []
    const complete = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (event.type !== 'message' && event.type !== 'message-edit') return
      const result = await store.ingest(session, event.conversation, event.message)
      ingested.push({ type: event.type, result })
      if (event.type === 'message') complete.resolve()
    })
    try {
      await Promise.race([
        complete.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('QQNT media E2E timed out')), 10_000)),
      ])
    } finally {
      await unsubscribe()
    }

    expect(ingested.map((entry) => entry.type)).toEqual(['message'])
    const webmMediaId = ingested[0].result.projection[0].mediaId!
    expect(await ctx.database.get('mtproto_im_media', {})).toMatchObject([
      { id: webmMediaId, platformMediaId: 'animated-media:original-v1:webm-v1', mimeType: 'video/webm' },
    ])
    expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(1)
    expect(await ctx.database.get('mtproto_qqnt_media_animation', {})).toMatchObject([{ animated: true }])

    const webm = await store.getMedia(session.platformSessionId, webmMediaId)
    expect(webm).toBeDefined()
    const webmBytes = await collect(platform.downloadMedia(session, webm!.media as any))
    expect([...webmBytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(rangeHeaders).toEqual(['bytes=0-65535', undefined])
  }, 30_000)
})

describe('QQNT animated system-face E2E', () => {
  it('materializes a large QQ face as a WebM sticker before publishing the message', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    defineQQMediaCacheModel(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    let assetRequests = 0
    let assetReference: unknown
    let server: Server | undefined
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/stickers/asset') {
        assetRequests++
        const chunks: Buffer[] = []
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
          assetReference = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          response.setHeader('content-type', 'image/apng')
          response.setHeader('content-length', apng.length)
          response.end(apng)
        })
        return
      }
      response.statusCode = 404
      response.end('not found')
    })
    const webSocketServer = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', (webSocket) => {
      webSocket.send(JSON.stringify({
        id: 'animated-sticker-event',
        event: {
          type: 'message',
          conversation: {
            id: 'sticker-group', kind: 'group', title: 'Sticker group',
            peerUid: 'sticker-group', peerUin: '10000', chatType: 2,
          },
          message: {
            id: 'animated-sticker-message', conversationId: 'sticker-group', senderId: 'sender',
            timestamp: 1_800_000_300, outgoing: false,
            parts: [{
              type: 'sticker',
              sticker: {
                stickerId: 'sysface:476', title: '/不是吧',
                format: 'animated', mimeType: 'image/apng', width: 12, height: 8, size: apng.length,
                version: 1,
                reference: {
                  kind: 'sysface', faceId: '476', faceType: 3, name: '/不是吧',
                  packId: '3', stickerId: '476', stickerType: 2, resultId: 'result-476',
                  width: 12, height: 8, animated: true,
                },
              },
            }],
          },
        },
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      if (server?.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve())
        })
        server.closeAllConnections()
        await closed
      }
    })

    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-sticker-thumbnail-e2e-'))
    temporaryDirectories.push(cachePath)
    const cache = new QQMediaCache({ path: cachePath, database: ctx.database, previewMaxDimension: 64 })
    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/events`,
    }, 'qqnt:stickers', cache)
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const store = new MessageStore(ctx.database)
    const events: Array<{ type: 'message' | 'message-edit', result: IngestResult }> = []
    const complete = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (event.type !== 'message' && event.type !== 'message-edit') return
      events.push({ type: event.type, result: await store.ingest(session, event.conversation, event.message) })
      if (event.type === 'message') complete.resolve()
    })
    try {
      await Promise.race([
        complete.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('QQNT sticker E2E timed out')), 10_000)),
      ])
    } finally {
      await unsubscribe()
    }

    expect(events.map((entry) => entry.type)).toEqual(['message'])
    expect(events[0].result.changed).toBe(true)
    const storedSticker = events[0].result.message.content as any
    expect(storedSticker.parts).toHaveLength(1)
    expect(storedSticker.parts[0]).toMatchObject({
      type: 'sticker', sticker: {
        stickerId: 'sysface:476', title: '/不是吧',
        format: 'video', mimeType: 'video/webm', size: expect.any(Number),
        locator: { kind: 'sysface', faceId: '476', faceType: 3, resultId: 'result-476' },
        thumbnail: {
          mimeType: 'image/webp', width: 12, height: 8,
          locator: { cacheKey: expect.any(String) },
        },
      },
    })
    expect(storedSticker.parts[0].sticker.size).toBeGreaterThan(0)
    const provider = {
      listPacks: vi.fn(async () => ({ packs: [] })),
      getPack: vi.fn(async () => null),
      getSticker: vi.fn(async () => storedSticker.parts[0].sticker),
      openAsset: vi.fn(async () => { throw new Error('not needed for document projection') }),
    }
    const stickerRpc = new StickerRpc(ctx.database, {
      entries: [['qqnt:stickers', provider]],
      get: (id: string) => id === 'qqnt:stickers' ? provider : undefined,
      require: (id: string) => {
        if (id === 'qqnt:stickers') return provider
        throw new Error(`unknown provider: ${id}`)
      },
    } as any, platform, session)
    const media = stickerRpc.makeMessageMedia(storedSticker.parts[0].sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('missing Telegram sticker document')
    expect(media.document.size).toBe(storedSticker.parts[0].sticker.size)
    expect(media.document.size).toBeGreaterThan(0)
    expect(media.document.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'documentAttributeVideo', nosound: true }),
    ]))
    expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(1)
    expect(assetRequests).toBe(1)
    expect(assetReference).toMatchObject({
      kind: 'sysface', faceId: '476', faceType: 3, resultId: 'result-476',
    })
    const thumbnail = await cache.openStickerThumbnail(storedSticker.parts[0].sticker)
    if (!thumbnail) throw new Error('stored sticker thumbnail is unavailable')
    expect((await collect(thumbnail.source.stream())).subarray(8, 12).toString()).toBe('WEBP')
  }, 30_000)
})

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
