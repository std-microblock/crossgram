import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { RpcDispatcher, isBareVector, type RpcResult, type ServerRpcContext } from '@mtproto-relay/mtproto'
import Long from 'long'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { androidRpcHandlers } from './android-rpc.js'

const RPC_RESULT_ID = 0xf35c6d01
const VECTOR_ID = 0x1cb5c415
const BOOL_TRUE_ID = 0x997275b5
const BOOL_FALSE_ID = 0xbc799737

const self = { _: 'inputPeerSelf' as const }

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
  let body: Uint8Array
  if (result._ === 'boolTrue' || result._ === 'boolFalse') {
    const writer = TlBinaryWriter.manual(4)
    writer.uint(result._ === 'boolTrue' ? BOOL_TRUE_ID : BOOL_FALSE_ID)
    body = writer.result()
  } else if (isBareVector(result)) {
    const items = result.items.map(item => TlBinaryWriter.serializeObject(__tlWriterMap, item))
    const writer = TlBinaryWriter.manual(8 + items.reduce((size, item) => size + item.length, 0))
    writer.uint(VECTOR_ID)
    writer.uint(items.length)
    for (const item of items) writer.raw(item)
    body = writer.result()
  } else {
    body = TlBinaryWriter.serializeObject(__tlWriterMap, result)
  }

  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(requestId)
  writer.raw(body)
  return writer.result()
}

function decodeRpcResult(bytes: Uint8Array): unknown {
  const reader = new TlBinaryReader(__tlReaderMap, bytes)
  expect(reader.uint()).toBe(RPC_RESULT_ID)
  reader.long(true)
  const constructor = reader.uint()
  if (constructor === BOOL_TRUE_ID) return { _: 'boolTrue' }
  if (constructor === BOOL_FALSE_ID) return { _: 'boolFalse' }
  if (constructor === VECTOR_ID) return reader.vector(reader.object, true)
  reader.pos -= 4
  return reader.object()
}

async function roundTripRpc(query: tl.RpcMethod): Promise<unknown> {
  const dispatcher = new RpcDispatcher()
  for (const [method, handler] of Object.entries(androidRpcHandlers)) {
    dispatcher.register(method, async (_context, request) => handler(request))
  }

  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, androidEnvelope(query))
  const decodedRequest = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await dispatcher.dispatch(makeContext(), decodedRequest)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

describe('Telegram Android capture RPC e2e', () => {
  it('serves empty premium and sponsored resources through a wrapped layer-228 request', async () => {
    await expect(roundTripRpc({ _: 'premium.getMyBoosts' })).resolves.toEqual({
      _: 'premium.myBoosts', myBoosts: [], chats: [], users: [],
    })
    await expect(roundTripRpc({
      _: 'messages.getSponsoredMessages', peer: self,
    })).resolves.toEqual({ _: 'messages.sponsoredMessagesEmpty' })
  })

  it('serializes bare Vector<EmojiLanguage> responses exactly as rpc_result payloads', async () => {
    await expect(roundTripRpc({
      _: 'messages.getEmojiKeywordsLanguages', langCodes: ['', 'en', 'en', 'zh-CN'],
    })).resolves.toEqual([
      { _: 'emojiLanguage', langCode: 'en' },
      { _: 'emojiLanguage', langCode: 'zh-CN' },
    ])
  })

  it('serializes bare Bool acknowledgements exactly as rpc_result payloads', async () => {
    await expect(roundTripRpc({
      _: 'account.updateNotifySettings',
      peer: { _: 'inputNotifyPeer', peer: self },
      settings: { _: 'inputPeerNotifySettings' },
    })).resolves.toEqual({ _: 'boolTrue' })
  })

  it('returns a valid empty Updates object for the Android read-all-stories probe', async () => {
    await expect(roundTripRpc({ _: 'stories.getAllReadPeerStories' })).resolves.toMatchObject({
      _: 'updates', updates: [], users: [], chats: [], seq: 0,
    })
  })
})
