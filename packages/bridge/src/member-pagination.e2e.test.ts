import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { RpcDispatcher, type RpcResult, type ServerRpcContext } from '@mtproto-relay/mtproto'
import Long from 'long'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc, stableId } from './dialogs.js'
import type { IMPlatform, PlatformSession } from './platform.js'

const RPC_RESULT_ID = 0xf35c6d01

const session: PlatformSession = {
  platformSessionId: 'android-members', platformId: 'qqnt', userId: 'self',
  credentials: {}, metadata: {},
}

function makeContext(): ServerRpcContext {
  return {
    connection: {} as ServerRpcContext['connection'],
    apiLayer: 228,
    authKeyId: new Uint8Array(8),
    sessionId: Long.ONE,
    isAuthorized: true,
    sendUpdate() {},
    getPlatformData: <T>() => null as T,
    setPlatformData() {},
  }
}

function androidEnvelope(query: tl.RpcMethod): tl.RpcMethod {
  return {
    _: 'invokeWithLayer',
    layer: 228,
    query: {
      _: 'initConnection',
      apiId: 25184524,
      deviceModel: 'Xiaomi25113PN0EC',
      systemVersion: 'SDK 36',
      appVersion: 'v12.9.0-66cf230',
      systemLangCode: 'zh-cn',
      langPack: 'android',
      langCode: 'zh-CN',
      query,
    },
  } as tl.RpcMethod
}

function encodeRpcResult(requestId: Long, result: RpcResult): Uint8Array {
  const body = TlBinaryWriter.serializeObject(__tlWriterMap, result as tl.TlObject)
  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(requestId)
  writer.raw(body)
  return writer.result()
}

function decodeRpcResult(bytes: Uint8Array): any {
  const reader = new TlBinaryReader(__tlReaderMap, bytes)
  expect(reader.uint()).toBe(RPC_RESULT_ID)
  reader.long(true)
  return reader.object()
}

async function roundTripRpc(dispatcher: RpcDispatcher, query: tl.RpcMethod): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, androidEnvelope(query))
  const decodedRequest = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await dispatcher.dispatch(makeContext(), decodedRequest)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

describe('Telegram Android member pagination e2e', () => {
  it('fills a 100-member Android page from QQNT-sized chunks and exposes all mention matches', async () => {
    const calls: Array<{ cursor?: string, limit?: number }> = []
    const permissions = {
      manageConversation: false, manageMembers: false, deleteAnyMessage: false,
      editAnyMessage: false, pinMessages: false, inviteMembers: true,
    }
    const members = Array.from({ length: 125 }, (_, index) => ({
      user: {
        id: `member-${index}`,
        firstName: `Member ${index}`,
      },
      title: index === 112 ? 'Android Target' : undefined,
      role: 'member' as const,
      permissions,
    }))
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
        members: { list: true, administrators: true, permissions: true },
      },
      async subscribe() { return () => {} },
      async getDialogs() {
        return {
          dialogs: [{
            conversation: {
              id: 'qq-group', kind: 'group', title: 'QQ Group', metadata: { participantsCount: 125 },
            },
            unreadCount: 0,
          }],
          total: 1,
        }
      },
      async getHistory() { return { messages: [] } },
      async getConversationMembers(_session, _conversation, query = {}) {
        calls.push(query)
        const start = Number(query.cursor?.replace('cursor-', '') ?? 0)
        const pageMembers = members.slice(start, start + Math.min(query.limit ?? 100, 30))
        const next = start + pageMembers.length
        return {
          members: pageMembers,
          total: members.length,
          nextCursor: next < members.length ? `cursor-${next}` : undefined,
        }
      },
      async sendMessage() { throw new Error('send is disabled') },
    }
    const dialogs = new DialogRpc(platform, session)
    const dispatcher = new RpcDispatcher()
    dispatcher.register('messages.getDialogs', async (_context, request) =>
      dialogs.getDialogs(request as tl.messages.RawGetDialogsRequest))
    dispatcher.register('channels.getParticipants', async (_context, request) =>
      dialogs.getChannelParticipants(request as tl.channels.RawGetParticipantsRequest))

    await roundTripRpc(dispatcher, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const channel = {
      _: 'inputChannel' as const,
      channelId: stableId('peer:qq-group'),
      accessHash: Long.ZERO,
    }
    const first = await roundTripRpc(dispatcher, {
      _: 'channels.getParticipants', channel, filter: { _: 'channelParticipantsRecent' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })
    const second = await roundTripRpc(dispatcher, {
      _: 'channels.getParticipants', channel, filter: { _: 'channelParticipantsRecent' },
      offset: 100, limit: 25, hash: Long.ZERO,
    })
    const mention = await roundTripRpc(dispatcher, {
      _: 'channels.getParticipants', channel,
      filter: { _: 'channelParticipantsMentions', q: 'android target' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })

    expect(first).toMatchObject({ _: 'channels.channelParticipants', count: 125 })
    expect(first.users).toHaveLength(100)
    expect(first.users[0]).toMatchObject({ firstName: 'Member 0' })
    expect(first.users[99]).toMatchObject({ firstName: 'Member 99' })
    expect(second.users).toHaveLength(25)
    expect(second.users[0]).toMatchObject({ firstName: 'Member 100' })
    expect(second.users[24]).toMatchObject({ firstName: 'Member 124' })
    expect(mention).toMatchObject({
      _: 'channels.channelParticipants', count: 1,
      participants: [{ _: 'channelParticipant', rank: 'Android Target' }],
      users: [{ firstName: 'Member 112' }],
    })
    expect(calls).toEqual([0, 30, 60, 90, 120].map((offset) => ({
      cursor: offset ? `cursor-${offset}` : undefined,
      limit: 100,
    })))
  })
})
