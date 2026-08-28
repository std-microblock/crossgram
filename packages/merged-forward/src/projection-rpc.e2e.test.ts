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
  stableId,
  type BridgeSessionState,
  type IMConversation,
  type IMMessageBundle,
  type IMMessage,
  type IMMessageSnapshot,
  type IMPlatform,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'merged-forward-rpc-e2e', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const outer: IMConversation = { id: 'outer-dialog', kind: 'group', title: 'Outer dialog' }
const bundle: IMMessageBundle = {
  id: 'bundle:rpc-e2e', title: 'Alice 和 Bob 的聊天记录',
  preview: 'Alice: first\nBob: latest', locator: { root: 'rpc-e2e' },
}
const innerMessages: IMMessageSnapshot[] = [
  {
    id: 'inner-media', senderId: 'alice', timestamp: 99,
    sender: { id: 'alice', firstName: 'Alice' },
    content: { parts: [{
      type: 'media',
      media: {
        id: 'archived-file', kind: 'file', name: 'archive.txt', mimeType: 'text/plain', size: 6,
        locator: { id: 'archived-file' },
      },
    }] },
  },
  {
    id: 'inner-first', senderId: 'alice', timestamp: 100,
    sender: { id: 'alice', firstName: 'Alice' },
    content: { parts: [{ type: 'text', text: 'first' }] },
  },
  {
    id: 'inner-latest', senderId: 'bob', timestamp: 101,
    sender: { id: 'bob', firstName: 'Bob' },
    content: { parts: [{ type: 'text', text: 'latest' }] },
  },
]
const outerMessage: IMMessage = {
  id: 'outer-message', conversationId: outer.id, senderId: 'alice', timestamp: 102,
  sender: { id: 'alice', firstName: 'Alice' },
  content: { parts: [{ type: 'message-bundle', bundle }] },
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    readState: { markRead: false, events: false },
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  messageBundles: { async load() { return innerMessages } },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getDialogs() {
    return { dialogs: [{ conversation: outer, lastMessage: outerMessage, unreadCount: 0 }] }
  },
  async getHistory(_session, conversation) {
    if (conversation.id === outer.id) return { messages: [outerMessage] }
    return { messages: [] }
  },
  async getUser(_session, id) { return { id, firstName: id } },
  async *downloadMedia() { yield new TextEncoder().encode('bundle') },
  async resolveMediaUrl() {
    return { url: 'https://cdn.example.test/bundle', expiresAt: Date.now() + 60_000, supportsRange: true }
  },
}

const disposals: Array<() => Promise<void>> = []

function makeDialogs(store: MessageStore, pipeline: MessageProjectionPipeline): DialogRpc {
  return new DialogRpc(
    platform, session, store,
    undefined, undefined, 1,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    pipeline,
  )
}

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

describe('merged-forward projection and RPC e2e', () => {
  it('projects linked history and serves every synthetic peer RPC without conversation-view', async () => {
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
    const plugin = ctx.plugin(mergedForward)
    await plugin
    disposals.push(async () => {
      await plugin.dispose()
      await bridge.dispose()
      await mtproto.dispose()
      await sqlite.dispose()
      await database.dispose()
    })

    const dialogsResult = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const projectedOuter = dialogsResult.messages.find((item) => item._ === 'message') as tl.RawMessage
    const entity = projectedOuter.entities?.find(
      (item): item is tl.RawMessageEntityTextUrl => item._ === 'messageEntityTextUrl',
    )
    if (!entity) throw new Error('merged-forward projection did not create a deep link')
    const chatId = stableId(`merged-forward-chat:${bundle.id}`)
    const targetId = Number(new URL(entity.url).pathname.split('/').at(-1))
    expect(entity.url).toBe(`https://t.me/bridgebundle_${chatId}/${targetId}`)
    expect(projectedOuter.media).toMatchObject({ _: 'messageMediaWebPage' })

    const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never
    const resolvedUsername = await ctx.mtproto.dispatch(rpc, {
      _: 'contacts.resolveUsername', username: `bridgebundle_${chatId}`,
    } as never)
    if (resolvedUsername._ === 'mt_rpc_error') throw new Error(resolvedUsername.errorMessage)
    expect(resolvedUsername).toMatchObject({
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId },
      chats: [{ _: 'chat', id: chatId, title: bundle.title }],
    })
    const peer = { _: 'inputPeerChat' as const, chatId }
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.getHistory', peer,
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
      maxId: 0, minId: 0, hash: Long.ZERO,
    } as never)).resolves.toMatchObject({
      messages: [
        { _: 'message', peerId: { _: 'peerChat', chatId }, message: 'latest' },
        { _: 'message', peerId: { _: 'peerChat', chatId }, message: 'first' },
        { _: 'message', peerId: { _: 'peerChat', chatId }, media: { _: 'messageMediaDocument' } },
      ],
    })
    const projectedHistory = await ctx.mtproto.dispatch(rpc, {
      _: 'messages.getHistory', peer,
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
      maxId: 0, minId: 0, hash: Long.ZERO,
    } as never) as tl.messages.RawMessagesSlice
    const mediaMessage = projectedHistory.messages.find((message) =>
      message._ === 'message' && message.media?._ === 'messageMediaDocument') as tl.RawMessage
    if (mediaMessage.media?._ !== 'messageMediaDocument'
      || !mediaMessage.media.document
      || mediaMessage.media.document._ !== 'document') throw new Error('bundle media was not projected')
    const document = mediaMessage.media.document
    const location = {
      _: 'inputDocumentFileLocation' as const,
      id: document.id,
      accessHash: document.accessHash,
      fileReference: document.fileReference,
      thumbSize: '',
    }
    await expect(dialogs.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location, offset: 0, limit: 16,
    })).resolves.toMatchObject({ bytes: new TextEncoder().encode('bundle') })
    await expect(dialogs.getFileUrl(location)).resolves.toMatchObject({
      _: 'dataJSON', data: expect.stringContaining('https://cdn.example.test/bundle'),
    })
    await expect(ctx.database.get('mtproto_im_media', {})).resolves.toEqual([])
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: targetId }],
    } as never)).resolves.toMatchObject({
      messages: [{ _: 'message', id: targetId, peerId: { _: 'peerChat', chatId }, message: 'latest' }],
    })
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer }],
    } as never)).resolves.toMatchObject({
      dialogs: [{ peer: { _: 'peerChat', chatId }, topMessage: targetId }],
      messages: [{ _: 'message', id: targetId, message: 'latest' }],
    })
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.getFullChat', chatId,
    } as never)).resolves.toMatchObject({
      _: 'messages.chatFull',
      fullChat: { _: 'chatFull', id: chatId, participants: { _: 'chatParticipantsForbidden', chatId } },
    })
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.getPeerSettings', peer,
    } as never)).resolves.toMatchObject({ _: 'messages.peerSettings', chats: [{ id: chatId }] })
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.getScheduledHistory', peer, hash: Long.ZERO,
    } as never)).resolves.toMatchObject({ _: 'messages.messages', messages: [] })
    await expect(ctx.mtproto.dispatch(rpc, {
      _: 'messages.readHistory', peer, maxId: targetId,
    } as never)).resolves.toMatchObject({ _: 'messages.affectedMessages' })
  })
})
