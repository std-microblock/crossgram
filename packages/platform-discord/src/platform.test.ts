import { EventEmitter } from 'node:events'
import { Collection } from 'discord.js-selfbot-v13'
import { describe, expect, it, vi } from 'vitest'
import type { Client, Message, PlatformSession } from './test-types.js'
import type { IMEvent, IMMedia } from '@mtproto-relay/bridge'
import { DiscordPlatform, type DiscordMediaLocator } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'discord-user-session', platformId: 'discord', userId: '100',
  credentials: {}, metadata: {},
}

function user(id: string, name: string, bot = false) {
  return {
    id, username: name.toLowerCase(), globalName: name, displayName: name, discriminator: '0',
    avatar: `avatar-${id}`, bot,
    displayAvatarURL: () => `https://cdn.example/avatar/${id}.png`,
  }
}

function message(channel: any, options: Partial<any> = {}) {
  const author = options.author ?? user('200', 'Alice')
  const value = {
    id: options.id ?? '900000000000000001', channelId: channel.id, channel, author,
    member: options.member ?? null, nonce: options.nonce ?? null,
    content: options.content ?? 'hello', cleanContent: options.content ?? 'hello',
    attachments: options.attachments ?? new Collection(), stickers: options.stickers ?? new Collection(),
    reactions: options.reactions ?? { cache: new Collection() },
    mentions: options.mentions ?? {
      users: new Collection(), members: new Collection(), channels: new Collection(),
    },
    embeds: options.embeds ?? [], system: options.system ?? false, type: options.type ?? 'DEFAULT',
    createdTimestamp: options.createdTimestamp ?? 1_900_000_000_000,
    editedTimestamp: options.editedTimestamp ?? null, reference: options.reference ?? null,
    partial: false,
    fetch: vi.fn(), edit: vi.fn(), delete: vi.fn(), forward: vi.fn(), markRead: vi.fn(),
    react: vi.fn(),
  }
  value.fetch.mockResolvedValue(value)
  return value
}

function dmChannel(id = '800000000000000001') {
  const recipient = user('200', 'Alice')
  const channel: any = {
    id, type: 'DM', recipient, lastMessageId: null,
    messages: { cache: new Collection(), fetch: vi.fn(), delete: vi.fn() },
    send: vi.fn(),
  }
  return channel
}

function fakeClient(channels: any[] = []) {
  const emitter = new EventEmitter() as any
  emitter.user = user('100', 'Self')
  emitter.channels = {
    cache: new Collection(channels.map((channel) => [channel.id, channel])),
    fetch: vi.fn(async (id: string) => emitter.channels.cache.get(id) ?? null),
  }
  emitter.users = { fetch: vi.fn(async (id: string) => id === emitter.user.id ? emitter.user : user(id, `User ${id}`)) }
  emitter.relationships = { fetch: vi.fn(), friendCache: new Collection([['200', user('200', 'Alice')]]) }
  emitter.guilds = { cache: new Collection() }
  emitter.isReady = vi.fn(() => true)
  emitter.login = vi.fn(async () => 'token')
  emitter.destroy = vi.fn()
  emitter.refreshAttachmentURL = vi.fn(async (url: string) => [{ original: url, refreshed: `${url}?renewed=1` }])
  return emitter as Client
}

