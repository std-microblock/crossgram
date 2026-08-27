import { describe, expect, it, vi } from 'vitest'
import { stableId, type BridgeSessionState, type MessageProjectionInput } from '@mtproto-relay/bridge'
import { makeMergedForwardProvider } from './index.js'

const conversation = {
  id: 'qqnt-multi-forward:test', kind: 'group' as const, title: 'Alice 和 Bob 的聊天记录',
  metadata: {
    conversationView: 'merged-forward',
    conversationViewPreview: 'Alice: hello\nBob: world',
  },
}

function input(loadConversation?: MessageProjectionInput['loadConversation']): MessageProjectionInput {
  return {
    mode: 'history',
    session: {
      platformId: 'test', platformSessionId: 'session-1', userId: 'self',
      credentials: {}, metadata: {},
    },
    conversation: { id: 'outer', kind: 'group', title: 'Outer' },
    tlMessageId: 10,
    ordinal: 0,
    draft: {
      source: {
        id: 'outer-message', conversationId: 'outer', senderId: 'alice', timestamp: 1,
        content: { parts: [{
          type: 'text', text: '查看聊天记录', entities: [{
            type: 'conversation-link', offset: 0, length: 6, conversation,
          }],
        }] },
      },
      chats: [],
    },
    loadConversation,
  }
}

describe('merged-forward projection', () => {
  it('owns state, deep links, preview cards, and synthetic peers inside the feature', () => {
    const projection = makeMergedForwardProvider()
    expect(projection.supports(conversation)).toBe(true)
    expect(projection.supports({ id: 'ordinary', kind: 'group', title: 'Ordinary' })).toBe(false)
    expect(projection.remember('session-1', 123, conversation)).toBe('https://t.me/bridgechat_123')
    projection.setTarget('session-1', 123, {
      conversationId: conversation.id, platformMessageId: 'first', tlMessageId: 456, timestamp: 1,
    })
    expect(projection.makeLink('session-1', 123)).toBe('https://t.me/bridgechat_123/456')
    expect(projection.makePreview('session-1', 123)).toMatchObject({
      webpage: {
        url: 'https://t.me/bridgechat_123/456',
        title: conversation.title,
        description: 'Alice: hello\nBob: world',
      },
    })
    expect(projection.makeChat('session-1', 123)).toMatchObject({
      _: 'chat', left: true, id: 123, title: conversation.title,
    })
    expect(projection.resolveUsername('session-1', 'bridgechat_123')).toMatchObject({
      chatId: 123, conversation,
    })
  })

  it('projects conversation links through the message waterfall and deduplicates target loading', async () => {
    const projection = makeMergedForwardProvider()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const loadConversation = vi.fn(async () => {
      await wait
      return [{
        conversationId: conversation.id, platformMessageId: 'latest',
        tlMessageId: 456, timestamp: 100,
      }]
    })
    const first = input(loadConversation)
    const second = input(loadConversation)
    const chatId = stableId(`peer:${conversation.id}`)
    const render = (value: MessageProjectionInput) => projection.project(value, async () => ({
      message: {
        _: 'message', id: value.tlMessageId, peerId: { _: 'peerChannel', channelId: 1 },
        date: 1, message: '查看聊天记录', entities: [],
      },
      chats: value.draft.chats,
    }))
    const pending = [render(first), render(second)]
    release()
    const [one, two] = await Promise.all(pending)

    expect(loadConversation).toHaveBeenCalledOnce()
    for (const [result, value] of [[one, first], [two, second]] as const) {
      expect(value.draft.source.content.parts[0]).toMatchObject({
        entities: [{ type: 'text-link', url: `https://t.me/bridgechat_${chatId}/456` }],
      })
      expect(value.draft.media).toMatchObject({ _: 'messageMediaWebPage' })
      expect(result.chats).toMatchObject([{ _: 'chat', left: true, id: chatId }])
    }
  })

  it('uses a generic fallback description for counter-only previews', () => {
    const projection = makeMergedForwardProvider()
    projection.remember('session-1', 123, {
      ...conversation,
      metadata: { ...conversation.metadata, conversationViewPreview: '3条消息的合并转发' },
    })
    expect(projection.makePreview('session-1', 123)?.webpage).toMatchObject({
      description: '点击查看合并转发消息',
    })
  })

  it('rebuilds feature-owned records and deep-link targets from the durable message store', async () => {
    const projection = makeMergedForwardProvider()
    const chatId = stableId(`peer:${conversation.id}`)
    const listConversations = vi.fn(async () => [conversation])
    const readProjectedHistory = vi.fn(async () => [{
      source: {
        id: 'persisted-latest', conversationId: conversation.id, senderId: 'alice', timestamp: 100,
        content: { parts: [{ type: 'text' as const, text: 'persisted transcript' }] },
      },
      parts: [{ ordinal: 0, tlMessageId: 789 }],
      media: [],
    }])
    const state = {
      session: input().session,
      store: { listConversations, readProjectedHistory },
    } as unknown as BridgeSessionState

    await projection.ensureHydrated(state)
    await projection.ensureHydrated(state)

    expect(projection.resolve('session-1', chatId)).toEqual(conversation)
    expect(projection.target('session-1', chatId)).toMatchObject({
      conversationId: conversation.id, platformMessageId: 'persisted-latest', tlMessageId: 789,
    })
    expect(projection.makeLink('session-1', chatId)).toBe(`https://t.me/bridgechat_${chatId}/789`)
    expect(listConversations).toHaveBeenCalledOnce()
    expect(readProjectedHistory).toHaveBeenCalledOnce()
  })
})
