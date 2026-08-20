import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { type RpcResult, type ServerRpcContext } from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc } from './dialogs.js'
import type { IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness } from './rpc-test-harness.js'

const RPC_RESULT_ID = 0xf35c6d01
const session: PlatformSession = {
  platformSessionId: 'contacts-search', platformId: 'qqnt', userId: 'self',
  credentials: {}, metadata: { firstName: 'Current' },
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
    _: 'invokeWithLayer', layer: 228,
    query: {
      _: 'initConnection', apiId: 25184524, deviceModel: 'Crossgram E2E',
      systemVersion: 'SDK 36', appVersion: 'v12.9.0', systemLangCode: 'zh-cn',
      langPack: 'android', langCode: 'zh-CN', query,
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

async function roundTripSearch(dialogs: DialogRpc, request: tl.contacts.RawSearchRequest): Promise<tl.contacts.RawFound> {
  const harness = createCordisRpcTestHarness()
  harness.register('contacts.search', async (_context, query) =>
    dialogs.searchContacts(query as tl.contacts.RawSearchRequest))
  try {
    const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, androidEnvelope(request))
    const decoded = new TlBinaryReader(getServerReaderMap(), bytes).object() as tl.RpcMethod
    const result = await harness.dispatch(makeContext(), decoded)
    const response = new TlBinaryReader(__tlReaderMap, encodeRpcResult(Long.fromNumber(0x228), result))
    expect(response.uint()).toBe(RPC_RESULT_ID)
    response.long(true)
    return response.object() as tl.contacts.RawFound
  } finally {
    harness.dispose()
  }
}

describe('Telegram Android contacts.search e2e', () => {
  it('returns a QQ buddy that is absent from recent dialogs through the layer-228 wire format', async () => {
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() {
        return { dialogs: [{
          conversation: { id: 'recent', kind: 'direct', title: 'Recent dialog' }, unreadCount: 0,
        }] }
      },
      async getContacts() {
        return { users: [{
          id: 'buddy-only', firstName: '通讯录好友', username: 'buddy_only',
          metadata: { qq: 123456789 },
        }] }
      },
      async getHistory() { return { messages: [] } },
      async sendMessage() { throw new Error('send is disabled') },
    }
    const dialogs = new DialogRpc(platform, session)

    const result = await roundTripSearch(dialogs, {
      _: 'contacts.search', q: '123456789', limit: 20,
    })

    expect(result).toMatchObject({
      _: 'contacts.found',
      myResults: [{ _: 'peerUser', userId: dialogs.peerTlId('buddy-only') }],
      results: [], chats: [],
      users: [{
        _: 'user', firstName: '通讯录好友', username: 'buddy_only',
        contact: true, mutualContact: true,
      }],
    })
  })
})
