import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import {
  isBareVector, type RpcResult, type ServerRpcContext,
} from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry } from './platform-manager.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness, type CordisRpcTestHarness } from './rpc-test-harness.js'
import { UpdateManager } from './update-manager.js'

const RPC_RESULT_ID = 0xf35c6d01
const VECTOR_ID = 0x1cb5c415
const BOOL_TRUE_ID = 0x997275b5
const BOOL_FALSE_ID = 0xbc799737

const session: PlatformSession = {
  platformSessionId: 'mention-e2e-session', platformId: 'mention-e2e', userId: 'self',
  credentials: {}, metadata: { firstName: 'Current' },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

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

function rpcHarnessFor(
  dialogs: DialogRpc,
  publishMentionRead?: NonNullable<Parameters<DialogRpc['readMentions']>[2]>,
): CordisRpcTestHarness {
  const rpcHarness = createCordisRpcTestHarness()
  rpcHarness.register('messages.getDialogs', async (_context, request) =>
    dialogs.getDialogs(request as tl.messages.RawGetDialogsRequest))
  rpcHarness.register('messages.getHistory', async (_context, request) =>
    dialogs.getHistory(request as tl.messages.RawGetHistoryRequest))
  rpcHarness.register('messages.getUnreadMentions', async (_context, request) =>
    dialogs.getUnreadMentions(request as tl.messages.RawGetUnreadMentionsRequest))
  rpcHarness.register('messages.readMentions', async (_context, request) =>
    dialogs.readMentions(request as tl.messages.RawReadMentionsRequest, undefined, publishMentionRead))
  rpcHarness.register('channels.readMessageContents', async (_context, request) =>
    dialogs.readChannelMessageContents(
      request as tl.channels.RawReadMessageContentsRequest, undefined, publishMentionRead,
    ))
  return rpcHarness
}

async function roundTripRpc(rpcHarness: CordisRpcTestHarness, query: tl.RpcMethod): Promise<unknown> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const decodedRequest = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpcHarness.dispatch(makeContext(), decodedRequest)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

function encodeRpcResult(requestId: Long, result: RpcResult): Uint8Array {
  let body: Uint8Array
  if (result._ === 'boolTrue' || result._ === 'boolFalse') {
    const writer = TlBinaryWriter.manual(4)
    writer.uint(result._ === 'boolTrue' ? BOOL_TRUE_ID : BOOL_FALSE_ID)
    body = writer.result()
  } else if (isBareVector(result)) {
    const items = result.items.map((item) => TlBinaryWriter.serializeObject(__tlWriterMap, item))
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

describe('unread mention navigation RPC e2e', () => {
  it('round-trips the @ button list and acknowledgement through TL and SQLite restart state', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const conversation: IMConversation = { id: 'group', kind: 'group', title: 'Muted Group' }
    const own: IMMessage = {
      id: 'own', conversationId: conversation.id, senderId: session.userId,
      outgoing: true, timestamp: 1, content: { parts: [{ type: 'text', text: 'question' }] },
    }
    const mention: IMMessage = {
      id: 'mention', conversationId: conversation.id, senderId: 'alice', timestamp: 2,
      content: { parts: [{
        type: 'text', text: '@Current ping',
        entities: [{ type: 'mention', offset: 0, length: 8, userId: session.userId }],
      }] },
    }
    const reply: IMMessage = {
      id: 'reply', conversationId: conversation.id, senderId: 'bob', replyToId: own.id,
      timestamp: 3, content: { parts: [{ type: 'text', text: 'reply ping' }] },
    }
    const ordinary: IMMessage = {
      id: 'ordinary', conversationId: conversation.id, senderId: 'carol', timestamp: 4,
      content: { parts: [{ type: 'text', text: 'ordinary newest' }] },
    }
    const messages = [own, mention, reply, ordinary]
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() {
        return { dialogs: [{
          conversation, unreadCount: 3, lastMessage: ordinary, readInboxMaxMessage: own,
        }] }
      },
      async getHistory() { return { messages } },
      async getUser(_session, id) { return { id, firstName: id } },
    }
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '0011223344556677', platformId: session.platformId,
      platformSessionId: session.platformSessionId,
    })
    const store = new MessageStore(ctx.database)
    const manager = new UpdateManager(
      ctx.database, new PlatformRegistry([[session.platformId, platform]]), store, () => 1,
    )
    await store.ingest(session, conversation, own)
    for (const message of [mention, reply, ordinary]) {
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    }

    const dialogs = new DialogRpc(platform, session, store)
    const mentionReadPublishes: Array<{
      conversation: IMConversation
      tlMessageIds: readonly number[]
      topMsgId: number | undefined
    }> = []
    const rpcHarness = rpcHarnessFor(dialogs, async (_session, publishedConversation, tlMessageIds, topMsgId) => {
      mentionReadPublishes.push({ conversation: publishedConversation, tlMessageIds, topMsgId })
      return { pts: 1, ptsCount: 0 }
    })
    const page = await roundTripRpc(rpcHarness, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    expect(page.dialogs).toMatchObject([{ unreadMentionsCount: 2 }])
    const peer = {
      _: 'inputPeerChannel' as const,
      channelId: stableId(`peer:${conversation.id}`), accessHash: Long.ONE,
    }
    const request: tl.messages.RawGetUnreadMentionsRequest = {
      _: 'messages.getUnreadMentions', peer,
      // Telegram Desktop asks for the oldest unread slice first so the @ button
      // can jump to the earliest outstanding mention.
      offsetId: 1, addOffset: -100, limit: 100, maxId: 0, minId: 0,
    }
    const unread = await roundTripRpc(rpcHarness, request) as tl.messages.RawMessages
    expect(unread.messages).toMatchObject([
      { _: 'message', message: 'reply ping', mentioned: true, mediaUnread: true },
      { _: 'message', message: '@Current ping', mentioned: true, mediaUnread: true },
    ])

    const history = await roundTripRpc(rpcHarness, {
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    const historyMessages = history.messages.filter((message): message is tl.RawMessage => message._ === 'message')
    expect(historyMessages.find((message) => message.message === 'reply ping')).toMatchObject({
      mentioned: true, mediaUnread: true,
    })
    expect(historyMessages.find((message) => message.message === '@Current ping')).toMatchObject({
      mentioned: true, mediaUnread: true,
    })

    const replyMessage = unread.messages.find((message): message is tl.RawMessage =>
      message._ === 'message' && message.message === 'reply ping')
    if (!replyMessage) throw new Error('missing unread reply')
    await expect(roundTripRpc(rpcHarness, {
      _: 'channels.readMessageContents',
      channel: { _: 'inputChannel', channelId: peer.channelId, accessHash: peer.accessHash },
      id: [replyMessage.id],
    })).resolves.toMatchObject({ _: 'boolTrue' })
    expect(mentionReadPublishes).toMatchObject([{
      conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
      tlMessageIds: [replyMessage.id],
      topMsgId: undefined,
    }])

    const resumed = rpcHarnessFor(
      new DialogRpc(platform, session, store),
      async (_session, publishedConversation, tlMessageIds, topMsgId) => {
        mentionReadPublishes.push({ conversation: publishedConversation, tlMessageIds, topMsgId })
        return { pts: 1, ptsCount: 0 }
      },
    )
    await expect(roundTripRpc(resumed, request)).resolves.toMatchObject({
      messages: [{ message: '@Current ping', mentioned: true, mediaUnread: true }],
    })
    await expect(roundTripRpc(resumed, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })).resolves.toMatchObject({ dialogs: [{ unreadMentionsCount: 1 }] })
    await expect(roundTripRpc(resumed, {
      _: 'messages.readMentions', peer,
    })).resolves.toMatchObject({ _: 'messages.affectedHistory', ptsCount: 0, offset: 0 })
    expect(mentionReadPublishes).toMatchObject([
      {
        conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
        tlMessageIds: [replyMessage.id], topMsgId: undefined,
      },
      {
        conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
        tlMessageIds: [unread.messages.find((message): message is tl.RawMessage =>
          message._ === 'message' && message.message === '@Current ping')!.id],
        topMsgId: undefined,
      },
    ])

    const acknowledged = rpcHarnessFor(new DialogRpc(platform, session, store))
    await expect(roundTripRpc(acknowledged, request)).resolves.toMatchObject({ messages: [] })
    const acknowledgedHistory = await roundTripRpc(acknowledged, {
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    const acknowledgedMention = acknowledgedHistory.messages.find((message): message is tl.RawMessage =>
      message._ === 'message' && message.message === '@Current ping')
    expect(acknowledgedMention).toMatchObject({ mentioned: true, mediaUnread: false })
    await expect(roundTripRpc(acknowledged, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })).resolves.toMatchObject({ dialogs: [{ unreadMentionsCount: 0 }] })
  })

  it('clears legacy private-chat reply mentions and keeps them out of TL history', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const conversation: IMConversation = { id: 'private', kind: 'direct', title: 'Private' }
    const own: IMMessage = {
      id: 'own-private', conversationId: conversation.id, senderId: session.userId,
      outgoing: true, timestamp: 10, content: { parts: [{ type: 'text', text: 'question' }] },
    }
    const reply: IMMessage = {
      id: 'private-reply', conversationId: conversation.id, senderId: 'alice',
      replyToId: own.id, timestamp: 11, content: { parts: [{ type: 'text', text: 'answer' }] },
    }
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() {
        return { dialogs: [{
          conversation, unreadCount: 1, lastMessage: reply, readInboxMaxMessage: own,
        }] }
      },
      async getHistory() { return { messages: [own, reply] } },
      async getUser(_session, id) { return { id, firstName: id } },
    }
    const store = new MessageStore(ctx.database)
    await store.ingest(session, conversation, own)
    const replyResult = await store.ingest(session, conversation, reply)
    const replyTlId = replyResult.projection[0].tlMessageId
    // Simulate mention state persisted by an older server version, where every
    // private reply to an outgoing message was classified as an unread mention.
    await store.setMessageMentioned(
      session.platformSessionId, conversation.id, replyTlId, true, true,
    )
    await expect(store.countUnreadMentions(session.platformSessionId, conversation.id)).resolves.toBe(1)

    const dialogs = new DialogRpc(platform, session, store)
    const rpcHarness = rpcHarnessFor(dialogs)
    await expect(roundTripRpc(rpcHarness, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })).resolves.toMatchObject({ dialogs: [{ unreadCount: 1, unreadMentionsCount: 0 }] })
    await expect(store.countUnreadMentions(session.platformSessionId, conversation.id)).resolves.toBe(0)

    const peer = {
      _: 'inputPeerUser' as const,
      userId: dialogs.peerTlId(conversation.id), accessHash: Long.ZERO,
    }
    await expect(roundTripRpc(rpcHarness, {
      _: 'messages.getUnreadMentions', peer,
      offsetId: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0,
    })).resolves.toMatchObject({ messages: [] })
    const history = await roundTripRpc(rpcHarness, {
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    expect(history.messages.find((message): message is tl.RawMessage =>
      message._ === 'message' && message.id === replyTlId)).toMatchObject({
      message: 'answer', mentioned: false, mediaUnread: false,
    })
  })
})
