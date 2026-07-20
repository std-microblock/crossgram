import { afterEach, describe, expect, it } from 'vitest'
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
  platformSessionId: 'kinds-session', platformId: 'kinds', userId: 'self', credentials: {}, metadata: {},
}

const conversations: IMConversation[] = [
  { id: 'direct', kind: 'direct', title: 'Direct' },
  { id: 'group', kind: 'group', title: 'QQ Group', metadata: { participantsCount: 23 } },
  {
    id: 'subchannel', kind: 'channel', title: 'Discord / support', parentId: 'category', spaceId: 'guild',
    metadata: { participantsCount: 42 },
  },
]

function source(conversation: IMConversation): IMMessage {
  return {
    id: `message-${conversation.id}`, conversationId: conversation.id,
    senderId: conversation.kind === 'direct' ? conversation.id : `sender-${conversation.id}`,
    timestamp: conversations.indexOf(conversation) + 1,
    content: { parts: [{ type: 'text', text: conversation.title }] },
  }
}

const sentTargets: string[] = []
const platform: IMPlatform = {
  id: 'kinds',
  capabilities: {
    history: true,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
  },
  async subscribe() { return () => {} },
  async getDialogs() {
    return { dialogs: conversations.map((conversation) => ({ conversation, unreadCount: 0, lastMessage: source(conversation) })) }
  },
  async getHistory(_session, target) {
    const conversation = conversations.find((item) => item.id === target.id)!
    return { messages: [source(conversation)] }
  },
  async getUser(_session, id) { return { id, firstName: id } },
  async sendMessage(_session, target, content) {
    sentTargets.push(target.id)
    return {
      id: `sent-${sentTargets.length}`, conversationId: target.id, senderId: 'self', outgoing: true,
      timestamp: 100 + sentTargets.length,
      content: { parts: content.parts.flatMap((part) => part.type === 'text' ? [part] : []) },
    }
  },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  sentTargets.length = 0
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createRpc() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, rpc: new DialogRpc(platform, session, new MessageStore(ctx.database)) }
}

function dialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
    limit: 100, hash: Long.ZERO,
  }
}

function historyRequest(peer: tl.TypeInputPeer): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0,
    limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

function roundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('conversation kinds', () => {
  it('materializes direct, group, and hierarchical channel dialogs with the correct peer types', async () => {
    const { ctx, rpc } = await createRpc()
    const result = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    expect(result.dialogs.map((dialog) => dialog.peer._)).toEqual(['peerChannel', 'peerChat', 'peerUser'])
    expect(result.chats).toMatchObject([
      { _: 'channel', title: 'Discord / support', megagroup: true, participantsCount: 42 },
      { _: 'chat', title: 'QQ Group', participantsCount: 23 },
    ])
    expect(result.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual([
      'sender-subchannel', 'sender-group', 'direct',
    ])
    const [stored] = await ctx.database.get('mtproto_im_conversation', { platformConversationId: 'subchannel' })
    expect(stored).toMatchObject({
      kind: 'channel', parentPlatformConversationId: 'category', spacePlatformId: 'guild',
    })
    expect(() => roundTrip(result)).not.toThrow()
  })

  it('accepts chat/channel input peers, returns sender users, and sends to the original target IDs', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const channelId = stableId('peer:subchannel')
    const group = await rpc.getHistory(historyRequest({ _: 'inputPeerChat', chatId: groupId })) as tl.messages.RawMessages
    const channel = await rpc.getHistory(historyRequest({
      _: 'inputPeerChannel', channelId, accessHash: Long.ZERO,
    })) as tl.messages.RawMessages
    expect((group.messages[0] as tl.RawMessage).peerId).toEqual({ _: 'peerChat', chatId: groupId })
    expect((channel.messages[0] as tl.RawMessage).peerId).toEqual({ _: 'peerChannel', channelId })
    expect(group.users).toMatchObject([{ _: 'user', firstName: 'sender-group' }, { _: 'user' }])
    expect(channel.chats).toMatchObject([{ _: 'channel', title: 'Discord / support' }])

    await rpc.sendMessage({
      _: 'messages.sendMessage', peer: { _: 'inputPeerChat', chatId: groupId },
      message: 'to group', randomId: Long.ONE,
    })
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ZERO },
      message: 'to channel', randomId: Long.fromNumber(2),
    })
    expect(sentTargets).toEqual(['group', 'subchannel'])
    await expect(rpc.getHistory(historyRequest({
      _: 'inputPeerUser', userId: groupId, accessHash: Long.ZERO,
    }))).rejects.toMatchObject({ text: 'PEER_ID_INVALID' })
  })

  it('keeps contacts limited to direct conversations', async () => {
    const { rpc } = await createRpc()
    const contacts = await rpc.getContacts()
    expect(contacts.contacts).toHaveLength(1)
    expect(contacts.users).toMatchObject([{ _: 'user', firstName: 'direct' }])
  })
})
