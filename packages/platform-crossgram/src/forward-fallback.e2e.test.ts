import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { QQNTPlatform } from './index.js'
import type { PlatformSession } from '@mtproto-relay/bridge'

const session: PlatformSession = {
  platformSessionId: 'forward-fallback-e2e',
  platformId: 'qqnt',
  userId: 'self',
  credentials: {},
  metadata: {},
}

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  server = undefined
})

describe('QQNT forward fallback HTTP E2E', () => {
  it('turns a native forward rejection into a copied send using the authorized relay source', async () => {
    const requests: Array<{ path: string, text?: string }> = []
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/messages/forward') {
        requests.push({ path: request.url })
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'forwardMsg: forward failed (2004004)' }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages') {
        const encoded = request.headers['x-qqnt-manifest']
        const manifest = JSON.parse(Buffer.from(String(encoded), 'base64url').toString()) as { text?: string }
        requests.push({ path: request.url, text: manifest.text })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'copied-message', conversationId: 'to', senderId: 'self',
          timestamp: 2, outgoing: true, parts: [{ type: 'text', text: manifest.text }],
        }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })

    const result = await platform.forwardMessages(
      session,
      { id: 'from' },
      ['native-source'],
      { id: 'to' },
      {
        sourceMessages: [{
          id: 'stored-source', conversationId: 'from', senderId: 'alice', timestamp: 1,
          content: { parts: [{ type: 'text', text: 'copied through fallback' }] },
        }],
      },
    )

    expect(requests).toEqual([
      { path: '/v1/messages/forward' },
      { path: '/v1/messages', text: 'copied through fallback' },
    ])
    expect(result).toMatchObject([{
      id: 'copied-message', conversationId: 'to',
      content: { parts: [{ type: 'text', text: 'copied through fallback' }] },
    }])
  })
})
