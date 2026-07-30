import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import type { ServerConnection } from '@mtproto-relay/mtproto'
import { DialogRpc, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { ReactionRpc } from './reaction-rpc.js'
import { IMMessageTargetUnavailableError } from './platform.js'
import type { IMConversation, IMEvent, IMMessage, IMPlatform, PlatformSession } from './platform.js'

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
const sentInputs: Array<import('./platform.js').IMMessageInput> = []
const actionCalls: string[] = []
const forwardOptions: import('./platform.js').IMForwardMessagesOptions[] = []
const subdialogCalls: Array<{ parentId: string, limit?: number, afterId?: string }> = []
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
  async getSubdialogs(_session, parent, query) {
    subdialogCalls.push({ parentId: parent.id, limit: query?.limit, afterId: query?.afterId })
    const children = conversations.filter((conversation) => conversation.parentId === parent.id)
    return {
      dialogs: children.map((conversation) => ({ conversation, unreadCount: 0, lastMessage: source(conversation) })),
      total: children.length,
    }
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
    sentInputs.push(content)
    return {
      id: `sent-${sentTargets.length}`, conversationId: target.id, senderId: 'self', outgoing: true,
      timestamp: 100 + sentTargets.length,
      content: { parts: content.parts.flatMap((part) => part.type === 'text' ? [part] : []) },
      replyToId: content.replyToId,
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
  async forwardMessages(_session, from, ids, to, options) {
    actionCalls.push(`forward:${from.id}:${ids.join(',')}:${to.id}`)
    forwardOptions.push(options ?? {})
    return ids.map((id, index) => ({
      id: `forwarded-${index}`, conversationId: to.id, senderId: 'self', outgoing: true,
      timestamp: 200 + index, content: { parts: [{ type: 'text' as const, text: `forwarded ${id}` }] },
    }))
  },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  sentTargets.length = 0
  sentInputs.length = 0
  actionCalls.length = 0
  forwardOptions.length = 0
  subdialogCalls.length = 0
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createRpc(
  selectedPlatform: IMPlatform = platform,
  options: { publishLocalEvents?: boolean } = {},
) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const reactions = selectedPlatform.capabilities.reactions
    ? new ReactionRpc(selectedPlatform, session, 1, ctx.database)
    : undefined
  const store = new MessageStore(ctx.database)
  const localEvents: IMEvent[] = []
  const localDeliveryOptions: Array<import('./platform-manager.js').PlatformEventDeliveryOptions | undefined> = []
  const onLocalEvent = options.publishLocalEvents
    ? async (
        localSession: PlatformSession,
        event: IMEvent,
        delivery?: import('./platform-manager.js').PlatformEventDeliveryOptions,
      ) => {
        localEvents.push(event)
        localDeliveryOptions.push(delivery)
        if (event.type === 'message') {
          const result = await store.ingest(localSession, event.conversation, event.message)
          return {
            _: 'updates' as const,
            updates: result.projection.map((part) => ({
              _: 'updateNewChannelMessage' as const,
              message: { _: 'messageEmpty' as const, id: part.tlMessageId },
              pts: 12, ptsCount: 1,
            })),
            users: [], chats: [], date: event.message.timestamp, seq: 2,
          }
        } else if (event.type === 'message-delete') {
          const result = await store.deleteMessages(localSession, event.conversation, event.messageIds)
          return {
            _: 'updates' as const,
            updates: [{
              _: 'updateDeleteChannelMessages' as const,
              channelId: stableId(`peer:${event.conversation.id}`),
              messages: result.tlMessageIds, pts: 11, ptsCount: result.tlMessageIds.length,
            }],
            users: [], chats: [], date: event.timestamp, seq: 1,
          }
        }
      }
    : undefined
  return {
    ctx,
    store,
    localEvents,
    localDeliveryOptions,
    rpc: new DialogRpc(
      selectedPlatform, session, store,
      undefined, undefined, 1, undefined, reactions,
      undefined, onLocalEvent, '0011223344556677',
    ),
  }
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
  it('acknowledges an empty channel deletion without refreshing dialogs or calling the platform', async () => {
    const getDialogs = vi.spyOn(platform, 'getDialogs')
    try {
      const { rpc } = await createRpc()
      const channel = {
        _: 'inputChannel' as const,
        channelId: stableId('peer:group'),
        accessHash: Long.ZERO,
      }

      await expect(rpc.deleteMessages({ _: 'channels.deleteMessages', channel, id: [] }, channel))
        .resolves.toEqual({ _: 'messages.affectedMessages', pts: 1, ptsCount: 0 })
      expect(getDialogs).not.toHaveBeenCalled()
      expect(actionCalls).toEqual([])
    } finally {
      getDialogs.mockRestore()
    }
  })

  it('acknowledges a deleted legacy projection whose platform alias is missing', async () => {
    const { ctx, rpc } = await createRpc()
    const channel = {
      _: 'inputChannel' as const,
      channelId: stableId('peer:group'),
      accessHash: Long.ZERO,
    }
    const history = await rpc.getHistory(historyRequest({
      _: 'inputPeerChannel', channelId: channel.channelId, accessHash: Long.ZERO,
    })) as tl.messages.RawMessages
    const messageId = (history.messages[0] as tl.RawMessage).id
    await ctx.database.remove('mtproto_im_message_alias', {
      platformSessionId: session.platformSessionId,
      platformMessageId: 'message-group',
    })

    await expect(rpc.deleteMessages({
      _: 'channels.deleteMessages', channel, id: [messageId],
    }, channel)).resolves.toEqual({ _: 'messages.affectedMessages', pts: 1, ptsCount: 0 })
    expect(actionCalls).toEqual(['delete:group:message-group:true'])
  })

  it('promotes newly selected reactions without treating removals as recent usage', async () => {
    const group = conversations.find((item) => item.id === 'group')!
    const available = [
      { key: 'like', presentation: { type: 'emoji' as const, emoticon: '👍' } },
      { key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' } },
    ]
    let reactionContext = { available, reactions: [], maxSelected: 1 } as import('./platform.js').IMReactionContext
    const reactionTargets: import('./platform.js').IMMessageTarget[] = []
    const selectedPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: true, events: false, actorList: false, maxSelected: 1 },
      },
      async getDialogs() {
        return { dialogs: [{
          conversation: group, unreadCount: 0,
          lastMessage: { ...source(group), metadata: { qqMsgSeq: '571' }, reactionContext },
        }] }
      },
      async getAvailableReactions() {
        return reactionContext
      },
      async setMessageReactions(_session, target, keys) {
        reactionTargets.push(target)
        reactionContext = {
          available,
          reactions: keys.map((key) => ({ key, count: 1, selected: true })),
          maxSelected: 1,
        }
        return reactionContext
      },
    }
    const { rpc } = await createRpc(selectedPlatform)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const message = dialogs.messages.find((item): item is tl.RawMessage => item._ === 'message')!
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('group'), accessHash: Long.ZERO }
    const send = (reaction: tl.TypeReaction[]) => rpc.sendReaction({
      _: 'messages.sendReaction', peer, msgId: message.id, reaction,
    })

    await expect(send([{ _: 'reactionEmoji', emoticon: '👍' }])).resolves.toMatchObject({
      _: 'updates',
      updates: [
        { _: 'updateMessageReactions' },
        { _: 'updateRecentReactions' },
      ],
    })
    await expect(send([])).resolves.toMatchObject({
      _: 'updates',
      updates: [{ _: 'updateMessageReactions' }],
    })
    await expect(rpc.getRecentReactions(100)).resolves.toMatchObject({ reactions: [
      { _: 'reactionEmoji', emoticon: '👍' },
    ] })

    await expect(send([{ _: 'reactionEmoji', emoticon: '🔥' }])).resolves.toMatchObject({
      _: 'updates',
      updates: [
        { _: 'updateMessageReactions' },
        { _: 'updateRecentReactions' },
      ],
    })
    await expect(rpc.getRecentReactions(100)).resolves.toMatchObject({ reactions: [
      { _: 'reactionEmoji', emoticon: '🔥' },
      { _: 'reactionEmoji', emoticon: '👍' },
    ] })
    expect(reactionTargets).toHaveLength(3)
    expect(reactionTargets).toEqual(reactionTargets.map((target) => ({
      ...target, nativeSequence: '571',
    })))
  })

  it('persists request order as Telegram chosen order for selected reactions', async () => {
    const group = conversations.find((item) => item.id === 'group')!
    const available = [
      { key: 'like', presentation: { type: 'emoji' as const, emoticon: '👍' } },
      { key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' } },
    ]
    let reactionContext = { available, reactions: [], maxSelected: 2 } as import('./platform.js').IMReactionContext
    const selectedPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: true, events: false, actorList: false, maxSelected: 2 },
      },
      async getDialogs() {
        return { dialogs: [{
          conversation: group, unreadCount: 0,
          lastMessage: { ...source(group), metadata: { qqMsgSeq: '572' }, reactionContext },
        }] }
      },
      async getAvailableReactions() {
        return reactionContext
      },
      async setMessageReactions(_session, _target, keys) {
        reactionContext = {
          available,
          reactions: keys.map((key) => ({ key, count: 1, selected: true })),
          maxSelected: 2,
        }
        return reactionContext
      },
    }
    const { rpc } = await createRpc(selectedPlatform)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const message = dialogs.messages.find((item): item is tl.RawMessage => item._ === 'message')!
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('group'), accessHash: Long.ZERO }

    const response = await rpc.sendReaction({
      _: 'messages.sendReaction', peer, msgId: message.id,
      reaction: [
        { _: 'reactionEmoji', emoticon: '👍' },
        { _: 'reactionEmoji', emoticon: '🔥' },
      ],
    }) as tl.RawUpdates
    const reactionUpdate = response.updates.find(
      (update): update is tl.RawUpdateMessageReactions => update._ === 'updateMessageReactions',
    )!
    expect(reactionUpdate.reactions.results).toMatchObject([
      { reaction: { _: 'reactionEmoji', emoticon: '👍' }, chosenOrder: 1 },
      { reaction: { _: 'reactionEmoji', emoticon: '🔥' }, chosenOrder: 2 },
    ])

    const reloaded = await rpc.getChannelMessages({
      _: 'channels.getMessages',
      channel: { _: 'inputChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ZERO },
      id: [{ _: 'inputMessageID', id: message.id }],
    }) as tl.messages.RawChannelMessages
    const stored = reloaded.messages.find((item): item is tl.RawMessage => item._ === 'message')!
    expect(stored.reactions?.results).toMatchObject([
      { reaction: { _: 'reactionEmoji', emoticon: '👍' }, chosenOrder: 1 },
      { reaction: { _: 'reactionEmoji', emoticon: '🔥' }, chosenOrder: 2 },
    ])
  })

  it('assigns a newer chosen order when an existing unselected reaction is clicked', async () => {
    const group = conversations.find((item) => item.id === 'group')!
    const available = [
      { key: 'fire', presentation: { type: 'emoji' as const, emoticon: '🔥' } },
      { key: 'like', presentation: { type: 'emoji' as const, emoticon: '👍' } },
    ]
    let reactionContext = {
      available,
      reactions: [
        { key: 'fire', count: 3, selected: false },
        { key: 'like', count: 2, selected: true, selectedOrder: 4 },
      ],
      maxSelected: 2,
    } as import('./platform.js').IMReactionContext
    const selectedPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: true, events: false, actorList: false, maxSelected: 2 },
      },
      async getDialogs() {
        return { dialogs: [{
          conversation: group, unreadCount: 0,
          lastMessage: { ...source(group), metadata: { qqMsgSeq: '573' }, reactionContext },
        }] }
      },
      async getAvailableReactions() {
        return reactionContext
      },
      async setMessageReactions(_session, _target, keys) {
        reactionContext = {
          available,
          reactions: keys.map((key) => ({ key, count: key === 'fire' ? 4 : 2, selected: true })),
          maxSelected: 2,
        }
        return reactionContext
      },
    }
    const { rpc } = await createRpc(selectedPlatform)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const message = dialogs.messages.find((item): item is tl.RawMessage => item._ === 'message')!
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('group'), accessHash: Long.ZERO }

    const response = await rpc.sendReaction({
      _: 'messages.sendReaction', peer, msgId: message.id,
      reaction: [
        { _: 'reactionEmoji', emoticon: '🔥' },
        { _: 'reactionEmoji', emoticon: '👍' },
      ],
    }) as tl.RawUpdates
    const reactionUpdate = response.updates.find(
      (update): update is tl.RawUpdateMessageReactions => update._ === 'updateMessageReactions',
    )!
    expect(reactionUpdate.reactions.results).toMatchObject([
      { reaction: { _: 'reactionEmoji', emoticon: '🔥' }, chosenOrder: 5 },
      { reaction: { _: 'reactionEmoji', emoticon: '👍' }, chosenOrder: 4 },
    ])
  })

  it('maps a permanently unavailable reaction target to a non-retryable RPC error', async () => {
    const group = conversations.find((item) => item.id === 'group')!
    const available = [{ key: 'like', presentation: { type: 'emoji' as const, emoticon: '👍' } }]
    const selectedPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: true, events: false, actorList: false, maxSelected: 1 },
      },
      async getDialogs() {
        return { dialogs: [{
          conversation: group, unreadCount: 0,
          lastMessage: {
            ...source(group), metadata: { qqMsgSeq: '571' },
            reactionContext: { available, reactions: [], maxSelected: 1 },
          },
        }] }
      },
      async setMessageReactions() {
        throw new IMMessageTargetUnavailableError('gone')
      },
    }
    const { rpc } = await createRpc(selectedPlatform)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const message = dialogs.messages.find((item): item is tl.RawMessage => item._ === 'message')!
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('group'), accessHash: Long.ZERO }

    await expect(rpc.sendReaction({
      _: 'messages.sendReaction', peer, msgId: message.id,
      reaction: [{ _: 'reactionEmoji', emoticon: '👍' }],
    })).rejects.toMatchObject({ code: 400, text: 'REACTION_INVALID' })
  })

  it('refreshes and returns the platform users behind message reactions', async () => {
    const reactionContext = {
      available: [{
        key: 'like',
        presentation: { type: 'emoji' as const, emoticon: '👍' },
      }],
      reactions: [{ key: 'like', count: 3 }],
      maxSelected: 1,
    }
    const getMessageReactions = vi.fn(async () => ({
      ...reactionContext,
      reactions: [{
        key: 'like', count: 3,
        recentActors: [{ userId: 'alice' }, { userId: 'bob' }],
      }],
    }))
    const selectedPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: false, events: false, actorList: true, maxSelected: 1 },
      },
      async getDialogs() {
        const conversation = conversations.find((item) => item.id === 'group')!
        return { dialogs: [{
          conversation,
          unreadCount: 0,
          lastMessage: { ...source(conversation), metadata: { qqMsgSeq: '571' }, reactionContext },
        }] }
      },
      getMessageReactions,
    }
    const { rpc } = await createRpc(selectedPlatform)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const message = dialogs.messages.find((item): item is tl.RawMessage => item._ === 'message')!
    const peer = { _: 'inputPeerChannel' as const, channelId: rpc.peerTlId('group'), accessHash: Long.ZERO }

    const result = await rpc.getMessageReactionsList({
      _: 'messages.getMessageReactionsList', peer, id: message.id, offset: '', limit: 100,
    })
    expect(result).toMatchObject({
      _: 'messages.messageReactionsList',
      count: 3,
      reactions: [
        { _: 'messagePeerReaction', peerId: { _: 'peerUser', userId: await rpc.userTlId('alice') } },
        { _: 'messagePeerReaction', peerId: { _: 'peerUser', userId: await rpc.userTlId('bob') } },
      ],
      users: expect.arrayContaining([
        expect.objectContaining({ _: 'user', firstName: 'alice' }),
        expect.objectContaining({ _: 'user', firstName: 'bob' }),
      ]),
    })
    expect(getMessageReactions).toHaveBeenCalledWith(session, {
      conversationId: 'group', messageId: 'message-group', targetId: 'message-group', nativeSequence: '571',
    })
  })

  it('materializes direct, group, and hierarchical channel dialogs with the correct peer types', async () => {
    const { ctx, rpc } = await createRpc()
    const result = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    expect(result.dialogs.map((dialog) => dialog.peer._)).toEqual(['peerUser', 'peerChannel', 'peerChannel'])
    expect(result.chats).toMatchObject([
      { _: 'channel', title: 'QQ Group', megagroup: true, participantsCount: 23 },
      { _: 'channel', title: 'Discord / general', megagroup: true, forum: true, participantsCount: 42 },
    ])
    expect(result.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual([
      'Direct', 'sender-group', 'sender-parent-channel',
    ])
    const [stored] = await ctx.database.get('mtproto_im_conversation', { platformConversationId: 'subchannel' })
    expect(stored).toMatchObject({
      kind: 'channel', parentPlatformConversationId: 'parent-channel', spacePlatformId: 'guild',
    })
    expect(() => roundTrip(result)).not.toThrow()
  })

  it('uses timestamp IDs for group messages and resolves native-sequence reply headers', async () => {
    const group = conversations.find((item) => item.id === 'group')!
    const target: IMMessage = {
      ...source(group), id: 'opaque-target', timestamp: 1,
      metadata: { qqMsgSeq: '5850632', telegramMessageId: 5_850_632 },
    }
    const reply: IMMessage = {
      ...source(group), id: 'opaque-reply', timestamp: 2, replyToId: target.id,
      metadata: {
        qqMsgSeq: '5850634', telegramMessageId: 5_850_634,
        qqReplyToMsgSeq: '5850632', telegramReplyToMessageId: 5_850_632,
      },
    }
    const getMessage = vi.fn(async () => { throw new Error('reply target must not be loaded') })
    const nativeIdsPlatform: IMPlatform = {
      ...platform,
      async getDialogs() { return { dialogs: [{ conversation: group, unreadCount: 0, lastMessage: reply }] } },
      async getHistory() { return { messages: [reply, target] } },
      getMessage,
    }
    const { rpc } = await createRpc(nativeIdsPlatform)
    const result = await rpc.getHistory(historyRequest({
      _: 'inputPeerChannel', channelId: stableId('peer:group'), accessHash: Long.ZERO,
    })) as tl.messages.RawMessages

    expect(result.messages).toMatchObject([
      { _: 'message', id: 0x40000007, replyTo: { _: 'messageReplyHeader', replyToMsgId: 0x3ffffff7 } },
      { _: 'message', id: 0x3ffffff7 },
    ])
    expect(getMessage).not.toHaveBeenCalled()
  })

  it('accepts channel input peers for groups, returns sender users, and sends to the original target IDs', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const channelId = stableId('peer:parent-channel')
    const group = await rpc.getHistory(historyRequest({
      _: 'inputPeerChannel', channelId: groupId, accessHash: Long.ZERO,
    })) as tl.messages.RawMessages
    const channel = await rpc.getHistory(historyRequest({
      _: 'inputPeerChannel', channelId, accessHash: Long.ZERO,
    })) as tl.messages.RawMessages
    expect((group.messages[0] as tl.RawMessage).peerId).toEqual({ _: 'peerChannel', channelId: groupId })
    expect((channel.messages[0] as tl.RawMessage).peerId).toEqual({ _: 'peerChannel', channelId })
    expect(group.users).toMatchObject([{ _: 'user', firstName: 'sender-group' }, { _: 'user' }])
    expect(channel.chats).toMatchObject([{ _: 'channel', title: 'Discord / general' }])

    const sentToGroup = await rpc.sendMessage({
      _: 'messages.sendMessage',
      peer: { _: 'inputPeerChannel', channelId: groupId, accessHash: Long.ZERO },
      message: 'to group', randomId: Long.ONE,
    }) as tl.RawUpdates
    const sentToChannel = await rpc.sendMessage({
      _: 'messages.sendMessage', peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ZERO },
      message: 'to channel', randomId: Long.fromNumber(2),
    }) as tl.RawUpdates
    expect(sentTargets).toEqual(['group', 'parent-channel'])
    for (const [result, expectedPeerId, expectedText, randomId] of [
      [sentToGroup, groupId, 'to group', Long.ONE],
      [sentToChannel, channelId, 'to channel', Long.fromNumber(2)],
    ] as const) {
      expect(result).toMatchObject({
        _: 'updates',
        updates: [
          { _: 'updateMessageID', randomId },
          {
            _: 'updateNewChannelMessage',
            message: {
              _: 'message', out: true, message: expectedText,
              fromId: { _: 'peerUser' },
              peerId: { _: 'peerChannel', channelId: expectedPeerId },
            },
            ptsCount: 1,
          },
        ],
        users: [{ _: 'user', self: true }],
        chats: [{ _: 'channel', id: expectedPeerId }],
      })
      const full = result as tl.RawUpdates
      const message = (full.updates[1] as tl.RawUpdateNewChannelMessage).message as tl.RawMessage
      expect(message.fromId).toEqual({ _: 'peerUser', userId: (full.users[0] as tl.RawUser).id })
      expect(() => roundTrip(result)).not.toThrow()
    }
    await expect(rpc.getHistory(historyRequest({
      _: 'inputPeerUser', userId: groupId, accessHash: Long.ZERO,
    }))).rejects.toMatchObject({ text: 'PEER_ID_INVALID' })
  })

  it('resolves Telegram reply IDs back to opaque platform message IDs', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const groupPeer = { _: 'inputPeerChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    const history = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
    const replied = history.messages[0] as tl.RawMessage

    await rpc.sendMessage({
      _: 'messages.sendMessage', peer: groupPeer, message: 'native reply', randomId: Long.fromNumber(88),
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: replied.id },
    })

    expect(sentInputs.at(-1)).toMatchObject({ replyToId: 'message-group' })
  })

  it('keeps contacts limited to direct conversations', async () => {
    const { rpc } = await createRpc()
    const contacts = await rpc.getContacts()
    expect(contacts.contacts).toHaveLength(1)
    expect(contacts.users).toMatchObject([{ _: 'user', firstName: 'direct' }])
  })

  it('rehydrates conversations persisted during the peer-cache TTL', async () => {
    const pushOnlyPlatform: IMPlatform = {
      ...platform,
      capabilities: { ...platform.capabilities, history: false },
    }
    const { rpc, store } = await createRpc(pushOnlyPlatform)
    await rpc.getUsers({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] })

    const lateConversation: IMConversation = {
      id: 'late-push-group', kind: 'group', title: 'Late push group',
    }
    await store.ingest(session, lateConversation, {
      id: 'late-message', conversationId: lateConversation.id, senderId: session.userId,
      outgoing: true, timestamp: 1_700_000_000,
      content: { parts: [{ type: 'text', text: 'late push' }] },
    })
    const channelId = stableId(`peer:${lateConversation.id}`)

    await expect(rpc.getPeerSettings({
      _: 'messages.getPeerSettings',
      peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ONE },
    })).resolves.toMatchObject({ _: 'messages.peerSettings' })
  })

  it('projects edit, forward, and administrator deletion through platform actions', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const directId = await rpc.userTlId('direct')
    const groupPeer = { _: 'inputPeerChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    const directPeer = { _: 'inputPeerUser' as const, userId: directId, accessHash: Long.ZERO }
    const groupHistory = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
    const groupMessageId = (groupHistory.messages[0] as tl.RawMessage).id

    const edited = await rpc.editMessage({
      _: 'messages.editMessage', peer: groupPeer, id: groupMessageId, message: 'edited via abstraction',
    }) as tl.RawUpdates
    const originalMessage = groupHistory.messages[0] as tl.RawMessage
    expect(edited.updates).toMatchObject([{
      _: 'updateEditChannelMessage',
      message: {
        id: groupMessageId,
        message: 'edited via abstraction',
        fromId: originalMessage.fromId,
      },
    }])
    expect((edited.updates[0] as tl.RawUpdateEditChannelMessage).message).toHaveProperty('out', undefined)

    const forwarded = await rpc.forwardMessages({
      _: 'messages.forwardMessages', fromPeer: groupPeer, id: [groupMessageId],
      randomId: [Long.fromNumber(99)], toPeer: directPeer,
    }) as tl.RawUpdates
    expect(forwarded.updates).toMatchObject([
      { _: 'updateMessageID', randomId: Long.fromNumber(99) },
      { _: 'updateNewMessage', message: { message: 'forwarded message-group' } },
    ])

    await expect(rpc.deleteMessages({
      _: 'channels.deleteMessages', channel: { _: 'inputChannel', channelId: groupId, accessHash: Long.ZERO },
      id: [groupMessageId],
    }, { _: 'inputChannel', channelId: groupId, accessHash: Long.ZERO }))
      .resolves.toMatchObject({ _: 'messages.affectedMessages', ptsCount: 1 })
    expect(actionCalls).toEqual([
      'edit:group:message-group',
      'forward:group:message-group:direct',
      'delete:group:message-group:true',
    ])
  })

  it('infers Android direct-message forwards whose from_peer is inputPeerEmpty', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const directId = await rpc.userTlId('direct')
    const directPeer = { _: 'inputPeerUser' as const, userId: directId, accessHash: Long.ZERO }
    const history = await rpc.getHistory(historyRequest(directPeer)) as tl.messages.RawMessages
    const messageId = (history.messages[0] as tl.RawMessage).id

    const forwarded = await rpc.forwardMessages({
      _: 'messages.forwardMessages', fromPeer: { _: 'inputPeerEmpty' }, id: [messageId],
      randomId: [Long.fromNumber(100)], toPeer: directPeer,
    }) as tl.RawUpdates

    expect(forwarded.updates).toMatchObject([
      { _: 'updateMessageID', randomId: Long.fromNumber(100) },
      { _: 'updateNewMessage', message: { message: 'forwarded message-direct' } },
    ])
    expect(actionCalls).toContain('forward:direct:message-direct:direct')
    expect(forwardOptions).toMatchObject([{
      sourceMessages: [{ id: 'message-direct', conversationId: 'direct' }],
    }])
  })

  it('returns one confirmation when a platform merges multiple Android forwards into one message', async () => {
    const mergedPlatform: IMPlatform = {
      ...platform,
      async getHistory(_session, target) {
        const conversation = conversations.find((item) => item.id === target.id)!
        return { messages: [0, 1].map((index) => ({
          ...source(conversation), id: `merge-source-${index}`, timestamp: 10 + index,
        })) }
      },
      async forwardMessages(_session, _from, _ids, to) {
        const virtual: IMConversation = {
          id: 'virtual-merged', kind: 'group', title: '聊天记录',
          metadata: { virtual: true, qqMultiForwardPreview: 'Alice: one\nBob: two' },
        }
        return [{
          id: 'merged-output', conversationId: to.id, senderId: 'self', outgoing: true, timestamp: 20,
          content: { parts: [{
            type: 'text', text: '查看聊天记录', entities: [{
              type: 'conversation-link', offset: 0, length: 6, conversation: virtual,
            }],
          }] },
        }]
      },
    }
    const { rpc } = await createRpc(mergedPlatform)
    await rpc.getDialogs(dialogsRequest())
    const directId = await rpc.userTlId('direct')
    const directPeer = { _: 'inputPeerUser' as const, userId: directId, accessHash: Long.ZERO }
    const history = await rpc.getHistory(historyRequest(directPeer)) as tl.messages.RawMessages
    const ids = history.messages.slice(0, 2).map((message) => (message as tl.RawMessage).id)
    expect(ids).toHaveLength(2)

    const forwarded = await rpc.forwardMessages({
      _: 'messages.forwardMessages', fromPeer: { _: 'inputPeerEmpty' }, id: ids,
      randomId: [Long.fromNumber(201), Long.fromNumber(202)], toPeer: directPeer,
    }) as tl.RawUpdates

    expect(forwarded.updates.filter((update) => update._ === 'updateMessageID')).toEqual([{
      _: 'updateMessageID', id: expect.any(Number), randomId: Long.fromNumber(201),
    }])
    expect(forwarded.updates.filter((update) => update._ === 'updateNewMessage')).toHaveLength(1)
  })

  it('projects delete-and-resend editing as delete plus new-message updates', async () => {
    const actions = platform.capabilities.messageActions!
    const originalMode = actions.edit.mode
    actions.edit.mode = 'delete-and-resend'
    try {
      const { rpc, store, localEvents, localDeliveryOptions } = await createRpc(
        platform, { publishLocalEvents: true },
      )
      await rpc.getDialogs(dialogsRequest())
      const groupId = stableId('peer:group')
      const groupPeer = { _: 'inputPeerChannel' as const, channelId: groupId, accessHash: Long.ZERO }
      const history = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
      const originalId = (history.messages[0] as tl.RawMessage).id

      const result = await rpc.editMessage({
        _: 'messages.editMessage', peer: groupPeer, id: originalId, message: 'replacement body',
      }) as tl.RawUpdatesCombined
      expect(result).toMatchObject({ _: 'updatesCombined', seqStart: 1, seq: 2 })
      expect(result.updates).toMatchObject([
        { _: 'updateDeleteChannelMessages', messages: [originalId], pts: 11, ptsCount: 1 },
        { _: 'updateNewChannelMessage', message: { _: 'messageEmpty' }, pts: 12, ptsCount: 1 },
      ])
      expect(localDeliveryOptions).toEqual([
        { excludeAuthKeyId: '0011223344556677', deliveredViaRpc: true },
        { excludeAuthKeyId: '0011223344556677', deliveredViaRpc: true },
      ])
      expect(localEvents).toMatchObject([
        {
          type: 'message-delete', conversation: { id: 'group' },
          messageIds: ['message-group'],
        },
        {
          type: 'message', conversation: { id: 'group' },
          message: { id: 'sent-1', content: { parts: [{ type: 'text', text: 'replacement body' }] } },
        },
      ])
      expect(await store.readHistory(session.platformSessionId, 'group')).toMatchObject([
        { id: 'sent-1', content: { parts: [{ type: 'text', text: 'replacement body' }] } },
      ])
      expect(actionCalls).toEqual(['delete:group:message-group:true'])
      expect(sentTargets).toEqual(['group'])
    } finally {
      actions.edit.mode = originalMode
    }
  })

  it('publishes a locally sent message to observer connections', async () => {
    const { rpc, store, localEvents, localDeliveryOptions } = await createRpc(
      platform, { publishLocalEvents: true },
    )
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const requester = {} as ServerConnection

    const result = await rpc.sendMessage({
      _: 'messages.sendMessage',
      peer: { _: 'inputPeerChannel', channelId: groupId, accessHash: Long.ZERO },
      message: 'fan out to B', randomId: Long.fromNumber(2026),
    }, requester) as tl.RawUpdates

    expect(localEvents).toMatchObject([{
      type: 'message', conversation: { id: 'group' },
      message: { conversationId: 'group', outgoing: true, content: { parts: [{ text: 'fan out to B' }] } },
    }])
    expect(localDeliveryOptions).toEqual([{
      excludeConnection: requester, deliveredViaRpc: true,
    }])
    expect(result).toMatchObject({
      _: 'updates', seq: 2,
      updates: [
        { _: 'updateMessageID', randomId: Long.fromNumber(2026) },
        { _: 'updateNewChannelMessage', pts: 12, ptsCount: 1 },
      ],
    })
    expect((await store.readHistory(session.platformSessionId, 'group'))[0]).toMatchObject({
      content: { parts: [{ type: 'text', text: 'fan out to B' }] },
    })
  })

  it('lets administrators edit beyond the member window while keeping regular members time-limited', async () => {
    const actions = platform.capabilities.messageActions!
    const originalEditLimit = actions.edit.maxAgeSeconds
    actions.edit.maxAgeSeconds = 1
    try {
      const { rpc } = await createRpc()
      await rpc.getDialogs(dialogsRequest())
      const groupId = stableId('peer:group')
      const groupPeer = { _: 'inputPeerChannel' as const, channelId: groupId, accessHash: Long.ZERO }
      const groupChannel = { _: 'inputChannel' as const, channelId: groupId, accessHash: Long.ZERO }
      const history = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
      const incomingId = (history.messages[0] as tl.RawMessage).id
      await expect(rpc.editMessage({
        _: 'messages.editMessage', peer: groupPeer, id: incomingId, message: 'admin edit',
      })).resolves.toMatchObject({
        updates: [{ message: { message: 'admin edit' } }],
      })

      const memberPlatform: IMPlatform = {
        ...platform,
        async getConversationMember(_session, _conversation, userId) {
          return {
            user: { id: userId, firstName: 'Regular member' },
            role: 'member',
            permissions: {
              manageConversation: false, manageMembers: false,
              deleteAnyMessage: false, editAnyMessage: false,
              pinMessages: false, inviteMembers: true,
            },
          }
        },
      }
      const { rpc: memberRpc } = await createRpc(memberPlatform)
      await memberRpc.getDialogs(dialogsRequest())
      const memberHistory = await memberRpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
      const memberIncomingId = (memberHistory.messages[0] as tl.RawMessage).id
      await expect(memberRpc.editMessage({
        _: 'messages.editMessage', peer: groupPeer, id: memberIncomingId, message: 'too late',
      })).rejects.toMatchObject({ text: 'MESSAGE_EDIT_TIME_EXPIRED' })

      const sent = await rpc.sendMessage({
        _: 'messages.sendMessage', peer: groupPeer, message: 'old own message', randomId: Long.fromNumber(101),
      }) as tl.RawUpdates
      const sentId = (sent.updates.find((update) => update._ === 'updateMessageID') as tl.RawUpdateMessageID).id
      await expect(rpc.deleteMessages({
        _: 'channels.deleteMessages', channel: groupChannel, id: [sentId],
      }, groupChannel)).rejects.toMatchObject({ text: 'MESSAGE_DELETE_FORBIDDEN' })

      await expect(rpc.deleteMessages({
        _: 'channels.deleteMessages', channel: groupChannel, id: [incomingId],
      }, groupChannel)).resolves.toMatchObject({ ptsCount: 1 })
    } finally {
      actions.edit.maxAgeSeconds = originalEditLimit
    }
  })

  it('serves the peer metadata RPCs required by desktop group and channel views', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const channelId = stableId('peer:parent-channel')
    const group = { _: 'inputChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    const channel = { _: 'inputChannel' as const, channelId, accessHash: Long.ZERO }

    const groupSettings = await rpc.getPeerSettings({
      _: 'messages.getPeerSettings',
      peer: { _: 'inputPeerChannel', channelId: groupId, accessHash: Long.ZERO },
    })
    const fullGroup = await rpc.getFullChannel({ _: 'channels.getFullChannel', channel: group })
    const fullChannel = await rpc.getFullChannel({ _: 'channels.getFullChannel', channel })
    await expect(rpc.getFullChat({
      _: 'messages.getFullChat', chatId: groupId,
    })).rejects.toMatchObject({ text: 'CHAT_ID_INVALID' })
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
    expect(fullGroup).toMatchObject({
      _: 'messages.chatFull', fullChat: { _: 'channelFull', id: groupId, participantsCount: 23 },
    })
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

  it('serves channel-scoped message, chat-list, and read RPCs', async () => {
    const { rpc } = await createRpc()
    await rpc.getDialogs(dialogsRequest())
    const groupId = stableId('peer:group')
    const channelId = stableId('peer:parent-channel')
    const group = { _: 'inputChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    const channel = { _: 'inputChannel' as const, channelId, accessHash: Long.ZERO }
    const groupPeer = { _: 'inputPeerChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    const channelPeer = { _: 'inputPeerChannel' as const, channelId, accessHash: Long.ZERO }
    const groupHistory = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
    const channelHistory = await rpc.getHistory(historyRequest(channelPeer)) as tl.messages.RawMessages
    const groupMessage = groupHistory.messages[0] as tl.RawMessage
    const channelMessage = channelHistory.messages[0] as tl.RawMessage

    const groupMessages = await rpc.getChannelMessages({
      _: 'channels.getMessages', channel: group,
      id: [{ _: 'inputMessageID', id: groupMessage.id }],
    })
    const channelMessages = await rpc.getChannelMessages({
      _: 'channels.getMessages', channel,
      id: [{ _: 'inputMessageID', id: channelMessage.id }],
    })
    const legacyChannelMessages = await rpc.getChannelMessages({
      _: 'channels.getMessages', channel,
      id: [channelMessage.id],
    })
    const chats = await rpc.getChannels({ _: 'channels.getChannels', id: [group, channel, group] })

    expect(groupMessages).toMatchObject({
      _: 'messages.channelMessages',
      messages: [{ _: 'message', message: 'QQ Group' }],
      chats: [{ _: 'channel', id: groupId, title: 'QQ Group' }],
    })
    expect(channelMessages).toMatchObject({
      _: 'messages.channelMessages',
      messages: [{ _: 'message', message: 'Discord / general' }],
      chats: [{ _: 'channel', id: channelId, title: 'Discord / general' }],
    })
    expect(legacyChannelMessages).toMatchObject({
      _: 'messages.channelMessages',
      messages: [{ _: 'message', id: channelMessage.id, message: 'Discord / general' }],
    })
    expect(chats).toMatchObject({
      _: 'messages.chats',
      chats: [
        { _: 'channel', id: groupId, title: 'QQ Group' },
        { _: 'channel', id: channelId, title: 'Discord / general' },
      ],
    })
    await expect(rpc.readChannelHistory({
      _: 'channels.readHistory', channel, maxId: channelMessage.id,
    })).resolves.toEqual({ _: 'boolTrue' })
    await expect(rpc.readChannelMessageContents({
      _: 'channels.readMessageContents', channel, id: [channelMessage.id],
    })).resolves.toEqual({ _: 'boolTrue' })
    for (const result of [groupMessages, channelMessages, legacyChannelMessages, chats]) {
      expect(() => roundTrip(result)).not.toThrow()
    }
  })

  it('scopes read boundaries when direct and channel message IDs collide', async () => {
    const readTargets: Array<{ conversationId: string, messageId: string }> = []
    const readPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        readState: { markRead: true, events: true },
      },
      async markRead(_session, target) { readTargets.push(target) },
    }
    const { rpc } = await createRpc(readPlatform)
    await rpc.getDialogs(dialogsRequest())
    const directPeer = {
      _: 'inputPeerUser' as const, userId: await rpc.userTlId('direct'), accessHash: Long.ZERO,
    }
    const groupId = stableId('peer:group')
    const groupPeer = { _: 'inputPeerChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    const directHistory = await rpc.getHistory(historyRequest(directPeer)) as tl.messages.RawMessages
    const groupHistory = await rpc.getHistory(historyRequest(groupPeer)) as tl.messages.RawMessages
    const directMessage = directHistory.messages[0] as tl.RawMessage
    const groupMessage = groupHistory.messages[0] as tl.RawMessage
    expect(groupMessage.id).toBe(directMessage.id)

    await rpc.readHistory({ _: 'messages.readHistory', peer: directPeer, maxId: directMessage.id })
    await rpc.readChannelHistory({
      _: 'channels.readHistory',
      channel: { _: 'inputChannel', channelId: groupId, accessHash: Long.ZERO },
      maxId: groupMessage.id,
    })

    expect(readTargets).toEqual([
      { conversationId: 'direct', messageId: 'message-direct' },
      { conversationId: 'group', messageId: 'message-group' },
    ])
  })

  it('projects every group as a megagroup and reuses its cached member snapshot', async () => {
    const calls: Array<{ cursor?: string, limit?: number }> = []
    const allMembers = ['self', 'alice', 'bob', 'carol', 'dave'].map((id, index) => ({
      user: { id, firstName: id },
      role: index === 0 ? 'owner' as const : 'member' as const,
      permissions: {
        manageConversation: index === 0, manageMembers: index === 0,
        deleteAnyMessage: index === 0, editAnyMessage: false,
        pinMessages: index === 0, inviteMembers: true,
      },
    }))
    const paginatedPlatform: IMPlatform = {
      ...platform,
      async getConversationMembers(_session, _target, query = {}) {
        calls.push(query)
        const start = Number(query.cursor?.replace('cursor-', '') ?? 0)
        const limit = query.limit ?? 100
        const members = allMembers.slice(start, start + limit)
        const next = start + members.length
        return {
          members,
          total: allMembers.length,
          nextCursor: next < allMembers.length ? `cursor-${next}` : undefined,
        }
      },
    }
    const { rpc } = await createRpc(paginatedPlatform)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const groupId = stableId('peer:group')
    const group = { _: 'inputChannel' as const, channelId: groupId, accessHash: Long.ZERO }
    expect(dialogs.dialogs.find((dialog) =>
      dialog.peer._ === 'peerChannel' && dialog.peer.channelId === groupId)).toBeDefined()
    expect(dialogs.chats).toContainEqual(expect.objectContaining({
      _: 'channel', title: 'QQ Group', megagroup: true,
    }))

    await rpc.getFullChannel({ _: 'channels.getFullChannel', channel: group })
    expect(calls).toEqual([])

    const first = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group, filter: { _: 'channelParticipantsRecent' },
      offset: 0, limit: 2, hash: Long.ZERO,
    })
    const second = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group, filter: { _: 'channelParticipantsRecent' },
      offset: 2, limit: 2, hash: Long.ZERO,
    })
    const admins = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group, filter: { _: 'channelParticipantsAdmins' },
      offset: 0, limit: 2, hash: Long.ZERO,
    })
    expect(calls).toEqual([{ cursor: undefined, limit: 100 }])
    expect(first).toMatchObject({
      _: 'channels.channelParticipants', count: 5,
      users: [{ firstName: 'self' }, { firstName: 'alice' }],
    })
    expect(second).toMatchObject({
      _: 'channels.channelParticipants', count: 5,
      users: [{ firstName: 'bob' }, { firstName: 'carol' }],
    })
    expect(admins).toMatchObject({
      _: 'channels.channelParticipants', count: 1,
      users: [{ firstName: 'self' }],
    })
    expect(() => roundTrip(first)).not.toThrow()
    expect(() => roundTrip(second)).not.toThrow()
  })

  it('fills Android member windows from short QQNT pages and searches all mention candidates', async () => {
    const calls: Array<{ cursor?: string, limit?: number }> = []
    const permissions = {
      manageConversation: false, manageMembers: false, deleteAnyMessage: false,
      editAnyMessage: false, pinMessages: false, inviteMembers: true,
    }
    const allMembers = Array.from({ length: 125 }, (_, index) => ({
      user: {
        id: `member-${index}`,
        firstName: index === 87 ? 'Needle User' : `Member ${index}`,
        username: String(10_000 + index),
        metadata: index === 112 ? { qqGroupAlias: 'Target Alias' } : {},
      },
      role: 'member' as const,
      permissions,
    }))
    const shortPagePlatform: IMPlatform = {
      ...platform,
      async getConversationMembers(_session, _target, query = {}) {
        calls.push(query)
        const start = Number(query.cursor?.replace('cursor-', '') ?? 0)
        const emitted = Math.min(query.limit ?? 100, 30)
        const members = allMembers.slice(start, start + emitted)
        const next = start + members.length
        return {
          members,
          total: allMembers.length,
          nextCursor: next < allMembers.length ? `cursor-${next}` : undefined,
        }
      },
    }
    const { rpc } = await createRpc(shortPagePlatform)
    await rpc.getDialogs(dialogsRequest())
    const group = {
      _: 'inputChannel' as const,
      channelId: stableId('peer:group'),
      accessHash: Long.ZERO,
    }

    const first = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group, filter: { _: 'channelParticipantsRecent' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })
    const second = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group, filter: { _: 'channelParticipantsRecent' },
      offset: 100, limit: 25, hash: Long.ZERO,
    })
    const mentions = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group, filter: { _: 'channelParticipantsMentions' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })
    const searchedMention = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group,
      filter: { _: 'channelParticipantsMentions', q: 'needle' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })
    const aliasMention = await rpc.getChannelParticipants({
      _: 'channels.getParticipants', channel: group,
      filter: { _: 'channelParticipantsMentions', q: '@target alias' },
      offset: 0, limit: 100, hash: Long.ZERO,
    })

    expect(calls).toEqual([0, 30, 60, 90, 120].map((offset) => ({
      cursor: offset ? `cursor-${offset}` : undefined,
      limit: 100,
    })))
    expect(first).toMatchObject({
      _: 'channels.channelParticipants', count: 125,
      users: [
        { firstName: 'Member 0' },
        ...Array.from({ length: 98 }, () => expect.any(Object)),
        { firstName: 'Member 99' },
      ],
    })
    expect(second).toMatchObject({
      _: 'channels.channelParticipants', count: 125,
      users: [
        { firstName: 'Member 100' },
        ...Array.from({ length: 23 }, () => expect.any(Object)),
        { firstName: 'Member 124' },
      ],
    })
    expect(mentions).toMatchObject({ _: 'channels.channelParticipants', count: 125 })
    expect(mentions.users).toHaveLength(100)
    expect(searchedMention).toMatchObject({
      _: 'channels.channelParticipants', count: 1, users: [{ firstName: 'Needle User' }],
    })
    expect(aliasMention).toMatchObject({
      _: 'channels.channelParticipants', count: 1, users: [{ firstName: 'Member 112' }],
    })
    for (const result of [first, second, mentions, searchedMention, aliasMention]) {
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
    expect(subdialogCalls).toEqual([{ parentId: 'parent-channel', limit: 100, afterId: undefined }])
    const topic = topics.topics[0] as tl.RawForumTopic
    const byId = await rpc.getForumTopics({ _: 'messages.getForumTopicsByID', peer, topics: [topic.id] })
    expect(byId.topics).toMatchObject([{ id: topic.id, title: 'Discord / support' }])
    const legacyTopics = await rpc.getLegacyForumTopics({
      _: 'channels.getForumTopics',
      channel: { _: 'inputChannel', channelId: parent.id, accessHash: Long.ZERO },
      offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
    })
    const legacyById = await rpc.getLegacyForumTopics({
      _: 'channels.getForumTopicsByID',
      channel: { _: 'inputChannel', channelId: parent.id, accessHash: Long.ZERO },
      topics: [topic.id],
    })
    expect(legacyTopics).toEqual(topics)
    expect(legacyById).toEqual(byId)
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
    const updated = await rpc.getReplies({
      _: 'messages.getReplies', peer, msgId: topic.id,
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawChannelMessages
    expect(updated.messages[0]).toMatchObject({
      _: 'message', message: 'to topic',
      replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToTopId: topic.id },
    })
    for (const result of [topics, byId, legacyTopics, legacyById, replies, updated]) {
      expect(() => roundTrip(result)).not.toThrow()
    }
  })
})
