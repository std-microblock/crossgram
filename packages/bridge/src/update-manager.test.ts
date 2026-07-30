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
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { UpdateManager } from './update-manager.js'
import { BlockedPeerStore, type BlockedContentMode } from './blocked-peers.js'
import { ReactionRpc } from './reaction-rpc.js'

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
        firstName: 'Group Alias',
        avatar: { id: 'avatar-alias', kind: 'image', locator: { userId: 'alice' } },
      },
      content: { parts: [{ type: 'text', text: 'pushed' }] },
    }
    const result = await store.ingest(session, conversation, message)
    await manager.publish(session, { event: { type: 'message', conversation, message }, result })

    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0].authKeyId).toString('hex')).toBe('0011223344556677')
    expect(sent[0].update).toMatchObject({
      _: 'updates', seq: 1,
      updates: [{ _: 'updateNewChannelMessage', pts: 2, ptsCount: 1, message: { message: 'pushed' } }],
      chats: [{
        _: 'channel', title: 'Group', megagroup: true, accessHash: Long.ONE,
        photo: { _: 'chatPhoto', dcId: 1 },
      }],
      users: [
        { _: 'user', self: true, accessHash: Long.ONE },
        {
          _: 'user', firstName: 'Group Alias', accessHash: Long.ONE,
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
    const text = '入口：https://example.com/path?q=1，备用 example.org/docs。'
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
          _: 'messageEntityUrl', offset: text.indexOf('https://'),
          length: 'https://example.com/path?q=1'.length,
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

  it('projects live merged-forward links as resolvable chats with native preview cards', async () => {
    const { store, manager, sent } = await createHarness()
    const conversation: IMConversation = { id: 'merged-parent', kind: 'group', title: 'Parent' }
    const virtual: IMConversation = {
      id: 'merged-virtual', kind: 'group', title: 'QQ用户的聊天记录',
      metadata: {
        virtual: true,
        qqMultiForwardPreview: 'Alice: 第一条\nBob: 第二条',
      },
    }
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
    const url = `https://t.me/bridgechat_${virtualId}`
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
      state: { pts: 2, seq: 4 },
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
