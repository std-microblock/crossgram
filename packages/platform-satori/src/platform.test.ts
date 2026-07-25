import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '@satorijs/core'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { SatoriPlatform } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'session', platformId: 'satori', userId: 'self', credentials: {}, metadata: {},
}

function makeBot(): Bot {
  return {
    sid: 'mock:self', selfId: 'self', userId: 'self', platform: 'mock',
    user: { id: 'self', name: 'Mock Account' },
    features: [
      'message.create', 'message.list', 'message.get', 'message.update', 'message.delete',
      'guild.list', 'channel.list', 'friend.list', 'guild.member.list', 'user.get',
    ],
    getLogin: vi.fn(async () => ({
      sn: 1, adapter: 'mock', platform: 'mock', status: 1, features: [],
      user: { id: 'self', name: 'Mock Account' },
    })),
    getGuildList: vi.fn(async () => ({
      data: [{ id: 'guild', name: 'Guild' }], next: undefined,
    })),
    getChannelList: vi.fn(async () => ({
      data: [
        { id: 'general', type: 0, name: 'General' },
        { id: 'voice', type: 3, name: 'Voice' },
      ],
    })),
    getFriendList: vi.fn(async () => ({ data: [{ user: { id: 'alice', name: 'Alice' } }] })),
    getMessageList: vi.fn(async () => ({
      data: [{ id: 'm1', channel: { id: 'general', type: 0 }, user: { id: 'alice' }, content: 'hello' }],
      next: 'history-next',
    })),
    getMessage: vi.fn(async (channelId: string, id: string) => ({
      id, channel: { id: channelId, type: 0 }, user: { id: 'alice' }, content: 'one',
    })),
    createMessage: vi.fn(async (channelId: string) => ([{
      id: 'sent', channel: { id: channelId, type: 0 }, user: { id: 'self' }, content: 'sent',
    }])),
    createUpload: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(),
  } as unknown as Bot
}

function context(bot: Bot) {
  return {
    bots: [bot],
    logger: () => ({ warn: vi.fn() }),
    on: vi.fn(() => vi.fn()),
    http: { file: vi.fn() },
  } as never
}

describe('SatoriPlatform', () => {
  it('projects one imported bot into account, dialogs, contacts, history, and actions', async () => {
    const bot = makeBot()
    const platform = new SatoriPlatform(context(bot), 'mock:self')

    await expect(platform.getAccount()).resolves.toMatchObject({
      user: { id: 'self', firstName: 'Mock Account' },
      credentials: { satoriBotSid: 'mock:self' },
    })
    expect(platform.capabilities).toMatchObject({
      history: true,
      messageActions: { delete: { own: { supported: true } }, edit: { mode: 'native' } },
    })
    await expect(platform.getDialogs(session)).resolves.toMatchObject({
      dialogs: [{ conversation: { id: 'general', kind: 'channel', title: 'General', spaceId: 'guild' } }],
    })
    await expect(platform.getContacts(session)).resolves.toMatchObject({
      users: [{ id: 'alice', firstName: 'Alice' }],
    })
    await expect(platform.getHistory(session, { id: 'general' }, { limit: 20 })).resolves.toMatchObject({
      messages: [{ id: 'm1', conversationId: 'general', senderId: 'alice' }],
      nextCursor: 'history-next',
    })
    await expect(platform.sendMessage(session, { id: 'general' }, {
      parts: [{ type: 'text', text: 'sent' }],
    })).resolves.toMatchObject({ id: 'sent', outgoing: true, sourceIds: ['sent'] })
    await platform.editMessage(session, {
      conversationId: 'general', messageId: 'm1', targetId: 'm1',
    }, { parts: [{ type: 'text', text: 'edited' }] })
    await platform.deleteMessages(session, { id: 'general' }, ['m1', 'm2'], { forEveryone: true })
    expect(bot.editMessage).toHaveBeenCalledOnce()
    expect(bot.deleteMessage).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit SID when more than one imported bot exists', () => {
    const first = makeBot()
    const second = { ...makeBot(), sid: 'mock:second' } as Bot
    const platform = new SatoriPlatform(context(first))
    ;(platform as any).ctx.bots.push(second)
    expect(() => platform.requireBot()).toThrow(/exactly one bot.*mock:self, mock:second/)
  })
})