describe('DiscordPlatform userbot', () => {
  it('maps the normal user account without attempting a bot login', async () => {
    const client = fakeClient()
    const platform = new DiscordPlatform({ token: 'user-token' }, { client })

    await expect(platform.getAccount()).resolves.toMatchObject({
      credentials: {},
      user: {
        id: '100', firstName: 'Self', username: 'self',
        avatar: { kind: 'image', locator: { url: 'https://cdn.example/avatar/100.png' } },
      },
    })
    expect(client.login).not.toHaveBeenCalled()
  })

  it('logs in lazily with the configured user token and rejects a missing token', async () => {
    const ready = fakeClient()
    ;(ready as any).isReady.mockReturnValue(false)
    const platform = new DiscordPlatform({ token: 'normal-user-token' }, { client: ready })
    await platform.getAccount()
    expect(ready.login).toHaveBeenCalledWith('normal-user-token')

    const missing = fakeClient()
    ;(missing as any).isReady.mockReturnValue(false)
    await expect(new DiscordPlatform({}, { client: missing }).getAccount())
      .rejects.toThrow('user token is required')
  })

  it('paginates private dialogs and restores READY unread/read boundaries', async () => {
    const first = dmChannel('800000000000000001')
    const second = dmChannel('800000000000000002')
    const read = message(second, { id: '900000000000000001', content: 'read' })
    const unread = message(second, { id: '900000000000000002', content: 'unread' })
    second.lastMessageId = unread.id
    second.messages.fetch.mockImplementation(async (input: any) => {
      if (input === read.id) return read
      if (input === unread.id) return unread
      if (input?.after === read.id) return new Collection([[unread.id, unread]])
      return new Collection()
    })
    const client = fakeClient([first, second])
    const platform = new DiscordPlatform({ token: 'token' }, { client })
    ;(client as any).emit('raw', { t: 'READY', d: { read_state: { entries: [{
      id: second.id, last_message_id: read.id, mention_count: 1,
    }] } } })

    await expect(platform.getDialogs(session, { limit: 1 })).resolves.toMatchObject({
      total: 2, nextCursor: '1',
      dialogs: [{
        unreadCount: 1,
        lastMessage: { id: unread.id, content: { parts: [{ type: 'text', text: 'unread' }] } },
        readInboxMaxMessage: { id: read.id },
      }],
    })
    await expect(platform.getDialogs(session, { cursor: '1', limit: 1 })).resolves.toMatchObject({
      dialogs: [{ conversation: { id: first.id, kind: 'direct' } }],
    })
  })

  it('maps user mentions, channel links, custom emoji, attachments, replies, and sender aliases', async () => {
    const channel = dmChannel()
    const mentioned = user('300', 'Mentioned')
    const linked = dmChannel('800000000000000099')
    const attachment = {
      id: '700000000000000001', name: 'photo.png', contentType: 'image/png', size: 42,
      width: 10, height: 20, duration: null, url: 'https://cdn.example/photo.png',
    }
    const input = message(channel, {
      content: '<@300> see <#800000000000000099> <:party:600000000000000001>',
      member: { displayName: 'Guild Alice' },
      attachments: new Collection([[attachment.id, attachment]]),
      mentions: {
        users: new Collection([[mentioned.id, mentioned]]),
        members: new Collection([[mentioned.id, { displayName: 'Server Mention' }]]),
        channels: new Collection([[linked.id, linked]]),
      },
      reference: { messageId: '900000000000000000' },
    })
    channel.messages.fetch.mockResolvedValue(input)
    const platform = new DiscordPlatform({ token: 'token' }, { client: fakeClient([channel, linked]) })

    const mapped = await platform.getMessage(session, { id: channel.id }, input.id)
    expect(mapped).toMatchObject({
      sender: { firstName: 'Guild Alice' }, replyToId: '900000000000000000',
      content: { parts: [
        {
          type: 'text', text: '@Server Mention see #Alice :party:',
          entities: [
            { type: 'mention', offset: 0, userId: '300' },
            { type: 'conversation-link', conversation: { id: linked.id } },
            { type: 'custom-emoji', definition: { key: 'custom:600000000000000001' } },
          ],
        },
        { type: 'media', media: {
          kind: 'image', size: 42, width: 10, height: 20,
          locator: { url: 'https://cdn.example/photo.png', refreshable: true },
        } },
      ] },
    })
  })

  it('forwards history anchors and returns a stable next cursor', async () => {
    const channel = dmChannel()
    const older = message(channel, { id: '900000000000000001', content: 'older' })
    const newer = message(channel, { id: '900000000000000002', content: 'newer' })
    channel.messages.fetch.mockResolvedValue(new Collection([[older.id, older], [newer.id, newer]]))
    const platform = new DiscordPlatform({ token: 'token' }, { client: fakeClient([channel]) })

    await expect(platform.getHistory(session, { id: channel.id }, {
      before: { id: '900000000000000010', timestamp: 10 }, limit: 2,
    })).resolves.toMatchObject({
      messages: [{ id: newer.id }, { id: older.id }], nextCursor: older.id,
    })
    expect(channel.messages.fetch).toHaveBeenCalledWith({
      limit: 2, before: '900000000000000010', after: undefined,
    })
  })

  it('encodes Telegram mentions and uploads mixed media with progress', async () => {
    const channel = dmChannel()
    const sent = message(channel, { id: '900000000000000003', author: user('100', 'Self'), content: '<@300> hi' })
    channel.send.mockResolvedValue(sent)
    const platform = new DiscordPlatform({ token: 'token' }, { client: fakeClient([channel]) })
    const progress: number[] = []

    await platform.sendMessage(session, { id: channel.id }, { parts: [
      { type: 'text', text: '@Bob hi', entities: [{ type: 'mention', offset: 0, length: 4, userId: '300' }] },
      { type: 'media', media: {
        kind: 'file', name: 'note.txt', size: 5,
        source: { size: 5, async *stream() { yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4, 5]) } },
      } },
    ] }, { onProgress: (item) => { progress.push(item.transferredBytes) } })

    expect(progress).toEqual([2, 5])
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: '<@300> hi', allowedMentions: { parse: [], users: ['300'], repliedUser: false },
      files: [{ attachment: Buffer.from([1, 2, 3, 4, 5]), name: 'note.txt' }],
      nonce: expect.any(String),
    }))
  })

  it('publishes gateway message/edit/delete/read events and removes listeners on unsubscribe', async () => {
    const channel = dmChannel()
    const client = fakeClient([channel])
    const platform = new DiscordPlatform({ token: 'token' }, { client })
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    const created = message(channel)
    const edited = message(channel, { editedTimestamp: 1_900_000_001_000 })

    ;(client as any).emit('messageCreate', created)
    ;(client as any).emit('messageUpdate', created, edited)
    ;(client as any).emit('messageDelete', created)
    ;(client as any).emit('raw', { t: 'MESSAGE_ACK', d: { channel_id: channel.id, message_id: created.id } })
    await vi.waitFor(() => expect(events.map((event) => event.type)).toEqual([
      'message', 'message-edit', 'message-delete', 'read',
    ]))
    await unsubscribe()
    ;(client as any).emit('messageCreate', created)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toHaveLength(4)
    expect(client.listenerCount('messageCreate')).toBe(0)
    expect(client.listenerCount('threadUpdate')).toBe(0)
  })

  it('marks an exact Discord message read through the user-account API', async () => {
    const channel = dmChannel()
    const target = message(channel)
    channel.messages.fetch.mockResolvedValue(target)
    const platform = new DiscordPlatform({ token: 'token' }, { client: fakeClient([channel]) })

    await platform.markRead(session, { conversationId: channel.id, messageId: target.id })
    expect(target.markRead).toHaveBeenCalledOnce()
  })

  it('refreshes signed CDN URLs, honors ranges, chunks output, and reports progress', async () => {
    const client = fakeClient()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(
      new Uint8Array([3, 4, 5, 6]), { status: 206, headers: { 'content-range': 'bytes 2-5/8' } },
    ))
    const platform = new DiscordPlatform(
      { token: 'token', downloadChunkSize: 2 },
      { client, fetch: fetchMock as typeof fetch },
    )
    const media: IMMedia<DiscordMediaLocator> = {
      id: 'media', kind: 'file', locator: { url: 'https://cdn.example/file', refreshable: true },
    }
    const chunks: number[][] = []
    const progress: number[] = []
    for await (const chunk of platform.downloadMedia(session, media, {
      offset: 2, limit: 4, onProgress: (item) => { progress.push(item.transferredBytes) },
    })) chunks.push([...chunk])

    expect(client.refreshAttachmentURL).toHaveBeenCalledWith('https://cdn.example/file')
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/file?renewed=1', expect.objectContaining({
      headers: { Range: 'bytes=2-5' },
    }))
    expect(chunks).toEqual([[3, 4], [5, 6]])
    expect(progress).toEqual([2, 4])
  })
})
