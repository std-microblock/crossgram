import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry, PlatformSubscriptionManager } from './platform-manager.js'
import { UpdateManager } from './update-manager.js'
import type { IMEvent, IMPlatform, IMRequest, PlatformSession } from './platform.js'
import {
  REQUEST_ACCEPT_CALLBACK_DATA, REQUEST_INBOX_CONVERSATION_ID, REQUEST_REJECT_CALLBACK_DATA,
  RequestInboxSystemPeerProvider, requestInboxMessage,
} from './request-inbox.js'
import { SystemPeerCallbackError, SystemPeerService } from './system-peer.js'

const session: PlatformSession = {
  platformSessionId: 'request-rpc-session', platformId: 'request-rpc', userId: 'self', credentials: {}, metadata: {},
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createRequestRpc(
  resolveRequest: IMPlatform['resolveRequest'],
  options: { history?: boolean, drafts?: boolean, failLocalDeliveryOnce?: boolean } = {},
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
  const getMessage = vi.fn()
  const getHistory = vi.fn(async () => ({ messages: [] }))
  const getUser = vi.fn(async () => null)
  const getConversation = vi.fn(async () => null)
  const searchMessages = vi.fn(async () => ({ messages: [] }))
  const clickInlineButton = vi.fn()
  const mutations = {
    sendMessage: vi.fn(), editMessage: vi.fn(), deleteMessages: vi.fn(),
    forwardMessages: vi.fn(async () => []), setMessageReactions: vi.fn(), markRead: vi.fn(),
  }
  const platform: IMPlatform = {
    capabilities: {
      history: options.history ?? false,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
      conversations: { groups: true, channels: true, subchannels: true },
      reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 20 },
      messageActions: { edit: { mode: 'native' }, delete: { own: { supported: true }, others: { supported: true } }, forward: { mode: 'native', preservesAuthor: true } },
    },
    async subscribe() { return () => {} },
    async sendMessage() { return mutations.sendMessage() },
    async editMessage(...args: any[]) { return mutations.editMessage(...args) },
    async deleteMessages(...args: any[]) { return mutations.deleteMessages(...args) },
    async forwardMessages() { return mutations.forwardMessages() },
    async setMessageReactions(...args: any[]) { return mutations.setMessageReactions(...args) },
    async markRead(...args: any[]) { return mutations.markRead(...args) },
    resolveRequest, getMessage, getHistory, getUser, getConversation, searchMessages, clickInlineButton,
  }
  const store = new MessageStore(ctx.database)
  let failLocalDelivery = options.failLocalDeliveryOnce ?? false
  const peers = new SystemPeerService(ctx)
  const deliver = async (_session: PlatformSession, event: IMEvent) => {
    if (failLocalDelivery) {
      failLocalDelivery = false
      throw new Error('simulated update delivery failure')
    }
    localEvents.push(event)
    if (event.type === 'request') await store.ingestRequest(session, event.request)
  }
  const localEvents: IMEvent[] = []
  peers.attach(deliver)
  peers.register(new RequestInboxSystemPeerProvider(
    store,
    async (requestSession, requestId, action) => {
      if (!resolveRequest) throw new SystemPeerCallbackError('REQUEST_RESOLVE_UNAVAILABLE')
      return resolveRequest(requestSession, requestId, action)
    },
    async (requestSession, request) => { await peers.emit(requestSession, { type: 'request', request, delivery: 'recovery' }) },
  ))
  const createRpc = (localEvents: IMEvent[]) => new DialogRpc(
    platform, session, store, undefined, undefined, 1, undefined, undefined, undefined,
    async (_session, event) => deliver(session, event), undefined, undefined,
    options.drafts ? { list: async () => [], save: async () => {}, remove: async () => {} } as any : undefined,
    undefined, undefined, undefined, undefined, undefined, peers,
  )
  const rpc = createRpc(localEvents)
  const createSiblingRpc = () => {
    const localEvents: IMEvent[] = []
    return { rpc: createRpc(localEvents), localEvents }
  }
  return { rpc, createSiblingRpc, platform, database: ctx.database, store, resolveRequest, localEvents, getMessage, getHistory, getUser, getConversation, searchMessages, clickInlineButton, mutations }
}

async function seedPendingRequest(store: MessageStore): Promise<IMRequest> {
  const request: IMRequest = {
    id: 'opaque/request id', kind: 'friend', state: 'pending', createdAt: 100,
    requester: { id: 'alice', firstName: 'Alice' },
  }
  await store.ingestRequest(session, request)
  return request
}

