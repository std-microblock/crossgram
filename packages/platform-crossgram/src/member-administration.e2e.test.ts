import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { type RpcResult, type ServerRpcContext } from '@mtproto-relay/mtproto'
import { DialogRpc, stableId } from '../../bridge/src/dialogs.js'
import { createCordisRpcTestHarness } from '../../bridge/src/rpc-test-harness.js'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import type { PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from './index.js'

const RPC_RESULT_ID = 0xf35c6d01
const session: PlatformSession = {
  platformSessionId: 'qq-admin-e2e', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
let server: Server | undefined

afterEach(async () => {
  if (!server?.listening) return
  const closed = new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve())
  })
  server.closeAllConnections()
  await closed
  server = undefined
})

function context(): ServerRpcContext {
  return {
    connection: {} as ServerRpcContext['connection'], apiLayer: 228,
    authKeyId: new Uint8Array(8), sessionId: Long.ONE, isAuthorized: true,
    sendUpdate() {}, getPlatformData: <T>() => null as T, setPlatformData() {},
  }
}

async function roundTrip(
  harness: ReturnType<typeof createCordisRpcTestHarness>,
  query: tl.RpcMethod,
): Promise<any> {
  const envelope = {
    _: 'invokeWithLayer', layer: 228,
    query: {
      _: 'initConnection', apiId: 25184524, deviceModel: 'AyuGram Desktop',
      systemVersion: 'Windows 11', appVersion: '5.16', systemLangCode: 'zh-cn',
      langPack: 'tdesktop', langCode: 'zh-CN', query,
    },
  } as tl.RpcMethod
  const encoded = TlBinaryWriter.serializeObject(__tlWriterMap, envelope)
  const decoded = new TlBinaryReader(getServerReaderMap(), encoded).object() as tl.RpcMethod
  const result = await harness.dispatch(context(), decoded)
  const body = TlBinaryWriter.serializeObject(__tlWriterMap, result as tl.TlObject)
  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(Long.ONE)
  writer.raw(body)
  const reader = new TlBinaryReader(__tlReaderMap, writer.result())
  expect(reader.uint()).toBe(RPC_RESULT_ID)
  reader.long(true)
  return reader.object()
}

describe('QQ administrator management E2E', () => {
  it('carries owner rights and promote/demote RPCs through MTProto, the adapter, HTTP, and QQ roles', async () => {
    let bobRole: 'administrator' | 'member' = 'member'
    const updates: Array<{ userId: string, role: 'administrator' | 'member' }> = []
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/status') {
        response.end(JSON.stringify({ protocolVersion: 25, ready: true, selfUid: 'self', selfUin: '10000' }))
        return
      }
      if (request.url?.startsWith('/v1/dialogs')) {
        response.end(JSON.stringify({ conversations: [{
          id: '2:group', kind: 'group', title: 'QQ Group', peerUid: 'group', peerUin: '12345',
          chatType: 2, participantCount: 2, selfRole: 'owner', unreadCount: 0,
        }] }))
        return
      }
      if (request.url?.startsWith('/v1/contacts')) {
        response.end(JSON.stringify({ users: [] }))
        return
      }
      if (request.url?.startsWith('/v1/conversations/2%3Agroup/history')) {
        response.end(JSON.stringify({ messages: [] }))
        return
      }
      if (request.url === '/v1/users/self') {
        response.end(JSON.stringify({ id: 'self', numericId: '10000', name: 'Owner' }))
        return
      }
      if (request.method === 'GET' && request.url?.startsWith('/v1/conversations/2%3Agroup/members')) {
        response.end(JSON.stringify({ total: 2, members: [
          { user: { id: 'self', numericId: '10000', name: 'Owner' }, role: 'owner' },
          { user: { id: 'bob', numericId: '10001', name: 'Bob' }, role: bobRole },
        ] }))
        return
      }
      const roleMatch = /^\/v1\/conversations\/2%3Agroup\/members\/([^/]+)\/role$/.exec(request.url ?? '')
      if (request.method === 'POST' && roleMatch) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { role: 'administrator' | 'member' }
        const userId = decodeURIComponent(roleMatch[1])
        bobRole = body.role
        updates.push({ userId, role: body.role })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const dialogs = new DialogRpc(platform, session)
    const harness = createCordisRpcTestHarness()
    harness.register('messages.getDialogs', async (_context, request) =>
      dialogs.getDialogs(request as tl.messages.RawGetDialogsRequest))
    harness.register('channels.getParticipants', async (_context, request) =>
      dialogs.getChannelParticipants(request as tl.channels.RawGetParticipantsRequest))
    harness.register('channels.editAdmin', async (_context, request) =>
      dialogs.editChannelAdmin(request as tl.channels.RawEditAdminRequest))

    const peers = await roundTrip(harness, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    expect(peers.chats).toMatchObject([{
      _: 'channel', title: 'QQ Group', creator: true, adminRights: { addAdmins: true },
    }])
    const channel = {
      _: 'inputChannel' as const, channelId: stableId('peer:2:group'), accessHash: Long.ZERO,
    }
    const members = await roundTrip(harness, {
      _: 'channels.getParticipants', channel, filter: { _: 'channelParticipantsRecent' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })
    const bob = members.users.find((user: tl.TypeUser) => user._ === 'user' && user.firstName === 'Bob')
    expect(bob).toBeDefined()
    const userId = { _: 'inputUser' as const, userId: bob.id, accessHash: Long.ZERO }

    await roundTrip(harness, {
      _: 'channels.editAdmin', channel, userId,
      adminRights: { _: 'chatAdminRights', deleteMessages: true }, rank: '',
    })
    const admins = await roundTrip(harness, {
      _: 'channels.getParticipants', channel, filter: { _: 'channelParticipantsAdmins' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })
    expect(admins.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'channelParticipantAdmin', userId: bob.id }),
    ]))

    await roundTrip(harness, {
      _: 'channels.editAdmin', channel, userId,
      adminRights: { _: 'chatAdminRights' }, rank: '',
    })
    expect(updates).toEqual([
      { userId: 'bob', role: 'administrator' },
      { userId: 'bob', role: 'member' },
    ])
  })
})
