import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { PlatformSession, Unsubscribe } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-ready-retry-e2e',
  platformId: 'qqnt',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const disposals: Unsubscribe[] = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe('QQNT readiness retry E2E', () => {
  it('polls readiness with backoff instead of repeatedly upgrading the WebSocket', async () => {
    let kernelReady = false
    let statusRequests = 0
    let rejectedUpgrades = 0
    let acceptedUpgrades = 0
    const connected = Promise.withResolvers<void>()
    const webSocketServer = new WebSocketServer({ noServer: true })
    const server = createServer((request, response) => {
      if (request.url !== '/v1/status') {
        response.writeHead(404).end()
        return
      }
      statusRequests++
      kernelReady = statusRequests >= 2
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ protocolVersion: 22, ready: kernelReady, selfUin: '10000' }))
    })
    server.on('upgrade', (request, socket, head) => {
      if (!kernelReady) {
        rejectedUpgrades++
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      acceptedUpgrades++
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', () => connected.resolve())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
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

    const platform = new QQNTPlatform({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/v1/events/ws`,
    })
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const unsubscribe = await platform.subscribe(session, () => {})
    disposals.push(unsubscribe)

    await Promise.race([
      connected.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('readiness retry E2E timed out')), 5_000)),
    ])

    expect(statusRequests).toBe(2)
    expect(rejectedUpgrades).toBe(1)
    expect(acceptedUpgrades).toBe(1)
  })
})
