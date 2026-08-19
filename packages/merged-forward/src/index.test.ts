import { describe, expect, it } from 'vitest'
import { makeMergedForwardProvider } from './index.js'

const context = {
  platformSessionId: 'session-1',
  chatId: 123,
  conversation: {
    id: 'qqnt-multi-forward:test', kind: 'group' as const, title: 'Alice 和 Bob 的聊天记录',
    metadata: {
      conversationView: 'merged-forward',
      qqMultiForwardPreview: 'Alice: hello\nBob: world',
    },
  },
}

describe('merged-forward conversation view provider', () => {
  it('owns only explicitly tagged merged-forward conversations', () => {
    const provider = makeMergedForwardProvider()
    expect(provider.supports(context.conversation)).toBe(true)
    expect(provider.supports({
      id: 'ordinary', kind: 'group', title: 'Ordinary', metadata: { virtual: true },
    })).toBe(false)
  })

  it('creates cross-client deep links and native preview cards', () => {
    const provider = makeMergedForwardProvider()
    const link = provider.makeLink(context, {
      conversationId: context.conversation.id,
      platformMessageId: 'first',
      tlMessageId: 456,
    })
    expect(link).toBe('https://t.me/bridgechat_123/456')
    expect(provider.makePreview(context, link)).toMatchObject({
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage', url: link, type: 'telegram_message',
        title: context.conversation.title,
        description: 'Alice: hello\nBob: world',
      },
    })
    expect(provider.makeChat(context, 1)).toMatchObject({
      _: 'chat', left: true, id: 123, title: context.conversation.title, participantsCount: 1,
    })
    expect(provider.makeChat(context, 1)).not.toHaveProperty('creator')
    expect(provider.makeFullChat(context, { _: 'peerNotifySettings' })).toMatchObject({
      fullChat: {
        _: 'chatFull', participants: { _: 'chatParticipantsForbidden', chatId: 123 },
      },
      chats: [{ _: 'chat', left: true, id: 123 }], users: [],
    })
  })

  it('hides generic counters and resolves only its synthetic usernames', () => {
    const provider = makeMergedForwardProvider()
    const generic = {
      ...context,
      conversation: {
        ...context.conversation,
        metadata: {
          ...context.conversation.metadata,
          qqMultiForwardPreview: '3条消息的合并转发',
        },
      },
    }
    expect(provider.makePreview(generic, provider.makeLink(generic)).webpage).toMatchObject({
      _: 'webPage', description: '点击查看合并转发消息',
    })
    expect(provider.resolveUsername?.('bridgechat_123')).toBe(123)
    expect(provider.resolveUsername?.('ordinary_user')).toBeUndefined()
  })
})
