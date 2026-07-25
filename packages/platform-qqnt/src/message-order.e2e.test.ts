import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import sharp from 'sharp'
import { MessageStore, type IngestResult, type PlatformSession } from '@mtproto-relay/bridge'
import { defineModels } from '../../bridge/src/models.js'
import { QQNTPlatform } from './index.js'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-order-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const disposals: Array<() => Promise<void>> = []
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

describe('QQNT animated media upgrade E2E', () => {
  it('streams APNG detection over HTTP, edits to WebM, and preserves both downloadable media IDs', async () => {
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
      if (event.type === 'message-edit') complete.resolve()
    })
    try {
      await Promise.race([
        complete.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('QQNT media E2E timed out')), 10_000)),
      ])
    } finally {
      await unsubscribe()
    }

    expect(ingested.map((entry) => entry.type)).toEqual(['message', 'message-edit'])
    const originalMediaId = ingested[0].result.projection[0].mediaId!
    const webmMediaId = ingested[1].result.projection[0].mediaId!
    expect(webmMediaId).not.toBe(originalMediaId)
    expect(ingested[1].result.projection[0].tlMessageId)
      .toBe(ingested[0].result.projection[0].tlMessageId)
    expect(await ctx.database.get('mtproto_im_media', {})).toMatchObject([
      { id: originalMediaId, platformMediaId: 'animated-media:original-v1', mimeType: 'image/png' },
      { id: webmMediaId, platformMediaId: 'animated-media:original-v1:webm-v1', mimeType: 'video/webm' },
    ])
    expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(2)
    expect(await ctx.database.get('mtproto_qqnt_media_animation', {})).toMatchObject([{ animated: true }])

    const original = await store.getMedia(session.platformSessionId, originalMediaId)
    const webm = await store.getMedia(session.platformSessionId, webmMediaId)
    expect(original).toBeDefined()
    expect(webm).toBeDefined()
    expect(await collect(platform.downloadMedia(session, original!.media as any))).toEqual(apng)
    const webmBytes = await collect(platform.downloadMedia(session, webm!.media as any))
    expect([...webmBytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(rangeHeaders).toEqual([undefined, 'bytes=0-65535', undefined, undefined])
  }, 30_000)
})

describe('QQNT animated sticker thumbnail E2E', () => {
  it('stores the APNG first frame and edits the existing message to advertise it', async () => {
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
    let server: Server | undefined
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/stickers/asset') {
        assetRequests++
        request.resume()
        response.setHeader('content-type', 'image/apng')
        response.setHeader('content-length', apng.length)
        response.end(apng)
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
                stickerId: 'favorite:animated-apng', title: 'Animated APNG',
                format: 'animated', mimeType: 'image/apng', width: 12, height: 8, size: apng.length,
                version: 1,
                reference: {
                  kind: 'favorite', resId: 'animated-apng', path: '/qq/animated.png',
                  name: 'animated.png', size: apng.length, width: 12, height: 8, animated: true,
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
      if (event.type === 'message-edit') complete.resolve()
    })
    try {
      await Promise.race([
        complete.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('QQNT sticker E2E timed out')), 10_000)),
      ])
    } finally {
      await unsubscribe()
    }

    expect(events.map((entry) => entry.type)).toEqual(['message', 'message-edit'])
    expect(events[0].result.projection[0].tlMessageId).toBe(events[1].result.projection[0].tlMessageId)
    expect(events[0].result.changed).toBe(true)
    expect(events[1].result.changed).toBe(true)
    const initialSticker = events[0].result.message.content as any
    const editedSticker = events[1].result.message.content as any
    expect(initialSticker.parts[0].sticker.thumbnail).toBeUndefined()
    expect(editedSticker.parts[0].sticker).toMatchObject({
      format: 'video', mimeType: 'video/webm',
      thumbnail: {
        mimeType: 'image/webp', width: 12, height: 8,
        locator: { cacheKey: expect.any(String) },
      },
    })
    expect(await ctx.database.get('mtproto_qqnt_media_preview', {})).toHaveLength(1)
    expect(assetRequests).toBe(1)
    const thumbnail = await cache.openStickerThumbnail(editedSticker.parts[0].sticker)
    if (!thumbnail) throw new Error('stored sticker thumbnail is unavailable')
    expect((await collect(thumbnail.source.stream())).subarray(8, 12).toString()).toBe('WEBP')
  }, 30_000)
})

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
