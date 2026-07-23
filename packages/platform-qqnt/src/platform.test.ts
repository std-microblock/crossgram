import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

describe('QQNTPlatform mapping', () => {
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
        unreadCount: 7,
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
    const dialogs = await platform.getDialogs(session)
    expect(dialogs.dialogs[0]).toMatchObject({
      conversation: {
        id: '2:1058754719', kind: 'group',
        metadata: { qqPeerUid: '1058754719', qq: '1058754719', chatType: 2 },
      },
      unreadCount: 7,
      readInboxMaxMessage: {
        id: 'read-42',
        content: { parts: [{ type: 'text', text: 'last read' }] },
      },
    })
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
        key: '1:14', title: '微笑',
        presentation: {
          type: 'custom' as const, alt: '[微笑]',
          resource: {
            version: 1, format: 'static' as const, mimeType: 'image/png' as const,
            width: 200, height: 200, size: 10, locator: { filePath: '/tmp/s14.png' },
          },
        },
      }],
      reactions: [{ key: '2:128522', count: 2, selected: true }],
      maxSelected: 20,
    }
    platform.client.getReactionCatalog = vi.fn(async () => context)
    platform.client.getMessageReactions = vi.fn(async () => context)
    platform.client.setMessageReactions = vi.fn(async () => ({
      ...context, reactions: [{ key: '1:14', count: 1, selected: true }],
    }))
    await expect(platform.getAvailableReactions(session, { conversationId: '2:g' }))
      .resolves.toMatchObject({ available: [{ key: '2:128522' }, { key: '1:14' }] })
    await expect(platform.getMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm',
    })).resolves.toMatchObject({ reactions: [{ key: '2:128522', selected: true }] })
    await expect(platform.setMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm',
    }, ['1:14'])).resolves.toMatchObject({ reactions: [{ key: '1:14', selected: true }] })
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