describe('request inbox dialog identity', () => {
  it.each([
    ['friend', {
      id: 'friend-request', kind: 'friend' as const, state: 'pending' as const, createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }],
    ['group join', {
      id: 'group-request', kind: 'group-join' as const, state: 'pending' as const, createdAt: 100,
      requester: { id: 'bob', firstName: 'Bob' },
      group: { id: 'group', kind: 'group' as const, title: 'Group' },
    }],
  ])('marks the inbox as a bot when a %s request first loads dialogs', async (_kind, request) => {
    const { rpc, store } = await createRequestRpc(undefined)
    await store.ingestRequest(session, request)

    const dialogs = await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
      limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const inboxUser = dialogs.users.find((user): user is tl.RawUser =>
      user._ === 'user' && user.id === rpc.peerTlId(REQUEST_INBOX_CONVERSATION_ID))

    expect(inboxUser?.bot).toBe(true)
  })
})

async function inboxCallbackTarget(rpc: DialogRpc, store: MessageStore) {
  await rpc.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
    limit: 100, hash: Long.ZERO,
  })
  const [message] = await store.readProjectedHistory(session.platformSessionId, 'bridge:request-inbox')
  if (!message?.parts[0]) throw new Error('request inbox projection is missing')
  expect(message.source.senderId).toBe('bridge:request-inbox')
  return {
    peer: { _: 'inputPeerUser' as const, userId: rpc.peerTlId('bridge:request-inbox'), accessHash: Long.ZERO },
    msgId: message.parts[0].tlMessageId,
  }
}

describe('request inbox timestamps', () => {
  it('preserves a numeric-string creation time as a nonzero Unix timestamp', () => {
    expect(requestInboxMessage({
      id: 'numeric-timestamp', kind: 'friend', state: 'pending', createdAt: '1710000000',
      requester: { id: 'alice', firstName: 'Alice' },
    }).timestamp).toBe(1_710_000_000)
  })

  it('labels QQ-filtered friend requests with QQ’s original reason', () => {
    const message = requestInboxMessage({
      id: 'filtered-request', kind: 'friend', state: 'pending',
      requester: { id: 'alice', firstName: 'Alice' },
      metadata: { qqRequestSource: 'doubt', qqRequestReason: '疑似营销账号' },
    })
    expect(message.content.parts).toEqual([{
      type: 'text',
      text: '好友申请\n申请人：Alice\nQQ 已过滤\n风险提示：疑似营销账号\n验证信息：无\n状态：待处理',
    }])
  })

  it.each(['', '   '])('keeps the filtered label but omits blank QQ reasons', (qqRequestReason) => {
    const message = requestInboxMessage({
      id: 'filtered-blank-reason', kind: 'friend', state: 'pending',
      requester: { id: 'alice', firstName: 'Alice' },
      metadata: { qqRequestSource: 'doubt', qqRequestReason },
    })
    expect(message.content.parts).toEqual([{
      type: 'text', text: '好友申请\n申请人：Alice\nQQ 已过滤\n验证信息：无\n状态：待处理',
    }])
  })
})

