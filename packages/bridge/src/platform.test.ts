import { describe, expect, it } from 'vitest'
import { messageMentionsUser, type IMMessage } from './platform.js'

describe('messageMentionsUser', () => {
  it('finds the addressed user across text parts without matching other entity types', () => {
    const message: IMMessage = {
      id: 'mention', conversationId: 'group', senderId: 'alice', timestamp: 1,
      content: { parts: [
        { type: 'text', text: 'hello' },
        {
          type: 'text', text: '@Current and @Other', entities: [
            { type: 'mention', offset: 0, length: 8, userId: 'self' },
            { type: 'bold', offset: 13, length: 6 },
            { type: 'mention', offset: 13, length: 6, userId: 'other' },
          ],
        },
      ] },
    }

    expect(messageMentionsUser(message, 'self')).toBe(true)
    expect(messageMentionsUser(message, 'other')).toBe(true)
    expect(messageMentionsUser(message, 'missing')).toBe(false)
  })

  it('does not infer mentions from plain text alone', () => {
    const message: IMMessage = {
      id: 'plain', conversationId: 'group', senderId: 'alice', timestamp: 1,
      content: { parts: [{ type: 'text', text: '@self' }] },
    }

    expect(messageMentionsUser(message, 'self')).toBe(false)
  })
})
