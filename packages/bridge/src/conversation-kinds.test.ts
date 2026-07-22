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
    id: 'parent-channel', kind: 'channel', title: 'Discord / general', parentId: 'category', spaceId: 'guild',
    metadata: { participantsCount: 42 },
  },
  {
    id: 'subchannel', kind: 'channel', title: 'Discord / support', parentId: 'parent-channel', spaceId: 'guild',
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
const actionCalls: string[] = []
const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
    members: { list: true, administrators: true, permissions: true },
    messageActions: {
      delete: { own: { supported: true, maxAgeSeconds: 120 }, others: { supported: true } },
      edit: { mode: 'native' }, forward: { mode: 'native', preservesAuthor: true },
    },
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
  async getConversationMembers(_session, target) {
    if (target.id === 'direct') return { members: [], total: 0 }
    const permissions = (admin: boolean) => ({
      manageConversation: admin, manageMembers: admin, deleteAnyMessage: admin,
      editAnyMessage: admin, pinMessages: admin, inviteMembers: true,
    })
    return {
      total: 3,
      members: [
        { user: { id: 'self', firstName: 'Self' }, role: 'owner' as const, permissions: permissions(true) },
        { user: { id: 'alice', firstName: 'Alice' }, role: 'administrator' as const, permissions: permissions(true) },
        { user: { id: 'bob', firstName: 'Bob' }, role: 'member' as const, permissions: permissions(false) },
      ],
    }
  },
  async sendMessage(_session, target, content) {
    sentTargets.push(target.id)
    return {
      id: `sent-${sentTargets.length}`, conversationId: target.id, senderId: 'self', outgoing: true,
      timestamp: 100 + sentTargets.length,
      content: { parts: content.parts.flatMap((part) => part.type === 'text' ? [part] : []) },
    }
  },
  async deleteMessages(_session, target, ids, options) {
    actionCalls.push(`delete:${target.id}:${ids.join(',')}:${options.forEveryone}`)
  },
  async editMessage(_session, target, content) {
    actionCalls.push(`edit:${target.conversationId}:${target.targetId}`)
    return {
      ...source(conversations.find((item) => item.id === target.conversationId)!),
      id: target.messageId, outgoing: true, senderId: 'self',
      content: { parts: content.parts.flatMap((part) => part.type === 'text' ? [part] : []) },
    }
  },
  async forwardMessages(_session, from, ids, to) {
    actionCalls.push(`forward:${from.id}:${ids.join(',')}:${to.id}`)
    return ids.map((id, index) => ({
      id: `forwarded-${index}`, conversationId: to.id, senderId: 'self', outgoing: true,
      timestamp: 200 + index, content: { parts: [{ type: 'text' as const, text: `forwarded ${id}` }] },
    }))
  },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  sentTargets.length = 0
  actionCalls.length = 0
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
      { _: 'channel', title: 'Discord / general', megagroup: true, forum: true, participantsCount: 42 },
      { _: 'chat', title: 'QQ Group', participantsCount: 23 },
    ])
    expect(result.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual([
      'sender-parent-channel', 'sender-group', 'direct',
    ])
    const [stored] = await ctx.database.get('mtproto_im_conversation', { platformConversationId: 'subchannel' })
    expect(stored).toMatchObject({
      kind: 'channel', parentPlatformConversationId: 'parent-channel', spacePlatformId: 'guild',
    })
    expect(() => roundTrip(result)).not.toThrow()
  })

  it('accepts chat/channel input peers, returns sender users, and sends to the original target IDs', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const channelId = stableId('peer:parent-channel')
    const group = await rpc.getHistory(historyRequest({ _: 'inputPeerChat', chatId: groupId })) as tl.messages.RawMessages
    const channel = await rpc.getHistory(historyRequest({
      _: 'inputPeerChannel', channelId, accessHash: Long.ZERO,
    })) as tl.messages.RawMessages
    expect((group.messages[0] as tl.RawMessage).peerId).toEqual({ _: 'peerChat', chatId: groupId })
    expect((channel.messages[0] as tl.RawMessage).peerId).toEqual({ _: 'peerChannel', channelId })
    expect(group.users).toMatchObject([{ _: 'user', firstName: 'sender-group' }, { _: 'user' }])
    expect(channel.chats).toMatchObject([{ _: 'channel', title: 'Discord / general' }])

    await rpc.sendMessage({
      _: 'messages.sendMessage', peer: { _: 'inputPeerChat', chatId: groupId },
      message: 'to group', randomId: Long.ONE,
    })
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ZERO },
      message: 'to channel', randomId: Long.fromNumber(2),
    })
    expect(sentTargets).toEqual(['group', 'parent-channel'])
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

  it('projects edit, forward, and administrator deletion through platform actions', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const directId = stableId('peer:direct')
    const groupPeer = { _: 'inputPeerChat' as const, chatId: groupId }
    const directPeer = { _: 'inputPeerUser' as const, userId: directId, accessHash: Long.ZERO }
    const groupHistory = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
    const groupMessageId = (groupHistory.messages[0] as tl.RawMessage).id

    const edited = await rpc.editMessage({
      _: 'messages.editMessage', peer: groupPeer, id: groupMessageId, message: 'edited via abstraction',
    }) as tl.RawUpdates
    expect(edited.updates).toMatchObject([{
      _: 'updateEditMessage', message: { id: groupMessageId, message: 'edited via abstraction' },
    }])

    const forwarded = await rpc.forwardMessages({
      _: 'messages.forwardMessages', fromPeer: groupPeer, id: [groupMessageId],
      randomId: [Long.fromNumber(99)], toPeer: directPeer,
    }) as tl.RawUpdates
    expect(forwarded.updates).toMatchObject([
      { _: 'updateMessageID', randomId: Long.fromNumber(99) },
      { _: 'updateNewMessage', message: { message: 'forwarded message-group' } },
    ])

    await expect(rpc.deleteMessages({
      _: 'messages.deleteMessages', revoke: true, id: [groupMessageId],
    })).resolves.toMatchObject({ _: 'messages.affectedMessages', ptsCount: 1 })
    expect(actionCalls).toEqual([
      'edit:group:message-group',
      'forward:group:message-group:direct',
      'delete:group:message-group:true',
    ])
  })

  it('projects delete-and-resend editing as delete plus new-message updates', async () => {
    const actions = platform.capabilities.messageActions!
    const originalMode = actions.edit.mode
    actions.edit.mode = 'delete-and-resend'
    try {
      const { rpc } = await createRpc()
      await rpc.getDialogs(dialogsRequest())
      const groupId = stableId('peer:group')
      const groupPeer = { _: 'inputPeerChat' as const, chatId: groupId }
      const history = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
      const originalId = (history.messages[0] as tl.RawMessage).id

      const result = await rpc.editMessage({
        _: 'messages.editMessage', peer: groupPeer, id: originalId, message: 'replacement body',
      }) as tl.RawUpdates
      expect(result.updates).toMatchObject([
        { _: 'updateDeleteMessages', messages: [originalId], ptsCount: 1 },
        { _: 'updateNewMessage', message: { message: 'replacement body' }, ptsCount: 1 },
      ])
      expect((result.updates[1] as tl.RawUpdateNewMessage).message).not.toMatchObject({ id: originalId })
      expect(actionCalls).toEqual(['delete:group:message-group:true'])
      expect(sentTargets).toEqual(['group'])
    } finally {
      actions.edit.mode = originalMode
    }
  })

  it('enforces own-message delete and edit windows while leaving administrator deletion unlimited', async () => {
    const actions = platform.capabilities.messageActions!
    const originalEditLimit = actions.edit.maxAgeSeconds
    actions.edit.maxAgeSeconds = 1
    try {
      const { rpc } = await createRpc()
      await rpc.getDialogs(dialogsRequest())
      const groupId = stableId('peer:group')
      const groupPeer = { _: 'inputPeerChat' as const, chatId: groupId }
      const history = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
      const incomingId = (history.messages[0] as tl.RawMessage).id
      await expect(rpc.editMessage({
        _: 'messages.editMessage', peer: groupPeer, id: incomingId, message: 'too late',
      })).rejects.toMatchObject({ text: 'MESSAGE_EDIT_TIME_EXPIRED' })

      const sent = await rpc.sendMessage({
        _: 'messages.sendMessage', peer: groupPeer, message: 'old own message', randomId: Long.fromNumber(101),
      })
      await expect(rpc.deleteMessages({
        _: 'messages.deleteMessages', revoke: true, id: [sent.id],
      })).rejects.toMatchObject({ text: 'MESSAGE_DELETE_FORBIDDEN' })

      await expect(rpc.deleteMessages({
        _: 'messages.deleteMessages', revoke: true, id: [incomingId],
      })).resolves.toMatchObject({ ptsCount: 1 })
    } finally {
      actions.edit.maxAgeSeconds = originalEditLimit
    }
  })

  it('serves the peer metadata RPCs required by desktop group and channel views', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const channelId = stableId('peer:parent-channel')
    const channel = { _: 'inputChannel' as const, channelId, accessHash: Long.ZERO }

    const groupSettings = await rpc.getPeerSettings({
      _: 'messages.getPeerSettings', peer: { _: 'inputPeerChat', chatId: groupId },
    })
    const fullGroup = await rpc.getFullChat({ _: 'messages.getFullChat', chatId: groupId })
    const fullChannel = await rpc.getFullChannel({ _: 'channels.getFullChannel', channel })
    const self = await rpc.getChannelParticipant({
      _: 'channels.getParticipant', channel, participant: { _: 'inputPeerSelf' },
    })
    const participants = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel, filter: { _: 'channelParticipantsRecent' },
      offset: 0, limit: 200, hash: Long.ZERO,
    })
    const admins = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel, filter: { _: 'channelParticipantsAdmins' },
      offset: 0, limit: 200, hash: Long.ZERO,
    })
    const sendAs = await rpc.getSendAs({
      _: 'channels.getSendAs', peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ZERO },
    })

    expect(groupSettings).toMatchObject({ _: 'messages.peerSettings', chats: [{ title: 'QQ Group' }] })
    expect(fullGroup).toMatchObject({ _: 'messages.chatFull', fullChat: { _: 'chatFull', id: groupId } })
    expect(fullChannel).toMatchObject({
      _: 'messages.chatFull', fullChat: { _: 'channelFull', id: channelId, participantsCount: 42 },
    })
    expect(self).toMatchObject({
      _: 'channels.channelParticipant', participant: { _: 'channelParticipantCreator' },
    })
    expect(participants).toMatchObject({ _: 'channels.channelParticipants', count: 3 })
    expect(admins).toMatchObject({
      _: 'channels.channelParticipants', count: 2,
      participants: [
        { _: 'channelParticipantCreator', adminRights: { manageTopics: true } },
        { _: 'channelParticipantAdmin', adminRights: { deleteMessages: true } },
      ],
    })
    expect(sendAs).toMatchObject({ _: 'channels.sendAsPeers', peers: [{ peer: { _: 'peerUser' } }] })
    for (const result of [groupSettings, fullGroup, fullChannel, self, participants, admins, sendAs]) {
      expect(() => roundTrip(result)).not.toThrow()
    }
  })

  it('projects known child channels as forum topics and routes topic sends to the child', async () => {
    const { rpc } = await createRpc()
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const parent = dialogs.chats.find((chat) => chat._ === 'channel' && chat.title === 'Discord / general')
    if (!parent || parent._ !== 'channel') throw new Error('forum parent missing')
    const peer = { _: 'inputPeerChannel' as const, channelId: parent.id, accessHash: Long.ZERO }
    const topics = await rpc.getForumTopics({
      _: 'messages.getForumTopics', peer, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
    })
    expect(topics).toMatchObject({
      _: 'messages.forumTopics', count: 1,
      topics: [{ _: 'forumTopic', title: 'Discord / support' }],
      messages: [{ _: 'message', peerId: { _: 'peerChannel', channelId: parent.id } }],
      chats: [{ _: 'channel', id: parent.id, forum: true }],
    })
    const topic = topics.topics[0] as tl.RawForumTopic
    const byId = await rpc.getForumTopics({ _: 'messages.getForumTopicsByID', peer, topics: [topic.id] })
    expect(byId.topics).toMatchObject([{ id: topic.id, title: 'Discord / support' }])
    const replies = await rpc.getReplies({
      _: 'messages.getReplies', peer, msgId: topic.id,
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawChannelMessages
    expect(replies).toMatchObject({
      _: 'messages.channelMessages', topics: [{ id: topic.id }],
      messages: [{ _: 'message', message: 'Discord / support', peerId: { _: 'peerChannel', channelId: parent.id } }],
    })

    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'to topic', randomId: Long.fromNumber(3),
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: topic.id, topMsgId: topic.id },
    })
    expect(sentTargets.at(-1)).toBe('subchannel')
    for (const result of [topics, byId, replies]) expect(() => roundTrip(result)).not.toThrow()
  })
})
