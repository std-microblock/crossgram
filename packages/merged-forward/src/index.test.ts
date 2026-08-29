import { describe, expect, it, vi } from 'vitest'
import {
  stableId,
  type IMMessageBundle,
  type IMPlatform,
  type MessageProjectionInput,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import { makeMergedForwardProvider } from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'session-1', userId: 'self',
  credentials: {}, metadata: {},
}

const bundle: IMMessageBundle = {
  id: 'bundle:test',
  title: 'Alice 和 Bob 的聊天记录',
  preview: 'Alice: hello\nBob: world',
  locator: { root: 'forward-1' },
}

function platform(load: NonNullable<IMPlatform['messageBundles']>['load'] = vi.fn(async () => [{
  id: 'latest', senderId: 'bob', timestamp: 100,
  sender: { id: 'bob', firstName: 'Bob' },
  content: { parts: [{ type: 'text' as const, text: 'world' }] },
}])): IMPlatform {
  return {
    capabilities: {
      history: true,
      send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
      conversations: { groups: true, channels: false, subchannels: false },
    },
    messageBundles: { load },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
  }
}

function input(adapter: IMPlatform): MessageProjectionInput {
  return {
    mode: 'history', platform: adapter, session,
    target: {
      conversation: { id: 'outer', kind: 'group', title: 'Outer' },
      peer: { _: 'peerChannel', channelId: 1 },
      title: 'Outer',
    },
    tlMessageId: 10,
    ordinal: 0,
    draft: {
      source: {
        id: 'outer-message', conversationId: 'outer', senderId: 'alice', timestamp: 1,
        content: { parts: [{ type: 'message-bundle', bundle }] },
      },
      chats: [],
    },
  }
}

describe('merged-forward projection', () => {
  it('owns only ephemeral bundle addressing and never needs a conversation/store record', async () => {
    const projection = makeMergedForwardProvider()
    const record = projection.remember(session.platformSessionId, bundle)
    const chatId = stableId(`merged-forward-chat:${bundle.id}`)

    expect(record.chatId).toBe(chatId)
    expect(projection.makeLink(record, 456)).toBe(`https://t.me/bridgebundle_${chatId}/456`)
    expect(projection.makePreview(record)).toMatchObject({
      webpage: {
        url: `https://t.me/bridgebundle_${chatId}`,
        title: bundle.title,
        description: bundle.preview,
      },
    })
    expect(projection.makeChat(record)).toMatchObject({
      _: 'chat', left: true, id: chatId, title: bundle.title,
    })
    expect(projection.resolveUsername(session.platformSessionId, `bridgebundle_${chatId}`)).toBe(record)
    expect(projection.resolveUsername(session.platformSessionId, `bridgechat_${chatId}`)).toBe(record)
    expect(projection.resolveUsername(session.platformSessionId, 'bridgebundle_999')).toBeUndefined()
  })

  it('projects bundle parts through the message waterfall and deduplicates complete bundle loading', async () => {
    const projection = makeMergedForwardProvider()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const load = vi.fn(async () => {
      await wait
      return [{
        id: 'latest', senderId: 'bob', timestamp: 100,
        content: { parts: [{ type: 'text' as const, text: 'latest' }] },
      }]
    })
    const adapter = platform(load)
    const first = input(adapter)
    const second = input(adapter)
    const render = (value: MessageProjectionInput) => projection.project(value, async () => ({
      message: {
        _: 'message', id: value.tlMessageId, peerId: value.target.peer,
        date: 1, message: '查看聊天记录', entities: [],
      },
      chats: value.draft.chats,
    }))
    const pending = [render(first), render(second)]
    release()
    const [one, two] = await Promise.all(pending)

    const chatId = stableId(`merged-forward-chat:${bundle.id}`)
    const messageId = stableId(`merged-forward-message:${bundle.id}:latest:0`)
    expect(load).toHaveBeenCalledOnce()
    for (const [result, value] of [[one, first], [two, second]] as const) {
      expect(value.draft.source.content.parts[0]).toMatchObject({
        type: 'text',
        entities: [{ type: 'text-link', url: `https://t.me/bridgebundle_${chatId}/${messageId}` }],
      })
      expect(value.draft.media).toMatchObject({ _: 'messageMediaWebPage' })
      expect(result.chats).toMatchObject([{ _: 'chat', left: true, id: chatId }])
    }
  })

  it('uses a generic preview when the platform supplies no detailed summary', () => {
    const projection = makeMergedForwardProvider()
    const record = projection.remember(session.platformSessionId, { ...bundle, preview: undefined })
    expect(projection.makePreview(record).webpage).toMatchObject({
      description: '点击查看合并转发消息',
    })
  })
})
