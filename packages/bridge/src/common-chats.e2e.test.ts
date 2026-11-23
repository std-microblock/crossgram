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
import {
  ConversationMemberStore, ConversationMemberSyncWorker,
} from './conversation-members.js'
import { DialogRpc, peerTlSeed, stableId } from './dialogs.js'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import { PlatformRegistry, PlatformSubscriptionManager } from './platform-manager.js'
import type { IMDialog, IMEvent, IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness, type CordisRpcTestHarness } from './rpc-test-harness.js'

const RPC_RESULT_ID = 0xf35c6d01

const session: PlatformSession = {
  platformSessionId: 'common-chats-e2e',
  platformId: 'qq-e2e',
  userId: 'self',
  credentials: {},
  metadata: { firstName: 'Self' },
}

const permissions = {
  manageConversation: false,
  manageMembers: true,
  deleteAnyMessage: false,
  editAnyMessage: false,
  pinMessages: false,
  inviteMembers: true,
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

async function roundTripRpc(rpcHarness: CordisRpcTestHarness, query: tl.RpcMethod): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const decodedRequest = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpcHarness.dispatch(makeContext(), decodedRequest)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

function rpcHarnessFor(dialogs: DialogRpc): CordisRpcTestHarness {
  const harness = createCordisRpcTestHarness()
  harness.register('users.getFullUser', async (_context, request) =>
    dialogs.getFullUser(request as tl.users.RawGetFullUserRequest))
  harness.register('messages.getCommonChats', async (_context, request) =>
    dialogs.getCommonChats(request as tl.messages.RawGetCommonChatsRequest))
  return harness
}

function peerChannelId(conversationId: string): number {
  return stableId(peerTlSeed(session.platformSessionId, conversationId))
}

describe('groups in common MTProto e2e', () => {
  it('syncs group members, persists across DialogRpc restarts, paginates over TL wire, and tracks live joins and leaves', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    let now = 1_700_000_000_000
    const store = new MessageStore(ctx.database)
    const memberStore = new ConversationMemberStore(ctx.database, () => now)

    const sourceDialogs: IMDialog[] = [
      { conversation: { id: 'alice', kind: 'direct', title: 'Alice' }, unreadCount: 0 },
      { conversation: { id: 'bob', kind: 'direct', title: 'Bob' }, unreadCount: 0 },
      { conversation: { id: 'group-a', kind: 'group', title: 'Alpha Group' }, unreadCount: 0 },
      { conversation: { id: 'group-b', kind: 'group', title: 'Beta Group' }, unreadCount: 0 },
      { conversation: { id: 'group-c', kind: 'group', title: 'Gamma Group' }, unreadCount: 0 },
    ]
    const roster: Record<string, string[]> = {
      'group-a': ['self', 'alice'],
      'group-b': ['self', 'alice'],
      'group-c': ['self', 'alice'],
    }
    let emitEvent: ((event: IMEvent) => Promise<void> | void) | undefined
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
        members: { list: true, administrators: true, permissions: true },
      },
      async subscribe(_session, handler) {
        emitEvent = handler
        return () => { emitEvent = undefined }
      },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() {
        return { dialogs: sourceDialogs, total: sourceDialogs.length }
      },
      async getUser(_session, id) {
        return { id, firstName: id[0].toUpperCase() + id.slice(1) }
      },
      async getConversationMembers(_session, conversation) {
        const ids = roster[conversation.id] ?? []
        return {
          members: ids.map((id) => ({
            user: { id, firstName: id[0].toUpperCase() + id.slice(1) },
            role: id === 'self' ? 'owner' as const : 'member' as const,
            permissions,
          })),
          total: ids.length,
        }
      },
    }

    const registry = new PlatformRegistry()
    registry.register(session.platformId, platform)
    const subscriptions = new PlatformSubscriptionManager(
      ctx.database, registry, store, () => {}, undefined, undefined, ctx, 'show', memberStore,
    )
    await subscriptions.ensure(session)
    disposals.push(async () => { await subscriptions.stop() })

    for (const dialog of sourceDialogs) {
      await store.upsertConversation(session, dialog.conversation)
    }
    const aliceRow = await store.upsertUser(session, { id: 'alice', firstName: 'Alice' })
    const bobRow = await store.upsertUser(session, { id: 'bob', firstName: 'Bob' })

    const worker = new ConversationMemberSyncWorker(
      () => [{ platform, session }],
      store,
      memberStore,
      undefined,
      { pageIntervalMs: 0, refreshIntervalMs: 60_000, now: () => now },
    )
    // Sync all 3 groups one tick at a time.
    expect((await worker.tick()).status).toBe('synced')
    expect((await worker.tick()).status).toBe('synced')
    expect((await worker.tick()).status).toBe('synced')
    expect((await worker.tick()).status).toBe('idle')

    // Instantiate a fresh DialogRpc (simulating server restart / new device connection) reading from DB.
    const dialogs = new DialogRpc(platform, session, store, {
      conversationMembers: memberStore,
    })
    const harness = rpcHarnessFor(dialogs)
    disposals.push(async () => { harness.dispose() })

    const aliceInput: tl.TypeInputUser = { _: 'inputUser', userId: aliceRow.id, accessHash: Long.ONE }
    const bobInput: tl.TypeInputUser = { _: 'inputUser', userId: bobRow.id, accessHash: Long.ONE }

    // users.getFullUser over TL wire reports exact commonChatsCount.
    const aliceFull = await roundTripRpc(harness, { _: 'users.getFullUser', id: aliceInput })
    expect(aliceFull).toMatchObject({
      _: 'users.userFull',
      fullUser: { _: 'userFull', id: aliceRow.id, commonChatsCount: 3 },
    })
    const bobFull = await roundTripRpc(harness, { _: 'users.getFullUser', id: bobInput })
    expect(bobFull.fullUser.commonChatsCount).toBe(0)

    // messages.getCommonChats over TL wire paginates across 2 pages and stops on empty 3rd page.
    const expectedIds = ['group-a', 'group-b', 'group-c']
      .map(peerChannelId)
      .sort((left, right) => right - left)

    const page1 = await roundTripRpc(harness, {
      _: 'messages.getCommonChats', userId: aliceInput, maxId: 0, limit: 2,
    })
    expect(page1).toMatchObject({ _: 'messages.chatsSlice', count: 3 })
    expect(page1.chats.map((chat: tl.TypeChat) => chat.id)).toEqual(expectedIds.slice(0, 2))

    const page2 = await roundTripRpc(harness, {
      _: 'messages.getCommonChats', userId: aliceInput, maxId: page1.chats[1].id, limit: 2,
    })
    expect(page2).toMatchObject({ _: 'messages.chatsSlice', count: 3 })
    expect(page2.chats.map((chat: tl.TypeChat) => chat.id)).toEqual(expectedIds.slice(2))

    const page3 = await roundTripRpc(harness, {
      _: 'messages.getCommonChats', userId: aliceInput, maxId: page2.chats[0].id, limit: 2,
    })
    expect(page3).toMatchObject({ _: 'messages.chatsSlice', count: 3, chats: [] })

    // Live group message from Bob immediately registers Bob in group-b.
    await emitEvent!({
      type: 'message',
      conversation: { id: 'group-b', kind: 'group', title: 'Beta Group' },
      message: {
        id: 'live-1',
        conversationId: 'group-b',
        senderId: 'bob',
        timestamp: 1_700_000_010,
        content: { parts: [{ type: 'text', text: 'hello beta!' }] },
      },
    })
    // Wait for subscription queue to settle.
    const bobAfterLive = await roundTripRpc(harness, { _: 'users.getFullUser', id: bobInput })
    expect(bobAfterLive.fullUser.commonChatsCount).toBe(1)
    const bobCommon = await roundTripRpc(harness, {
      _: 'messages.getCommonChats', userId: bobInput, maxId: 0, limit: 20,
    })
    expect(bobCommon).toMatchObject({ _: 'messages.chats' })
    expect(bobCommon.chats.map((chat: tl.TypeChat) => chat.id)).toEqual([peerChannelId('group-b')])

    // Alice leaves group-c; periodic refresh reconciles and removes group-c from Alice's common chats.
    roster['group-c'] = ['self']
    now += 65_000
    expect((await worker.tick()).status).toBe('synced')
    expect((await worker.tick()).status).toBe('synced')
    expect((await worker.tick()).status).toBe('synced')

    const aliceAfterLeave = await roundTripRpc(harness, { _: 'users.getFullUser', id: aliceInput })
    expect(aliceAfterLeave.fullUser.commonChatsCount).toBe(2)
    const aliceRemaining = await roundTripRpc(harness, {
      _: 'messages.getCommonChats', userId: aliceInput, maxId: 0, limit: 20,
    })
    expect(aliceRemaining).toMatchObject({ _: 'messages.chats' })
    expect(aliceRemaining.chats.map((chat: tl.TypeChat) => chat.id)).toEqual(
      ['group-a', 'group-b'].map(peerChannelId).sort((left, right) => right - left),
    )
  })
})
