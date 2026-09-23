import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'bundle-avatar-session', platformId: 'qqnt', userId: 'self',
  credentials: {}, metadata: {},
}

const avatar = {
  id: 'avatar:group:479613101',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  locator: {
    messageId: 'avatar:group:479613101', elementId: 'avatar:group:479613101',
    chatType: 2 as const, peerUid: '479613101', kind: 'image' as const,
    fileName: '479613101.jpg', filePath: '/var/lib/qq/avatar/479613101.jpg', fileSize: '7143',
  },
}

function wireConversation() {
  return {
    id: '479613101', kind: 'group' as const, title: '群聊的聊天记录',
    peerUid: '479613101', peerUin: '479613101', chatType: 2 as const, avatar,
  }
}

describe('QQ merged-forward bundle avatar', () => {
  it('answers with the avatar of the archived conversation', async () => {
    const platform = new QQNTPlatform()
    const getConversation = vi.fn(async () => wireConversation())
    platform.client.getConversation = getConversation as never

    await expect(platform.messageBundles.avatar!(session, {
      conversationId: '479613101', rootMessageId: '7688695746422337380',
    })).resolves.toMatchObject({ id: avatar.id + ':original-v1', locator: { filePath: avatar.locator.filePath } })
    expect(getConversation).toHaveBeenCalledOnce()

    // The mapped conversation is remembered, so a second transcript of the
    // same chat resolves its avatar without another bridge round trip.
    await expect(platform.messageBundles.avatar!(session, {
      conversationId: '479613101', rootMessageId: '7688695746422337381',
    })).resolves.toMatchObject({ id: avatar.id + ':original-v1' })
    expect(getConversation).toHaveBeenCalledOnce()
  })

  it('answers nothing when the conversation has no avatar or cannot be resolved', async () => {
    const platform = new QQNTPlatform()
    platform.client.getConversation = vi.fn(async () => ({
      ...wireConversation(), avatar: undefined,
    })) as never

    await expect(platform.messageBundles.avatar!(session, {
      conversationId: '479613101', rootMessageId: '1',
    })).resolves.toBeUndefined()

    platform.client.getConversation = vi.fn(async () => {
      throw new Error('QQNT bridge 404: conversation not found')
    }) as never
    await expect(platform.messageBundles.avatar!(session, {
      conversationId: 'unknown-chat', rootMessageId: '1',
    })).resolves.toBeUndefined()
  })

  it('rejects locators that are not QQ merged-forward resources', () => {
    const platform = new QQNTPlatform()
    expect(() => platform.messageBundles.avatar!(session, { root: 'legacy' }))
      .toThrow('invalid QQ merged-forward locator')
  })
})
