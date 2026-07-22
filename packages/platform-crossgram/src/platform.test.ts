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
