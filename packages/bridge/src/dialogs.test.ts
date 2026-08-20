import { describe, expect, it, vi } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { RpcError, type ServerConnection } from '@mtproto-relay/mtproto'
import { DialogRpc, stableId } from './dialogs.js'
import { ReactionRpc } from './reaction-rpc.js'
import { IMMessageSendRejectedError } from './platform.js'
import type {
  IMDialogPage, IMHistoryPage, IMMessage, IMMessageInput, IMMessageSearchQuery, IMPlatform, IMUser, PlatformSession,
} from './platform.js'
import { createTestConversationViews } from './conversation-view.test-utils.js'

const session: PlatformSession = {
  platformSessionId: 'session-1',
  platformId: 'dialog-test',
  userId: 'me',
  credentials: { token: 'test' },
  metadata: { firstName: 'Current', lastName: 'User', phone: 'qq-uin-must-not-project' },
  virtualPhone: '888123456789012',
}

function makeViewRpc(
  platform: IMPlatform,
  views = createTestConversationViews(),
): DialogRpc {
  return new DialogRpc(
    platform, session,
    undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    views,
  )
}

class DialogTestPlatform implements IMPlatform {
  readonly capabilities = {
    history: true,
    readState: { markRead: true, events: true },
    send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
    conversations: { groups: false, channels: false, subchannels: false },
  }
  private readonly _users: Record<string, IMUser> = {
    alice: { id: 'alice', firstName: 'Alice', username: 'alice', about: 'Alice signature' },
    bob: { id: 'bob', firstName: 'Bob', username: 'bob', about: '' },
  }
  private readonly _messages: Record<string, IMMessage[]> = {
    alice: [
      this._message('1', 'alice', 'Hey there!', 1_700_000_000),
      this._message('2', 'alice', 'How are you?', 1_700_000_100),
    ],
    bob: [this._message('1', 'bob', 'Meeting at 3?', 1_700_000_200)],
  }
  private _sequence = 100
  contactIds = ['alice', 'bob']
  lastInput?: IMMessageInput
  readonly readTargets: Array<{ conversationId: string, messageId: string }> = []
  readonly historyCalls: string[] = []

  addMessage(conversationId: string, message: IMMessage): void {
    ;(this._messages[conversationId] ??= []).push(message)
  }

  async subscribe() { return () => {} }

  async sendMessage(
    _session: PlatformSession,
    conversation: { id: string },
    content: IMMessageInput,
  ): Promise<IMMessage> {
    this.lastInput = content
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
    const message = this._message(String(++this._sequence), conversation.id, text, Math.floor(Date.now() / 1000), true)
    message.content = { parts: content.parts.flatMap((part) => part.type === 'text' ? [part] : []) }
    message.replyToId = content.replyToId
    ;(this._messages[conversation.id] ??= []).push(message)
    return message
  }

  async getDialogs(): Promise<IMDialogPage> {
    return {
      dialogs: Object.values(this._users).map((user) => ({
        conversation: { id: user.id, kind: 'direct' as const, title: user.firstName },
        unreadCount: 0,
        lastMessage: this._messages[user.id].at(-1),
      })).sort((left, right) => (right.lastMessage?.timestamp ?? 0) - (left.lastMessage?.timestamp ?? 0)),
    }
  }

  async getHistory(_session: PlatformSession, conversation: { id: string }): Promise<IMHistoryPage> {
    this.historyCalls.push(conversation.id)
    return { messages: this._messages[conversation.id] ?? [] }
  }

  async getUser(_session: PlatformSession, id: string): Promise<IMUser | null> {
    if (id === 'me') return { id, firstName: 'Current', about: 'Self signature' }
    return this._users[id] ?? null
  }

  async getContacts() {
    return { users: this.contactIds.map((id) => this._users[id]) }
  }

  async markRead(
    _session: PlatformSession,
    target: { conversationId: string, messageId: string },
  ): Promise<void> {
    this.readTargets.push(target)
  }

  private _message(
    id: string,
    conversationId: string,
    text: string,
    timestamp: number,
    outgoing = false,
  ): IMMessage {
    return {
      id, conversationId, senderId: outgoing ? 'self' : conversationId,
      timestamp, outgoing: outgoing || undefined, content: { parts: [{ type: 'text', text }] },
    }
  }
}

function getDialogsRequest(overrides: Partial<tl.messages.RawGetDialogsRequest> = {}): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    ...overrides,
  }
}

function getHistoryRequest(peerId: number, overrides: Partial<tl.messages.RawGetHistoryRequest> = {}): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory', peer: { _: 'inputPeerUser', userId: peerId, accessHash: Long.ZERO },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    ...overrides,
  }
}

