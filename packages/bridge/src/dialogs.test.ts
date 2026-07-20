import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { DialogRpc, stableId } from './dialogs.js'
import type {
  IMDialogPage, IMHistoryPage, IMMessage, IMMessageInput, IMPlatform, IMUser, PlatformSession,
} from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'session-1',
  platformId: 'static-demo',
  userId: 'me',
  credentials: { token: 'test' },
  metadata: { firstName: 'Current', lastName: 'User' },
}

class DialogTestPlatform implements IMPlatform {
  readonly id = 'dialog-test'
  readonly capabilities = {
    history: true,
    send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
    conversations: { groups: false, channels: false, subchannels: false },
  }
  private readonly _users: Record<string, IMUser> = {
    alice: { id: 'alice', firstName: 'Alice', username: 'alice' },
    bob: { id: 'bob', firstName: 'Bob', username: 'bob' },
  }
  private readonly _messages: Record<string, IMMessage[]> = {
    alice: [
      this._message('1', 'alice', 'Hey there!', 1_700_000_000),
      this._message('2', 'alice', 'How are you?', 1_700_000_100),
    ],
    bob: [this._message('1', 'bob', 'Meeting at 3?', 1_700_000_200)],
  }
  private _sequence = 100

  async subscribe() { return () => {} }

  async sendMessage(
    _session: PlatformSession,
    conversation: { id: string },
    content: IMMessageInput,
  ): Promise<IMMessage> {
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
    const message = this._message(String(++this._sequence), conversation.id, text, Math.floor(Date.now() / 1000), true)
    ;(this._messages[conversation.id] ??= []).push(message)
    return message
  }

  async getDialogs(): Promise<IMDialogPage> {
    return {
      dialogs: Object.values(this._users).map((user) => ({
        conversation: { id: user.id, kind: 'direct', title: user.firstName },
        unreadCount: 0,
        lastMessage: this._messages[user.id].at(-1),
      })),
    }
  }

  async getHistory(_session: PlatformSession, conversation: { id: string }): Promise<IMHistoryPage> {
    return { messages: this._messages[conversation.id] ?? [] }
  }

  async getUser(_session: PlatformSession, id: string): Promise<IMUser | null> {
    return this._users[id] ?? null
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
  it('builds serializable dialogs, users, and top messages in newest-first order', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const result = await rpc.getDialogs(getDialogsRequest())
    const decoded = wireRoundTrip(result) as tl.messages.RawDialogs

    expect(decoded._).toBe('messages.dialogs')
    expect(decoded.dialogs).toHaveLength(2)
    expect(decoded.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'Meeting at 3?', 'How are you?',
    ])
    expect(decoded.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['Bob', 'Alice'])
    expect(decoded.dialogs[0]).toMatchObject({
      _: 'dialog', unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
    })
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

  it('returns a serializable empty pinned-dialog page for folder merging', () => {
    const result = new DialogRpc(new DialogTestPlatform(), session).getPinnedDialogs()
    expect(result).toMatchObject({
      _: 'messages.peerDialogs', dialogs: [], messages: [], chats: [], users: [],
      state: { _: 'updates.state', pts: 1, qts: 0, seq: 0, unreadCount: 0 },
    })
    expect(() => wireRoundTrip(result)).not.toThrow()
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
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    const contacts = await rpc.getContacts()
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
    expect(users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['Current', 'Alice'])

    const full = await rpc.getFullUser({
      _: 'users.getFullUser',
      id: { _: 'inputUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
    })
    expect(full).toMatchObject({
      _: 'users.userFull',
      fullUser: { _: 'userFull', id: rpc.peerTlId('alice'), commonChatsCount: 0 },
      users: [{ _: 'user', firstName: 'Alice' }],
    })
    expect(() => wireRoundTrip(contacts)).not.toThrow()
    expect(() => wireRoundTrip(full)).not.toThrow()
  })

  it('sends exactly once per random ID and exposes the outgoing message in history', async () => {
    const platform = new DialogTestPlatform()
    const rpc = new DialogRpc(platform, session)
    const aliceId = stableId('peer:alice')
    const request = sendMessageRequest(aliceId)

    const first = await rpc.sendMessage(request)
    const duplicate = await rpc.sendMessage(request)
    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({
      _: 'updateShortSentMessage', out: true, ptsCount: 1,
    })

    const history = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages
    const sent = history.messages.filter((message) => message._ === 'message' && message.message === request.message)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ _: 'message', id: first.id, out: true })
    expect(() => wireRoundTrip(first)).not.toThrow()
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
      id: 'disabled',
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

  it('rejects unknown peers and platforms without history support', async () => {
    const rpc = new DialogRpc(new DialogTestPlatform(), session)
    await expect(rpc.getHistory(getHistoryRequest(123456))).rejects.toMatchObject({
      code: 400, text: 'PEER_ID_INVALID',
    } satisfies Partial<RpcError>)

    const platform: IMPlatform = {
      id: 'push-only',
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
