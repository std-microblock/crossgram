import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { MessageStore, type IngestResult, type PlatformSession } from '@mtproto-relay/bridge'
import { defineModels } from '../../bridge/src/models.js'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-order-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe('QQNT same-second message ordering E2E', () => {
  it('persists 100, 102, 101 WebSocket events without reconnecting or exhausting the scope', async () => {
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
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
      if (server?.listening) await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}` })
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
    expect(connectionUrls).toEqual(['/events/ws'])
    expect([...bySequence.keys()]).toEqual([100, 102, 101])
    expect([bySequence.get(100), bySequence.get(101), bySequence.get(102)])
      .toEqual([0x40000007, 0x40000009, 0x4000000b])
    expect(await ctx.database.get('mtproto_im_message', {})).toHaveLength(3)
    expect(await ctx.database.get('mtproto_tl_message_part', {})).toHaveLength(3)
  })
})
