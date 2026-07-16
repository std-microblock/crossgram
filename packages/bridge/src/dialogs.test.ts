import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { DialogRpc, stableId } from './dialogs.js'
import { StaticDemoPlatform, type IMPlatform, type PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'session-1',
  platformId: 'static-demo',
  userId: 'me',
  credentials: { token: 'test' },
  metadata: { firstName: 'Current', lastName: 'User' },
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

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('DialogRpc', () => {
  it('builds serializable dialogs, users, and top messages in newest-first order', async () => {
    const rpc = new DialogRpc(new StaticDemoPlatform(), session)
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
    const rpc = new DialogRpc(new StaticDemoPlatform(), session)
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

  it('returns filtered history and includes peer plus current user metadata', async () => {
    const rpc = new DialogRpc(new StaticDemoPlatform(), session)
    const aliceId = rpc.peerTlId('alice')
    const full = await rpc.getHistory(getHistoryRequest(aliceId)) as tl.messages.RawMessages

    expect(full.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'How are you?', 'Hey there!',
    ])
    expect(full.users.map((user) => user._ === 'user' ? user.firstName : '')).toEqual(['Alice', 'Current'])
    const newest = full.messages[0] as tl.RawMessage
    const oldest = full.messages[1] as tl.RawMessage
    expect(newest.id).toBeGreaterThan(oldest.id)
    const olderOnly = await rpc.getHistory(getHistoryRequest(aliceId, { offsetDate: newest.date }))
    expect(olderOnly.messages).toHaveLength(1)
    const afterNewest = await rpc.getHistory(getHistoryRequest(aliceId, { offsetId: newest.id }))
    expect(afterNewest.messages).toEqual([oldest])
    expect(() => wireRoundTrip(full)).not.toThrow()
  })

  it('hydrates messages by synthetic ID and returns messageEmpty for unknown IDs', async () => {
    const rpc = new DialogRpc(new StaticDemoPlatform(), session)
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

  it('rejects unknown peers and platforms without history support', async () => {
    const rpc = new DialogRpc(new StaticDemoPlatform(), session)
    await expect(rpc.getHistory(getHistoryRequest(123456))).rejects.toMatchObject({
      code: 400, text: 'PEER_ID_INVALID',
    } satisfies Partial<RpcError>)

    const platform: IMPlatform = {
      id: 'push-only',
      capabilities: { history: false, sendMessage: true, groups: false, maxMessageLength: 100 },
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
