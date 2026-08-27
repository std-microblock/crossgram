import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Long from 'long'
import { ConversationViewService, type ConversationViewProvider } from './conversation-view.js'
import { createTestConversationViews } from './conversation-view.test-utils.js'

const conversation = {
  id: 'view-1', kind: 'group' as const, title: 'Conversation view',
  metadata: { conversationView: 'merged-forward' },
}

function provider(id = 'merged-forward-unit'): ConversationViewProvider {
  return {
    id,
    supports: (value) => value.metadata?.conversationView === 'merged-forward',
    makeLink: (context) => `https://t.me/bridgechat_${context.chatId}`,
    makePreview: (context, url) => ({
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage', id: Long.ONE, url, displayUrl: context.conversation.title, hash: 0,
        type: 'telegram_message', title: context.conversation.title,
      },
    }),
    makeChat: (context) => ({
      _: 'chat', left: true, id: context.chatId, title: context.conversation.title,
      photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
    }),
    makeFullChat: (context, notifySettings) => ({
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: context.chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId: context.chatId },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO }, notifySettings, botInfo: [],
      },
      chats: [], users: [],
    }),
  }
}

describe('ConversationViewService', () => {
  it('keeps peer and first-message state account-scoped', () => {
    const service = createTestConversationViews()
    expect(service.remember('session-a', 100, conversation)).toBe('https://t.me/bridgechat_100')
    expect(service.resolve('session-a', 100)).toEqual(conversation)
    expect(service.resolve('session-b', 100)).toBeUndefined()

    service.setTarget('session-a', 100, {
      conversationId: conversation.id,
      platformMessageId: 'first',
      tlMessageId: 200,
    })
    expect(service.makeLink('session-a', 100)).toBe('https://t.me/bridgechat_100/200')
    expect(service.ownsMessage('session-a', 200)).toBe(true)
    expect(service.ownsMessage('session-b', 200)).toBe(false)
  })

  it('projects linked chats as left and forbidden instead of joined dialogs', () => {
    const service = createTestConversationViews()
    service.remember('session-a', 100, conversation)
    expect(service.makeChat('session-a', 100, 1)).toMatchObject({
      _: 'chat', left: true, id: 100,
    })
    expect(service.makeFullChat('session-a', 100, { _: 'peerNotifySettings' })).toMatchObject({
      fullChat: { participants: { _: 'chatParticipantsForbidden', chatId: 100 } },
      chats: [{ _: 'chat', left: true, id: 100 }], users: [],
    })
  })

  it('deduplicates linked conversations and concurrent target resolution across projection paths', async () => {
    const service = createTestConversationViews()
    const message = {
      id: 'outer', conversationId: 'ordinary', senderId: 'alice', timestamp: 1,
      content: { parts: [{
        type: 'text' as const, text: 'open twice', entities: [
          { type: 'conversation-link' as const, offset: 0, length: 4, conversation },
          { type: 'conversation-link' as const, offset: 5, length: 5, conversation },
        ],
      }] },
    }
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const resolveTarget = vi.fn(async () => {
      await pending
      return { conversationId: conversation.id, platformMessageId: 'latest', tlMessageId: 200 }
    })

    const first = service.prepareTargets('session-a', [message], () => 100, resolveTarget)
    const second = service.prepareTargets('session-a', [message], () => 100, resolveTarget)
    release()

    await expect(first).resolves.toEqual([{
      conversationId: conversation.id, platformMessageId: 'latest', tlMessageId: 200,
    }])
    await expect(second).resolves.toEqual([{
      conversationId: conversation.id, platformMessageId: 'latest', tlMessageId: 200,
    }])
    expect(resolveTarget).toHaveBeenCalledOnce()
    expect(service.target('session-a', 100)?.tlMessageId).toBe(200)
  })

  it('keeps the returned disposer for explicit early teardown and clears owned records', () => {
    const service = new ConversationViewService(new Context())
    const unregister = service.register(provider())
    expect(service.remember('session-a', 100, conversation)).toBe('https://t.me/bridgechat_100')

    unregister()

    expect(service.supports(conversation)).toBe(false)
    expect(service.resolve('session-a', 100)).toBeUndefined()
  })
})