describe('request inbox read-only boundary', () => {
  it('rejects write RPCs before their platform mutations', async () => {
    const { rpc, store, mutations } = await createRequestRpc(undefined, { drafts: true })
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)
    const writes: Array<[string, () => Promise<unknown>, keyof typeof mutations]> = [
      ['send', () => rpc.sendMessage({ _: 'messages.sendMessage', peer: target.peer, message: 'blocked', randomId: Long.ONE }), 'sendMessage'],
      ['edit', () => rpc.editMessage({ _: 'messages.editMessage', peer: target.peer, id: target.msgId, message: 'blocked' }), 'editMessage'],
      ['delete', () => rpc.deleteMessages({ _: 'messages.deleteMessages', id: [target.msgId], revoke: true }), 'deleteMessages'],
      ['forward-to', () => rpc.forwardMessages({ _: 'messages.forwardMessages', fromPeer: target.peer, toPeer: target.peer, id: [target.msgId], randomId: [Long.ONE] }), 'forwardMessages'],
      ['reaction', () => rpc.sendReaction({ _: 'messages.sendReaction', peer: target.peer, msgId: target.msgId, reaction: [] }), 'setMessageReactions'],
      ['draft', () => rpc.saveDraft({ _: 'messages.saveDraft', peer: target.peer, message: 'blocked', noWebpage: false, invertMedia: false }), 'sendMessage'],
    ]
    for (const [, invoke, mutation] of writes) {
      await expect(invoke()).rejects.toMatchObject({ text: 'CHAT_WRITE_FORBIDDEN' })
      expect(mutations[mutation]).not.toHaveBeenCalled()
    }
  })

  it('reads the inbox locally without calling upstream history or markRead', async () => {
    const { rpc, store, localEvents, getHistory, getUser, getConversation, mutations } = await createRequestRpc(undefined, { history: true })
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)
    getHistory.mockClear()
    getUser.mockClear()
    getConversation.mockClear()
    await rpc.getHistory({ _: 'messages.getHistory', peer: target.peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: Long.ZERO })
    await rpc.readHistory({ _: 'messages.readHistory', peer: target.peer, maxId: target.msgId })
    expect(localEvents).toMatchObject([{ type: 'read', conversationId: 'bridge:request-inbox' }])
    expect(getHistory).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
    expect(getConversation).not.toHaveBeenCalled()
    expect(mutations.markRead).not.toHaveBeenCalled()
  })

  it('searches persisted inbox projections without upstream search or synthetic IDs', async () => {
    const { rpc, store, searchMessages } = await createRequestRpc(undefined, { history: true })
    await seedPendingRequest(store)
    await store.ingestRequest(session, {
      id: 'newer-request-1', kind: 'friend', state: 'pending', createdAt: 101,
      requester: { id: 'bob', firstName: 'Bob' },
    })
    await store.ingestRequest(session, {
      id: 'newer-request-2', kind: 'friend', state: 'pending', createdAt: 102,
      requester: { id: 'carol', firstName: 'Carol' },
    })
    const target = await inboxCallbackTarget(rpc, store)

    const result = await rpc.search({
      _: 'messages.search', peer: target.peer, q: 'Alice', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: Long.ZERO,
    })

    expect(result).toMatchObject({ _: 'messages.messages', messages: [{ _: 'message', message: expect.stringContaining('Alice') }] })
    expect(searchMessages).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('bridge:request:')
  })

  it('keeps a later same-second request unread after marking the first read', async () => {
    const { store } = await createRequestRpc(undefined)
    const first = await seedPendingRequest(store)
    await store.ingestRequest(session, {
      id: 'opaque/request second', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'bob', firstName: 'Bob' },
    })

    await expect(store.markRead(session, 'bridge:request-inbox', requestInboxMessage(first).id))
      .resolves.toMatchObject({ unreadCount: 1 })
  })

  it('pages same-second requests in a complete stable local order', async () => {
    const { rpc, store } = await createRequestRpc(undefined, { history: true })
    for (const [id, firstName] of [
      ['same-second-alice', 'Alice'], ['same-second-bob', 'Bob'], ['same-second-carol', 'Carol'],
    ]) {
      await store.ingestRequest(session, {
        id, kind: 'friend', state: 'pending', createdAt: 200,
        requester: { id, firstName },
      })
    }
    const target = await inboxCallbackTarget(rpc, store)
    const request = {
      _: 'messages.getHistory' as const, peer: target.peer, offsetDate: 0, addOffset: 0,
      limit: 1, maxId: 0, minId: 0, hash: Long.ZERO,
    }
    const messages: any[] = []
    let offsetId = 0
    for (let page = 0; page < 3; page++) {
      const result = await rpc.getHistory({ ...request, offsetId }) as any
      const message = result.messages[0]
      if (!message) throw new Error('request inbox history page is missing')
      messages.push(message)
      offsetId = message.id
    }

    expect(messages.map((message) => message.message)).toEqual([
      expect.stringContaining('Carol'), expect.stringContaining('Bob'), expect.stringContaining('Alice'),
    ])
    expect(new Set(messages.map((message) => message.id)).size).toBe(3)
  })
})

