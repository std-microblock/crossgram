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
import { SendEchoes } from './send-echoes.js'
import { DialogRpc, peerTlSeed, stableId } from './dialogs.js'
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
    const dialogs = new DialogRpc(platform, session, store, {
        dcId: 1,
        onLocalEvent: async (localSession, event, options) => {
        if (event.type !== 'message') return
        const result = await store.ingest(localSession, event.conversation, event.message)
        return manager.publish(localSession, { event, result }, options)
      },
        authKeyId: REQUESTER_AUTH_KEY,
    }
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

  it('excludes only the sending auth key for the echoed message, not every own message', async () => {
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

    const sendEchoes = new SendEchoes()
    const store = new MessageStore(ctx.database)
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id === session.userId ? 'Current' : id } },
      async sendMessage(): Promise<IMMessage> { throw new Error('not used') },
    }
    const pushes: Array<{ authKeyId: string, payload: tl.RawUpdates }> = []
    const manager = new UpdateManager(
      ctx.database, new PlatformRegistry([[session.platformId, platform]]), store,
      (authKeyId, update) => {
        pushes.push({
          authKeyId: Buffer.from(authKeyId).toString('hex'),
          payload: update as tl.RawUpdates,
        })
        return 1
      },
      1, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sendEchoes,
    )
    const echo = async (id: string, text: string) => {
      const message: IMMessage = {
        id, conversationId: conversation.id, senderId: session.userId, outgoing: true,
        timestamp: 1_800_000_000, content: { parts: [{ type: 'text', text }] },
      }
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result }, {})
    }

    // 发送 RPC 拿到平台结果后登记这条消息：它的回显只推给其他设备。
    sendEchoes.bind(session.platformSessionId, ['qq-sent-text'], REQUESTER_AUTH_KEY)
    await echo('qq-sent-text', 'one bubble for the sender')
    expect(pushes.map((push) => push.authKeyId)).toEqual([OBSERVER_AUTH_KEY])
    expect(pushes[0]!.payload.updates).toMatchObject([
      { _: 'updateNewChannelMessage', message: { message: 'one bubble for the sender' } },
    ])

    // 同一时间段里从 QQ 手机端发出的另一条自己消息，不能被顺带屏蔽掉。
    await echo('qq-phone-app-text', 'sent from another client')
    expect(pushes.map((push) => push.authKeyId)).toEqual([
      OBSERVER_AUTH_KEY, REQUESTER_AUTH_KEY, OBSERVER_AUTH_KEY,
    ])

    // 本方投递完成后解绑，之后到达的消息照常推给所有设备。
    sendEchoes.release(session.platformSessionId, ['qq-sent-text'])
    await echo('qq-later-text', 'delivered to every device')
    expect(pushes.map((push) => push.authKeyId)).toEqual([
      OBSERVER_AUTH_KEY, REQUESTER_AUTH_KEY, OBSERVER_AUTH_KEY,
      REQUESTER_AUTH_KEY, OBSERVER_AUTH_KEY,
    ])
  })

  it('binds the sent platform message for the whole local publish', async () => {
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

    const sendEchoes = new SendEchoes()
    const store = new MessageStore(ctx.database)
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id === session.userId ? 'Current' : id } },
      async sendMessage(_session, target, input): Promise<IMMessage> {
        const text = input.parts.find((part) => part.type === 'text')
        if (!text || text.type !== 'text') throw new Error('expected sent text')
        return {
          id: 'qq-wired-text', conversationId: target.id, senderId: session.userId,
          outgoing: true, timestamp: 1_800_000_000,
          content: { parts: [{ type: 'text', text: text.text }] },
        }
      },
    }
    const boundDuringPublish: Array<string | undefined> = []
    const manager = new UpdateManager(
      ctx.database, new PlatformRegistry([[session.platformId, platform]]), store,
      () => 1,
      1, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sendEchoes,
    )
    const dialogs = new DialogRpc(platform, session, store, {
        dcId: 1,
        onLocalEvent: async (localSession, event, options) => {
        if (event.type !== 'message') return
        boundDuringPublish.push(sendEchoes.excludeFor(localSession, event.message))
        const result = await store.ingest(localSession, event.conversation, event.message)
        return manager.publish(localSession, { event, result }, options)
      },
        authKeyId: REQUESTER_AUTH_KEY,
        sendEchoes: sendEchoes,
    }
    )
    await (dialogs as any)._hydratePeers()
    const rpc = createCordisRpcTestHarness()
    rpc.register('messages.sendMessage', async (context, request) =>
      dialogs.sendMessage(request as tl.messages.RawSendMessageRequest, context.connection))
    const targetPeer = {
      _: 'inputPeerChannel' as const,
      channelId: stableId(peerTlSeed(session.platformSessionId, conversation.id)), accessHash: Long.ZERO,
    }
    await roundTripRpc(rpc, {
      _: 'messages.sendMessage',
      peer: targetPeer,
      message: 'bind while publishing',
      randomId: Long.fromNumber(80_003),
    })

    // 投递本地副本的那一刻，这条平台消息已经归属发送它的 auth key。
    expect(boundDuringPublish).toEqual([REQUESTER_AUTH_KEY])
    // 投递完成后解绑：此后同一条消息的回显由事件去重处理。
    expect(sendEchoes.excludeFor(session, {
      id: 'qq-wired-text', conversationId: conversation.id, senderId: session.userId,
      outgoing: true, timestamp: 1_800_000_000, content: { parts: [{ type: 'text', text: 'x' }] },
    })).toBeUndefined()
  })
})
