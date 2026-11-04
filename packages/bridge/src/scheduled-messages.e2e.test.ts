import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import type { RpcResult, ServerRpcContext } from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness } from './rpc-test-harness.js'
import { ScheduledMessageStore } from './scheduled-messages.js'

const RPC_RESULT_ID = 0xf35c6d01
const session: PlatformSession = {
  platformSessionId: 'scheduled-e2e',
  platformId: 'scheduled-e2e',
  userId: 'self',
  credentials: {},
  metadata: {},
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

async function roundTripRpc(
  rpc: ReturnType<typeof createCordisRpcTestHarness>,
  query: tl.RpcMethod,
): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const request = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpc.dispatch(makeContext(), request)
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

/**
 * 按 Telegram Desktop 的 ScheduledMessages 语义维护客户端的定时列表：
 * 本地「发送中」占位只能被 `updateMessageID` 升级为服务端 ID，
 * `getScheduledHistory` 不会清掉发送中的占位，`updateDeleteScheduledMessages` 只按服务端 ID 删除。
 */
class ScheduledListModel {
  readonly items = new Map<string, { serverId?: number, text: string }>()
  private readonly _pendingRandom = new Map<string, string>()
  private _nextLocal = 0

  sendLocal(randomId: Long, text: string): void {
    this.items.set(`local-${++this._nextLocal}`, { text })
    this._pendingRandom.set(randomId.toString(), `local-${this._nextLocal}`)
  }

  apply(updates: tl.TypeUpdate[]): void {
    for (const update of updates) {
      if (update._ === 'updateMessageID') {
        const key = this._pendingRandom.get(update.randomId.toString())
        if (!key) continue
        this._pendingRandom.delete(update.randomId.toString())
        const item = this.items.get(key)!
        if ([...this.items.values()].some((other) => other.serverId === update.id)) this.items.delete(key)
        else item.serverId = update.id
      } else if (update._ === 'updateNewScheduledMessage') {
        this._append(update.message as tl.RawMessage)
      } else if (update._ === 'updateDeleteScheduledMessages') {
        for (const [key, item] of this.items) {
          if (item.serverId !== undefined && update.messages.includes(item.serverId)) this.items.delete(key)
        }
      }
    }
  }

  applyHistory(messages: tl.RawMessage[]): void {
    const received = new Set(messages.map((message) => this._append(message)))
    for (const [key, item] of this.items) {
      if (item.serverId !== undefined && !received.has(key)) this.items.delete(key)
    }
  }

  sending(): number {
    return [...this.items.values()].filter((item) => item.serverId === undefined).length
  }

  private _append(message: tl.RawMessage): string {
    for (const [key, item] of this.items) {
      if (item.serverId === message.id) return key
    }
    const key = `server-${message.id}`
    this.items.set(key, { serverId: message.id, text: message.message })
    return key
  }
}

describe('scheduled message RPC e2e', () => {
  it('confirms the local placeholder and removes it once the message is sent', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    let sentCount = 0
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
        conversations: { groups: false, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() {
        return { dialogs: [{ conversation: { id: 'peer', kind: 'direct' as const, title: 'Peer' }, unreadCount: 0 }] }
      },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id } },
      async sendMessage(_session, target, input): Promise<IMMessage> {
        return {
          id: `sent-${++sentCount}`, conversationId: target.id, senderId: session.userId,
          outgoing: true, timestamp: Math.floor(Date.now() / 1_000), content: input as IMMessage['content'],
        }
      },
    }
    const store = new MessageStore(ctx.database)
    const scheduled = new ScheduledMessageStore(ctx.database)
    const peerId = (await store.upsertUser(session, { id: 'peer', firstName: 'Peer' })).id
    const dialogs = new DialogRpc(platform, session, store, {
        dcId: 1,
        authenticatedSelfId: 1,
        scheduled: scheduled,
    }
    )
    const rpc = createCordisRpcTestHarness()
    disposals.push(async () => rpc.dispose())
    rpc.register('messages.sendMessage', async (_context, request) =>
      dialogs.sendMessage(request as tl.messages.RawSendMessageRequest))
    rpc.register('messages.getScheduledHistory', async (_context, request) =>
      dialogs.getScheduledHistory(request as tl.messages.RawGetScheduledHistoryRequest))
    rpc.register('messages.sendScheduledMessages', async (_context, request) =>
      dialogs.sendScheduledMessages(request as tl.messages.RawSendScheduledMessagesRequest))

    const peer = { _: 'inputPeerUser' as const, userId: peerId, accessHash: Long.ZERO }
    const client = new ScheduledListModel()
    const history = async () => (await roundTripRpc(rpc, {
      _: 'messages.getScheduledHistory', peer, hash: Long.ZERO,
    }) as tl.messages.RawMessages).messages as tl.RawMessage[]

    for (const [randomId, text] of [[Long.fromNumber(501), 'first'], [Long.fromNumber(502), 'second']] as const) {
      client.sendLocal(randomId, text)
      const created = await roundTripRpc(rpc, {
        _: 'messages.sendMessage', peer, message: text, randomId,
        scheduleDate: Math.floor(Date.now() / 1_000) + 3_600,
      }) as tl.RawUpdates
      client.apply(created.updates)
    }
    expect(client.sending()).toBe(0)
    client.applyHistory(await history())
    expect([...client.items.values()].map((item) => item.text)).toEqual(['first', 'second'])

    const firstId = [...client.items.values()].find((item) => item.text === 'first')!.serverId!
    const sentNow = await roundTripRpc(rpc, {
      _: 'messages.sendScheduledMessages', peer, id: [firstId],
    }) as tl.RawUpdates
    expect(sentNow.updates.map((update) => update._)).not.toContain('updateMessageID')
    client.apply(sentNow.updates)
    client.applyHistory(await history())
    expect([...client.items.values()].map((item) => item.text)).toEqual(['second'])
    expect(client.sending()).toBe(0)
  })
})
