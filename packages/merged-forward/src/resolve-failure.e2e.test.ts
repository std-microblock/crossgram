import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  DialogRpc,
  MessageProjectionPipeline,
  MessageStore,
  MtprotoBridgeService,
  defineModels,
  type BridgeSessionState,
  type IMConversation,
  type IMMessage,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type IMPlatform,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'merged-forward-resolve-failure', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const outer: IMConversation = { id: 'failure-outer', kind: 'group', title: 'Failure outer' }
const bundle: IMMessageBundle = {
  id: 'bundle:resolve-failure', title: '群聊的聊天记录', preview: 'Alice: hi',
  locator: { root: 'resolve-failure' },
}
const innerMessages: IMMessageSnapshot[] = [{
  id: 'inner', senderId: 'alice', timestamp: 10,
  sender: { id: 'alice', firstName: 'Alice' },
  content: { parts: [{ type: 'text', text: 'hi' }] },
}, {
  id: 'inner-bob', senderId: 'bob', timestamp: 11,
  sender: { id: 'bob', firstName: 'Bob' },
  content: { parts: [{ type: 'text', text: 'yo' }] },
}]
const outerMessage: IMMessage = {
  id: 'failure-outer-message', conversationId: outer.id, senderId: 'alice', timestamp: 20,
  sender: { id: 'alice', firstName: 'Alice' },
  content: { parts: [{ type: 'message-bundle', bundle }] },
}

/** QQ 侧接口的可用性，测试按需把它们切成失败。 */
const archive = { loadFails: false, avatarFails: false }

const platform: IMPlatform = {
  capabilities: {
    history: true,
    readState: { markRead: false, events: false },
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  messageBundles: {
    async load() {
      if (archive.loadFails) throw new Error('qq archive timeout')
      return innerMessages
    },
    async avatar() {
      if (archive.avatarFails) throw new Error('avatar backend down')
      return undefined
    },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getDialogs() {
    return { dialogs: [{ conversation: outer, lastMessage: outerMessage, unreadCount: 0 }] }
  },
  async getHistory(_session, conversation) {
    return { messages: conversation.id === outer.id ? [outerMessage] : [] }
  },
  async getUser(_session, id) { return { id, firstName: id } },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  archive.loadFails = false
  archive.avatarFails = false
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

function makeDialogs(store: MessageStore, pipeline: MessageProjectionPipeline): DialogRpc {
  return new DialogRpc(
    platform, session, store,
    undefined, undefined, 1,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    pipeline,
  )
}

/** 起一个真实的 relay（sqlite + MessageStore + bridge + merged-forward），并给出重启插件的入口。 */
async function startRelay() {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: ':memory:' })
  await Promise.all([database, sqlite])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const mtproto = ctx.plugin(Mtproto, { host: '127.0.0.1', port: 0 })
  await mtproto
  const pipeline = new MessageProjectionPipeline(ctx)
  const store = new MessageStore(ctx.database, undefined, undefined, undefined, pipeline)
  const dialogs = makeDialogs(store, pipeline)
  const bridge = ctx.plugin((scope) => {
    new MtprotoBridgeService(scope, async () => ({
      generation: {}, platform, session, projection: pipeline, dialogs, stickers: {} as never,
    } satisfies BridgeSessionState))
  })
  await bridge
  let plugin = ctx.plugin(mergedForward)
  await plugin
  disposals.push(async () => {
    await plugin.dispose()
    await bridge.dispose()
    await mtproto.dispose()
    await sqlite.dispose()
    await database.dispose()
  })
  // 重启 feature 插件：进程内的转发缓存随之清空，逼着每条 RPC 从落库消息重建。
  const restart = async () => {
    await plugin.dispose()
    plugin = ctx.plugin(mergedForward)
    await plugin
  }
  return { ctx, dialogs, restart }
}

/** 从对话列表里拿到投影出的深链，返回其中的虚拟群 ID。 */
async function outerChatId(dialogs: DialogRpc): Promise<number> {
  const listed = await dialogs.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }) as tl.messages.RawDialogs
  const projected = listed.messages.find((item) => item._ === 'message') as tl.RawMessage
  const entity = projected.entities?.find(
    (item): item is tl.RawMessageEntityTextUrl => item._ === 'messageEntityTextUrl',
  )
  if (!entity) throw new Error('merged-forward projection did not create a deep link')
  return Number(/bridgebundle_(\d+)/.exec(entity.url)![1])
}