function sendMessageRequest(peerId: number, overrides: Partial<tl.messages.RawSendMessageRequest> = {}): tl.messages.RawSendMessageRequest {
  return {
    _: 'messages.sendMessage',
    peer: { _: 'inputPeerUser', userId: peerId, accessHash: Long.ZERO },
    message: 'Hello from bridge', randomId: Long.fromNumber(1234),
    ...overrides,
  }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('DialogRpc', () => {
  it('marks unread group mentions and replies to the current user for Telegram notification badges', async () => {
    const mentionGroup = { id: 'mention-group', kind: 'group' as const, title: 'Mentions' }
    const replyGroup = { id: 'reply-group', kind: 'group' as const, title: 'Replies' }
    const otherGroup = { id: 'other-group', kind: 'group' as const, title: 'Other mentions' }
    const selfTarget: IMMessage = {
      id: 'self-target', conversationId: replyGroup.id, senderId: session.userId,
      outgoing: true, timestamp: 10, content: { parts: [{ type: 'text', text: 'my message' }] },
    }
    const reply: IMMessage = {
      id: 'reply', conversationId: replyGroup.id, senderId: 'alice', replyToId: selfTarget.id,
      timestamp: 11, content: { parts: [{ type: 'text', text: 'answer' }] },
    }
    const mention: IMMessage = {
      id: 'mention', conversationId: mentionGroup.id, senderId: 'bob', timestamp: 12,
      content: { parts: [{
        type: 'text', text: '@Current ping',
        entities: [{ type: 'mention', offset: 0, length: 8, userId: session.userId }],
      }] },
    }
    const otherMention: IMMessage = {
      id: 'other', conversationId: otherGroup.id, senderId: 'bob', timestamp: 13,
      content: { parts: [{
        type: 'text', text: '@Other ping',
        entities: [{ type: 'mention', offset: 0, length: 6, userId: 'other' }],
      }] },
    }
    const histories = new Map([
      [mentionGroup.id, [mention]],
      [replyGroup.id, [selfTarget, reply]],
      [otherGroup.id, [otherMention]],
    ])
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() {
        return { dialogs: [
          { conversation: otherGroup, unreadCount: 1, lastMessage: otherMention },
          { conversation: mentionGroup, unreadCount: 1, lastMessage: mention },
          { conversation: replyGroup, unreadCount: 1, lastMessage: reply, readInboxMaxMessage: selfTarget },
        ] }
      },
      async getHistory(_session, conversation) { return { messages: histories.get(conversation.id) ?? [] } },
      async getUser(_session, id) { return { id, firstName: id } },
    }
    const rpc = new DialogRpc(platform, session)
    const decoded = wireRoundTrip(await rpc.getDialogs(getDialogsRequest())) as tl.messages.RawDialogs
    const dialogs = new Map(decoded.dialogs.map((dialog) => [
      dialog.peer._ === 'peerChannel' ? dialog.peer.channelId : 0,
      dialog as tl.RawDialog,
    ]))
    const messages = new Map(decoded.messages.flatMap((message) =>
      message._ === 'message' && message.peerId._ === 'peerChannel'
        ? [[message.peerId.channelId, message] as const]
        : []))

    expect(dialogs.get(rpc.peerTlId(mentionGroup.id))).toMatchObject({ unreadMentionsCount: 1 })
    expect(messages.get(rpc.peerTlId(mentionGroup.id))).toMatchObject({ mentioned: true })
    expect(dialogs.get(rpc.peerTlId(replyGroup.id))).toMatchObject({ unreadMentionsCount: 1 })
    expect(messages.get(rpc.peerTlId(replyGroup.id))).toMatchObject({
      mentioned: true,
      replyTo: { _: 'messageReplyHeader' },
    })
    expect(dialogs.get(rpc.peerTlId(otherGroup.id))).toMatchObject({ unreadMentionsCount: 0 })
    expect(messages.get(rpc.peerTlId(otherGroup.id))?.mentioned).toBe(false)
  })

  it('builds serializable dialogs, users, and top messages in newest-first order', async () => {
    const platform = new DialogTestPlatform()
    const getUser = vi.spyOn(platform, 'getUser')
    const rpc = new DialogRpc(platform, session)
    const result = await rpc.getDialogs(getDialogsRequest())
    const decoded = wireRoundTrip(result) as tl.messages.RawDialogs

    expect(decoded._).toBe('messages.dialogs')
    expect(decoded.dialogs).toHaveLength(2)
    expect(decoded.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'Meeting at 3?', 'How are you?',
    ])
    expect(decoded.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['Bob', 'Alice'])
    expect(decoded.users.every((user) => user._ !== 'user' || user.accessHash?.equals(Long.ONE))).toBe(true)
    expect(decoded.dialogs[0]).toMatchObject({
      _: 'dialog', unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
    })
    expect(getUser).not.toHaveBeenCalled()
  })

  it('uses and remembers a native Telegram message ID before background persistence finishes', async () => {
    const conversation = { id: 'native-id-user', kind: 'direct' as const, title: 'Native ID' }
    const message: IMMessage = {
      id: 'native-message', conversationId: conversation.id, senderId: conversation.id,
      timestamp: 1_700_000_000, content: { parts: [{ type: 'text', text: 'stable' }] },
      metadata: { telegramMessageId: 5_850_634 },
    }
    const markRead = vi.fn(async () => undefined)
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        readState: { markRead: true, events: false },
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 1, lastMessage: message }] } },
      async getHistory() { return { messages: [message] } },
      async getUser() { return { id: conversation.id, firstName: conversation.title } },
      markRead,
    }
    const rpc = new DialogRpc(platform, session)
    const result = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const dialog = result.dialogs[0] as tl.RawDialog

    expect(dialog.topMessage).toBe(5_850_634)
    expect(result.messages[0]).toMatchObject({ _: 'message', id: 5_850_634 })
    await rpc.readHistory({
      _: 'messages.readHistory',
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO },
      maxId: 5_850_634,
    })
    expect(markRead).toHaveBeenCalledWith(session, {
      conversationId: conversation.id, messageId: message.id,
    })
  })

  it('projects group content.serviceAction in dialogs and history', async () => {
    const conversation = { id: 'group', kind: 'group' as const, title: 'Group' }
    const service: IMMessage = {
      id: 'joined', conversationId: conversation.id, senderId: 'alice', timestamp: 1_700_000_000,
      content: { serviceAction: { type: 'custom', text: 'Alice joined the group' }, parts: [] },
    }
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: service }] } },
      async getHistory() { return { messages: [service] } },
      async getUser(_session, id) { return { id, firstName: 'Alice' } },
    }
    const rpc = new DialogRpc(platform, session)
    const dialogs = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const dialog = dialogs.dialogs[0] as tl.RawDialog

    expect(dialogs.chats).toMatchObject([{
      _: 'channel', title: 'Group', accessHash: Long.ONE,
    }])
    expect(dialogs.messages[0]).toMatchObject({
      _: 'messageService', id: dialog.topMessage,
      action: { _: 'messageActionCustomAction', message: 'Alice joined the group' },
    })
    const history = await rpc.getHistory({
      _: 'messages.getHistory', peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO },
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    expect(history.messages).toMatchObject([{
      _: 'messageService', action: { _: 'messageActionCustomAction', message: 'Alice joined the group' },
    }])
    expect(() => wireRoundTrip(history)).not.toThrow()
  })

  it('projects empty default banned rights through channel discovery and full-info RPCs', async () => {
    const conversation = { id: 'permissions-group', kind: 'group' as const, title: 'Permissions' }
    const message: IMMessage = {
      id: 'permissions-message', conversationId: conversation.id, senderId: 'alice', timestamp: 1_700_000_000,
      content: { parts: [{ type: 'text', text: 'members can send' }] },
    }
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: message }] } },
      async getHistory() { return { messages: [message] } },
      async getUser(_session, id) { return { id, firstName: id } },
    }
    const rpc = new DialogRpc(platform, session)
    const channelId = rpc.peerTlId(conversation.id)
    const channel = { _: 'inputChannel' as const, channelId, accessHash: Long.ONE }

    const dialogs = wireRoundTrip(await rpc.getDialogs(getDialogsRequest())) as tl.messages.RawDialogs
    const channels = wireRoundTrip(await rpc.getChannels({ _: 'channels.getChannels', id: [channel] })) as tl.messages.RawChats
    const full = wireRoundTrip(await rpc.getFullChannel({
      _: 'channels.getFullChannel', channel,
    })) as tl.messages.RawChatFull

    const projected = [
      dialogs.chats[0] as tl.RawChannel,
      channels.chats[0] as tl.RawChannel,
      full.chats[0] as tl.RawChannel,
    ]
    for (const chat of projected) {
      expect(chat.defaultBannedRights).toMatchObject({
        _: 'chatBannedRights', untilDate: 0,
        viewMessages: false, sendMessages: false, sendMedia: false,
      })
    }
  })

  it('projects direct content.serviceAction in dialogs and history', async () => {
    const conversation = { id: 'alice', kind: 'direct' as const, title: 'Alice' }
    const service: IMMessage = {
      id: 'private-service', conversationId: conversation.id, senderId: conversation.id, timestamp: 1_700_000_000,
      content: { serviceAction: { type: 'custom', text: 'Alice waved' }, parts: [] },
    }
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: service }] } },
      async getHistory() { return { messages: [service] } },
      async getUser(_session, id) { return { id, firstName: 'Alice' } },
    }
    const rpc = new DialogRpc(platform, session)
    const dialogs = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs

    expect(dialogs.messages).toMatchObject([{
      _: 'messageService',
      peerId: { _: 'peerUser', userId: rpc.peerTlId(conversation.id) },
      action: { _: 'messageActionCustomAction', message: 'Alice waved' },
    }])
    const history = await rpc.getHistory(getHistoryRequest(rpc.peerTlId(conversation.id))) as tl.messages.RawMessages
    expect(history.messages).toMatchObject([{
      _: 'messageService', action: { _: 'messageActionCustomAction', message: 'Alice waved' },
    }])
    expect(() => wireRoundTrip(dialogs)).not.toThrow()
    expect(() => wireRoundTrip(history)).not.toThrow()
  })

  it('coalesces and caches repeated platform user lookups', async () => {
    const platform = new DialogTestPlatform()
    const getUser = vi.spyOn(platform, 'getUser')
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs(getDialogsRequest())
    const alice = { _: 'inputUser' as const, userId: rpc.peerTlId('alice'), accessHash: Long.ZERO }

    const users = await rpc.getUsers({ _: 'users.getUsers', id: [alice, alice] })
    await rpc.getUsers({ _: 'users.getUsers', id: [alice] })

    expect(users).toMatchObject([
      { _: 'user', firstName: 'Alice', username: 'alice' },
      { _: 'user', firstName: 'Alice', username: 'alice' },
    ])
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('paginates dialogs using limit and offset peer', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const first = await rpc.getDialogs(getDialogsRequest({ limit: 1 })) as tl.messages.RawDialogsSlice
    expect(first._).toBe('messages.dialogsSlice')
    expect(first.count).toBe(2)
    expect(first.dialogs).toHaveLength(1)

    const bobId = rpc.peerTlId('bob')
    const second = await rpc.getDialogs(getDialogsRequest({
      limit: 1,
      offsetPeer: { _: 'inputPeerUser', userId: bobId, accessHash: Long.ZERO },
    })) as tl.messages.RawDialogsSlice
    expect(second.dialogs).toHaveLength(1)
    expect((second.users[0] as tl.RawUser).firstName).toBe('Alice')
    expect(() => wireRoundTrip(second)).not.toThrow()
  })

  it('keeps archived QQ rows in unscoped Android pagination and scopes explicit folders', async () => {
    const dialogs = Array.from({ length: 103 }, (_, index) => {
      const id = `group-${String(index).padStart(3, '0')}`
      return {
        conversation: {
          id, kind: 'group' as const, title: id,
          ...(index < 30 ? { metadata: { qqGroupMsgMask: 2 } } : {}),
        },
        unreadCount: 0,
      }
    })
    const platform: IMPlatform = {
      platformKind: 'qq',
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs(_session, query) {
        const start = query?.afterId
          ? dialogs.findIndex((dialog) => dialog.conversation.id === query.afterId) + 1
          : 0
        const limit = query?.limit ?? dialogs.length
        return { dialogs: dialogs.slice(Math.max(0, start), Math.max(0, start) + limit), total: dialogs.length }
      },
      async getHistory() { return { messages: [] } },
      async sendMessage() { throw new Error('unused') },
    }
    const rpc = new DialogRpc(platform, session)
    const peerIds = (result: tl.messages.RawDialogs | tl.messages.RawDialogsSlice) => result.dialogs
      .filter((dialog): dialog is tl.RawDialog => dialog._ === 'dialog')
      .map((dialog) => (dialog.peer as tl.RawPeerChannel).channelId)

    const first = await rpc.getDialogs(getDialogsRequest({ limit: 100 })) as tl.messages.RawDialogsSlice
    expect(first._).toBe('messages.dialogsSlice')
    expect(first.count).toBe(103)
    expect(peerIds(first)).toEqual(Array.from({ length: 100 }, (_, index) => stableId(
      `peer:group-${String(index).padStart(3, '0')}`,
    )))
    expect(first.dialogs.slice(0, 30).every((dialog) =>
      dialog._ === 'dialog' && dialog.folderId === 1)).toBe(true)
    expect(first.dialogs.slice(30).every((dialog) =>
      dialog._ === 'dialog' && dialog.folderId === undefined)).toBe(true)

    const second = await rpc.getDialogs(getDialogsRequest({
      limit: 100,
      offsetPeer: {
        _: 'inputPeerChannel', channelId: stableId('peer:group-099'), accessHash: Long.ONE,
      },
    })) as tl.messages.RawDialogs
    const visible = [...peerIds(first), ...peerIds(second)]
    expect(visible).toEqual(Array.from({ length: 103 }, (_, index) => stableId(
      `peer:group-${String(index).padStart(3, '0')}`,
    )))
    expect(new Set(visible)).toHaveLength(103)

    const main = await rpc.getDialogs(
      getDialogsRequest({ folderId: 0, limit: 100 }),
    ) as tl.messages.RawDialogs
    expect(peerIds(main)).toEqual(Array.from({ length: 73 }, (_, index) => stableId(
      `peer:group-${String(index + 30).padStart(3, '0')}`,
    )))

    const archive = await rpc.getDialogs(
      getDialogsRequest({ folderId: 1, limit: 100 }),
    ) as tl.messages.RawDialogs
    expect(peerIds(archive)).toEqual(Array.from({ length: 30 }, (_, index) => stableId(
      `peer:group-${String(index).padStart(3, '0')}`,
    )))
  })

  it('reports the upstream total instead of the limit-plus-one probe size', async () => {
    class LargeDialogPlatform extends DialogTestPlatform {
      override async getDialogs(): Promise<IMDialogPage> {
        return { ...await super.getDialogs(), total: 347, nextCursor: '2' }
      }
    }
    const rpc = new DialogRpc(new LargeDialogPlatform(), session)

    const result = await rpc.getDialogs(getDialogsRequest({ limit: 1 })) as tl.messages.RawDialogsSlice

    expect(result._).toBe('messages.dialogsSlice')
    expect(result.dialogs).toHaveLength(1)
    expect(result.count).toBe(347)
  })

  it('forwards a group offset peer as the upstream afterId', async () => {
    const platform = new DialogTestPlatform()
    const getDialogs = vi.spyOn(platform, 'getDialogs')
    const rpc = new DialogRpc(platform, session)
    const groupTlId = rpc.peerTlId('group-offset')

    await rpc.getDialogs(getDialogsRequest({
      limit: 1,
      offsetPeer: { _: 'inputPeerChat', chatId: groupTlId },
    }))

    expect(getDialogs).toHaveBeenCalledWith(session, { limit: 2, afterId: 'group-offset' })
  })

  it('maps an exact upstream unread boundary to readInboxMaxId', async () => {
    class UnreadPlatform extends DialogTestPlatform {
      override async getDialogs(): Promise<IMDialogPage> {
        const page = await super.getDialogs()
        const alice = page.dialogs.find((dialog) => dialog.conversation.id === 'alice')!
        alice.unreadCount = 1
        alice.readInboxMaxMessage = {
          id: '1', conversationId: 'alice', senderId: 'alice',
          timestamp: 1_700_000_000, content: { parts: [{ type: 'text', text: 'Hey there!' }] },
        }
        return page
      }
    }
    const rpc = new DialogRpc(new UnreadPlatform(), session)

    const result = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const alice = result.dialogs.find((dialog) =>
      dialog._ === 'dialog'
      && dialog.peer._ === 'peerUser'
      && dialog.peer.userId === rpc.peerTlId('alice')) as tl.RawDialog

    expect(alice).toMatchObject({
      unreadCount: 1,
    })
    expect(alice.readInboxMaxId).toBeGreaterThan(0)
    expect(alice.readInboxMaxId).toBeLessThan(alice.topMessage)
  })

  it('returns messages on both sides of an unread boundary requested with negative add_offset', async () => {
    class UnreadPlatform extends DialogTestPlatform {
      override async getDialogs(): Promise<IMDialogPage> {
        const page = await super.getDialogs()
        const alice = page.dialogs.find((dialog) => dialog.conversation.id === 'alice')!
        alice.unreadCount = 1
        alice.readInboxMaxMessage = {
          id: '1', conversationId: 'alice', senderId: 'alice',
          timestamp: 1_700_000_000, content: { parts: [{ type: 'text', text: 'Hey there!' }] },
        }
        return page
      }
    }
    const rpc = new DialogRpc(new UnreadPlatform(), session)
    const dialogs = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const alice = dialogs.dialogs.find((dialog) =>
      dialog._ === 'dialog'
      && dialog.peer._ === 'peerUser'
      && dialog.peer.userId === rpc.peerTlId('alice')) as tl.RawDialog

    const history = await rpc.getHistory(getHistoryRequest(rpc.peerTlId('alice'), {
      offsetId: alice.readInboxMaxId,
      addOffset: -25,
      limit: 50,
    })) as tl.messages.RawMessages

    expect(history.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'How are you?', 'Hey there!',
    ])
    expect(() => wireRoundTrip(history)).not.toThrow()
  })

  it('returns a serializable empty pinned-dialog page for folder merging', () => {
    const result = new DialogRpc(new DialogTestPlatform(), session).getPinnedDialogs()
    expect(result).toMatchObject({
      _: 'messages.peerDialogs', dialogs: [], messages: [], chats: [], users: [],
      state: { _: 'updates.state', pts: 1, qts: 0, seq: 0, unreadCount: 0 },
    })
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('returns only requested peer dialogs in request order and deduplicates peers', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const aliceId = stableId('peer:alice')
    const bobId = stableId('peer:bob')
    const result = await rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs',
      peers: [
        { _: 'inputDialogPeer', peer: { _: 'inputPeerUser', userId: bobId, accessHash: Long.ZERO } },
        { _: 'inputDialogPeer', peer: { _: 'inputPeerUser', userId: aliceId, accessHash: Long.ZERO } },
        { _: 'inputDialogPeer', peer: { _: 'inputPeerUser', userId: bobId, accessHash: Long.ZERO } },
      ],
    })

    expect(result.dialogs.map((dialog) => dialog.peer)).toEqual([
      { _: 'peerUser', userId: bobId },
      { _: 'peerUser', userId: aliceId },
    ])
    expect(result.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'Meeting at 3?', 'How are you?',
    ])
    expect(result.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['Bob', 'Alice'])
    expect(result.state).toMatchObject({ _: 'updates.state', pts: 1, qts: 0, seq: 0, unreadCount: 0 })
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('revalidates peer dialogs instead of reusing a hydrated preview', async () => {
    const platform = new DialogTestPlatform()
    const getDialogs = vi.spyOn(platform, 'getDialogs')
    const rpc = new DialogRpc(platform, session)
    const alice = { _: 'inputPeerUser' as const, userId: stableId('peer:alice'), accessHash: Long.ZERO }

    await rpc.getPeerSettings({ _: 'messages.getPeerSettings', peer: alice })
    await rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer: alice }],
    })

    expect(getDialogs).toHaveBeenCalledTimes(2)
  })

  it('expands folder zero, ignores unsupported archived folders, and rejects unknown peers', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const all = await rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs',
      peers: [
        { _: 'inputDialogPeerFolder', folderId: 1 },
        { _: 'inputDialogPeerFolder', folderId: 0 },
      ],
    })
    expect(all.dialogs).toHaveLength(2)
    expect(() => wireRoundTrip(all)).not.toThrow()

    await expect(rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs',
      peers: [{
        _: 'inputDialogPeer',
        peer: { _: 'inputPeerUser', userId: 987654321, accessHash: Long.ZERO },
      }],
    })).rejects.toMatchObject({ code: 400, text: 'PEER_ID_INVALID' })
  })

  it('returns filtered history and includes peer plus current user metadata', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    // A resumed client can use its cached stable user ID before getDialogs has
    // hydrated this DialogRpc instance.
    const aliceId = stableId('peer:alice')
    const full = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages

    expect(full.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'How are you?', 'Hey there!',
    ])
    expect(full.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['Alice', 'Current'])
    const newest = full.messages[0] as tl.RawMessage
    const oldest = full.messages[1] as tl.RawMessage
    expect(newest.id).toBeGreaterThan(oldest.id)
    const olderOnly = await rpc.getHistory(getHistoryRequest(aliceId, { offsetDate: newest.date })) as tl.messages.RawMessages
    expect(olderOnly.messages).toHaveLength(1)
    const afterNewest = await rpc.getHistory(getHistoryRequest(aliceId, { offsetId: newest.id })) as tl.messages.RawMessages
    expect(afterNewest.messages).toEqual([oldest])
    expect(() => wireRoundTrip(full)).not.toThrow()
  })

  it('coalesces and briefly caches peer hydration while opening a dialog', async () => {
    const platform = new DialogTestPlatform()
    const getDialogs = vi.spyOn(platform, 'getDialogs')
    const rpc = new DialogRpc(platform, session)
    const aliceId = stableId('peer:alice')
    const peer = { _: 'inputPeerUser' as const, userId: aliceId, accessHash: Long.ZERO }

    await Promise.all([
      rpc.getHistory(getHistoryRequest(aliceId)),
      rpc.getPeerSettings({ _: 'messages.getPeerSettings', peer }),
      rpc.readHistory({ _: 'messages.readHistory', peer, maxId: 123 }),
    ])
    await rpc.getScheduledHistory({ _: 'messages.getScheduledHistory', peer, hash: Long.ZERO })

    expect(getDialogs).toHaveBeenCalledTimes(1)

    // An explicit dialog-list request remains a refresh and bypasses the
    // short-lived hydration cache.
    await rpc.getDialogs(getDialogsRequest())
    expect(getDialogs).toHaveBeenCalledTimes(2)
  })

  it('serves desktop search, read-state, and scheduled-history requests', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const peer = { _: 'inputPeerUser' as const, userId: stableId('peer:alice'), accessHash: Long.ZERO }
    const request: tl.messages.RawSearchRequest = {
      _: 'messages.search', peer, q: 'how', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 100,
      maxId: 0, minId: 0, hash: Long.ZERO,
    }
    const search = await rpc.search(request) as tl.messages.RawMessages
    expect(search.messages).toMatchObject([{ _: 'message', message: 'How are you?' }])
    const pinned = await rpc.search({ ...request, q: '', filter: { _: 'inputMessagesFilterPinned' } })
    expect(pinned).toMatchObject({ _: 'messages.messages', messages: [] })
    await expect(rpc.readHistory({ _: 'messages.readHistory', peer, maxId: 123 }))
      .resolves.toEqual({ _: 'messages.affectedMessages', pts: 1, ptsCount: 0 })
    await expect(rpc.getScheduledHistory({ _: 'messages.getScheduledHistory', peer, hash: Long.ZERO }))
      .resolves.toMatchObject({ _: 'messages.messages', messages: [] })
    for (const result of [search, pinned]) expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('maps Telegram read boundaries back to opaque platform messages', async () => {
    const platform = new DialogTestPlatform()
    const localEvents: Array<{ event: import('./platform.js').IMEvent, options: unknown }> = []
    const rpc = new DialogRpc(
      platform, session, undefined, undefined, undefined, 1, undefined, undefined, undefined,
      async (_session, event, options) => { localEvents.push({ event, options }) },
      'source-auth-key',
    )
    const peer = { _: 'inputPeerUser' as const, userId: stableId('peer:alice'), accessHash: Long.ZERO }
    const history = await rpc.getHistory(getHistoryRequest(peer.userId)) as tl.messages.RawMessages
    const newest = history.messages[0] as tl.RawMessage
    const requester = {} as ServerConnection

    await expect(rpc.readHistory({ _: 'messages.readHistory', peer, maxId: newest.id }, requester))
      .resolves.toEqual({ _: 'messages.affectedMessages', pts: 1, ptsCount: 0 })
    expect(platform.readTargets).toEqual([{ conversationId: 'alice', messageId: '2' }])
    expect(localEvents).toEqual([{
      event: { type: 'read', conversationId: 'alice', upToMessageId: '2' },
      options: { excludeConnection: requester, deliveredViaRpc: true },
    }])

    await rpc.readHistory({ _: 'messages.readHistory', peer, maxId: 0x7fffffff })
    expect(platform.readTargets).toHaveLength(1)
    expect(localEvents).toHaveLength(1)
  })

  it('acknowledges readHistory without waiting for the upstream mark-read request', async () => {
    const platform = new DialogTestPlatform()
    let release!: () => void
    let started!: () => void
    const markStarted = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(platform, 'markRead').mockImplementation(async () => {
      started()
      await new Promise<void>((resolve) => { release = resolve })
    })
    const rpc = new DialogRpc(platform, session)
    const peer = { _: 'inputPeerUser' as const, userId: stableId('peer:alice'), accessHash: Long.ZERO }
    const history = await rpc.getHistory(getHistoryRequest(peer.userId)) as tl.messages.RawMessages
    const newest = history.messages[0] as tl.RawMessage
    let completed = false
    const response = rpc.readHistory({ _: 'messages.readHistory', peer, maxId: newest.id })
      .then((value) => {
        completed = true
        return value
      })

    await markStarted
    await Promise.resolve()
    await Promise.resolve()
    const completedBeforeUpstream = completed
    release()

    await expect(response).resolves.toEqual({ _: 'messages.affectedMessages', pts: 1, ptsCount: 0 })
    expect(completedBeforeUpstream).toBe(true)
  })

  it('uses platform search filters and carries its opaque cursor across Telegram pages', async () => {
    class NativeSearchPlatform extends DialogTestPlatform {
      readonly queries: IMMessageSearchQuery[] = []

      async searchMessages(
        _session: PlatformSession,
        conversation: { id: string },
        query: IMMessageSearchQuery,
      ) {
        this.queries.push(query)
        const id = query.cursor ? 'native-2' : 'native-1'
        return {
          messages: [{
            id, conversationId: conversation.id, senderId: 'alice',
            timestamp: query.cursor ? 1_700_000_110 : 1_700_000_120,
            content: { parts: [{ type: 'text' as const, text: `needle ${id}` }] },
          }],
          nextCursor: query.cursor ? undefined : 'qq-search-next',
        }
      }
    }
    const platform = new NativeSearchPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs(getDialogsRequest())
    const peer = { _: 'inputPeerUser' as const, userId: rpc.peerTlId('alice'), accessHash: Long.ZERO }
    const request: tl.messages.RawSearchRequest = {
      _: 'messages.search', peer, fromId: peer, q: 'needle', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 1_700_000_000, maxDate: 1_800_000_000, offsetId: 0, addOffset: 0, limit: 1,
      maxId: 0, minId: 0, hash: Long.ZERO,
    }

    const first = await rpc.search(request) as tl.messages.RawMessagesSlice
    expect(first).toMatchObject({
      _: 'messages.messagesSlice', messages: [{ _: 'message', message: 'needle native-1' }],
    })
    expect(platform.queries[0]).toEqual({
      query: 'needle', cursor: undefined, limit: 200, fromUserId: 'alice',
      minTimestamp: 1_700_000_000, maxTimestamp: 1_800_000_000, mediaKind: undefined,
    })

    const firstId = (first.messages[0] as tl.RawMessage).id
    const second = await rpc.search({ ...request, offsetId: firstId }) as tl.messages.RawMessagesSlice
    expect(second.messages).toMatchObject([{ _: 'message', message: 'needle native-2' }])
    expect(platform.queries[1]?.cursor).toBe('qq-search-next')
    expect(() => wireRoundTrip(first)).not.toThrow()
    expect(() => wireRoundTrip(second)).not.toThrow()
  })

  it('hydrates messages by synthetic ID and returns messageEmpty for unknown IDs', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const dialogs = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const knownId = (dialogs.messages[0] as tl.RawMessage).id
    const result = await rpc.getMessages({
      _: 'messages.getMessages',
      id: [{ _: 'inputMessageID', id: knownId }, { _: 'inputMessageID', id: 987654321 }],
    }) as tl.messages.RawMessages

    expect(result.messages[0]).toMatchObject({ _: 'message', id: knownId, message: 'Meeting at 3?' })
    expect(result.messages[1]).toEqual({ _: 'messageEmpty', id: 987654321 })
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('builds contacts plus basic and full users with contact metadata', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    const contacts = await rpc.getContacts()
    const getUser = vi.spyOn(platform, 'getUser')
    expect(contacts.contacts).toEqual([
      { _: 'contact', userId: rpc.peerTlId('alice'), mutual: true },
      { _: 'contact', userId: rpc.peerTlId('bob'), mutual: true },
    ])
    expect(contacts.users).toHaveLength(2)
    expect(contacts.users[0]).toMatchObject({
      _: 'user', firstName: 'Alice', contact: true, mutualContact: true,
    })

    const users = await rpc.getUsers({
      _: 'users.getUsers',
      id: [
        { _: 'inputUserSelf' },
        { _: 'inputUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
      ],
    })
    expect(users).toMatchObject([
      { _: 'user', self: true, firstName: 'Current', phone: '888123456789012' },
      { _: 'user', firstName: 'Alice' },
    ])

    const full = await rpc.getFullUser({
      _: 'users.getFullUser',
      id: { _: 'inputUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
    })
    expect(full).toMatchObject({
      _: 'users.userFull',
      fullUser: {
        _: 'userFull', id: rpc.peerTlId('alice'), about: 'Alice signature', commonChatsCount: 0,
      },
      users: [{ _: 'user', firstName: 'Alice' }],
    })
    const self = await rpc.getFullUser({
      _: 'users.getFullUser', id: { _: 'inputUserSelf' },
    })
    expect(self).toMatchObject({
      fullUser: { _: 'userFull', about: 'Self signature' },
      users: [{ _: 'user', self: true, firstName: 'Current', phone: '888123456789012' }],
    })

    const emptyAbout = await rpc.getFullUser({
      _: 'users.getFullUser',
      id: { _: 'inputUser', userId: rpc.peerTlId('bob'), accessHash: Long.ZERO },
    })
    expect(emptyAbout).toMatchObject({
      fullUser: { _: 'userFull', id: rpc.peerTlId('bob'), about: '' },
    })
    expect(getUser.mock.calls).toEqual([[session, 'me']])
    expect(() => wireRoundTrip(contacts)).not.toThrow()
    expect(() => wireRoundTrip(full)).not.toThrow()
    expect(() => wireRoundTrip(self)).not.toThrow()
    expect(() => wireRoundTrip(emptyAbout)).not.toThrow()
  })

  it('uses one cold profile lookup and degrades when optional self profile loading fails', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    const getUser = vi.spyOn(platform, 'getUser')
    const aliceId = rpc.peerTlId('alice')

    await expect(rpc.getFullUser({
      _: 'users.getFullUser',
      id: { _: 'inputUser', userId: aliceId, accessHash: Long.ZERO },
    })).resolves.toMatchObject({
      fullUser: { _: 'userFull', id: aliceId, about: 'Alice signature' },
    })
    expect(getUser.mock.calls).toEqual([[session, 'alice']])

    getUser.mockRejectedValueOnce(new Error('profile temporarily unavailable'))
    await expect(rpc.getFullUser({
      _: 'users.getFullUser', id: { _: 'inputUserSelf' },
    })).resolves.toMatchObject({
      fullUser: { _: 'userFull' }, users: [{ _: 'user', self: true }],
    })
  })

  it('marks only authoritative address-book users as contacts and refreshes cached flags', async () => {
    const platform = new DialogTestPlatform()
    platform.contactIds = ['alice']
    const rpc = new DialogRpc(platform, session)

    const dialogsBeforeContacts = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const beforeByName = new Map(dialogsBeforeContacts.users
      .filter((user): user is tl.RawUser => user._ === 'user')
      .map((user) => [user.firstName, user]))
    expect(beforeByName.get('Alice')).toMatchObject({ contact: undefined, mutualContact: undefined })
    expect(beforeByName.get('Bob')).toMatchObject({ contact: undefined, mutualContact: undefined })

    const firstSnapshot = await rpc.getContacts()
    expect(firstSnapshot.users).toMatchObject([
      { _: 'user', firstName: 'Alice', contact: true, mutualContact: true },
    ])

    const afterFirstSnapshot = await rpc.getUsers({
      _: 'users.getUsers',
      id: [
        { _: 'inputUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
        { _: 'inputUser', userId: rpc.peerTlId('bob'), accessHash: Long.ZERO },
      ],
    }) as tl.RawUser[]
    expect(afterFirstSnapshot[0]).toMatchObject({ firstName: 'Alice', contact: true, mutualContact: true })
    expect(afterFirstSnapshot[1]).toMatchObject({ firstName: 'Bob', contact: undefined, mutualContact: undefined })

    platform.contactIds = ['bob']
    await rpc.getContacts()
    const afterReplacement = await rpc.getUsers({
      _: 'users.getUsers',
      id: [
        { _: 'inputUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
        { _: 'inputUser', userId: rpc.peerTlId('bob'), accessHash: Long.ZERO },
      ],
    }) as tl.RawUser[]
    expect(afterReplacement[0]).toMatchObject({ firstName: 'Alice', contact: undefined, mutualContact: undefined })
    expect(afterReplacement[1]).toMatchObject({ firstName: 'Bob', contact: true, mutualContact: true })

    platform.contactIds = []
    const emptySnapshot = await rpc.getContacts()
    expect(emptySnapshot).toMatchObject({ contacts: [], users: [], savedCount: 0 })
    const afterEmptySnapshot = await rpc.getUsers({
      _: 'users.getUsers',
      id: [{ _: 'inputUser', userId: rpc.peerTlId('bob'), accessHash: Long.ZERO }],
    }) as tl.RawUser[]
    expect(afterEmptySnapshot[0]).toMatchObject({ firstName: 'Bob', contact: undefined, mutualContact: undefined })
  })

  it('sends exactly once per random ID and exposes the outgoing message in history', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    const aliceId = stableId('peer:alice')
    const request = sendMessageRequest(aliceId)

    const first = await rpc.sendMessage(request) as tl.RawUpdates
    const duplicate = await rpc.sendMessage(request) as tl.RawUpdates
    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({
      _: 'updates', seq: 0,
      updates: [
        { _: 'updateMessageID', randomId: request.randomId },
        {
          _: 'updateNewMessage', ptsCount: 1,
          message: { _: 'message', out: true, message: request.message },
        },
      ],
    })
    const sentId = (first.updates[0] as tl.RawUpdateMessageID).id

    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const sent = history.messages.filter((message) => message._ === 'message' && message.message === request.message)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ _: 'message', id: sentId, out: true })
    expect(() => wireRoundTrip(first)).not.toThrow()
  })

  it('maps permanent platform send rejection to a non-retryable MTProto error', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getContacts()
    const aliceId = rpc.peerTlId('alice')
    const send = vi.spyOn(platform, 'sendMessage')
      .mockRejectedValueOnce(new IMMessageSendRejectedError(
        'permission-denied',
        'QQNT bridge 403: QQ message send rejected',
      ))
      .mockRejectedValueOnce(new Error('QQNT bridge 500: temporary send failure'))

    await expect(rpc.sendMessage(sendMessageRequest(aliceId, {
      randomId: Long.fromNumber(12_001),
    }))).rejects.toMatchObject({ code: 403, text: 'CHAT_WRITE_FORBIDDEN' })
    await expect(rpc.sendMessage(sendMessageRequest(aliceId, {
      randomId: Long.fromNumber(12_002),
    }))).rejects.toThrow('QQNT bridge 500: temporary send failure')
    send.mockRejectedValueOnce(new IMMessageSendRejectedError(
      'platform-rejected',
      'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
    ))
    await expect(rpc.sendMessage(sendMessageRequest(aliceId, {
      randomId: Long.fromNumber(12_003),
    }))).rejects.toMatchObject({
      code: 400,
      text: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
    })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('resolves a reply from the message target loaded into the active dialog', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    const aliceId = rpc.peerTlId('alice')
    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const target = history.messages.find((message) => message._ === 'message' && message.message === 'Hey there!')
    expect(target).toMatchObject({ _: 'message' })

    await rpc.sendMessage(sendMessageRequest(aliceId, {
      randomId: Long.fromNumber(1235),
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: target!.id },
    }))

    expect(platform.lastInput).toMatchObject({ replyToId: '1' })
  })

  it('passes a stable native sequence with replies whose opaque platform ID may change', async () => {
    const platform = new DialogTestPlatform()
    platform.addMessage('alice', {
      id: 'old-account-view-id', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_010,
      content: { parts: [{ type: 'text', text: 'stable reply target' }] },
      metadata: { qqMsgSeq: '571' },
    })
    const rpc = new DialogRpc(platform, session)
    const aliceId = rpc.peerTlId('alice')
    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const target = history.messages.find((message) =>
      message._ === 'message' && message.message === 'stable reply target')
    expect(target).toMatchObject({ _: 'message' })

    await rpc.sendMessage(sendMessageRequest(aliceId, {
      randomId: Long.fromNumber(1236),
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: target!.id },
    }))

    expect(platform.lastInput).toMatchObject({
      replyToId: 'old-account-view-id',
      replyToNativeSequence: '571',
    })
  })

  it('maps Telegram mention-name entities to opaque platform users and back', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs(getDialogsRequest())
    const aliceId = rpc.peerTlId('alice')
    const bobId = rpc.peerTlId('bob')
    const sent = await rpc.sendMessage(sendMessageRequest(aliceId, {
      message: 'hello @Bob', randomId: Long.fromNumber(998),
      entities: [{
        _: 'inputMessageEntityMentionName', offset: 6, length: 4,
        userId: { _: 'inputUser', userId: bobId, accessHash: Long.ZERO },
      }],
    })) as tl.RawUpdates
    const sentId = (sent.updates[0] as tl.RawUpdateMessageID).id

    expect(platform.lastInput).toEqual({ parts: [{
      type: 'text', text: 'hello @Bob',
      entities: [{ type: 'mention', offset: 6, length: 4, userId: 'bob' }],
    }], replyToId: undefined })
    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const message = history.messages.find((item) => item._ === 'message' && item.id === sentId)
    expect(message).toMatchObject({
      _: 'message',
      entities: [{ _: 'messageEntityMentionName', offset: 6, length: 4, userId: bobId }],
    })
  })

  it('resolves Telegram username mention entities to opaque platform users', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getContacts()
    const aliceId = rpc.peerTlId('alice')
    const bobId = rpc.peerTlId('bob')
    const text = 'hello @BoB and @missing'
    const sent = await rpc.sendMessage(sendMessageRequest(aliceId, {
      message: text, randomId: Long.fromNumber(999),
      entities: [
        { _: 'messageEntityMention', offset: text.indexOf('@BoB'), length: '@BoB'.length },
        { _: 'messageEntityMention', offset: text.indexOf('@missing'), length: '@missing'.length },
      ],
    })) as tl.RawUpdates
    const sentId = (sent.updates[0] as tl.RawUpdateMessageID).id

    expect(platform.lastInput).toEqual({ parts: [{
      type: 'text', text,
      entities: [{ type: 'mention', offset: text.indexOf('@BoB'), length: '@BoB'.length, userId: 'bob' }],
    }], replyToId: undefined })
    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const message = history.messages.find((item) => item._ === 'message' && item.id === sentId)
    expect(message).toMatchObject({
      _: 'message',
      entities: [{
        _: 'messageEntityMentionName', offset: text.indexOf('@BoB'), length: '@BoB'.length, userId: bobId,
      }],
    })
  })

  it('refreshes contacts before resolving a username absent from loaded dialogs', async () => {
    class ContactsOnlyMentionPlatform extends DialogTestPlatform {
      override async getDialogs(): Promise<IMDialogPage> {
        const page = await super.getDialogs()
        return { dialogs: page.dialogs.filter((dialog) => dialog.conversation.id === 'alice') }
      }
    }
    const platform = new ContactsOnlyMentionPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs(getDialogsRequest())
    const aliceId = rpc.peerTlId('alice')
    const text = 'hello @BoB and @missing'

    await rpc.sendMessage(sendMessageRequest(aliceId, {
      message: text, randomId: Long.fromNumber(1_001),
      entities: [
        { _: 'messageEntityMention', offset: text.indexOf('@BoB'), length: '@BoB'.length },
        { _: 'messageEntityMention', offset: text.indexOf('@missing'), length: '@missing'.length },
      ],
    }))

    expect(platform.lastInput).toMatchObject({ parts: [{
      type: 'text', text,
      entities: [{ type: 'mention', offset: text.indexOf('@BoB'), length: '@BoB'.length, userId: 'bob' }],
    }] })
  })

  it('infers known @username text without mistaking email addresses or unknown users for mentions', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getContacts()
    const aliceId = rpc.peerTlId('alice')
    const text = 'hi @BoB, email a@bob.test and ping @missing'
    await rpc.sendMessage(sendMessageRequest(aliceId, {
      message: text, randomId: Long.fromNumber(1_000), entities: [],
    }))

    expect(platform.lastInput).toEqual({ parts: [{
      type: 'text', text,
      entities: [{ type: 'mention', offset: text.indexOf('@BoB'), length: '@BoB'.length, userId: 'bob' }],
    }], replyToId: undefined })
  })

  it('exposes plain platform links as clickable Telegram entities through serialized history', async () => {
    const platform = new DialogTestPlatform()
    const first = '😀 docs: https://example.com/a_(b).'
    const qqGroupUrl = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    const second = `官网 ${qqGroupUrl}，@Bob`
    platform.addMessage('alice', {
      id: 'linked', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_225,
      content: { parts: [
        { type: 'text', text: first },
        {
          type: 'text', text: second,
          entities: [{ type: 'mention', offset: second.indexOf('@Bob'), length: 4, userId: 'bob' }],
        },
      ] },
    })
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs(getDialogsRequest())

    const history = wireRoundTrip(
      await rpc.getHistory(getHistoryRequest(rpc.peerTlId('alice'))),
    ) as tl.messages.RawMessages
    const message = history.messages.find(
      (item) => item._ === 'message' && item.message.includes('example.com'),
    ) as tl.RawMessage
    const text = `${first}\n${second}`

    expect(message.message).toBe(text)
    expect(message.entities).toEqual([
      {
        _: 'messageEntityUrl', offset: text.indexOf('https://'),
        length: 'https://example.com/a_(b)'.length,
      },
      {
        _: 'messageEntityUrl', offset: text.indexOf(qqGroupUrl), length: qqGroupUrl.length,
      },
      {
        _: 'messageEntityMentionName', offset: text.indexOf('@Bob'), length: 4,
        userId: rpc.peerTlId('bob'),
      },
    ])
  })

  it('separates adjacent links and mentions without linking filenames or dot-separated prose', async () => {
    const platform = new DialogTestPlatform()
    const prose = '我想到隔壁有人用.net写东西后aot并且导出C符号入口点给cpp乃至Java用'
    const text = `地址 http://aaa.com@某个群友，附件 这不是一个链接啊.zip，讨论 ${prose}`
    const mentionOffset = text.indexOf('@')
    platform.addMessage('alice', {
      id: 'link-boundaries', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_230,
      content: { parts: [{
        type: 'text', text,
        entities: [{ type: 'mention', offset: mentionOffset, length: '@某个群友'.length, userId: 'bob' }],
      }] },
    })
    const rpc = new DialogRpc(platform, session)
    await rpc.getDialogs(getDialogsRequest())

    const history = wireRoundTrip(
      await rpc.getHistory(getHistoryRequest(rpc.peerTlId('alice'))),
    ) as tl.messages.RawMessages
    const message = history.messages.find(
      (item) => item._ === 'message' && item.message === text,
    ) as tl.RawMessage

    expect(message.entities).toEqual([
      {
        _: 'messageEntityUrl', offset: text.indexOf('http://'), length: 'http://aaa.com'.length,
      },
      {
        _: 'messageEntityMentionName', offset: mentionOffset, length: '@某个群友'.length,
        userId: rpc.peerTlId('bob'),
      },
    ])
  })

  it('prepares virtual deep links through peer-dialog and search projections', async () => {
    const platform = new DialogTestPlatform()
    const peerArchive = {
      id: 'peer-dialog-archive', kind: 'group' as const, title: 'Peer dialog archive',
      metadata: { conversationView: 'merged-forward' },
    }
    const searchArchive = {
      id: 'search-archive', kind: 'group' as const, title: 'Search archive',
      metadata: { conversationView: 'merged-forward' },
    }
    platform.addMessage('alice', {
      id: 'peer-link', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_250,
      content: { parts: [{
        type: 'text', text: 'peer link',
        entities: [{ type: 'conversation-link', offset: 0, length: 9, conversation: peerArchive }],
      }] },
    })
    platform.addMessage('alice', {
      id: 'search-link', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_251,
      content: { parts: [{
        type: 'text', text: 'search link',
        entities: [{ type: 'conversation-link', offset: 0, length: 11, conversation: searchArchive }],
      }] },
    })
    for (const conversation of [peerArchive, searchArchive]) {
      platform.addMessage(conversation.id, {
        id: `${conversation.id}-first`, conversationId: conversation.id, senderId: 'bob', timestamp: 1_700_000_249,
        content: { parts: [{ type: 'text', text: `${conversation.id} first` }] },
      })
    }
    const rpc = makeViewRpc(platform)
    const peerDialogs = await rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs', peers: [{
        _: 'inputDialogPeer',
        peer: { _: 'inputPeerUser', userId: stableId('peer:alice'), accessHash: Long.ZERO },
      }],
    })
    const peerMessage = peerDialogs.messages[0] as tl.RawMessage
    const peerEntity = peerMessage.entities?.find(
      (entity): entity is tl.RawMessageEntityTextUrl => entity._ === 'messageEntityTextUrl',
    )
    expect(peerEntity?.url).toMatch(new RegExp(`/bridgechat_${stableId(`peer:${searchArchive.id}`)}/\\d+$`))

    const search = await rpc.search({
      _: 'messages.search',
      peer: { _: 'inputPeerUser', userId: stableId('peer:alice'), accessHash: Long.ZERO },
      q: 'peer link', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    const searchMessage = search.messages[0] as tl.RawMessage
    const searchEntity = searchMessage.entities?.find(
      (entity): entity is tl.RawMessageEntityTextUrl => entity._ === 'messageEntityTextUrl',
    )
    expect(searchEntity?.url).toMatch(new RegExp(`/bridgechat_${stableId(`peer:${peerArchive.id}`)}/\\d+$`))
  })

  it('renders an addressable non-dialog conversation as a Telegram message preview card', async () => {
    const platform = new DialogTestPlatform()
    const getHistory = vi.spyOn(platform, 'getHistory')
    const temporary = {
      id: 'temporary-forward', kind: 'group' as const, title: '聊天记录',
      metadata: {
        conversationView: 'merged-forward',
        qqMultiForwardPreview: 'Bob: native preview\nAlice: work',
      },
    }
    platform.addMessage('alice', {
      id: 'merged', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_250,
      content: { parts: [{
        type: 'text', text: '查看聊天记录',
        entities: [{ type: 'conversation-link', offset: 0, length: 6, conversation: temporary }],
      }] },
    })
    platform.addMessage(temporary.id, {
      id: 'inside', conversationId: temporary.id, senderId: 'bob', timestamp: 1_700_000_251,
      sender: { id: 'bob', firstName: 'Bob' },
      content: { parts: [{ type: 'text', text: 'forwarded content' }] },
    })
    platform.addMessage(temporary.id, {
      id: 'inside-2', conversationId: temporary.id, senderId: 'alice', timestamp: 1_700_000_252,
      sender: { id: 'alice', firstName: 'Alice' },
      content: { parts: [{ type: 'text', text: 'work' }] },
    })
    const views = createTestConversationViews()
    const rpc = makeViewRpc(platform, views)
    await rpc.getDialogs(getDialogsRequest())
    expect(platform.historyCalls).toContain(temporary.id)
    expect(getHistory).toHaveBeenCalledWith(
      session, { id: temporary.id }, { limit: 200 },
    )
    const aliceId = rpc.peerTlId('alice')
    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const merged = history.messages.find((item) => item._ === 'message' && item.id > 0) as tl.RawMessage
    const temporaryId = rpc.peerTlId(temporary.id)
    if (merged.media?._ !== 'messageMediaWebPage' || merged.media.webpage._ !== 'webPage') {
      throw new Error('merged forward preview was not projected as a full webpage')
    }
    const url = merged.media.webpage.url
    const insideFirstId = Number(new URL(url).pathname.split('/').at(-1))
    expect(insideFirstId).toBeGreaterThan(0)
    expect(merged.message).toBe('查看聊天记录')
    expect(merged.entities).toMatchObject([{
      _: 'messageEntityTextUrl', offset: 0, length: 6, url,
    }])
    expect(merged.media).toMatchObject({
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage',
        url: `https://t.me/bridgechat_${temporaryId}/${insideFirstId}`,
        displayUrl: '聊天记录', type: 'telegram_message',
        title: '聊天记录', description: 'Bob: native preview\nAlice: work',
      },
    })
    expect(history.chats).toMatchObject([{ _: 'chat', id: temporaryId, title: '聊天记录' }])
    expect(() => wireRoundTrip(history)).not.toThrow()

    const inside = await rpc.getHistory(getHistoryRequest(temporaryId, {
      peer: { _: 'inputPeerChat', chatId: temporaryId },
    })) as tl.messages.RawMessages
    expect(inside.messages).toMatchObject([
      { _: 'message', message: 'work' },
      { _: 'message', message: 'forwarded content' },
    ])

    // Telegram Desktop opens chats through multiple MTProto connections.
    // A fresh DialogRpc must resolve the linked virtual peer and serve the
    // bootstrap requests without calling nonexistent upstream member APIs.
    const freshRpc = makeViewRpc(platform, views)
    const peer = { _: 'inputPeerChat' as const, chatId: temporaryId }
    expect(freshRpc.resolveUsername({
      _: 'contacts.resolveUsername', username: `bridgechat_${temporaryId}`,
    })).toMatchObject({
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: temporaryId },
      chats: [{ _: 'chat', id: temporaryId, title: '聊天记录' }],
    })
    await expect(freshRpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: insideFirstId }],
    })).resolves.toMatchObject({
      messages: [{ _: 'message', id: insideFirstId, message: 'forwarded content' }],
    })
    await expect(freshRpc.getPeerDialogs({
      _: 'messages.getPeerDialogs', peers: [{
        _: 'inputDialogPeer', peer,
      }],
    })).resolves.toMatchObject({
      dialogs: [{ peer: { _: 'peerChat', chatId: temporaryId }, topMessage: expect.any(Number) }],
      messages: [{ _: 'message', message: 'work' }],
      chats: [{ _: 'chat', id: temporaryId, title: '聊天记录' }],
    })
    await expect(freshRpc.getScheduledHistory({
      _: 'messages.getScheduledHistory', peer, hash: Long.ZERO,
    })).resolves.toMatchObject({ _: 'messages.messages', messages: [] })
    await expect(freshRpc.getFullChat({ _: 'messages.getFullChat', chatId: temporaryId }))
      .resolves.toMatchObject({
        _: 'messages.chatFull',
        fullChat: {
          _: 'chatFull', id: temporaryId,
          participants: { _: 'chatParticipantsForbidden', chatId: temporaryId },
        },
        chats: [{ _: 'chat', left: true, id: temporaryId, title: '聊天记录' }], users: [],
      })
    await expect(freshRpc.getFullChannel({
      _: 'channels.getFullChannel',
      channel: { _: 'inputChannel', channelId: temporaryId, accessHash: Long.ZERO },
    })).rejects.toMatchObject({ code: 400, text: 'CHANNEL_INVALID' } satisfies Partial<RpcError>)
    const freshHistory = await freshRpc.getHistory(getHistoryRequest(temporaryId, { peer })) as tl.messages.RawMessages
    expect(freshHistory).toMatchObject({ messages: [
        { _: 'message', message: 'work' },
        { _: 'message', message: 'forwarded content' },
      ] })
    const newest = freshHistory.messages[0] as tl.RawMessage
    await expect(freshRpc.readHistory({ _: 'messages.readHistory', peer, maxId: newest.id }))
      .resolves.toMatchObject({ _: 'messages.affectedMessages' })
    expect(platform.readTargets).toEqual([])
  })

  it('maps platform inline custom emoji entities to Telegram documents and back', async () => {
    const platform = new DialogTestPlatform()
    const definition = {
      key: '1:14', title: 'QQ 微笑',
      presentation: {
        type: 'custom' as const, alt: '🙂',
        resource: {
          version: 1, format: 'static' as const, mimeType: 'image/png' as const,
          width: 32, height: 32, size: 3, locator: { faceId: '14' },
        },
      },
    }
    platform.addMessage('alice', {
      id: 'face', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_300,
      content: { parts: [{
        type: 'text', text: '🙂',
        entities: [{ type: 'custom-emoji', offset: 0, length: 2, definition }],
      }] },
    })
    const reactions = new ReactionRpc(platform, session)
    const rpc = new DialogRpc(platform, session, undefined, undefined, undefined, 1, undefined, reactions)
    await rpc.getDialogs(getDialogsRequest())
    const aliceId = rpc.peerTlId('alice')
    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const face = history.messages.find((item) => item._ === 'message' && item.message === '🙂') as tl.RawMessage
    expect(face.entities).toMatchObject([{
      _: 'messageEntityCustomEmoji', offset: 0, length: 2,
    }])
    const documentId = (face.entities![0] as any).documentId as Long
    const [document] = rpc.getCustomEmojiDocuments({
      _: 'messages.getCustomEmojiDocuments', documentId: [documentId],
    })
    expect(document.attributes).toContainEqual(expect.objectContaining({
      _: 'documentAttributeCustomEmoji', alt: '🙂',
    }))

    await rpc.sendMessage(sendMessageRequest(aliceId, {
      message: '🙂', randomId: Long.fromNumber(999),
      entities: [{ _: 'messageEntityCustomEmoji', offset: 0, length: 2, documentId }],
    }))
    expect(platform.lastInput).toMatchObject({ parts: [{
      type: 'text', text: '🙂',
      entities: [{ type: 'custom-emoji', offset: 0, length: 2, definition: { key: '1:14' } }],
    }] })
  })

  it('validates send capabilities, text length, scheduling, and unknown peers', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    await rpc.getContacts()
    const aliceId = rpc.peerTlId('alice')

    await expect(rpc.sendMessage(sendMessageRequest(aliceId, { message: '' })))
      .rejects.toMatchObject({ code: 400, text: 'MESSAGE_EMPTY' })
    await expect(rpc.sendMessage(sendMessageRequest(aliceId, { message: 'x'.repeat(4097), randomId: Long.fromNumber(2) })))
      .rejects.toMatchObject({ code: 400, text: 'MESSAGE_TOO_LONG' })
    await expect(rpc.sendMessage(sendMessageRequest(aliceId, { scheduleDate: 1_800_000_000, randomId: Long.fromNumber(3) })))
      .rejects.toMatchObject({ code: 400, text: 'SCHEDULED_MESSAGES_UNAVAILABLE' })
    await expect(rpc.sendMessage(sendMessageRequest(123456, { randomId: Long.fromNumber(4) })))
      .rejects.toMatchObject({ code: 400, text: 'PEER_ID_INVALID' })

    const disabled: IMPlatform = {
      ...platform,
      capabilities: { ...platform.capabilities, send: { ...platform.capabilities.send, text: false } },
      subscribe: platform.subscribe.bind(platform),
      sendMessage: platform.sendMessage.bind(platform),
      getDialogs: platform.getDialogs.bind(platform),
      getHistory: platform.getHistory.bind(platform),
      getUser: platform.getUser.bind(platform),
    }
    await expect(new DialogRpc(disabled, session).sendMessage(sendMessageRequest(aliceId)))
      .rejects.toMatchObject({ code: 400, text: 'MESSAGE_SEND_UNAVAILABLE' })
  })

  it('keeps channel and user IDs independent when their platform IDs are identical', async () => {
    const collisionId = '1002974327'
    const conversation = { id: collisionId, kind: 'group' as const, title: 'Colliding QQ group' }
    const message: IMMessage = {
      id: 'group-message', conversationId: collisionId, senderId: collisionId,
      sender: { id: collisionId, firstName: 'Colliding QQ user' },
      timestamp: 1_700_000_000, content: { parts: [{ type: 'text', text: 'first chat history' }] },
    }
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: message }] } },
      async getHistory() { return { messages: [message] } },
      async getUser(_session, id) { return { id, firstName: 'Colliding QQ user' } },
    }
    const rpc = new DialogRpc(platform, session)
    ;(rpc as any)._registerUser({
      id: 42, platformId: session.platformId, platformUserId: collisionId,
      firstName: 'Colliding QQ user', lastName: null, username: null, avatar: null,
      metadata: {}, updatedAt: new Date(),
    })

    const channelId = stableId(`peer:${collisionId}`)
    const history = await rpc.getHistory({
      _: 'messages.getHistory',
      peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ONE },
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
      maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    const [user] = await rpc.getUsers({
      _: 'users.getUsers', id: [{ _: 'inputUser', userId: 42, accessHash: Long.ONE }],
    })

    expect(history.messages).toMatchObject([{
      _: 'message', peerId: { _: 'peerChannel', channelId }, message: 'first chat history',
      fromId: { _: 'peerUser', userId: 42 },
    }])
    expect(history.chats).toMatchObject([{ _: 'channel', id: channelId, title: 'Colliding QQ group' }])
    expect(user).toMatchObject({ _: 'user', id: 42, firstName: 'Colliding QQ user' })
    expect(() => wireRoundTrip(history)).not.toThrow()
  })

  it('rejects unknown peers and platforms without history support', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    await expect(rpc.getHistory(getHistoryRequest(123456))).rejects.toMatchObject({
      code: 400, text: 'PEER_ID_INVALID',
    } satisfies Partial<RpcError>)

    const platform: IMPlatform = {
      capabilities: {
        history: false,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 100, maxMedia: 0 },
        conversations: { groups: false, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
    }
    await expect(new DialogRpc(platform, session).getDialogs(getDialogsRequest())).rejects.toMatchObject({
      code: 400, text: 'HISTORY_UNAVAILABLE',
    } satisfies Partial<RpcError>)
  })
})

describe('stableId', () => {
  it('is deterministic, positive, and namespaces different entities', () => {
    expect(stableId('peer:alice')).toBe(stableId('peer:alice'))
    expect(stableId('peer:alice')).toBeGreaterThan(0)
    expect(stableId('peer:alice')).toBeLessThanOrEqual(0x7fffffff)
    expect(stableId('peer:alice')).not.toBe(stableId('message:alice'))
  })
})
