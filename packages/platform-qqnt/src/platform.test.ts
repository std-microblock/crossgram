import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'
import { QQStickerProvider } from './sticker-provider.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

describe('QQNTPlatform mapping', () => {
  it('registers native sticker plans and maps QQ stickers back to the provider', async () => {
    const platform = new QQNTPlatform({}, 'qq-provider')
    const reference = {
      kind: 'market' as const, packageId: '42', stickerId: 'wave', name: 'Wave', key: 'secret',
      width: 320, height: 180, animated: true,
    }
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'sent-sticker', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'sticker' as const, sticker: {
        stickerId: 'market:42:wave', packId: '42', title: 'Wave',
        format: 'animated' as const, mimeType: 'image/gif', width: 320, height: 180,
        reference,
      } }],
    }))

    const sent = await platform.sendMessage(session, { id: 'u' }, { parts: [{
      type: 'sticker',
      sticker: {
        type: 'native', providerId: 'qq-provider', stickerId: 'market:42:wave', packId: '42',
        reference,
      },
    }] })

    expect((platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![5]).toEqual(reference)
    expect(sent.content.parts).toMatchObject([{
      type: 'sticker', sticker: {
        providerId: 'qq-provider', stickerId: 'market:42:wave', format: 'animated',
        locator: reference,
      },
    }])
  })

  it('exposes QQ packs, assets, and native favorite mutation through the sticker provider', async () => {
    const platform = new QQNTPlatform()
    const provider = new QQStickerProvider(platform.client, 'qq-provider')
    const reference = {
      kind: 'favorite' as const, resId: 'fav', path: '/tmp/fav.png', name: 'fav.png',
      width: 1, height: 1, animated: false,
    }
    platform.client.getStickerPack = vi.fn(async () => ({
      packId: 'favorites', title: 'Favorites', stickers: [{
        stickerId: 'favorite:fav', format: 'static' as const, mimeType: 'image/png',
        width: 1, height: 1, reference,
      }],
    }))
    platform.client.stickerSource = vi.fn(() => ({ async *stream() { yield new Uint8Array([1, 2, 3]) } }))
    platform.client.setSavedSticker = vi.fn(async () => {})

    const pack = await provider.getPack({ session, platformKind: 'qq' }, 'favorites')
    expect(pack?.stickers[0]).toMatchObject({ providerId: 'qq-provider', stickerId: 'favorite:fav' })
    const asset = await provider.openAsset({ session, platformKind: 'qq' }, pack!.stickers[0])
    const chunks: number[] = []
    for await (const chunk of asset.source.stream()) chunks.push(...chunk)
    expect(chunks).toEqual([1, 2, 3])
    await provider.setSavedSticker({ session, platformKind: 'qq' }, pack!.stickers[0], true)
    expect(platform.client.setSavedSticker).toHaveBeenCalledWith(reference, true)
  })

  it('suppresses only the originating session listener echo', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    let wireHandler: ((event: any) => void | Promise<void>) | undefined
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      wireHandler = handler
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    platform.client.sendMessage = vi.fn(async (_conversation, _text, _media, _options, originRequestId) => ({
      id: 'sent', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
      originRequestId, parts: [{ type: 'text' as const, text: 'hello' }],
    }))
    const other = { ...session, platformSessionId: 'other-session' }
    const ownEvents: unknown[] = []
    const otherEvents: unknown[] = []
    const unsubscribeOwn = await platform.subscribe(session, (event) => { ownEvents.push(event) })
    const unsubscribeOther = await platform.subscribe(other, (event) => { otherEvents.push(event) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sent = await platform.sendMessage(session, { id: 'u' }, {
      parts: [{ type: 'text', text: 'hello' }],
    })
    const originRequestId = (platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![4]
    const echo = {
      type: 'message' as const,
      conversation: { id: 'u', kind: 'direct' as const, title: 'u', peerUid: 'u', peerUin: '1', chatType: 1 as const },
      message: {
        id: 'sent', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
        originRequestId, parts: [{ type: 'text' as const, text: 'hello' }],
      },
    }
    // Each subscription owns an SSE connection; exercise the same wire event against both handlers.
    const handlers = (platform.client.subscribe as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])
    await handlers[0](echo)
    await handlers[1](echo)
    expect(sent.id).toBe('sent')
    expect(ownEvents).toEqual([])
    expect(otherEvents).toHaveLength(1)
    await unsubscribeOwn()
    await unsubscribeOther()
    expect(wireHandler).toBeTypeOf('function')
  })

  it('maps opaque QQ IDs and member roles without numeric coercion', async () => {
    const platform = new QQNTPlatform()
    const avatar = {
      id: 'avatar:user:u_very_long_opaque', kind: 'image' as const, mimeType: 'image/jpeg',
      locator: {
        messageId: 'avatar:user:u_very_long_opaque', elementId: 'avatar:user:u_very_long_opaque',
        chatType: 1 as const, peerUid: 'u_very_long_opaque', kind: 'image' as const,
        fileName: '1715311957.jpg', avatarUin: '1715311957',
      },
    }
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [{
        id: '2:1058754719', kind: 'group' as const, title: 'Test Group',
        peerUid: '1058754719', peerUin: '1058754719', chatType: 2 as const,
        participantCount: 42, selfRole: 'owner' as const,
        unreadCount: 7,
        firstUnread: { msgSeq: 'opaque-seq-42', msgTime: '1700000001' },
        readInboxMaxMessage: {
          id: 'read-42', conversationId: '2:1058754719', senderId: 'member',
          timestamp: 1_700_000_000, outgoing: false,
          parts: [{ type: 'text' as const, text: 'last read' }],
        },
      }],
    }))
    platform.client.getMembers = vi.fn(async () => ({
      members: [{
        user: {
          id: 'u_very_long_opaque', numericId: '1715311957',
          name: 'Profile Name', alias: 'Group Alias', avatar,
        },
        role: 'administrator' as const,
      }],
      total: 1,
    }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [] }))
    platform.client.getUser = vi.fn(async () => ({
      id: 'self', numericId: '10000', name: 'Bridge',
    }))
    const dialogs = await platform.getDialogs(session)
    expect(dialogs.dialogs[0]).toMatchObject({
      conversation: {
        id: '2:1058754719', kind: 'group',
        metadata: {
          qqPeerUid: '1058754719', qq: '1058754719', chatType: 2,
          participantsCount: 42, qqSelfRole: 'owner',
        },
      },
      unreadCount: 7,
      readInboxMaxMessage: {
        id: 'read-42',
        content: { parts: [{ type: 'text', text: 'last read' }] },
      },
    })
    await platform.getHistory(session, { id: '2:1058754719' }, { limit: 50 })
    expect(platform.client.getHistory).toHaveBeenCalledWith('2:1058754719', {
      cursor: undefined,
      limit: 50,
      beforeId: undefined,
      afterId: undefined,
      aroundUnreadSeq: 'opaque-seq-42',
    })
    await expect(platform.getConversationMember(
      session, { id: '2:1058754719' }, 'self',
    )).resolves.toMatchObject({
      user: { id: 'self', firstName: 'Bridge' },
      role: 'owner',
      permissions: { manageMembers: true },
    })
    expect(platform.client.getMembers).not.toHaveBeenCalled()
    const members = await platform.getConversationMembers(session, { id: '2:1058754719' })
    expect(members.members[0]).toMatchObject({
      user: {
        id: 'u_very_long_opaque',
        firstName: 'Group Alias',
        username: '1715311957',
        avatar: { locator: { avatarUin: '1715311957' } },
        metadata: { qqName: 'Profile Name', qqGroupAlias: 'Group Alias' },
      },
      role: 'administrator',
      permissions: { manageMembers: true, editAnyMessage: false },
    })
  })

  it('can use the profile nickname instead of a conversation-scoped group alias', async () => {
    const platform = new QQNTPlatform({ memberName: 'nickname' })
    platform.client.getMembers = vi.fn(async () => ({
      members: [{
        user: {
          id: 'member', numericId: '42', name: 'Profile Name', alias: 'Group Alias',
        },
        role: 'member' as const,
      }],
      total: 1,
    }))
    await expect(platform.getConversationMembers(session, { id: 'group' })).resolves.toMatchObject({
      members: [{ user: {
        firstName: 'Profile Name',
        metadata: { qqName: 'Profile Name', qqGroupAlias: 'Group Alias' },
      } }],
    })
  })

  it('does not scan the full member list when a self-role probe arrives before group metadata', async () => {
    const platform = new QQNTPlatform()
    platform.client.getMembers = vi.fn(async () => ({ members: [], total: 0 }))
    await expect(platform.getConversationMember(
      session, { id: 'cold-group' }, session.userId,
    )).resolves.toBeNull()
    expect(platform.client.getMembers).not.toHaveBeenCalled()
  })

  it('keeps the full buddy address book separate from recent dialogs and exposes avatars', async () => {
    const platform = new QQNTPlatform()
    const avatar = {
      id: 'avatar:user:u1', kind: 'image' as const, name: 'avatar.png', size: 12,
      locator: {
        messageId: 'avatar:u1', elementId: 'avatar:u1', chatType: 1 as const,
        peerUid: 'u1', kind: 'image' as const, fileName: 'avatar.png', filePath: '/tmp/avatar.png',
      },
    }
    platform.client.getContacts = vi.fn(async () => ({
      users: [{ id: 'u1', numericId: '10001', name: 'Friend', avatar }],
    }))
    const contacts = await platform.getContacts(session, { limit: 500 })
    expect(contacts.users).toMatchObject([{
      id: 'u1', firstName: 'Friend', username: '10001',
      avatar: { id: 'avatar:user:u1', locator: { filePath: '/tmp/avatar.png' } },
    }])
  })

  it('keeps cached conversation identity fields when an incremental event is incomplete', async () => {
    const platform = new QQNTPlatform()
    const avatar = {
      id: 'avatar:group:1058754719', kind: 'image' as const,
      locator: {
        messageId: 'avatar:group:1058754719', elementId: 'avatar:group:1058754719',
        chatType: 2 as const, peerUid: '1058754719', kind: 'image' as const,
        fileName: 'group.png', filePath: '/tmp/group.png',
      },
    }
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [{
        id: '1058754719', kind: 'group' as const, title: 'Bridge Test Group',
        peerUid: '1058754719', peerUin: '1058754719', chatType: 2 as const, avatar,
      }],
    }))
    await platform.getDialogs(session)
    const received = Promise.withResolvers<unknown>()
    platform.client.getReactionCatalog = vi.fn(async () => ({
      available: [], reactions: [], maxSelected: 20,
    }))
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      await handler({
        type: 'message',
        conversation: {
          id: '1058754719', kind: 'group', title: '1058754719',
          peerUid: '1058754719', peerUin: '1058754719', chatType: 2,
        },
        message: {
          id: 'm1', conversationId: '1058754719', senderId: 'member',
          sender: {
            id: 'member', numericId: '42', name: 'Profile Name', alias: 'Group Alias',
            avatar: {
              id: 'avatar:user:member', kind: 'image', mimeType: 'image/jpeg',
              locator: {
                messageId: 'avatar:user:member', elementId: 'avatar:user:member',
                chatType: 1, peerUid: 'member', kind: 'image',
                fileName: '42.jpg', avatarUin: '42',
              },
            },
          },
          timestamp: 1, outgoing: false, parts: [{ type: 'text', text: 'hello' }],
        },
      })
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const unsubscribe = await platform.subscribe(session, (event) => received.resolve(event))

    await expect(received.promise).resolves.toMatchObject({
      type: 'message',
      conversation: {
        title: 'Bridge Test Group',
        avatar: { id: 'avatar:group:1058754719', locator: { filePath: '/tmp/group.png' } },
      },
      message: {
        sender: {
          firstName: 'Group Alias',
          username: '42',
          avatar: { locator: { avatarUin: '42' } },
          metadata: { qqName: 'Profile Name', qqGroupAlias: 'Group Alias' },
        },
      },
    })
    await unsubscribe()
  })

  it('maps QQ cloud-controlled reaction definitions and delegates reaction writes', async () => {
    const platform = new QQNTPlatform()
    const context = {
      available: [{
        key: '2:128522', title: '嘿嘿',
        presentation: { type: 'emoji' as const, emoticon: '😊' },
      }, {
        key: '1:265', title: '辣眼睛',
        presentation: {
          type: 'custom' as const, alt: '[辣眼睛]',
          resource: {
            version: 1, format: 'static' as const, mimeType: 'image/png' as const,
            width: 200, height: 200, size: 10, locator: { filePath: '/tmp/s265.png' },
          },
        },
      }, {
        key: '1:14', title: '微笑',
        presentation: {
          type: 'custom' as const, alt: '[微笑]',
          resource: {
            version: 2, format: 'video' as const, mimeType: 'video/webm' as const,
            width: 128, height: 128, locator: { filePath: '/tmp/s14.png', assetKey: 'sysface/s14.webm' },
          },
        },
      }],
      reactions: [{ key: '2:128522', count: 2, selected: true }],
      maxSelected: 20,
    }
    platform.client.getReactionCatalog = vi.fn(async () => context)
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer()
    platform.client.downloadMedia = vi.fn(async function* () { yield png })
    platform.client.getMessageReactions = vi.fn(async () => ({
      reactions: context.reactions, maxSelected: 20,
    }))
    platform.client.setMessageReactions = vi.fn(async () => ({
      reactions: [{ key: '1:14', count: 1, selected: true }], maxSelected: 20,
    }))
    const catalog = await platform.getAvailableReactions(session, { conversationId: '2:g' })
    expect(catalog).toMatchObject({
      available: [{
        key: '2:128522',
      }, {
        key: '1:265',
        presentation: {
          resource: { mimeType: 'image/webp', width: 100, height: 100 },
        },
      }, {
        key: '1:14',
        presentation: {
          resource: { format: 'video', mimeType: 'video/webm', width: 100, height: 100 },
        },
      }],
    })
    const custom = catalog.available[1]!
    if (custom.presentation.type !== 'custom') throw new Error('expected custom reaction')
    const cached: Uint8Array[] = []
    for await (const chunk of platform.downloadReactionResource(
      session, custom.presentation.resource, { offset: 8, limit: 4 },
    )) cached.push(chunk)
    expect(Buffer.concat(cached).toString()).toBe('WEBP')
    const animated = catalog.available[2]!
    if (animated.presentation.type !== 'custom') throw new Error('expected animated custom reaction')
    expect(animated.presentation.resource).toMatchObject({
      format: 'video', mimeType: 'video/webm', width: 100, height: 100, size: expect.any(Number),
    })
    const webm: Uint8Array[] = []
    for await (const chunk of platform.downloadReactionResource(
      session, animated.presentation.resource, { offset: 0, limit: 4 },
    )) webm.push(chunk)
    expect(Buffer.concat(webm)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    await expect(platform.getMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm',
    })).resolves.toMatchObject({ reactions: [{ key: '2:128522', selected: true }] })
    await expect(platform.setMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm',
    }, ['1:14'])).resolves.toMatchObject({ reactions: [{ key: '1:14', selected: true }] })
    await expect(platform.getAvailableReactions(session, { conversationId: '1:u' }))
      .resolves.toEqual({ available: [], reactions: [], maxSelected: 0 })
    expect(platform.client.getReactionCatalog).toHaveBeenCalledTimes(1)
  })

  it('maps sent media locators and streams downloads with progress', async () => {
    const platform = new QQNTPlatform()
    const locator = {
      messageId: 'm', elementId: 'e', chatType: 1 as const, peerUid: 'u',
      kind: 'file' as const, fileName: 'x.bin',
    }
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'm', conversationId: '1:u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'media' as const, media: { id: 'e', kind: 'file' as const, name: 'x.bin', size: 3, locator } }],
    }))
    const sent = await platform.sendMessage(session, { id: '1:u' }, {
      parts: [{ type: 'media', media: {
        kind: 'file', name: 'x.bin', size: 3,
        source: { size: 3, async *stream() { yield new Uint8Array([1, 2, 3]) } },
      } }],
    })
    expect(sent.content.parts[0]).toMatchObject({ media: { locator } })

    platform.client.downloadMedia = vi.fn(async function* (_locator, options) {
      await options.onChunk?.(2)
      yield new Uint8Array([1, 2])
      await options.onChunk?.(1)
      yield new Uint8Array([3])
    })
    const progress: number[] = []
    const chunks: number[] = []
    for await (const chunk of platform.downloadMedia(session, {
      id: 'e', kind: 'file', size: 3, locator,
    }, { onProgress: (item) => { progress.push(item.transferredBytes) } })) chunks.push(...chunk)
    expect(chunks).toEqual([1, 2, 3])
    expect(progress).toEqual([2, 3])
  })
})
