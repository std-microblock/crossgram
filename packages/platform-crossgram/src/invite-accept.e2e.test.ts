import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { defineModels } from '../../bridge/src/models.js'
import type { IMEvent, PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-invite-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe('QQNT group-invite accept E2E', () => {
  it('projects an accept button and refreshes it away once the invite is accepted', async () => {
    const accepted: Array<{ groupCode: string, msgSeq: string }> = []
    const server: Server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        if (request.url === '/v1/group-invites/accept') {
          accepted.push(JSON.parse(body))
          response.end('{}')
          return
        }
        if (request.url === '/v1/messages/get') {
          response.end(JSON.stringify({
            id: 'qq-invite', conversationId: 'invite-room', senderId: 'friend',
            timestamp: 1_800_000_000, outgoing: false,
            parts: [{ type: 'card', card: {
              kind: 'application', title: '邀请你加入群聊', source: '邀请加群',
              description: '邀请你加入群聊“测试群聊”，进入可查看详情。\n群号 123456789',
              groupInvite: { groupCode: '123456789', msgSeq: '1791449541900000' },
            } }],
          }))
          return
        }
        if (request.url?.startsWith('/v1/conversations/invite-room/history')) {
          response.end(JSON.stringify({ messages: [{
            id: 'qq-invite', conversationId: 'invite-room', senderId: 'friend',
            timestamp: 1_800_000_000, outgoing: false,
            parts: [{ type: 'card', card: {
              kind: 'application', title: '邀请你加入群聊', source: '邀请加群',
              description: '邀请你加入群聊“测试群聊”，进入可查看详情。\n群号 123456789',
              groupInvite: { groupCode: '123456789', msgSeq: '1791449541900000' },
            } }],
          }] }))
          return
        }
        if (request.url?.startsWith('/v1/dialogs')) {
          response.end(JSON.stringify({ conversations: [{
            id: 'invite-room', kind: 'direct', title: 'Invite room',
            peerUid: 'invite-room', peerUin: '10001', chatType: 1, unreadCount: 0,
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
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      if (!server.listening) return
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
    const conversation = { id: 'invite-room', kind: 'direct' as const, title: 'Invite room' }
    const history = await platform.getHistory(session, conversation)
    const store = new MessageStore(ctx.database)
    const ingested = await store.ingest(session, conversation, history.messages[0], { allocation: 'history' })
    await store.upsertUser(session, { id: 'invite-room', firstName: 'Invite room' })

    const edits: IMEvent[] = []
    const rpc = new DialogRpc(platform, session, store, {
        dcId: 1,
        onLocalEvent: async (_session, event) => { edits.push(event) },
      })

    // getMessages hydrates the store's conversations and users first so the
    // direct peer id below resolves as a user id, not a channel one.
    const projected = await rpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: ingested.projection[0].tlMessageId }],
    }) as tl.messages.RawMessages
    const peer = { _: 'inputPeerUser' as const, userId: rpc.peerTlId('invite-room'), accessHash: Long.ZERO }
    await rpc.getHistory({
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0,
      limit: 10, maxId: 0, minId: 0, hash: Long.ZERO,
    })
    const message = projected.messages[0] as tl.RawMessage
    expect(message.replyMarkup).toMatchObject({
      _: 'replyInlineMarkup', rows: [{ buttons: [{
        _: 'keyboardInlineButton', text: '同意加群',
        style: { _: 'keyboardButtonStyle', bgSuccess: true },
        type: { _: 'inlineButtonTypeCallback', data: Buffer.from('group-invite:123456789:1791449541900000') },
      }] }],
    })

    const answer = await rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', peer, msgId: message.id,
      data: Buffer.from('group-invite:123456789:1791449541900000'),
    })
    expect(answer).toMatchObject({ _: 'messages.botCallbackAnswer', message: '已接受邀请；若群开启了入群审核，还需管理员通过' })
    expect(accepted).toEqual([{ groupCode: '123456789', msgSeq: '1791449541900000' }])
    expect(edits).toEqual([{
      type: 'message-edit',
      eventId: 'inline-keyboard-refresh:invite-room:qq-invite',
      conversation: expect.objectContaining({ id: 'invite-room' }),
      message: expect.objectContaining({
        id: 'qq-invite',
        content: expect.objectContaining({ inlineKeyboard: undefined }),
      }),
    }])

    // The edit flows through the platform-manager message-edit pipeline, the
    // same path QQ recalls already exercise end to end.
  })
})