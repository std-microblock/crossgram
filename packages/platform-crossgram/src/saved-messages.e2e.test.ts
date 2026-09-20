import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { DialogRpc } from '../../bridge/src/dialogs.js'
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

  it.each([19, 99])('loads every desktop dialog when Saved Messages is at index %i', async (savedIndex) => {
    const physicalId = 'device:134:desktop'
    const conversations = Array.from({ length: 143 }, (_, index) => {
      const id = index === savedIndex ? physicalId : 'group-' + index
      return {
        id, kind: index === savedIndex ? 'direct' : 'group', title: id,
        peerUid: id, peerUin: '', chatType: index === savedIndex ? 134 : 2,
        lastMessage: {
          id: 'message-' + index, conversationId: id, senderId: 'self',
          timestamp: 1_700_000_000 - index, outgoing: true,
          parts: [{ type: 'text', text: 'preview-' + index }],
        },
      }
    })
    const offsets: Array<string | null> = []
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      response.setHeader('content-type', 'application/json')
      if (url.pathname === '/v1/reactions/catalog') {
        response.end(JSON.stringify({ available: [], reactions: [], maxSelected: 0 }))
      } else if (url.pathname === '/v1/dialogs') {
        const afterId = url.searchParams.get('afterId')
        offsets.push(afterId)
        const start = afterId ? conversations.findIndex(item => item.id === afterId) + 1 : 0
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const page = conversations.slice(start, start + limit)
        response.end(JSON.stringify({
          conversations: page, total: conversations.length,
          nextCursor: start + page.length < conversations.length ? String(start + page.length) : undefined,
        }))
      } else if (url.pathname.endsWith('/history')) {
        response.end(JSON.stringify({ messages: [] }))
      } else if (url.pathname.startsWith('/v1/users/')) {
        response.end(JSON.stringify({ id: 'self', name: 'Self' }))
      } else if (url.pathname === '/v1/contacts') {
        response.end(JSON.stringify({ users: [] }))
      } else {
        response.writeHead(404).end(JSON.stringify({ error: 'unexpected ' + url.pathname }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    const platform = new QQNTPlatform({ endpoint: 'http://127.0.0.1:' + address.port + '/v1' })
    const rpc = new DialogRpc(platform, session)
    let request: tl.messages.RawGetDialogsRequest = {
      _: 'messages.getDialogs', excludePinned: true, folderId: 0,
      offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, limit: 20, hash: Long.ZERO,
    }
    const seen: number[] = []
    let completed = false
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const response = await rpc.getDialogs(request)
      const page = new TlBinaryReader(__tlReaderMap,
        TlBinaryWriter.serializeObject(__tlWriterMap, response)).object() as tl.messages.RawDialogs | tl.messages.RawDialogsSlice
      const dialogs = page.dialogs.filter((dialog): dialog is tl.RawDialog => dialog._ === 'dialog')
      seen.push(...dialogs.map(dialog => dialog.peer._ === 'peerUser' ? dialog.peer.userId :
        dialog.peer._ === 'peerChannel' ? dialog.peer.channelId : dialog.peer.chatId))
      if (pageNumber === 0) expect(page).toMatchObject({ _: 'messages.dialogsSlice', count: conversations.length })
      if (page._ === 'messages.dialogs') { completed = true; break }
      const last = dialogs.at(-1)
      const top = last && page.messages.find(message => message.id === last.topMessage
        && 'peerId' in message && JSON.stringify(message.peerId) === JSON.stringify(last.peer))
      expect(top, 'Desktop stops loading a slice without a dated top message').toBeDefined()
      if (!last || !top || !('date' in top) || !top.date) break
      request = {
        ...request, limit: 500, offsetId: last.topMessage, offsetDate: top.date,
        offsetPeer: last.peer._ === 'peerUser'
          ? { _: 'inputPeerUser', userId: last.peer.userId, accessHash: Long.ZERO }
          : { _: 'inputPeerChannel', channelId: (last.peer as tl.RawPeerChannel).channelId, accessHash: Long.ONE },
      }
    }
    expect(completed).toBe(true)
    expect(seen).toHaveLength(conversations.length)
    expect(new Set(seen).size).toBe(conversations.length)
    expect(offsets).not.toContain(session.userId)
    expect(offsets).toContain(physicalId)
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
