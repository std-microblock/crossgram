import { describe, expect, it } from 'vitest'
import { createTestConversationViews } from './conversation-view.test-utils.js'

const conversation = {
  id: 'view-1', kind: 'group' as const, title: 'Conversation view',
  metadata: { conversationView: 'merged-forward' },
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
})