describe('request inbox callbacks', () => {
  it('accepts a pending request through a local request event without using platform message actions', async () => {
    const accepted: IMRequest = {
      id: 'opaque/request id', kind: 'friend', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const resolveRequest = vi.fn(async () => accepted)
    const { rpc, store, localEvents, getMessage, clickInlineButton } = await createRequestRpc(resolveRequest)
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).resolves.toMatchObject({ _: 'messages.botCallbackAnswer', message: '请求已处理' })

    expect(resolveRequest).toHaveBeenCalledWith(session, 'opaque/request id', 'accept')
    expect(localEvents).toMatchObject([{ type: 'request', request: { state: 'accepted' } }])
    expect(getMessage).not.toHaveBeenCalled()
    expect(clickInlineButton).not.toHaveBeenCalled()
    await expect(store.getRequest(session.platformSessionId, accepted.id)).resolves.toMatchObject({ state: 'accepted' })
    expect((await store.readHistory(session.platformSessionId, 'bridge:request-inbox'))[0]?.content.inlineKeyboard)
      .toBeUndefined()
  })

  it('serializes concurrent accept and reject callbacks across DialogRpc instances', async () => {
    const resolution = Promise.withResolvers<IMRequest>()
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(() => resolution.promise)
    const { rpc, createSiblingRpc, store } = await createRequestRpc(resolveRequest)
    const sibling = createSiblingRpc()
    const pending = await seedPendingRequest(store)
    const firstTarget = await inboxCallbackTarget(rpc, store)
    const secondTarget = await inboxCallbackTarget(sibling.rpc, store)

    const accept = rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...firstTarget, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })
    await vi.waitFor(() => expect(resolveRequest).toHaveBeenCalledTimes(1))
    const reject = sibling.rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...secondTarget, data: Buffer.from(REQUEST_REJECT_CALLBACK_DATA), game: false,
    })
    resolution.resolve({ ...pending, state: 'accepted' })

    await expect(accept).resolves.toMatchObject({ message: '请求已处理' })
    await expect(reject).rejects.toMatchObject({ text: 'REQUEST_STATE_CONFLICT' })
    expect(resolveRequest).toHaveBeenCalledTimes(1)
  })

  it('returns idempotent success to concurrent accepts across DialogRpc instances', async () => {
    const resolution = Promise.withResolvers<IMRequest>()
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(() => resolution.promise)
    const { rpc, createSiblingRpc, store } = await createRequestRpc(resolveRequest)
    const sibling = createSiblingRpc()
    const pending = await seedPendingRequest(store)
    const firstTarget = await inboxCallbackTarget(rpc, store)
    const secondTarget = await inboxCallbackTarget(sibling.rpc, store)

    const first = rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...firstTarget, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })
    await vi.waitFor(() => expect(resolveRequest).toHaveBeenCalledTimes(1))
    const second = sibling.rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...secondTarget, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })
    resolution.resolve({ ...pending, state: 'accepted' })

    await expect(first).resolves.toMatchObject({ message: '请求已处理' })
    await expect(second).resolves.toMatchObject({ message: '请求已处理' })
    expect(resolveRequest).toHaveBeenCalledTimes(1)
  })

  it('releases the shared resolution lock after a resolver failure', async () => {
    const accepted: IMRequest = {
      id: 'opaque/request id', kind: 'friend', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(accepted)
    const { rpc, createSiblingRpc, store } = await createRequestRpc(resolveRequest)
    const sibling = createSiblingRpc()
    await seedPendingRequest(store)
    const firstTarget = await inboxCallbackTarget(rpc, store)
    const retryTarget = await inboxCallbackTarget(sibling.rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...firstTarget, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_RESOLVE_FAILED' })
    await expect(sibling.rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...retryTarget, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).resolves.toMatchObject({ message: '请求已处理' })
    expect(resolveRequest).toHaveBeenCalledTimes(2)
  })

  it('retries terminal recovery after local delivery fails without resolving again', async () => {
    const accepted: IMRequest = {
      id: 'opaque/request id', kind: 'friend', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(async () => accepted)
    const { rpc, store, localEvents } = await createRequestRpc(resolveRequest, { failLocalDeliveryOnce: true })
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_RESOLVE_FAILED' })
    expect(resolveRequest).toHaveBeenCalledTimes(1)
    await expect(store.getRequest(session.platformSessionId, accepted.id)).resolves.toMatchObject({ state: 'accepted' })
    expect((await store.readHistory(session.platformSessionId, 'bridge:request-inbox'))[0]?.content.inlineKeyboard)
      .toBeUndefined()

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).resolves.toMatchObject({ message: '请求已处理' })
    expect(resolveRequest).toHaveBeenCalledTimes(1)
    expect(localEvents).toEqual([{ type: 'request', request: accepted, delivery: 'recovery' }])
  })

  it('recovers one failed request edit delivery through the subscription and update managers', async () => {
    const accepted: IMRequest = {
      id: 'opaque/request id', kind: 'friend', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(async () => accepted)
    const { platform, database, store } = await createRequestRpc(resolveRequest)
    await database.create('mtproto_auth_binding', {
      authKeyId: '0011223344556677', platformId: session.platformId, platformSessionId: session.platformSessionId,
    })
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const updates: unknown[] = []
    let failFirstSend = true
    const updateManager = new UpdateManager(database, registry, store, (_authKeyId, update) => {
      if (failFirstSend) {
        failFirstSend = false
        throw new Error('simulated socket failure')
      }
      updates.push(update)
      return 1
    })
    const subscriptions = new PlatformSubscriptionManager(
      database, registry, store, undefined,
      (eventSession, committed, options) => updateManager.publish(eventSession, committed, options),
    )
    await subscriptions.ensure(session)
    const peers = new SystemPeerService(new Context())
    peers.attach(
      (eventSession, event, options) => subscriptions.ingestLocalEvent(eventSession, event, options),
    )
    peers.register(new RequestInboxSystemPeerProvider(
      store,
      async (requestSession, requestId, action) => {
        if (!resolveRequest) throw new SystemPeerCallbackError('REQUEST_RESOLVE_UNAVAILABLE')
        return resolveRequest(requestSession, requestId, action)
      },
      async (requestSession, request) => { await peers.emit(requestSession, { type: 'request', request, delivery: 'recovery' }) },
    ))
    const rpc = new DialogRpc(
      platform, session, store, undefined, undefined, 1, undefined, undefined, undefined,
      (eventSession, event, options) => subscriptions.ingestLocalEvent(eventSession, event, options),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, peers,
    )
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_RESOLVE_FAILED' })
    expect(resolveRequest).toHaveBeenCalledTimes(1)
    expect((await store.readHistory(session.platformSessionId, 'bridge:request-inbox'))[0]?.content.inlineKeyboard)
      .toBeUndefined()

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).resolves.toMatchObject({ message: '请求已处理' })
    expect(resolveRequest).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(1)
    expect(JSON.stringify(updates[0])).toContain('updateEditMessage')

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).resolves.toMatchObject({ message: '请求已处理' })
    expect(updates).toHaveLength(1)
    await subscriptions.stop()
  })

  it('returns success without resolving an already accepted request again', async () => {
    const resolveRequest = vi.fn()
    const { rpc, store, getMessage, clickInlineButton } = await createRequestRpc(resolveRequest)
    const pending = await seedPendingRequest(store)
    await store.ingestRequest(session, { ...pending, state: 'accepted' })
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).resolves.toMatchObject({ _: 'messages.botCallbackAnswer', message: '请求已处理' })

    expect(resolveRequest).not.toHaveBeenCalled()
    expect(getMessage).not.toHaveBeenCalled()
    expect(clickInlineButton).not.toHaveBeenCalled()
  })

  it('rejects a callback action that conflicts with the resolved request state', async () => {
    const resolveRequest = vi.fn()
    const { rpc, store, getMessage, clickInlineButton } = await createRequestRpc(resolveRequest)
    const pending = await seedPendingRequest(store)
    await store.ingestRequest(session, { ...pending, state: 'accepted' })
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_REJECT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_STATE_CONFLICT' })

    expect(resolveRequest).not.toHaveBeenCalled()
    expect(getMessage).not.toHaveBeenCalled()
    expect(clickInlineButton).not.toHaveBeenCalled()
  })

  it('rejects a resolver response with the opposite terminal state', async () => {
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(async () => ({
      id: 'opaque/request id', kind: 'friend', state: 'rejected', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }))
    const { rpc, store } = await createRequestRpc(resolveRequest)
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_RESOLVE_FAILED' })
  })

  it.each<[string, IMRequest]>([
    ['a different request ID', {
      id: 'other/request', kind: 'friend', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }],
    ['a different request kind', {
      id: 'opaque/request id', kind: 'group-join', state: 'accepted', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }],
  ])('rejects a resolver response with %s without persisting it', async (_label, response) => {
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(async () => response)
    const { rpc, store, localEvents } = await createRequestRpc(resolveRequest)
    await seedPendingRequest(store)
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_ACCEPT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_RESOLVE_FAILED' })

    await expect(store.getRequest(session.platformSessionId, 'opaque/request id'))
      .resolves.toMatchObject({ id: 'opaque/request id', kind: 'friend', state: 'pending' })
    expect(localEvents).toEqual([])
  })

  it('rejects a resolver response that leaves a request pending', async () => {
    const resolveRequest = vi.fn<NonNullable<IMPlatform['resolveRequest']>>(
      async () => { throw new Error('test resolver was not configured') },
    )
    const { rpc, store, getMessage, clickInlineButton } = await createRequestRpc(resolveRequest)
    const pending = await seedPendingRequest(store)
    resolveRequest.mockResolvedValue(pending)
    const target = await inboxCallbackTarget(rpc, store)

    await expect(rpc.getBotCallbackAnswer({
      _: 'messages.getBotCallbackAnswer', ...target, data: Buffer.from(REQUEST_REJECT_CALLBACK_DATA), game: false,
    })).rejects.toMatchObject({ text: 'REQUEST_RESOLVE_FAILED' })

    expect(getMessage).not.toHaveBeenCalled()
    expect(clickInlineButton).not.toHaveBeenCalled()
  })
})
