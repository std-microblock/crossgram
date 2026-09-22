import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'
import Long from 'long'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry } from './platform-manager.js'
import type { IMPlatform, IMRequest, PlatformSession } from './platform.js'
import {
  createRequestResolver, REQUEST_ACCEPT_CALLBACK_DATA, REQUEST_INBOX_CONVERSATION_ID,
  RequestInboxSystemPeerProvider, requestInboxMessage,
} from './request-inbox.js'
import { createCordisRpcTestHarness } from './rpc-test-harness.js'
import { SystemPeerService } from './system-peer.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe('request inbox callback RPC e2e', () => {
  it('round-trips a safe alert and a successful retry through RPC routes and TL serialization', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    const harness = createCordisRpcTestHarness()
    disposals.push(async () => {
      harness.dispose()
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })
    const session: PlatformSession = {
      platformSessionId: 'request-callback-e2e', platformId: 'qqnt-e2e', userId: 'self',
      credentials: {}, metadata: {},
    }
    const pending: IMRequest = {
      id: 'qq/friend-request', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const originalError = new Error('QQ resolver failed token=private-token')
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>()
      .mockRejectedValueOnce(originalError)
      .mockResolvedValue({ ...pending, state: 'accepted' })
    const platform: IMPlatform = {
      capabilities: {
        history: false,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('发送已禁用') },
      resolveRequest,
    }
    const store = new MessageStore(ctx.database)
    const peers = new SystemPeerService(ctx)
    const onError = vi.fn()
    peers.attach(async (activeSession, event) => {
      if (event.type === 'request') await store.ingestRequest(activeSession, event.request)
    })
    peers.register(new RequestInboxSystemPeerProvider(
      store, createRequestResolver(new PlatformRegistry([[session.platformId, platform]])),
      async (activeSession, request) => { await peers.emit(activeSession, { type: 'request', request, delivery: 'recovery' }) },
      onError,
    ))
    const dialogs = new DialogRpc(
      platform, session, store, undefined, undefined, 1, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, peers,
    )
    harness.register('messages.getDialogs', async (_context, request) =>
      dialogs.getDialogs(request as tl.messages.RawGetDialogsRequest))
    harness.register('messages.getBotCallbackAnswer', async (_context, request) =>
      dialogs.getBotCallbackAnswer(request as tl.messages.RawGetBotCallbackAnswerRequest))
    harness.register('messages.getHistory', async (_context, request) =>
      dialogs.getHistory(request as tl.messages.RawGetHistoryRequest))
    const context: ServerRpcContext = {
      connection: {} as ServerRpcContext['connection'], apiLayer: 228,
      authKeyId: new Uint8Array(8), sessionId: Long.ONE, isAuthorized: true,
      sendUpdate() {}, getPlatformData: <T>() => null as T, setPlatformData() {},
    }
    // 使用真实 Cordis RPC 路由与双向 TL 编解码，不建立网络连接。
    const roundTrip = async (request: tl.RpcMethod) => {
      const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, request)
      const decoded = new TlBinaryReader(getServerReaderMap(), bytes).object() as tl.RpcMethod
      const result = await harness.dispatch(context, decoded)
      const body = TlBinaryWriter.serializeObject(__tlWriterMap, result)
      const writer = TlBinaryWriter.manual(12 + body.length)
      writer.uint(0xf35c6d01)
      writer.long(Long.ONE)
      writer.raw(body)
      const reader = new TlBinaryReader(__tlReaderMap, writer.result())
      expect(reader.uint()).toBe(0xf35c6d01)
      expect(reader.long(true).equals(Long.ONE)).toBe(true)
      return reader.object()
    }
    await store.ingestRequest(session, pending)
    const page = await harness.dispatch(context, {
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
      limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const inbox = page.dialogs.find((dialog) => dialog.peer._ === 'peerUser'
      && dialog.peer.userId === dialogs.peerTlId(REQUEST_INBOX_CONVERSATION_ID))!
    const peer: tl.RawInputPeerUser = {
      _: 'inputPeerUser', userId: dialogs.peerTlId(REQUEST_INBOX_CONVERSATION_ID), accessHash: Long.ZERO,
    }
    const callback: tl.messages.RawGetBotCallbackAnswerRequest = {
      _: 'messages.getBotCallbackAnswer', peer, msgId: inbox.topMessage,
      data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA),
    }
    const history: tl.messages.RawGetHistoryRequest = {
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0,
      limit: 10, maxId: 0, minId: 0, hash: Long.ZERO,
    }
    await expect(roundTrip(callback)).resolves.toMatchObject({
      _: 'messages.botCallbackAnswer', alert: true,
      message: '请求处理或状态同步失败，请稍后重试或在 QQ 中确认。', cacheTime: 0,
    })
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('request resolver failed'), originalError)
    await expect(store.getRequest(session.platformSessionId, pending.id)).resolves.toMatchObject({ state: 'pending' })
    expect((await store.readHistory(session.platformSessionId, REQUEST_INBOX_CONVERSATION_ID))[0]?.content.inlineKeyboard)
      .toEqual(requestInboxMessage(pending).content.inlineKeyboard)
    const failedHistory = await harness.dispatch(context, history) as tl.messages.RawMessages
    expect((failedHistory.messages[0] as tl.RawMessage).replyMarkup?._).toBe('replyInlineMarkup')

    const success = await roundTrip(callback) as tl.messages.RawBotCallbackAnswer
    expect(success).toMatchObject({ _: 'messages.botCallbackAnswer', message: '请求已处理', cacheTime: 0 })
    expect(success.alert).toBeFalsy()
    expect(resolveRequest).toHaveBeenCalledTimes(2)
    await expect(store.getRequest(session.platformSessionId, pending.id)).resolves.toMatchObject({ state: 'accepted' })
    const acceptedHistory = await harness.dispatch(context, history) as tl.messages.RawMessages
    expect((acceptedHistory.messages[0] as tl.RawMessage).replyMarkup).toBeUndefined()
    await expect(roundTrip(callback)).resolves.toMatchObject({ message: '请求已处理' })
    expect(resolveRequest).toHaveBeenCalledTimes(2)
  })
})
