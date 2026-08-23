import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import type { RpcResult, ServerConnection, ServerRpcContext } from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry } from './platform-manager.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness } from './rpc-test-harness.js'
import { UpdateManager } from './update-manager.js'

const RPC_RESULT_ID = 0xf35c6d01
const REQUESTER_AUTH_KEY = '0011223344556677'
const OBSERVER_AUTH_KEY = '1122334455667788'
const session: PlatformSession = {
  platformSessionId: 'send-observer-e2e', platformId: 'send-observer', userId: 'self',
  virtualPhone: '888123456789012', credentials: {}, metadata: { firstName: 'Current' },
}
const conversation: IMConversation = { id: 'group', kind: 'group', title: 'Group' }
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function rpcContext(): ServerRpcContext {
  return {
    connection: {} as ServerConnection,
    apiLayer: 228,
    authKeyId: Uint8Array.from(Buffer.from(REQUESTER_AUTH_KEY, 'hex')),
    sessionId: Long.ONE,
    isAuthorized: true,
    sendUpdate() {},
    getPlatformData: <T>() => null as T,
    setPlatformData() {},
  }
}

async function roundTripRpc(
  rpc: ReturnType<typeof createCordisRpcTestHarness>,
  query: tl.RpcMethod,
): Promise<any> {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const decoded = new TlBinaryReader(getServerReaderMap(), bytes).object() as tl.RpcMethod
  const result = await rpc.dispatch(rpcContext(), decoded)
  const body = TlBinaryWriter.serializeObject(__tlWriterMap, result as RpcResult as tl.TlObject)
  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(Long.fromNumber(0x228))
  writer.raw(body)
  const reader = new TlBinaryReader(__tlReaderMap, writer.result())
  expect(reader.uint()).toBe(RPC_RESULT_ID)
  reader.long(true)
  return reader.object()
}

describe('sent-message observer reconciliation e2e', () => {
  it('carries updateMessageID on the parallel auth-key push before returning the RPC result', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })
    for (const authKeyId of [REQUESTER_AUTH_KEY, OBSERVER_AUTH_KEY]) {
      await ctx.database.create('mtproto_auth_binding', {
        authKeyId, platformId: session.platformId, platformSessionId: session.platformSessionId,
      })
    }

    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
      async getHistory() { return { messages: [{
        id: 'qq-reply-target', conversationId: conversation.id, senderId: 'friend', timestamp: 1_799_999_999,
        content: { parts: [{ type: 'text', text: 'reply target' }] },
      }] } },
      async getUser(_session, id) { return { id, firstName: id === session.userId ? 'Current' : id } },
      async sendMessage(_session, target, input): Promise<IMMessage> {
        const text = input.parts.find((part) => part.type === 'text')
        if (!text || text.type !== 'text') throw new Error('expected sent text')
        return {
          id: 'qq-sent-text', conversationId: target.id, senderId: session.userId,
          outgoing: true, timestamp: 1_800_000_000, replyToId: input.replyToId,
          content: { parts: [{ type: 'text', text: text.text }] },
        }
      },
    }
    const store = new MessageStore(ctx.database)
    const observerPushes: Array<{ authKeyId: string, payload: tl.RawUpdates }> = []
    const manager = new UpdateManager(
      ctx.database, new PlatformRegistry([[session.platformId, platform]]), store,
      (authKeyId, update) => {
        observerPushes.push({
          authKeyId: Buffer.from(authKeyId).toString('hex'),
          payload: update as tl.RawUpdates,
        })
        return 1
      },
    )
    const dialogs = new DialogRpc(
      platform, session, store,
      undefined, undefined, 1, undefined, undefined, undefined,
      async (localSession, event, options) => {
        if (event.type !== 'message') return
        const result = await store.ingest(localSession, event.conversation, event.message)
        return manager.publish(localSession, { event, result }, options)
      },
      REQUESTER_AUTH_KEY,
    )
    const rpc = createCordisRpcTestHarness()
    rpc.register('messages.sendMessage', async (context, request) =>
      dialogs.sendMessage(request as tl.messages.RawSendMessageRequest, context.connection))
    const randomId = Long.fromNumber(80_001)
    const targetPeer = {
      _: 'inputPeerChannel' as const,
      channelId: stableId(`peer:${conversation.id}`), accessHash: Long.ZERO,
    }
    const history = await dialogs.getHistory({
      _: 'messages.getHistory', peer: targetPeer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    const replyToMsgId = (history.messages.find((message) =>
      message._ === 'message' && message.message === 'reply target') as tl.RawMessage).id

    const response = await roundTripRpc(rpc, {
      _: 'messages.sendMessage',
      peer: targetPeer,
      message: 'keep the optimistic text item',
      replyTo: { _: 'inputReplyToMessage', replyToMsgId, topMsgId: 1 },
      randomId,
    }) as tl.RawUpdates

    expect(observerPushes).toHaveLength(1)
    expect(observerPushes[0].authKeyId).toBe(OBSERVER_AUTH_KEY)
    expect(observerPushes[0].payload.updates).toMatchObject([
      { _: 'updateMessageID', randomId },
      { _: 'updateNewChannelMessage', message: {
        message: 'keep the optimistic text item',
        replyTo: { _: 'messageReplyHeader', replyToMsgId, replyToTopId: 1 },
      } },
    ])
    expect(response).toMatchObject({
      _: 'updates', seq: 0,
      updates: [
        { _: 'updateMessageID', randomId },
        { _: 'updateNewChannelMessage', message: {
          message: 'keep the optimistic text item',
          replyTo: { _: 'messageReplyHeader', replyToMsgId, replyToTopId: 1 },
        } },
      ],
    })
    expect((observerPushes[0].payload.updates[0] as tl.RawUpdateMessageID).id)
      .toBe((response.updates[0] as tl.RawUpdateMessageID).id)
  })
})
