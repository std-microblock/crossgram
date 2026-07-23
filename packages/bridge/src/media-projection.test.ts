import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { DialogRpc, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'media-session', platformId: 'media', userId: 'self', credentials: {}, metadata: {},
}

const conversation: IMConversation = { id: 'album-room', kind: 'direct', title: 'Album room' }

const album: IMMessage = {
  id: 'logical-album',
  sourceIds: ['platform-photo-message', 'platform-file-message'],
  conversationId: conversation.id,
  senderId: 'alice',
  timestamp: 1_800_000_000,
  content: {
    parts: [
      { type: 'text', text: 'album caption' },
      {
        type: 'media',
        media: {
          id: 'photo', kind: 'image', name: 'photo.png', mimeType: 'image/png',
          size: 1234, width: 800, height: 600, locator: { remote: 'photo' },
        },
      },
      {
        type: 'media',
        media: {
          id: 'document', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf',
          size: 5678, locator: { remote: 'document' },
        },
      },
    ],
  },
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
  },
  async subscribe() { return () => {} },
  async sendMessage() { return album },
  async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: album }] } },
  async getHistory() { return { messages: [album] } },
  async getUser(_session, id) { return { id, firstName: id === 'alice' ? 'Alice' : 'Album room' } },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return new MessageStore(ctx.database)
}

function historyRequest(): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory',
    peer: { _: 'inputPeerUser', userId: stableId(`peer:${conversation.id}`), accessHash: Long.ZERO },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

function dialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('rich-media projection', () => {
  it('materializes persisted dialog previews without fetching every conversation history', async () => {
    const store = await createStore()
    const getHistory = vi.fn(async () => ({ messages: [album] }))
    const result = await new DialogRpc({ ...platform, getHistory }, session, store)
      .getDialogs(dialogsRequest()) as tl.messages.RawDialogs

    expect(getHistory).not.toHaveBeenCalled()
    expect(result.dialogs).toHaveLength(1)
    expect((result.messages[0] as tl.RawMessage).media?._).toBe('messageMediaDocument')
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('does not fetch history for a stored dialog whose cold-start preview is absent', async () => {
    const store = await createStore()
    const getHistory = vi.fn(async () => ({ messages: [album] }))
    const getDialogs = vi.fn(async () => ({ dialogs: [{ conversation, unreadCount: 0 }] }))
    const result = await new DialogRpc({ ...platform, getDialogs, getHistory }, session, store)
      .getDialogs(dialogsRequest()) as tl.messages.RawDialogs

    expect(getHistory).not.toHaveBeenCalled()
    expect(result.dialogs).toMatchObject([{ topMessage: 0 }])
    expect(result.messages).toEqual([])
  })

  it('expands mixed media into consecutive ungrouped Telegram messages', async () => {
    const store = await createStore()
    const rpc = new DialogRpc(platform, session, store)
    const result = await rpc.getHistory(historyRequest()) as tl.messages.RawMessages
    const messages = result.messages as tl.RawMessage[]

    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.id)).toEqual([0x40000001, 0x40000000])
    expect(messages.map((message) => message.groupedId)).toEqual([undefined, undefined])
    expect(messages.map((message) => message.message)).toEqual(['', 'album caption'])
    expect(messages.map((message) => message.media?._)).toEqual([
      'messageMediaDocument', 'messageMediaPhoto',
    ])
    expect((messages[0].media as tl.RawMessageMediaDocument).document).toMatchObject({
      _: 'document', accessHash: Long.fromNumber(2), mimeType: 'application/pdf', size: 5678,
      attributes: [{ _: 'documentAttributeFilename', fileName: 'report.pdf' }],
    })
    expect((messages[1].media as tl.RawMessageMediaPhoto).photo).toMatchObject({
      _: 'photo', accessHash: Long.fromNumber(1), sizes: [{ _: 'photoSize', w: 800, h: 600, size: 1234 }],
    })
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('keeps same-kind media grouped as a Telegram album', async () => {
    const store = await createStore()
    const imageAlbum: IMMessage = {
      ...album,
      id: 'image-album',
      content: {
        parts: [
          { type: 'media', media: { id: 'one', kind: 'image', locator: null } },
          { type: 'media', media: { id: 'two', kind: 'image', locator: null } },
        ],
      },
    }
    const imagePlatform: IMPlatform = {
      ...platform,
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: imageAlbum }] } },
      async getHistory() { return { messages: [imageAlbum] } },
    }
    const result = await new DialogRpc(imagePlatform, session, store).getHistory(historyRequest()) as tl.messages.RawMessages
    const messages = result.messages as tl.RawMessage[]
    expect(messages[0].groupedId?.toString()).toBe(messages[1].groupedId?.toString())
    expect(messages[0].groupedId).toBeDefined()
  })

  it('reuses message and grouped IDs in a fresh DialogRpc instance', async () => {
    const store = await createStore()
    const first = await new DialogRpc(platform, session, store).getHistory(historyRequest()) as tl.messages.RawMessages
    const second = await new DialogRpc(platform, session, store).getHistory(historyRequest()) as tl.messages.RawMessages
    const pick = (result: tl.messages.RawMessages) => (result.messages as tl.RawMessage[]).map((message) => ({
      id: message.id,
      groupedId: message.groupedId?.toString(),
      media: message.media?._,
    }))
    expect(pick(second)).toEqual(pick(first))
  })

  it('requests and materializes bounded history windows instead of loading the full conversation', async () => {
    const store = await createStore()
    const messages = Array.from({ length: 1_000 }, (_, index): IMMessage => ({
      id: String(1_000 - index),
      conversationId: conversation.id,
      senderId: 'alice',
      timestamp: 1_000 - index,
      content: { parts: [{ type: 'text', text: String(1_000 - index) }] },
    }))
    const queries: Array<{ limit?: number, before?: { id: string } }> = []
    const pagedPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [{ conversation, unreadCount: 0, lastMessage: messages[0] }] }
      },
      async getHistory(_session, _conversation, query) {
        queries.push({ limit: query?.limit, before: query?.before })
        const start = query?.before ? messages.findIndex((message) => message.id === query.before!.id) + 1 : 0
        return { messages: messages.slice(start, start + (query?.limit ?? 100)) }
      },
    }
    const rpc = new DialogRpc(pagedPlatform, session, store)
    const first = await rpc.getHistory({ ...historyRequest(), limit: 2 }) as tl.messages.RawMessages
    expect(queries).toMatchObject([{ limit: 3, before: undefined }])
    expect(first.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual(['1000', '999'])

    const offsetId = (first.messages[1] as tl.RawMessage).id
    const second = await rpc.getHistory({ ...historyRequest(), offsetId, limit: 2 }) as tl.messages.RawMessages
    expect(queries[1]).toMatchObject({ limit: 3, before: { id: '999' } })
    expect(second.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual(['998', '997'])
    expect((await store.readHistory(session.platformSessionId, conversation.id, { limit: 100 })).length)
      .toBeLessThanOrEqual(6)
  })

  it('lets an adapter fetch around unread state for a persisted negative-offset window', async () => {
    const store = await createStore()
    const messages = ['old', 'read', 'unread', 'latest'].map((id, index): IMMessage => ({
      id,
      conversationId: conversation.id,
      senderId: 'alice',
      timestamp: index + 1,
      content: { parts: [{ type: 'text', text: id }] },
    }))
    const queries: Array<{ limit?: number, before?: { id: string } }> = []
    const unreadPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [{
          conversation,
          unreadCount: 2,
          lastMessage: messages[3],
          readInboxMaxMessage: messages[1],
        }] }
      },
      async getHistory(_session, _conversation, query) {
        queries.push({ limit: query?.limit, before: query?.before })
        return { messages }
      },
    }
    const rpc = new DialogRpc(unreadPlatform, session, store)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const dialog = dialogs.dialogs[0] as tl.RawDialog
    const history = await rpc.getHistory({
      ...historyRequest(),
      offsetId: dialog.readInboxMaxId,
      addOffset: -2,
      limit: 3,
    }) as tl.messages.RawMessages

    expect(queries).toEqual([{ limit: 6, before: undefined }])
    expect(history.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'unread', 'read', 'old',
    ])
  })
})
