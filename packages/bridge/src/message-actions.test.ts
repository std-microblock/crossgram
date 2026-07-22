import { describe, expect, it, vi } from 'vitest'
import {
  MessageActionUnavailableError, PlatformMessageActions, messageRuleAllows,
} from './message-actions.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'session', platformId: 'test', userId: 'self', credentials: null, metadata: {},
}

function message(id: string): IMMessage {
  return {
    id, conversationId: 'room', senderId: 'self', timestamp: 100,
    content: { parts: [{ type: 'text', text: id }] }, outgoing: true,
  }
}

function platform(editMode: 'native' | 'delete-and-resend' | 'unsupported'): IMPlatform {
  return {
    capabilities: {
      history: true,
      send: { text: true, images: false, files: false, mixed: false, maxTextLength: 100, maxMedia: 0 },
      conversations: { groups: true, channels: false, subchannels: false },
      messageActions: {
        delete: { own: { supported: true, maxAgeSeconds: 120 }, others: { supported: true } },
        edit: { mode: editMode },
        forward: { mode: 'copy', preservesAuthor: false },
      },
    },
    async subscribe() { return () => {} },
    async sendMessage(_session, conversation, content) {
      return { ...message('replacement'), conversationId: conversation.id, content: { parts: content.parts as never } }
    },
  }
}

describe('PlatformMessageActions', () => {
  it('uses the native edit primitive without deleting the original', async () => {
    const adapter = platform('native')
    adapter.editMessage = vi.fn(async () => message('original'))
    adapter.deleteMessages = vi.fn(async () => {})
    const actions = new PlatformMessageActions(adapter, session)

    await expect(actions.edit(
      { conversationId: 'room', messageId: 'original', targetId: 'physical' },
      { parts: [{ type: 'text', text: 'edited' }] },
    )).resolves.toEqual({ message: message('original') })
    expect(adapter.editMessage).toHaveBeenCalledOnce()
    expect(adapter.deleteMessages).not.toHaveBeenCalled()
  })

  it('implements edit as delete then resend when requested by the adapter', async () => {
    const adapter = platform('delete-and-resend')
    const order: string[] = []
    adapter.deleteMessages = vi.fn(async (_session, _conversation, ids, options) => {
      order.push(`delete:${ids.join(',')}:${options.forEveryone}`)
    })
    adapter.sendMessage = vi.fn(async () => {
      order.push('send')
      return message('replacement')
    })
    const actions = new PlatformMessageActions(adapter, session)

    await expect(actions.edit(
      { conversationId: 'room', messageId: 'original', targetId: 'physical' },
      { parts: [{ type: 'text', text: 'edited' }] },
    )).resolves.toEqual({ message: message('replacement'), replacedMessageId: 'original' })
    expect(order).toEqual(['delete:physical:true', 'send'])
  })

  it('does not resend when the delete half of fallback editing fails', async () => {
    const adapter = platform('delete-and-resend')
    adapter.deleteMessages = vi.fn(async () => { throw new Error('too old') })
    adapter.sendMessage = vi.fn(adapter.sendMessage)
    const actions = new PlatformMessageActions(adapter, session)

    await expect(actions.edit(
      { conversationId: 'room', messageId: 'original', targetId: 'physical' },
      { parts: [{ type: 'text', text: 'edited' }] },
    )).rejects.toThrow('too old')
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('delegates native/copy forwarding and rejects unsupported actions', async () => {
    const adapter = platform('unsupported')
    adapter.forwardMessages = vi.fn(async () => [message('forwarded')])
    const actions = new PlatformMessageActions(adapter, session)
    await expect(actions.forward({ id: 'room' }, ['physical'], { id: 'target' }, { dropAuthor: true }))
      .resolves.toEqual([message('forwarded')])

    adapter.capabilities.messageActions!.forward.mode = 'unsupported'
    await expect(actions.forward({ id: 'room' }, ['physical'], { id: 'target' }))
      .rejects.toBeInstanceOf(MessageActionUnavailableError)
  })
})

describe('messageRuleAllows', () => {
  it('distinguishes unsupported, time-limited, and unlimited administrator deletion', () => {
    expect(messageRuleAllows({ supported: false }, 100, 101)).toBe(false)
    expect(messageRuleAllows({ supported: true, maxAgeSeconds: 120 }, 100, 220)).toBe(true)
    expect(messageRuleAllows({ supported: true, maxAgeSeconds: 120 }, 100, 221)).toBe(false)
    expect(messageRuleAllows({ supported: true }, 100, 1_000_000)).toBe(true)
  })
})
