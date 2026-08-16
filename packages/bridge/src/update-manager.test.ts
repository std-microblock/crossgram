import { afterEach, describe, expect, it } from 'vitest'
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
import { PlatformRegistry } from './platform-manager.js'
import type { IMConversation, IMMessage, IMPlatform, IMRequest, PlatformSession } from './platform.js'
import { UpdateManager } from './update-manager.js'
import { BlockedPeerStore, type BlockedContentMode } from './blocked-peers.js'
import { ReactionRpc } from './reaction-rpc.js'
import { requestInboxConversation, requestInboxMessage } from './request-inbox.js'

const session: PlatformSession = {
  platformSessionId: 'updates-session', platformId: 'updates-platform', userId: 'self',
  credentials: {}, metadata: { firstName: 'Current' },
}

const platform: IMPlatform = {
  capabilities: {
    history: false,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
  async getUser(_session, id) {
    return {
      id, firstName: `User ${id}`,
      avatar: { id: `avatar-${id}`, kind: 'image' as const, locator: { userId: id } },
    }
  },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness(
  updateDeliveryRetention?: number,
  targetPlatform: IMPlatform = platform,
  projectSticker?: ConstructorParameters<typeof UpdateManager>[6],
  deliveredConnections = 1,
  blockedMode?: BlockedContentMode,
  registerReactions?: ConstructorParameters<typeof UpdateManager>[8],
) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  await ctx.database.create('mtproto_auth_binding', {
    authKeyId: '0011223344556677', platformId: session.platformId, platformSessionId: session.platformSessionId,
  })
  await ctx.database.create('mtproto_auth_binding', {
    authKeyId: '8899aabbccddeeff', platformId: session.platformId, platformSessionId: 'other-session',
  })
  const sent: Array<{
    authKeyId: Uint8Array
    update: tl.TypeUpdates
    excludeConnection?: ServerConnection
  }> = []
  const store = new MessageStore(ctx.database, updateDeliveryRetention)
  const blockedPeers = blockedMode ? new BlockedPeerStore(ctx.database, blockedMode) : undefined
  const manager = new UpdateManager(
    ctx.database, new PlatformRegistry([[session.platformId, targetPlatform]]), store,
    (authKeyId, update, excludeConnection) => {
      sent.push({ authKeyId, update, excludeConnection })
      return deliveredConnections
    },
    1, undefined, projectSticker, blockedPeers, registerReactions,
  )
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store, manager, sent, blockedPeers }
}

function roundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('UpdateManager', () => {
  it('does not publish transient platform voice control events as Telegram messages', async () => {
    const { manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'caller', kind: 'direct', title: 'Caller' }

    await manager.publish(session, { event: {
      type: 'voice-call', callRef: 'opaque-source-ref', signal: 'incoming', media: 'voice',
      conversation, timestamp: 1,
    } })

    expect(sent).toEqual([])
  })

  it('forces one unchanged request recovery edit while deduplicating later retries', async () => {
    const { store, manager, sent } = await createHarness()
    const pending: IMRequest = {
      id: 'request-recovery', kind: 'friend', state: 'pending', createdAt: 100,
      requester: { id: 'alice', firstName: 'Alice' },
    }
    await store.ingestRequest(session, pending)
    const terminal = await store.ingestRequest(session, { ...pending, state: 'accepted' })
    const replay = await store.ingestRequest(session, terminal.request)
    const event = {
      type: 'message-edit' as const,
      eventId: 'bridge-request:request-recovery:terminal',
      conversation: requestInboxConversation(),
      message: requestInboxMessage(terminal.request),
    }

    await manager.publish(session, { event, result: replay.message })
    expect(sent).toEqual([])
    await manager.publish(session, { event, result: replay.message }, { forceDelivery: true })
    await manager.publish(session, { event, result: replay.message }, { forceDelivery: true })

    expect(sent).toHaveLength(1)
  })

  it('gives a paginated channel dialog the durable pts baseline for its next live update', async () => {
    const upperConversation: IMConversation = { id: 'upper-group', kind: 'group', title: 'Upper Group' }
    const lowerConversation: IMConversation = { id: 'lower-group', kind: 'group', title: 'Lower Group' }
    const upperMessage: IMMessage = {
      id: 'upper-message', conversationId: upperConversation.id, senderId: 'alice', timestamp: 200,
      content: { parts: [{ type: 'text', text: 'upper' }] },
    }
    let lowerMessage: IMMessage = {
      id: 'lower-first', conversationId: lowerConversation.id, senderId: 'bob', timestamp: 100,
      content: { parts: [{ type: 'text', text: 'lower first' }] },
    }
    const paginatedPlatform: IMPlatform = {
      ...platform,
      capabilities: { ...platform.capabilities, history: true },
      async getDialogs(_session, query) {
        const dialogs = [
          { conversation: upperConversation, unreadCount: 0, lastMessage: upperMessage },
          { conversation: lowerConversation, unreadCount: 1, lastMessage: lowerMessage },
        ]
        const start = query.afterId
          ? Math.max(0, dialogs.findIndex((dialog) => dialog.conversation.id === query.afterId) + 1)
          : 0
        const limit = query.limit ?? 100
        return {
          dialogs: dialogs.slice(start, start + limit), total: dialogs.length,
          nextCursor: start + limit < dialogs.length ? String(start + limit) : undefined,
        }
      },
      async getHistory(_session, conversation) {
        return { messages: conversation.id === upperConversation.id ? [upperMessage] : [lowerMessage] }
      },
    }
    const { store, manager, sent } = await createHarness(undefined, paginatedPlatform)
    for (const [id, text, timestamp] of [
      ['lower-first', 'lower first', 100],
      ['lower-second', 'lower second', 101],
    ] as const) {
      lowerMessage = {
        id, conversationId: lowerConversation.id, senderId: 'bob', timestamp,
        content: { parts: [{ type: 'text', text }] },
      }
      const result = await store.ingest(session, lowerConversation, lowerMessage)
      await manager.publish(session, { event: { type: 'message', conversation: lowerConversation, message: lowerMessage }, result })
    }

    const rpc = new DialogRpc(paginatedPlatform, session, store)
    const firstPage = await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 1, hash: Long.ZERO,
    }) as tl.messages.RawDialogsSlice
    const upperChannelId = stableId(`peer:${upperConversation.id}`)
    const lowerChannelId = stableId(`peer:${lowerConversation.id}`)
    expect(firstPage.dialogs).toMatchObject([{ peer: { _: 'peerChannel', channelId: upperChannelId } }])

    const secondPage = await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerChannel', channelId: upperChannelId, accessHash: Long.ONE },
      limit: 1, hash: Long.ZERO,
    }) as tl.messages.RawDialogsSlice
    const lowerDialog = secondPage.dialogs[0] as tl.RawDialog
    expect(lowerDialog).toMatchObject({
      peer: { _: 'peerChannel', channelId: lowerChannelId },
      pts: 3,
    })
    expect(roundTrip(secondPage)).toMatchObject({ dialogs: [{ pts: 3 }] })

    const full = await rpc.getFullChannel({
      _: 'channels.getFullChannel',
      channel: { _: 'inputChannel', channelId: lowerChannelId, accessHash: Long.ONE },
    })
    expect(full.fullChat).toMatchObject({ _: 'channelFull', pts: lowerDialog.pts })

    lowerMessage = {
      id: 'lower-third', conversationId: lowerConversation.id, senderId: 'bob', timestamp: 102,
      content: { parts: [{ type: 'text', text: 'lower third' }] },
    }
    const result = await store.ingest(session, lowerConversation, lowerMessage)
    await manager.publish(session, { event: { type: 'message', conversation: lowerConversation, message: lowerMessage }, result })
    const nextUpdate = (sent.at(-1)!.update as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage
    expect(nextUpdate).toMatchObject({ _: 'updateNewChannelMessage', pts: lowerDialog.pts! + 1, ptsCount: 1 })
  })

  it('registers live custom reactions with the same document ID used by history RPCs', async () => {
    const reactionRpc = new ReactionRpc({
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: true, events: true, actorList: false, maxSelected: 20 },
      },
    }, session)
    const harness = await createHarness(
      undefined, platform, undefined, 1, undefined,
      (_session, message) => reactionRpc.registerContext(message.conversationId, message.reactionContext),
    )
    const conversation: IMConversation = { id: 'custom-reaction-group', kind: 'group', title: 'Custom' }
    const definition = {
      key: 'custom:wave',
      presentation: {
        type: 'custom' as const, alt: '👋',
        resource: {
          version: 7, format: 'static' as const, mimeType: 'image/webp' as const,
          width: 100, height: 100, size: 4,
        },
      },
    }
    const message: IMMessage = {
      id: 'custom-message', conversationId: conversation.id, senderId: 'alice', timestamp: 200,
      content: { parts: [{ type: 'text', text: 'custom reaction' }] },
      reactionContext: {
        available: [definition],
        reactions: [{ key: definition.key, count: 1 }],
        maxSelected: 20,
      },
    }
    const result = await harness.store.ingest(session, conversation, message)

    await harness.manager.publish(session, { event: { type: 'message', conversation, message }, result })

    const pushed = ((harness.sent[0]!.update as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage)
      .message as tl.RawMessage
    const pushedReaction = pushed.reactions!.results[0]!.reaction
    const historyReaction = reactionRpc.toTlReaction(conversation.id, definition)
    expect(pushedReaction).toEqual(historyReaction)
    if (pushedReaction._ !== 'reactionCustomEmoji') throw new Error('expected custom reaction')
    expect(reactionRpc.getCustomEmojiDocuments([pushedReaction.documentId])).toHaveLength(1)
  })

  it('hydrates every referenced user before channels.getMessages projection', async () => {
    const conversation: IMConversation = { id: 'reaction-users-group', kind: 'group', title: 'Reaction Users' }
    const message: IMMessage = {
      id: 'reaction-users-message', conversationId: conversation.id, senderId: 'alice', timestamp: 300,
      sender: { id: 'alice', firstName: 'Alice' },
      content: { parts: [{
        type: 'text', text: '@Bob hello',
        entities: [{ type: 'mention', offset: 0, length: 4, userId: 'bob' }],
      }] },
      reactionContext: {
        available: [{ key: 'like', presentation: { type: 'emoji', emoticon: '👍' } }],
        reactions: [{ key: 'like', count: 1, recentActors: [{ userId: 'carol' }] }],
        maxSelected: 20,
      },
    }
    const targetPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        history: true,
        conversations: { groups: true, channels: true, subchannels: false },
        reactions: { read: true, write: false, events: true, actorList: true, maxSelected: 20 },
      },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: message }] } },
      async getHistory() { return { messages: [message] } },
    }
    const harness = await createHarness(undefined, targetPlatform)
    const ingested = await harness.store.ingest(session, conversation, message)
    const reactions = new ReactionRpc(targetPlatform, session)
    const rpc = new DialogRpc(targetPlatform, session, harness.store, undefined, undefined, 1, undefined, reactions)

    const response = await rpc.getChannelMessages({
      _: 'channels.getMessages',
      channel: { _: 'inputChannel', channelId: stableId(`peer:${conversation.id}`), accessHash: Long.ONE },
      id: [{ _: 'inputMessageID', id: ingested.projection[0]!.tlMessageId }],
    }) as tl.messages.RawChannelMessages

    expect(response.messages).toMatchObject([{ _: 'message', message: '@Bob hello' }])
    expect(response.users.filter((user): user is tl.RawUser => user._ === 'user').map((user) => user.firstName))
      .toEqual(expect.arrayContaining(['Alice', 'User bob', 'User carol', 'User self']))
    expect(() => roundTrip(response)).not.toThrow()
  })

  it('deletes cached blocked content and suppresses later live messages from that user', async () => {
    const harness = await createHarness(undefined, platform, undefined, 1, 'hide-user')
    const conversation: IMConversation = { id: 'blocked-group', kind: 'group', title: 'Blocked Group' }
    const first: IMMessage = {
      id: 'blocked-first', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_000,
      content: { parts: [{ type: 'text', text: 'hide me' }] },
    }
    await harness.store.ingest(session, conversation, first)
    const reacted: IMMessage = {
      id: 'visible-reaction', conversationId: conversation.id, senderId: 'bob', timestamp: 1_800_000_001,
      content: { parts: [{ type: 'text', text: 'keep me' }] },
      reactionContext: {
        available: [{ key: 'like', presentation: { type: 'emoji', emoticon: '👍' } }],
        reactions: [{
          key: 'like', count: 2,
          recentActors: [{ userId: 'alice' }, { userId: 'bob' }],
        }],
        maxSelected: 1,
      },
    }
    const reactedResult = await harness.store.ingest(session, conversation, reacted)
    const alice = await harness.store.getUser(session.platformId, 'alice')
    await harness.blockedPeers!.block(session.platformSessionId, 'alice')

    await harness.manager.publishPeerBlocked(session, alice!.id, true, new Date(1_800_000_000_000))
    expect(harness.sent).toHaveLength(2)
    expect(harness.sent.map(({ update }) => (update as tl.RawUpdates).updates[0])).toMatchObject([
      { _: 'updatePeerBlocked', blocked: true, peerId: { _: 'peerUser', userId: alice!.id } },
      { _: 'updateDeleteChannelMessages', messages: expect.any(Array) },
    ])
    expect((harness.sent[1]!.update as tl.RawUpdates).updates).toContainEqual(expect.objectContaining({
      _: 'updateMessageReactions',
      msgId: reactedResult.projection[0]!.tlMessageId,
      reactions: expect.objectContaining({
        results: [expect.objectContaining({ count: 1 })],
      }),
    }))

    const second: IMMessage = {
      ...first, id: 'blocked-second', timestamp: first.timestamp + 1,
      content: { parts: [{ type: 'text', text: 'do not push me' }] },
    }
    const result = await harness.store.ingest(session, conversation, second)
    await harness.manager.publish(session, { event: { type: 'message', conversation, message: second }, result })
    expect(harness.sent).toHaveLength(2)
  })

  it('pushes draft updates only to other auth keys of the same bridge account', async () => {
    const { ctx, manager, sent } = await createHarness()
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '1021324354657687',
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
    })

    await manager.publishDraft(session, {
      _: 'updateDraftMessage',
      peer: { _: 'peerUser', userId: 42 },
      draft: { _: 'draftMessage', message: 'local draft', date: 1_800_000_000 },
    }, '0011223344556677')

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0]!.authKeyId).toString('hex')).toBe('1021324354657687')
    expect(roundTrip(sent[0]!.update)).toMatchObject({
      _: 'updates',
      updates: [{
        _: 'updateDraftMessage', peer: { _: 'peerUser', userId: 42 },
        draft: { _: 'draftMessage', message: 'local draft' },
      }],
    })
  })

  it('fans folder changes out to the other auth keys of the same bridge account', async () => {
    const { ctx, manager, sent } = await createHarness()
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '1021324354657687',
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
    })

    await manager.publishAccountUpdates(session, [{
      _: 'updateDialogFilterOrder', order: [2, 0],
    }], '0011223344556677')

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0]!.authKeyId).toString('hex')).toBe('1021324354657687')
    expect(roundTrip(sent[0]!.update)).toMatchObject({
      _: 'updates', updates: [{ _: 'updateDialogFilterOrder', order: [2, 0] }],
    })
  })

  it('replays an in-memory phone snapshot only to its reconnecting authorized binding', async () => {
    const { ctx, manager, sent, store } = await createHarness()
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '1021324354657687', platformId: session.platformId, platformSessionId: session.platformSessionId,
    })
    const update: tl.RawUpdatePhoneCall = {
      _: 'updatePhoneCall', phoneCall: {
        _: 'phoneCallRequested', id: Long.ONE, accessHash: Long.fromInt(2), date: 1,
        adminId: 1, participantId: 2, gAHash: Uint8Array.of(1), protocol: {
          _: 'phoneCallProtocol', udpP2p: false, udpReflector: false, minLayer: 100, maxLayer: 100, libraryVersions: [],
        },
      },
    }

    expect(await manager.replayPhoneCall(session, update, '1021324354657687')).toBe(1)
    expect(await manager.replayPhoneCall(session, update, '8899aabbccddeeff')).toBe(0)

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0]!.authKeyId).toString('hex')).toBe('1021324354657687')
    expect(roundTrip(sent[0]!.update)).toMatchObject({ _: 'updateShort', update })
    expect(await manager.publishPhoneCall(session, update, '0011223344556677')).toBe(1)
    expect(sent).toHaveLength(2)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toEqual([])
  })

  it('advances persisted state and targets only auth keys bound to the source platform session', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = {
      id: 'group', kind: 'group', title: 'Group',
      avatar: { id: 'avatar-group', kind: 'image', locator: { conversationId: 'group' } },
    }
    const message: IMMessage = {
      id: 'incoming', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_000,
      sender: {
        id: 'alice',
        firstName: 'Profile Name',
        avatar: { id: 'avatar-alias', kind: 'image', locator: { userId: 'alice' } },
      },
      senderTitle: 'Group Alias',
      content: { parts: [{ type: 'text', text: 'pushed' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0].authKeyId).toString('hex')).toBe('0011223344556677')
    expect(sent[0].update).toMatchObject({
      _: 'updates', seq: 1,
      updates: [{
        _: 'updateNewChannelMessage', pts: 2, ptsCount: 1,
        message: { message: 'pushed', fromRank: 'Group Alias' },
      }],
      chats: [{
        _: 'channel', title: 'Group', megagroup: true, accessHash: Long.ONE,
        photo: { _: 'chatPhoto', dcId: 1 },
      }],
      users: [
        { _: 'user', self: true, accessHash: Long.ONE },
        {
          _: 'user', firstName: 'Profile Name', accessHash: Long.ONE,
          photo: { _: 'userProfilePhoto', dcId: 1 },
        },
      ],
    })
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 1, seq: 1 })
    expect(() => roundTrip(sent[0].update)).not.toThrow()

    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(sent).toHaveLength(1)
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 1, seq: 1 })
  })

  it('keeps the self and premium flags on outgoing live-update users', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'outgoing-group', kind: 'group', title: 'Outgoing Group' }
    const message: IMMessage = {
      id: 'outgoing', conversationId: conversation.id, senderId: session.userId,
      timestamp: 1_800_000_001, outgoing: true,
      content: { parts: [{ type: 'text', text: 'sent by current user' }] },
    }
    const result = await store.ingest(session, conversation, message)

    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    const payload = roundTrip(sent[0].update) as tl.RawUpdates
    expect(payload.users).toHaveLength(1)
    expect(payload.users[0]).toMatchObject({
      _: 'user', self: true, premium: true, firstName: 'User self',
    })
    expect((payload.updates[0] as tl.RawUpdateNewChannelMessage).message).toMatchObject({
      fromId: { _: 'peerUser', userId: (payload.users[0] as tl.RawUser).id },
    })
  })

  it('returns RPC-delivered replacements while excluding only the requester connection', async () => {
    const { ctx, store, manager, sent } = await createHarness(undefined, platform, undefined, 0)
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '1122334455667788',
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
    })
    const conversation: IMConversation = { id: 'replacement-room', kind: 'group', title: 'Replacement Room' }
    const original: IMMessage = {
      id: 'original', conversationId: conversation.id, senderId: session.userId,
      timestamp: 1_800_000_010, outgoing: true,
      content: { parts: [{ type: 'text', text: 'before edit' }] },
    }
    const created = await store.ingest(session, conversation, original)
    const deleted = await store.deleteMessages(session, conversation, [original.id])
    const requester = {} as ServerConnection
    const options = {
      excludeAuthKeyId: '0011223344556677', excludeConnection: requester, deliveredViaRpc: true,
    }
    const deletePayload = await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'local-edit:original:replacement', conversation,
        messageIds: [original.id], timestamp: original.timestamp + 1,
      },
      result: deleted,
    }, options) as tl.RawUpdates

    const replacement: IMMessage = {
      ...original, id: 'replacement', timestamp: original.timestamp + 1,
      content: { parts: [{ type: 'text', text: 'after edit' }] },
    }
    const replacementResult = await store.ingest(session, conversation, replacement)
    const replacementPayload = await manager.publish(session, {
      event: { type: 'message', conversation, message: replacement },
      result: replacementResult,
    }, options) as tl.RawUpdates

    expect(sent).toHaveLength(4)
    expect(sent.map(({ authKeyId }) => Buffer.from(authKeyId).toString('hex')))
      .toEqual([
        '0011223344556677', '1122334455667788',
        '0011223344556677', '1122334455667788',
      ])
    expect(sent.every(({ excludeConnection }) => excludeConnection === requester)).toBe(true)
    expect(deletePayload.updates).toMatchObject([{
      _: 'updateDeleteChannelMessages', messages: [created.projection[0].tlMessageId], ptsCount: 1,
    }])
    expect(replacementPayload.updates).toMatchObject([{
      _: 'updateNewChannelMessage', ptsCount: 1, message: { message: 'after edit', out: true },
    }])
    expect(replacementPayload.updates[0]).toMatchObject({
      pts: (deletePayload.updates[0] as tl.RawUpdateDeleteChannelMessages).pts + 1,
    })
    expect(sent.slice(0, 2).every(({ update }) => update === deletePayload)).toBe(true)
    expect(sent.slice(2).every(({ update }) => update === replacementPayload)).toBe(true)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toEqual([])
  })


  it('includes clickable URL entities in live updates', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'links', kind: 'group', title: 'Links' }
    const qqGroupUrl = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    const text = `入口：${qqGroupUrl}，备用 example.org/docs。`
    const message: IMMessage = {
      id: 'linked-live', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_001,
      content: { parts: [{ type: 'text', text }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    const payload = roundTrip(sent[0].update) as tl.RawUpdates
    const update = payload.updates[0] as tl.RawUpdateNewChannelMessage
    expect(update.message).toMatchObject({
      _: 'message', message: text,
      entities: [
        {
          _: 'messageEntityUrl', offset: text.indexOf(qqGroupUrl), length: qqGroupUrl.length,
        },
        {
          _: 'messageEntityUrl', offset: text.indexOf('example.org'),
          length: 'example.org/docs'.length,
        },
      ],
    })
  })

  it('includes native WebPage previews in live structured-card updates', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'cards', kind: 'group', title: 'Cards' }
    const message: IMMessage = {
      id: 'card-live', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_002,
      content: { parts: [{ type: 'card', card: {
        kind: 'link', source: '示例资讯', title: '实时卡片', description: '实时卡片摘要',
        url: 'https://example.com/live',
      } }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    const payload = roundTrip(sent[0].update) as tl.RawUpdates
    const update = payload.updates[0] as tl.RawUpdateNewChannelMessage
    expect(update.message).toMatchObject({
      _: 'message', message: '分享 · 示例资讯',
      entities: [{
        _: 'messageEntityTextUrl', offset: 0, length: '分享 · 示例资讯'.length,
        url: 'https://example.com/live',
      }],
      media: { _: 'messageMediaWebPage', manual: true, safe: true, webpage: {
        _: 'webPage', url: 'https://example.com/live', displayUrl: 'example.com',
        siteName: '示例资讯', title: '实时卡片', description: '实时卡片摘要',
      } },
    })
  })

  it('prepares virtual deep links while forwarding messages', async () => {
    const sourceConversation: IMConversation = { id: 'forward-source', kind: 'group', title: 'Source' }
    const targetConversation: IMConversation = { id: 'forward-target', kind: 'group', title: 'Target' }
    const archive: IMConversation = {
      id: 'forward-archive', kind: 'group', title: 'Forward archive', metadata: { virtual: true },
    }
    const source: IMMessage = {
      id: 'forward-source-message', conversationId: sourceConversation.id, senderId: 'alice', timestamp: 1_800_000_010,
      content: { parts: [{
        type: 'text', text: 'forward archive',
        entities: [{ type: 'conversation-link', offset: 0, length: 15, conversation: archive }],
      }] },
    }
    const targetPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities, history: true,
        messageActions: {
          delete: { own: { supported: true }, others: { supported: true } },
          edit: { mode: 'native' }, forward: { mode: 'native', preservesAuthor: true },
        },
      },
      async getDialogs() {
        return {
          dialogs: [
            { conversation: sourceConversation, unreadCount: 0, lastMessage: source },
            { conversation: targetConversation, unreadCount: 0 },
          ],
        }
      },
      async getHistory(_session, conversation) {
        return conversation.id === archive.id
          ? { messages: [{
              id: 'forward-archive-first', conversationId: archive.id, senderId: 'bob', timestamp: 1_800_000_001,
              content: { parts: [{ type: 'text', text: 'forwarded first' }] },
            }] }
          : { messages: [] }
      },
      async forwardMessages(_session, _from, _ids, to) {
        return [{ ...source, id: 'forwarded-message', conversationId: to.id, timestamp: 1_800_000_011 }]
      },
    }
    const { store } = await createHarness(undefined, targetPlatform)
    const sourceProjection = await store.ingest(session, sourceConversation, source)
    await store.upsertConversation(session, targetConversation)
    const rpc = new DialogRpc(targetPlatform, session, store)
    const forwarded = await rpc.forwardMessages({
      _: 'messages.forwardMessages',
      fromPeer: { _: 'inputPeerChannel', channelId: stableId(`peer:${sourceConversation.id}`), accessHash: Long.ONE },
      toPeer: { _: 'inputPeerChannel', channelId: stableId(`peer:${targetConversation.id}`), accessHash: Long.ONE },
      id: [sourceProjection.projection[0].tlMessageId], randomId: [Long.ONE],
    }) as tl.RawUpdates
    const update = forwarded.updates.find((item) => item._ === 'updateNewChannelMessage') as tl.RawUpdateNewChannelMessage
    const entity = (update.message as tl.RawMessage).entities?.find(
      (item): item is tl.RawMessageEntityTextUrl => item._ === 'messageEntityTextUrl',
    )
    expect(entity?.url).toMatch(new RegExp(`/bridgechat_${stableId(`peer:${archive.id}`)}/\\d+$`))
  })

  it('links live merged forwards to their first saved message across new RPC connections', async () => {
    const conversation: IMConversation = { id: 'merged-parent', kind: 'group', title: 'Parent' }
    const virtual: IMConversation = {
      id: 'merged-virtual', kind: 'group', title: 'QQ用户的聊天记录',
      metadata: {
        virtual: true,
        qqMultiForwardPreview: 'Alice: 第一条\nBob: 第二条',
      },
    }
    const forwarded = Array.from({ length: 201 }, (_, index): IMMessage => ({
      id: `merged-${index}`, conversationId: virtual.id, senderId: 'alice', timestamp: 1_800_000_004 + index,
      content: { parts: [{ type: 'text', text: `forwarded ${index}` }] },
    }))
    const targetPlatform: IMPlatform = {
      ...platform,
      capabilities: { ...platform.capabilities, history: true },
      async getDialogs() { return { dialogs: [] } },
      async getHistory(_session, target, query) {
        expect(target.id).toBe(virtual.id)
        return { messages: forwarded.slice(0, query.limit ?? forwarded.length) }
      },
    }
    const { store, manager, sent } = await createHarness(undefined, targetPlatform)
    const text = '查看聊天记录'
    const message: IMMessage = {
      id: 'merged-live', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_003,
      content: { parts: [{
        type: 'text', text,
        entities: [{ type: 'conversation-link', offset: 0, length: text.length, conversation: virtual }],
      }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    const payload = roundTrip(sent[0].update) as tl.RawUpdates
    const update = payload.updates[0] as tl.RawUpdateNewChannelMessage
    const virtualId = stableId(`peer:${virtual.id}`)
    const url = expect.stringMatching(new RegExp(`^https://t\\.me/bridgechat_${virtualId}/\\d+$`))
    expect(update.message).toMatchObject({
      _: 'message', message: text,
      entities: [{ _: 'messageEntityTextUrl', offset: 0, length: text.length, url }],
      media: {
        _: 'messageMediaWebPage', manual: true, safe: true,
        webpage: {
          _: 'webPage', url, type: 'telegram_message', title: virtual.title,
          description: 'Alice: 第一条\nBob: 第二条',
        },
      },
    })
    const firstEntity = (update.message as tl.RawMessage).entities?.find(
      (entity): entity is tl.RawMessageEntityTextUrl => entity._ === 'messageEntityTextUrl',
    )
    if (!firstEntity) throw new Error('merged forward update is missing its deep link')
    const firstId = Number(new URL(firstEntity.url).pathname.split('/').at(-1))
    const freshRpc = new DialogRpc(targetPlatform, session, store)
    expect(freshRpc.resolveUsername({
      _: 'contacts.resolveUsername', username: `bridgechat_${virtualId}`,
    })).toMatchObject({ _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: virtualId } })
    await expect(freshRpc.getMessages({
      _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: firstId }],
    })).resolves.toMatchObject({ messages: [{ _: 'message', id: firstId, message: 'forwarded 0' }] })
    expect(payload.chats).toMatchObject([
      { _: 'channel', title: conversation.title, megagroup: true },
      { _: 'chat', id: virtualId, title: virtual.title, participantsCount: 1 },
    ])
    expect(JSON.stringify(payload)).not.toContain('tg://privatepost')
  })

  it('keeps account and per-channel pts domains independent and replays each channel separately', async () => {
    const { store, manager, sent } = await createHarness()
    const alpha: IMConversation = { id: 'alpha', kind: 'group', title: 'Alpha' }
    const beta: IMConversation = { id: 'beta', kind: 'channel', title: 'Beta' }
    const direct: IMConversation = { id: 'direct-peer', kind: 'direct', title: 'Direct' }
    const publish = async (conversation: IMConversation, id: string, timestamp: number) => {
      const message: IMMessage = {
        id, conversationId: conversation.id, senderId: 'alice', timestamp,
        content: { parts: [{ type: 'text', text: id }] },
      }
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    }

    await publish(alpha, 'alpha-1', 10)
    await publish(beta, 'beta-1', 11)
    await publish(alpha, 'alpha-2', 12)
    await publish(direct, 'direct-1', 13)

    expect(sent.map(({ update }) => (update as tl.RawUpdates).updates[0])).toMatchObject([
      { _: 'updateNewChannelMessage', pts: 2 },
      { _: 'updateNewChannelMessage', pts: 2 },
      { _: 'updateNewChannelMessage', pts: 3 },
      { _: 'updateNewMessage', pts: 2 },
    ])
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 4 })
    expect(await store.getChannelUpdateState(session.platformSessionId, stableId('peer:alpha')))
      .toMatchObject({ pts: 3 })
    expect(await store.getChannelUpdateState(session.platformSessionId, stableId('peer:beta')))
      .toMatchObject({ pts: 2 })

    const alphaDifference = await manager.getChannelDifference(session.platformSessionId, {
      _: 'updates.getChannelDifference', force: true,
      channel: { _: 'inputChannel', channelId: stableId('peer:alpha'), accessHash: Long.ZERO },
      filter: { _: 'channelMessagesFilterEmpty' }, pts: 1, limit: 100,
    })
    expect(alphaDifference).toMatchObject({
      _: 'updates.channelDifference', final: true, pts: 3,
      newMessages: [{ message: 'alpha-1' }, { message: 'alpha-2' }],
    })
    expect(() => roundTrip(alphaDifference)).not.toThrow()

    const accountDifference = await manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })
    expect(accountDifference).toMatchObject({
      _: 'updates.difference', newMessages: [{ message: 'direct-1' }],
      otherUpdates: [
        { _: 'updateChannelTooLong', channelId: stableId('peer:alpha'), pts: 3 },
        { _: 'updateChannelTooLong', channelId: stableId('peer:beta'), pts: 2 },
      ],
      state: { pts: 2, seq: 4 },
    })
  })

  it('announces every channel changed since an offline client server-date cursor', async () => {
    const { store, manager } = await createHarness()
    const alpha: IMConversation = { id: 'offline-alpha', kind: 'group', title: 'Offline Alpha' }
    const beta: IMConversation = { id: 'offline-beta', kind: 'group', title: 'Offline Beta' }
    const publish = async (conversation: IMConversation, id: string, timestamp: number) => {
      const message: IMMessage = {
        id, conversationId: conversation.id, senderId: 'alice', timestamp,
        content: { parts: [{ type: 'text', text: id }] },
      }
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    }

    const before = await manager.getState(session.platformSessionId)
    await publish(alpha, 'offline-alpha-message', before.date + 1)
    await publish(beta, 'offline-beta-message', before.date + 2)

    const difference = await manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: before.pts, date: before.date, qts: before.qts,
    })
    expect(difference).toMatchObject({
      _: 'updates.difference', newMessages: [],
      otherUpdates: [
        { _: 'updateChannelTooLong', channelId: stableId('peer:offline-alpha'), pts: 2 },
        { _: 'updateChannelTooLong', channelId: stableId('peer:offline-beta'), pts: 2 },
      ],
      chats: [
        { _: 'channel', title: 'Offline Alpha' },
        { _: 'channel', title: 'Offline Beta' },
      ],
    })
  })

  it('does not create a channel pts gap between a reaction update and the next message', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'reaction-pts', kind: 'group', title: 'Reaction Pts' }
    const first: IMMessage = {
      id: 'reaction-target', conversationId: conversation.id, senderId: 'alice', timestamp: 20,
      content: { parts: [{ type: 'text', text: 'target' }] },
    }
    const created = await store.ingest(session, conversation, first)
    await manager.publish(session, { event: { type: 'message', conversation, message: first }, result: created })
    const channelId = stableId(`peer:${conversation.id}`)
    expect(await store.getChannelUpdateState(session.platformSessionId, channelId)).toMatchObject({ pts: 2 })

    const target = {
      conversationId: conversation.id,
      messageId: first.id,
      targetId: first.id,
    }
    const context = {
      available: [{ key: 'like', presentation: { type: 'emoji' as const, emoticon: '👍' } }],
      reactions: [{ key: 'like', count: 1, selected: true, selectedOrder: 1 }],
      maxSelected: 1,
    }
    const reacted = await store.setReactions(session, conversation, target, context)
    await manager.publish(session, {
      event: {
        type: 'message-reactions', eventId: 'reaction-pts-update', conversation,
        target, context, timestamp: 21,
      },
      result: reacted,
    })

    expect((sent[1]!.update as tl.RawUpdates).updates).toMatchObject([{ _: 'updateMessageReactions' }])
    expect(await store.getChannelUpdateState(session.platformSessionId, channelId)).toMatchObject({ pts: 2 })

    const second: IMMessage = {
      id: 'after-reaction', conversationId: conversation.id, senderId: 'bob', timestamp: 22,
      content: { parts: [{ type: 'text', text: 'after reaction' }] },
    }
    const next = await store.ingest(session, conversation, second)
    await manager.publish(session, { event: { type: 'message', conversation, message: second }, result: next })

    expect((sent[2]!.update as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateNewChannelMessage', pts: 3, ptsCount: 1,
      message: { message: 'after reaction' },
    }])
    await expect(manager.getChannelDifference(session.platformSessionId, {
      _: 'updates.getChannelDifference', force: true,
      channel: { _: 'inputChannel', channelId, accessHash: Long.ZERO },
      filter: { _: 'channelMessagesFilterEmpty' }, pts: 2, limit: 100,
    })).resolves.toMatchObject({
      _: 'updates.channelDifference', final: true, pts: 3,
      newMessages: [{ message: 'after reaction' }],
      otherUpdates: [],
    })
  })

  it('pushes complete reaction counts, recent actors, and actor users together', async () => {
    const reactionPlatform: IMPlatform = {
      ...platform,
      capabilities: {
        ...platform.capabilities,
        reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 20 },
      },
    }
    const { store, manager, sent } = await createHarness(undefined, reactionPlatform)
    const conversation: IMConversation = { id: 'reaction-actors', kind: 'group', title: 'Reaction Actors' }
    const message: IMMessage = {
      id: 'reaction-actors-target',
      conversationId: conversation.id,
      senderId: 'alice',
      timestamp: 30,
      content: { parts: [{ type: 'text', text: 'target' }] },
    }
    const created = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result: created })
    const target = {
      conversationId: conversation.id,
      messageId: message.id,
      targetId: message.id,
    }
    const context = {
      available: [{ key: 'like', presentation: { type: 'emoji' as const, emoticon: '👍' } }],
      reactions: [{
        key: 'like',
        count: 3,
        recentActors: [{ userId: 'self' }, { userId: 'bob' }, { userId: 'carol' }],
      }],
      maxSelected: 20,
    }
    const reacted = await store.setReactions(session, conversation, target, context)

    await manager.publish(session, {
      event: {
        type: 'message-reactions', eventId: 'reaction-actors-update', conversation,
        target, context, timestamp: 31,
      },
      result: reacted,
    })

    const payload = sent[1]!.update as tl.RawUpdates
    const update = payload.updates[0] as tl.RawUpdateMessageReactions
    expect(update.reactions).toMatchObject({
      canSeeList: true,
      results: [{ count: 3 }],
      recentReactions: [
        { my: true, peerId: { _: 'peerUser' } },
        { peerId: { _: 'peerUser' } },
        { peerId: { _: 'peerUser' } },
      ],
    })
    expect(payload.users).toHaveLength(3)
    expect(payload.users).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'user', self: true, firstName: 'User self', photo: expect.any(Object) }),
      expect.objectContaining({ _: 'user', firstName: 'User bob', photo: expect.any(Object) }),
      expect.objectContaining({ _: 'user', firstName: 'User carol', photo: expect.any(Object) }),
    ]))
    expect(new Set(update.reactions.recentReactions!.map((item) => item.peerId._ === 'peerUser'
      ? item.peerId.userId
      : 0))).toEqual(new Set(payload.users.map((user) => user.id)))
    expect(() => roundTrip(payload)).not.toThrow()
  })

  it('projects platform read events into direct and channel inbox updates', async () => {
    const { store, manager, sent } = await createHarness()
    const direct: IMConversation = { id: 'alice', kind: 'direct', title: 'Alice' }
    const group: IMConversation = { id: 'group-read', kind: 'group', title: 'Group Read' }
    const directMessage: IMMessage = {
      id: 'direct-read', conversationId: direct.id, senderId: 'alice', timestamp: 40,
      content: { parts: [{ type: 'text', text: 'direct' }] },
    }
    const groupMessage: IMMessage = {
      id: 'group-read', conversationId: group.id, senderId: 'alice', timestamp: 41,
      content: { parts: [{ type: 'text', text: 'group' }] },
    }
    await store.ingest(session, direct, directMessage)
    await store.ingest(session, group, groupMessage)
    const directResult = await store.markRead(session, direct.id, directMessage.id)
    const groupResult = await store.markRead(session, group.id, groupMessage.id)
    if (!directResult || !groupResult) throw new Error('missing read projections')

    await manager.publish(session, {
      event: { type: 'read', conversationId: direct.id, upToMessageId: directMessage.id },
      result: directResult,
    })
    await manager.publish(session, {
      event: { type: 'read', conversationId: group.id, upToMessageId: groupMessage.id },
      result: groupResult,
    })

    expect(sent.map(({ update }) => (update as tl.RawUpdates).updates[0])).toMatchObject([{
      _: 'updateReadHistoryInbox', peer: { _: 'peerUser' },
      maxId: directResult.tlMessageId, stillUnreadCount: 0, pts: 2, ptsCount: 1,
    }, {
      _: 'updateReadChannelInbox', channelId: stableId('peer:group-read'),
      maxId: groupResult.tlMessageId, stillUnreadCount: 0, pts: 3,
    }])
    for (const item of sent) expect(() => roundTrip(item.update)).not.toThrow()
  })

  it('fans a local read update out through every bound auth key except the requesting connection', async () => {
    const { ctx, store, manager, sent } = await createHarness()
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '1021324354657687',
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
    })
    const conversation: IMConversation = { id: 'read-fanout', kind: 'group', title: 'Read Fanout' }
    const message: IMMessage = {
      id: 'read-fanout-message', conversationId: conversation.id, senderId: 'alice', timestamp: 42,
      content: { parts: [{ type: 'text', text: 'read me everywhere' }] },
    }
    await store.ingest(session, conversation, message)
    const result = await store.markRead(session, conversation.id, message.id)
    if (!result) throw new Error('missing read projection')
    const requester = {} as ServerConnection

    await manager.publish(session, {
      event: { type: 'read', conversationId: conversation.id, upToMessageId: message.id },
      result,
    }, { excludeConnection: requester, deliveredViaRpc: true })

    expect(sent.map(({ authKeyId }) => Buffer.from(authKeyId).toString('hex')).sort()).toEqual([
      '0011223344556677', '1021324354657687',
    ])
    expect(sent.every(({ excludeConnection }) => excludeConnection === requester)).toBe(true)
    expect(sent.map(({ update }) => (update as tl.RawUpdates).updates[0])).toMatchObject([
      { _: 'updateReadChannelInbox', maxId: result.tlMessageId, stillUnreadCount: 0 },
      { _: 'updateReadChannelInbox', maxId: result.tlMessageId, stillUnreadCount: 0 },
    ])
  })

  it('keeps a locally acknowledged read update available for an offline device difference', async () => {
    const { store, manager, sent } = await createHarness(undefined, platform, undefined, 0)
    const conversation: IMConversation = { id: 'offline-read', kind: 'direct', title: 'Offline Read' }
    const message: IMMessage = {
      id: 'offline-read-message', conversationId: conversation.id, senderId: conversation.id, timestamp: 43,
      content: { parts: [{ type: 'text', text: 'catch up later' }] },
    }
    await store.ingest(session, conversation, message)
    const result = await store.markRead(session, conversation.id, message.id)
    if (!result) throw new Error('missing read projection')

    await manager.publish(session, {
      event: { type: 'read', conversationId: conversation.id, upToMessageId: message.id },
      result,
    }, { excludeAuthKeyId: '0011223344556677', deliveredViaRpc: true })

    expect(sent).toEqual([])
    await expect(manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })).resolves.toMatchObject({
      _: 'updates.difference',
      otherUpdates: [{
        _: 'updateReadHistoryInbox', maxId: result.tlMessageId, stillUnreadCount: 0,
      }],
      state: { pts: 2 },
    })
  })

  it('emits one update per mixed-media projection without an invalid Telegram album', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'channel', kind: 'channel', title: 'Channel' }
    const message: IMMessage = {
      id: 'album', conversationId: conversation.id, senderId: 'alice', timestamp: 10,
      content: {
        parts: [
          { type: 'text', text: 'caption' },
          { type: 'media', media: { id: 'one', kind: 'image', locator: null } },
          { type: 'media', media: { id: 'two', kind: 'file', name: 'two.bin', locator: null } },
        ],
      },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    const payload = sent[0].update as tl.RawUpdates
    expect(payload.updates).toHaveLength(2)
    expect(payload.updates.map((update) => update._)).toEqual([
      'updateNewChannelMessage', 'updateNewChannelMessage',
    ])
    const messages = payload.updates.map((update) => (update as tl.RawUpdateNewChannelMessage).message as tl.RawMessage)
    expect(messages.map((item) => item.groupedId)).toEqual([undefined, undefined])
    expect(messages.map((item) => item.message)).toEqual(['caption', ''])
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 1, seq: 1 })
  })

  it('projects live stickers through the same Telegram message path as history', async () => {
    const stickerMedia = {
      _: 'messageMediaDocument',
      document: { _: 'documentEmpty', id: 42 as never },
    } as tl.TypeMessageMedia
    const projected: string[] = []
    const { store, manager, sent } = await createHarness(undefined, platform, (_session, sticker) => {
      projected.push(sticker.stickerId)
      return stickerMedia
    })
    const conversation: IMConversation = { id: 'stickers', kind: 'group', title: 'Stickers' }
    const message: IMMessage = {
      id: 'live-sticker', conversationId: conversation.id, senderId: 'alice', timestamp: 20,
      content: { parts: [{ type: 'sticker', sticker: {
        providerId: 'qq', stickerId: 'favorite:wave', format: 'animated', mimeType: 'image/apng',
      } }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    const update = (sent[0].update as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage
    expect(projected).toEqual(['favorite:wave'])
    expect((update.message as tl.RawMessage).media).toBe(stickerMedia)
    expect((update.message as tl.RawMessage).media?._).toBe('messageMediaDocument')
  })

  it('backfills an uncached reply target before publishing the live reply', async () => {
    const conversation: IMConversation = { id: 'reply-group', kind: 'group', title: 'Replies' }
    const target: IMMessage = {
      id: 'opaque-target', conversationId: conversation.id, senderId: 'bob', timestamp: 20,
      content: { parts: [{ type: 'text', text: 'target' }] },
    }
    const getMessage = async (_session: PlatformSession, _conversation: { id: string }, id: string) =>
      id === target.id ? target : null
    const replyPlatform: IMPlatform = { ...platform, getMessage }
    const { store, manager, sent } = await createHarness(undefined, replyPlatform)
    const reply: IMMessage = {
      id: 'live-reply', conversationId: conversation.id, senderId: 'alice', timestamp: 21,
      replyToId: target.id,
      content: { parts: [{ type: 'text', text: 'reply' }] },
    }
    const result = await store.ingest(session, conversation, reply)
    await manager.publish(session, { event: { type: 'message', conversation, message: reply }, result })

    const storedTarget = await store.findProjectedByPlatformId(
      session.platformSessionId, conversation.id, target.id,
    )
    const update = (sent[0].update as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage
    expect(storedTarget).toBeDefined()
    expect((update.message as tl.RawMessage).replyTo).toMatchObject({
      _: 'messageReplyHeader', replyToMsgId: storedTarget!.parts[0].tlMessageId,
    })
  })

  it('sets the Telegram mentioned flag for live self mentions and replies to outgoing messages only', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'muted-group', kind: 'group', title: 'Muted Group' }
    const outgoing: IMMessage = {
      id: 'outgoing-target', conversationId: conversation.id, senderId: session.userId,
      outgoing: true, timestamp: 30,
      content: { parts: [{ type: 'text', text: 'my message' }] },
    }
    const incomingTarget: IMMessage = {
      id: 'incoming-target', conversationId: conversation.id, senderId: 'bob', timestamp: 31,
      content: { parts: [{ type: 'text', text: 'bob message' }] },
    }
    const outgoingResult = await store.ingest(session, conversation, outgoing)
    const outgoingTlId = outgoingResult.projection[0].tlMessageId
    await store.ingest(session, conversation, incomingTarget)

    const cases: Array<{ message: IMMessage, mentioned: boolean }> = [{
      message: {
        id: 'explicit-self-mention', conversationId: conversation.id, senderId: 'alice', timestamp: 32,
        content: { parts: [{
          type: 'text', text: '@Current',
          entities: [{ type: 'mention', offset: 0, length: 8, userId: session.userId }],
        }] },
      },
      mentioned: true,
    }, {
      message: {
        id: 'native-reply-to-self', conversationId: conversation.id, senderId: 'alice', timestamp: 33,
        metadata: { telegramReplyToMessageId: outgoingTlId },
        content: { parts: [{ type: 'text', text: 'native reply' }] },
      },
      mentioned: true,
    }, {
      message: {
        id: 'reply-to-other', conversationId: conversation.id, senderId: 'alice', timestamp: 34,
        replyToId: incomingTarget.id,
        content: { parts: [{ type: 'text', text: 'not for self' }] },
      },
      mentioned: false,
    }, {
      message: {
        id: 'mention-other', conversationId: conversation.id, senderId: 'alice', timestamp: 35,
        content: { parts: [{
          type: 'text', text: '@Bob',
          entities: [{ type: 'mention', offset: 0, length: 4, userId: 'bob' }],
        }] },
      },
      mentioned: false,
    }]

    for (const item of cases) {
      const result = await store.ingest(session, conversation, item.message)
      await manager.publish(session, {
        event: { type: 'message', conversation, message: item.message }, result,
      })
    }

    const liveMessages = sent.map(({ update }) => {
      const pushed = (update as tl.RawUpdates).updates[0] as tl.RawUpdateNewChannelMessage
      return roundTrip(pushed.message) as tl.RawMessage
    })
    expect(liveMessages.map((message) => [
      message.message, message.mentioned ?? false, message.mediaUnread ?? false,
    ])).toEqual([
      ['@Current', true, true],
      ['native reply', true, true],
      ['not for self', false, false],
      ['@Bob', false, false],
    ])
    expect(liveMessages[1].replyTo).toMatchObject({
      _: 'messageReplyHeader', replyToMsgId: outgoingTlId,
    })
  })

  it('lists, paginates, acknowledges, and durably clears unread mentions after live delivery', async () => {
    const conversation: IMConversation = { id: 'mention-navigation', kind: 'group', title: 'Mention Navigation' }
    const own: IMMessage = {
      id: 'own', conversationId: conversation.id, senderId: session.userId,
      outgoing: true, timestamp: 40, content: { parts: [{ type: 'text', text: 'question' }] },
    }
    const explicit: IMMessage = {
      id: 'explicit', conversationId: conversation.id, senderId: 'alice', timestamp: 41,
      content: { parts: [{
        type: 'text', text: '@Current answer',
        entities: [{ type: 'mention', offset: 0, length: 8, userId: session.userId }],
      }] },
    }
    const reply: IMMessage = {
      id: 'reply', conversationId: conversation.id, senderId: 'bob', replyToId: own.id,
      timestamp: 42, content: { parts: [{ type: 'text', text: 'reply answer' }] },
    }
    const ordinary: IMMessage = {
      id: 'ordinary', conversationId: conversation.id, senderId: 'carol', timestamp: 43,
      content: { parts: [{ type: 'text', text: 'ordinary newest message' }] },
    }
    const messages = [own, explicit, reply, ordinary]
    const mentionPlatform: IMPlatform = {
      ...platform,
      capabilities: { ...platform.capabilities, history: true },
      async getDialogs() {
        return { dialogs: [{
          conversation, unreadCount: 3, lastMessage: ordinary, readInboxMaxMessage: own,
        }] }
      },
      async getHistory() { return { messages } },
    }
    const { store, manager } = await createHarness(undefined, mentionPlatform)
    await store.ingest(session, conversation, own)
    for (const message of [explicit, reply, ordinary]) {
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    }

    const rpc = new DialogRpc(mentionPlatform, session, store)
    const dialogs = await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    expect(dialogs.dialogs[0]).toMatchObject({ unreadCount: 3, unreadMentionsCount: 2 })
    const peer = {
      _: 'inputPeerChannel' as const,
      channelId: stableId(`peer:${conversation.id}`), accessHash: Long.ONE,
    }
    const request: tl.messages.RawGetUnreadMentionsRequest = {
      _: 'messages.getUnreadMentions', peer,
      offsetId: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0,
    }
    const unread = await rpc.getUnreadMentions(request) as tl.messages.RawMessages
    expect(unread.messages).toMatchObject([
      { _: 'message', message: 'reply answer', mentioned: true },
      { _: 'message', message: '@Current answer', mentioned: true },
    ])
    const newestMentionId = (unread.messages[0] as tl.RawMessage).id
    const older = await rpc.getUnreadMentions({
      ...request, offsetId: newestMentionId, limit: 1,
    }) as tl.messages.RawMessages
    expect(older.messages).toMatchObject([{ message: '@Current answer', mentioned: true }])

    await expect(rpc.readMentions({ _: 'messages.readMentions', peer })).resolves.toMatchObject({
      _: 'messages.affectedHistory', ptsCount: 0, offset: 0,
    })
    await expect(rpc.getUnreadMentions(request)).resolves.toMatchObject({ messages: [] })

    const resumed = new DialogRpc(mentionPlatform, session, store)
    const resumedDialogs = await resumed.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    expect(resumedDialogs.dialogs[0]).toMatchObject({ unreadMentionsCount: 0 })
    await expect(resumed.getUnreadMentions(request)).resolves.toMatchObject({ messages: [] })
  })

  it('publishes subchannel events through the parent forum and topic root', async () => {
    const { store, manager, sent } = await createHarness()
    const parent: IMConversation = { id: 'general', kind: 'channel', title: 'General' }
    const thread: IMConversation = {
      id: 'support', kind: 'channel', title: 'Support', parentId: parent.id, spaceId: 'guild',
    }
    await store.upsertConversation(session, parent)
    const root: IMMessage = {
      id: 'thread-root', conversationId: thread.id, senderId: 'alice', timestamp: 10,
      content: { parts: [{ type: 'text', text: 'root' }] },
    }
    const rootResult = await store.ingest(session, thread, root)
    await manager.publish(session, { event: { type: 'message', conversation: thread, message: root }, result: rootResult })
    const reply: IMMessage = {
      id: 'thread-reply', conversationId: thread.id, senderId: 'alice', timestamp: 11,
      content: { parts: [{ type: 'text', text: 'reply' }] },
    }
    const replyResult = await store.ingest(session, thread, reply)
    await manager.publish(session, { event: { type: 'message', conversation: thread, message: reply }, result: replyResult })

    const rootId = rootResult.projection[0].tlMessageId
    expect(sent[0].update).toMatchObject({
      updates: [{
        _: 'updateNewChannelMessage',
        message: { id: rootId, peerId: { _: 'peerChannel', channelId: stableId('peer:general') } },
      }],
      chats: [{ _: 'channel', id: stableId('peer:general'), title: 'General', forum: true }],
    })
    expect(sent[1].update).toMatchObject({
      updates: [{
        _: 'updateNewChannelMessage',
        message: {
          peerId: { _: 'peerChannel', channelId: stableId('peer:general') },
          replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToTopId: rootId },
        },
      }],
    })
    expect(() => roundTrip(sent[1].update)).not.toThrow()
  })

  it('persists edits, tombstones deletes, and publishes each mutation exactly once', async () => {
    const { ctx, store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'mutations', kind: 'group', title: 'Mutations' }
    const original: IMMessage = {
      id: 'mutable-message', conversationId: conversation.id, senderId: 'alice', timestamp: 30,
      content: { parts: [{ type: 'text', text: 'original' }] },
    }
    const created = await store.ingest(session, conversation, original)
    await manager.publish(session, { event: { type: 'message', conversation, message: original }, result: created })
    const tlMessageId = created.projection[0].tlMessageId

    const edited: IMMessage = {
      ...original,
      content: { parts: [{ type: 'text', text: 'edited' }] },
      metadata: { revision: 2 },
    }
    const editResult = await store.ingest(session, conversation, edited)
    expect(editResult).toMatchObject({ created: false, changed: true })
    await manager.publish(session, {
      event: { type: 'message-edit', eventId: 'edit-2', conversation, message: edited },
      result: editResult,
    })
    expect((sent[1].update as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateEditChannelMessage', pts: 3, ptsCount: 1,
      message: { id: tlMessageId, message: 'edited' },
    }])
    expect((await store.readHistory(session.platformSessionId, conversation.id))[0])
      .toMatchObject({ id: original.id, content: edited.content })

    const duplicateEdit = await store.ingest(session, conversation, edited)
    expect(duplicateEdit.changed).toBe(false)
    await manager.publish(session, {
      event: { type: 'message-edit', eventId: 'edit-2', conversation, message: edited },
      result: duplicateEdit,
    })
    expect(sent).toHaveLength(2)

    const deleted = await store.deleteMessages(session, conversation, [original.id])
    expect(deleted).toMatchObject({ changed: true, tlMessageIds: [tlMessageId] })
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'delete-1', conversation,
        messageIds: [original.id], timestamp: 31,
      },
      result: deleted,
    })
    expect((sent[2].update as tl.RawUpdates).updates).toMatchObject([{
      _: 'updateDeleteChannelMessages', messages: [tlMessageId], pts: 4, ptsCount: 1,
    }])
    expect(await store.readHistory(session.platformSessionId, conversation.id)).toEqual([])
    expect(await store.findProjectedByTlId(session.platformSessionId, tlMessageId, conversation.id)).toBeUndefined()
    const [stored] = await ctx.database.get('mtproto_im_message', { id: created.message.id })
    expect(stored).toMatchObject({ text: 'edited', deleted: true })

    const duplicateDelete = await store.deleteMessages(session, conversation, [original.id])
    expect(duplicateDelete).toMatchObject({ changed: false, tlMessageIds: [tlMessageId] })
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'delete-1', conversation,
        messageIds: [original.id], timestamp: 31,
      },
      result: duplicateDelete,
    })
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'delete-duplicate', conversation,
        messageIds: [original.id], timestamp: 31,
      },
      result: duplicateDelete,
    })
    expect(sent).toHaveLength(3)
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 1, seq: 3 })
  })

  it('reuses the reserved pts and retries delivery after a send failure', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const conversation: IMConversation = { id: 'retry', kind: 'direct', title: 'Retry' }
    const message: IMMessage = {
      id: 'retry-message', conversationId: conversation.id, senderId: 'alice', timestamp: 20,
      content: { parts: [{ type: 'text', text: 'retry me' }] },
    }
    const result = await store.ingest(session, conversation, message)
    const failing = new UpdateManager(ctx.database, registry, store, () => { throw new Error('socket failed') })
    await expect(failing.publish(session, { event: { type: 'message', conversation, message }, result }))
      .rejects.toThrow('socket failed')
    expect(await failing.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })

    const retried: tl.TypeUpdates[] = []
    const retrying = new UpdateManager(ctx.database, registry, store, (_key, update) => retried.push(update))
    await retrying.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(retried).toMatchObject([{ _: 'updates', seq: 1, updates: [{ pts: 2 }] }])
    expect(await retrying.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })
  })

  it('keeps offline updates pending and replays them when a bound connection returns', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const sent: tl.TypeUpdates[] = []
    let online = false
    const manager = new UpdateManager(ctx.database, registry, store, (_key, update) => {
      if (!online) return 0
      sent.push(update)
      return 1
    })
    const conversation: IMConversation = { id: 'offline', kind: 'group', title: 'Offline' }
    const message: IMMessage = {
      id: 'offline-message', conversationId: conversation.id, senderId: 'alice', timestamp: 40,
      content: { parts: [{ type: 'text', text: 'persist before push' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent).toHaveLength(0)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toMatchObject([{
      published: false, pts: 2, payload: expect.any(String),
    }])
    online = true
    await expect(manager.retryPending(session.platformSessionId)).resolves.toBe(1)
    expect(sent).toMatchObject([{
      _: 'updates', seq: 1,
      updates: [{ _: 'updateNewChannelMessage', pts: 2, message: { message: 'persist before push' } }],
    }])
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toEqual([])
  })

  it('recovers journaled messages and mutations through updates.getDifference', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const manager = new UpdateManager(ctx.database, registry, store, () => 0)
    const conversation: IMConversation = { id: 'difference', kind: 'direct', title: 'Difference' }
    const original: IMMessage = {
      id: 'difference-message', conversationId: conversation.id, senderId: 'alice', timestamp: 50,
      content: { parts: [{ type: 'text', text: 'original' }] },
    }
    const created = await store.ingest(session, conversation, original)
    await manager.publish(session, { event: { type: 'message', conversation, message: original }, result: created })
    const edited = { ...original, content: { parts: [{ type: 'text' as const, text: 'edited' }] } }
    const changed = await store.ingest(session, conversation, edited)
    await manager.publish(session, {
      event: { type: 'message-edit', eventId: 'difference-edit', conversation, message: edited }, result: changed,
    })

    const difference = await manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })
    expect(difference).toMatchObject({
      _: 'updates.difference',
      newMessages: [{ _: 'message', message: 'original' }],
      otherUpdates: [{ _: 'updateEditMessage', message: { message: 'edited' } }],
      state: { pts: 3, seq: 2 },
    })
    expect(() => roundTrip(difference)).not.toThrow()
  })

  it('replays and deletes the same Telegram ID after QQ finalizes a live msgSeq', async () => {
    const { ctx, store } = await createHarness()
    const manager = new UpdateManager(
      ctx.database,
      new PlatformRegistry([[session.platformId, platform]]),
      store,
      () => 0,
    )
    const conversation: IMConversation = { id: 'final-sequence', kind: 'group', title: 'Final sequence' }
    const make = (id: string, sequence: number, text: string): IMMessage => ({
      id, conversationId: conversation.id, senderId: 'alice', timestamp: 70,
      metadata: { qqMsgSeq: String(sequence) },
      content: { parts: [{ type: 'text', text }] },
    })

    await store.ingest(session, conversation, make('previous', 100, 'previous'))
    const target = make('target', 99, 'target')
    const created = await store.ingest(session, conversation, target)
    await manager.publish(session, { event: { type: 'message', conversation, message: target }, result: created })
    const pushedId = created.projection[0].tlMessageId

    await store.ingest(session, conversation, make('target', 101, 'target'), { allocation: 'history' })
    const deleted = await store.deleteMessages(session, conversation, ['target'])
    await manager.publish(session, {
      event: {
        type: 'message-delete', eventId: 'recall-target', conversation,
        messageIds: ['target'], timestamp: 71,
      },
      result: deleted,
    })

    const difference = await manager.getChannelDifference(session.platformSessionId, {
      _: 'updates.getChannelDifference', force: true,
      channel: { _: 'inputChannel', channelId: stableId('peer:final-sequence'), accessHash: Long.ZERO },
      filter: { _: 'channelMessagesFilterEmpty' }, pts: 1, limit: 100,
    })
    expect(difference).toMatchObject({
      _: 'updates.channelDifference',
      newMessages: [{ id: pushedId, message: 'target' }],
      otherUpdates: [{ _: 'updateDeleteChannelMessages', messages: [pushedId] }],
    })
  })

  it('pushes and replays content.serviceAction through updates.getChannelDifference', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'service-group', kind: 'group', title: 'Service Group' }
    const message: IMMessage = {
      id: 'joined', conversationId: conversation.id, senderId: 'alice', timestamp: 60,
      content: { serviceAction: { type: 'custom', text: 'Alice joined the group' }, parts: [] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent[0].update).toMatchObject({
      _: 'updates',
      updates: [{
        _: 'updateNewChannelMessage',
        message: { _: 'messageService', action: { _: 'messageActionCustomAction', message: 'Alice joined the group' } },
      }],
    })
    const difference = await manager.getChannelDifference(session.platformSessionId, {
      _: 'updates.getChannelDifference', force: true,
      channel: { _: 'inputChannel', channelId: stableId('peer:service-group'), accessHash: Long.ZERO },
      filter: { _: 'channelMessagesFilterEmpty' }, pts: 1, limit: 100,
    })
    expect(difference).toMatchObject({
      _: 'updates.channelDifference',
      newMessages: [{ _: 'messageService', action: { _: 'messageActionCustomAction', message: 'Alice joined the group' } }],
    })
    expect(() => roundTrip(sent[0].update)).not.toThrow()
    expect(() => roundTrip(difference)).not.toThrow()
  })

  it('recovers retained updates without returning unsupported differenceTooLong across a pruned pts gap', async () => {
    const { ctx, store } = await createHarness(3)
    const manager = new UpdateManager(
      ctx.database,
      new PlatformRegistry([[session.platformId, platform]]),
      store,
      () => 0,
    )
    const conversation: IMConversation = { id: 'bounded', kind: 'direct', title: 'Bounded' }
    for (let index = 1; index <= 4; index++) {
      const message: IMMessage = {
        id: `bounded-${index}`,
        conversationId: conversation.id,
        senderId: 'alice',
        timestamp: 100 + index,
        content: { parts: [{ type: 'text', text: `message ${index}` }] },
      }
      const result = await store.ingest(session, conversation, message)
      await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    }

    const retained = await store.getUpdateDeliveriesAfter(session.platformSessionId, 1)
    expect(retained.map((delivery) => delivery.pts)).toEqual([3, 4, 5])
    await expect(manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })).resolves.toMatchObject({
      _: 'updates.difference',
      newMessages: [{ message: 'message 2' }, { message: 'message 3' }, { message: 'message 4' }],
      state: { pts: 5, seq: 4 },
    })
  })

  it('realigns state with a supported empty difference after the in-memory journal is restarted', async () => {
    const { ctx, store } = await createHarness()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const manager = new UpdateManager(ctx.database, registry, store, () => 0)
    const conversation: IMConversation = { id: 'restart-gap', kind: 'direct', title: 'Restart Gap' }
    const message: IMMessage = {
      id: 'restart-gap-message', conversationId: conversation.id, senderId: 'alice', timestamp: 200,
      content: { parts: [{ type: 'text', text: 'lost with process memory' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })
    expect(await manager.getState(session.platformSessionId)).toMatchObject({ pts: 2, seq: 1 })

    const restartedStore = new MessageStore(ctx.database)
    const restarted = new UpdateManager(ctx.database, registry, restartedStore, () => 0)
    expect(await restartedStore.getUpdateDeliveriesAfter(session.platformSessionId, 1)).toEqual([])
    await expect(restarted.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })).resolves.toMatchObject({
      _: 'updates.difference', newMessages: [], otherUpdates: [], state: { pts: 2, seq: 1 },
    })
  })
})
