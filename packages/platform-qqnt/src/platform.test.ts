import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

describe('QQNTPlatform mapping', () => {
  it('maps opaque QQ IDs and member roles without numeric coercion', async () => {
    const platform = new QQNTPlatform()
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [{
        id: '2:1058754719', kind: 'group' as const, title: 'Test Group',
        peerUid: '1058754719', peerUin: '1058754719', chatType: 2 as const,
        unreadCount: 7,
      }],
    }))
    platform.client.getMembers = vi.fn(async () => ({
      members: [{
        user: { id: 'u_very_long_opaque', numericId: '1715311957', name: 'MicroBlock' },
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
    })
    const members = await platform.getConversationMembers(session, { id: '2:1058754719' })
    expect(members.members[0]).toMatchObject({
      user: { id: 'u_very_long_opaque', username: '1715311957' },
      role: 'administrator',
      permissions: { manageMembers: true, editAnyMessage: false },
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