function historyRequest(chatId: number) {
  return {
    _: 'messages.getHistory' as const,
    peer: { _: 'inputPeerChat' as const, chatId },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
    maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

describe('merged-forward resolve failures', () => {
  it('answers a retryable error, never an unknown username, when the store fails', async () => {
    const { ctx, dialogs, restart } = await startRelay()
    const chatId = await outerChatId(dialogs)
    await restart()
    // 模拟 DB 抖动：读落库消息直接失败。
    dialogs.readStoredMessage = async () => { throw new Error('database offline') }

    const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never
    const resolved = await ctx.mtproto.dispatch(rpc, {
      _: 'contacts.resolveUsername', username: `bridgebundle_${chatId}`,
    } as never)
    // 400 USERNAME_NOT_OCCUPIED 会被客户端当成「链接已失效」而永久缓存下来，用户点了没反应；
    // 这里必须是可重试的服务端错误，客户端下一轮会再敲一次。
    expect(resolved).toMatchObject({
      _: 'mt_rpc_error', errorCode: 500, errorMessage: 'MERGED_FORWARD_UNAVAILABLE',
    })
    expect(JSON.stringify(resolved)).not.toContain('USERNAME_NOT_OCCUPIED')

    // 同一次故障下，非转发 peer 仍要落到默认实现：宽松的 lookup 用 undefined 表示「不是我的 peer」，
    // 不能把普通群的 getHistory 顶成 500。
    const fallback: tl.messages.RawGetHistoryRequest[] = []
    ctx.mtproto.register('messages.getHistory', async (_rpc, request) => {
      fallback.push(request as tl.messages.RawGetHistoryRequest)
      return { _: 'messages.messages', messages: [], topics: [], chats: [], users: [] }
    })
    await expect(ctx.mtproto.dispatch(rpc, historyRequest(777) as never)).resolves.toMatchObject({
      _: 'messages.messages', messages: [],
    })
    expect(fallback).toHaveLength(1)
    expect(fallback[0]!.peer).toEqual({ _: 'inputPeerChat', chatId: 777 })
  })

  it('still resolves the peer when the bundle archive and avatars are unavailable', async () => {
    const { ctx, dialogs, restart } = await startRelay()
    const chatId = await outerChatId(dialogs)
    await restart()
    // QQ 归档接口与头像接口同时失败：它们只提供 participantsCount 与头像这类装饰，
    // 聊天记录本体走 messages.getHistory，不该被装饰拖成错误。
    archive.loadFails = true
    archive.avatarFails = true

    const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'contacts.resolveUsername', username: `bridgebundle_${chatId}`,
    } as never)).resolves.toMatchObject({
      _: 'contacts.resolvedPeer',
      peer: { _: 'peerChat', chatId },
      chats: [{
        _: 'chat', id: chatId, title: bundle.title,
        // 归档不可用时人数退化为 1（至少是“一个会话”），头像退化为空。
        participantsCount: 1,
        photo: { _: 'chatPhotoEmpty' },
      }],
    })
    // 归档恢复后同一个链接照常给出真实人数。
    archive.loadFails = false
    await restart()
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'contacts.resolveUsername', username: `bridgebundle_${chatId}`,
    } as never)).resolves.toMatchObject({
      _: 'contacts.resolvedPeer',
      chats: [{ _: 'chat', id: chatId, participantsCount: 2 }],
    })
  })
})
