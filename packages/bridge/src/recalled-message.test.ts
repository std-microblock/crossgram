import { describe, expect, it } from 'vitest'
import type { IMMessage } from './platform.js'
import { isLegacyRecallStrikethrough, markMessageRecalled } from './recalled-message.js'

function message(parts: IMMessage['content']['parts'], recalled?: boolean): IMMessage {
  return {
    id: 'recall-target', conversationId: 'room', senderId: 'alice', timestamp: 1,
    recalled, content: { parts },
  }
}

describe('recalled message formatting', () => {
  it('marks a message as recalled without adding strikethrough formatting', () => {
    const source = message([{
      type: 'text', text: 'keep formatting',
      entities: [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'strikethrough', offset: 5, length: 3 },
      ],
    }])

    expect(markMessageRecalled(source)).toEqual({
      ...source,
      recalled: true,
    })
  })

  it('removes only the full-span strike injected by legacy recall handling', () => {
    const source = message([{
      type: 'text', text: 'legacy strike',
      entities: [
        { type: 'strikethrough', offset: 0, length: 'legacy strike'.length },
        { type: 'strikethrough', offset: 7, length: 6 },
        { type: 'italic', offset: 0, length: 6 },
      ],
    }], true)

    const result = markMessageRecalled(source)
    expect(result.content.parts).toEqual([{
      type: 'text', text: 'legacy strike',
      entities: [
        { type: 'strikethrough', offset: 7, length: 6 },
        { type: 'italic', offset: 0, length: 6 },
      ],
    }])
    expect(markMessageRecalled(result)).toBe(result)
  })

  it('recognizes the legacy marker only on recalled full text parts', () => {
    const part = {
      type: 'text' as const,
      text: 'gone',
      entities: [{ type: 'strikethrough' as const, offset: 0, length: 4 }],
    }
    expect(isLegacyRecallStrikethrough(message([part], true), part, part.entities[0])).toBe(true)
    expect(isLegacyRecallStrikethrough(message([part]), part, part.entities[0])).toBe(false)
    expect(isLegacyRecallStrikethrough(
      message([part], true), part, { type: 'strikethrough', offset: 1, length: 3 },
    )).toBe(false)
  })
})
