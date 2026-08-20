import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qq-saved-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

describe('QQ Saved Messages E2E', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server?.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    server = undefined
  })

  it('maps the real QQNT HTTP device conversation onto the account self peer', async () => {
    const physicalId = 'device:134:desktop'
    const calls: Array<{ method: string, url: string }> = []
    server = createServer(async (request, response) => {
      const url = request.url ?? ''
      calls.push({ method: request.method ?? '', url })
      response.setHeader('content-type', 'application/json')
      if (url === '/v1/reactions/catalog') {
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 0 }))
        return
      }
      if (url === '/v1/dialogs') {
        response.end(JSON.stringify({ conversations: [{
          id: physicalId, kind: 'direct', title: '我的电脑', peerUid: 'desktop', peerUin: '', chatType: 134,
          lastMessage: {
            id: 'saved-1', conversationId: physicalId, senderId: 'self', timestamp: 1, outgoing: true,
            parts: [{ type: 'text', text: 'first saved item' }],
          },
        }] }))
        return
      }
      if (url === `/v1/conversations/${encodeURIComponent(physicalId)}/history`) {
        response.end(JSON.stringify({ messages: [{
          id: 'saved-1', conversationId: physicalId, senderId: 'self', timestamp: 1, outgoing: true,
          parts: [{ type: 'text', text: 'first saved item' }],
        }] }))
        return
      }
      if (url === '/v1/messages' && request.method === 'POST') {
        const manifest = JSON.parse(Buffer.from(
          String(request.headers['x-qqnt-manifest']), 'base64url',
        ).toString('utf8')) as { conversationId: string, text?: string }
        expect(manifest).toMatchObject({ conversationId: physicalId, text: 'new saved item' })
        for await (const _chunk of request) { /* drain body */ }
        response.end(JSON.stringify({
          id: 'saved-2', conversationId: physicalId, senderId: 'self', timestamp: 2, outgoing: true,
          parts: [{ type: 'text', text: 'new saved item' }],
        }))
        return
      }
      response.writeHead(404).end(JSON.stringify({ error: `unexpected ${request.method} ${url}` }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })

    await expect(platform.getDialogs(session)).resolves.toMatchObject({
      dialogs: [{
        conversation: { id: 'self', title: '我的电脑', metadata: { qqConversationId: physicalId } },
        lastMessage: { id: 'saved-1', conversationId: 'self' },
      }],
    })
    await expect(platform.getHistory(session, { id: 'self' })).resolves.toMatchObject({
      messages: [{ id: 'saved-1', conversationId: 'self' }],
    })
    await expect(platform.sendMessage(session, { id: 'self' }, {
      parts: [{ type: 'text', text: 'new saved item' }],
    })).resolves.toMatchObject({ id: 'saved-2', conversationId: 'self' })
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'GET', url: '/v1/dialogs' },
      { method: 'GET', url: `/v1/conversations/${encodeURIComponent(physicalId)}/history` },
      { method: 'POST', url: '/v1/messages' },
    ]))
  })
})
