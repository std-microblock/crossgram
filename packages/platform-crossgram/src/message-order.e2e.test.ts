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

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
