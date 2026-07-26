import { describe, expect, it } from 'vitest'
import { registerVirtualConversation, virtualConversation } from './virtual-conversations.js'

describe('virtual conversations', () => {
  it('uses a cross-client HTTPS link while retaining the basic-chat peer', () => {
    const conversation = {
      id: 'merged-forward', kind: 'group' as const, title: '聊天记录',
      metadata: { virtual: true },
    }

    expect(registerVirtualConversation('android-link-test', 1113, conversation))
      .toBe('https://t.me/bridgechat_1113')
    expect(virtualConversation('android-link-test', 1113)).toBe(conversation)
  })
})
