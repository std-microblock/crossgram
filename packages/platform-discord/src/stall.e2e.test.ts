import { EventEmitter } from 'node:events'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { Collection, type Client } from 'discord.js-selfbot-v13'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { MessageStore, type PlatformSession } from '@mtproto-relay/bridge'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { defineModels } from '../../bridge/src/models.js'
import { DiscordPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'discord-stall-e2e', platformId: 'discord', userId: '100',
  credentials: {}, metadata: { firstName: 'Self' },
}

const disposals: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore(): Promise<MessageStore> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return new MessageStore(ctx.database)
}

function user(id: string, name: string) {
  return {
    id, username: name.toLowerCase(), globalName: name, displayName: name, discriminator: '0',
    avatar: null, bot: false, displayAvatarURL: () => `https://cdn.example/${id}.png`,
  }
}

function discordMessage(channel: any, id: string, author: any, content: string) {
  return {
    id, channelId: channel.id, channel, author, member: null, nonce: null,
    content, cleanContent: content, attachments: new Collection(), stickers: new Collection(),
    reactions: { cache: new Collection() },
    mentions: { users: new Collection(), members: new Collection(), channels: new Collection() },
    embeds: [], system: false, type: 'DEFAULT', createdTimestamp: Date.now(),
    editedTimestamp: null, reference: null, partial: false,
  }
}

function dialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }
}

describe('Discord stall regression E2E', () => {
  it('projects a corrupt Discord cache through the bridge under replayed concurrent dialog RPCs', async () => {
    const self = user('100', 'Self')
    const alice = user('200', 'Alice')
    const channel: any = {
      id: '800000000000000001', type: 'DM', recipient: alice,
      lastMessageId: '900000000000000003',
      messages: { cache: new Collection(), fetch: vi.fn() },
    }
    const read = discordMessage(channel, '900000000000000001', alice, 'read')
    const authorless = discordMessage(channel, '900000000000000002', null, 'partial')
    const unread = discordMessage(channel, '900000000000000003', alice, 'unread')
    channel.messages.cache.set(read.id, read)
    channel.messages.cache.set(authorless.id, authorless)
    channel.messages.cache.set('900000000000000004', null)

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    channel.messages.fetch.mockImplementation(async () => {
      await gate
      return new Collection([
        [authorless.id, authorless], ['900000000000000004', null], [unread.id, unread],
      ])
    })

    const client = new EventEmitter() as any
    client.user = self
    client.channels = {
      cache: new Collection([[channel.id, channel]]),
      fetch: vi.fn(async () => channel),
    }
    client.users = { fetch: vi.fn(async (id: string) => id === self.id ? self : alice) }
    client.relationships = { fetch: vi.fn(), friendCache: new Collection() }
    client.guilds = { cache: new Collection() }
    client.isReady = vi.fn(() => true)
    client.login = vi.fn()
    client.destroy = vi.fn()
    client.refreshAttachmentURL = vi.fn()

    const platform = new DiscordPlatform({ token: 'token' }, { client: client as Client })
    ;(client as any).emit('raw', { t: 'READY', d: { read_state: { entries: [{
      id: channel.id, last_message_id: read.id, mention_count: 0,
    }] } } })
    const rpc = new DialogRpc(platform, session, await createStore())

    const requests = Array.from({ length: 24 }, () => rpc.getDialogs(dialogsRequest()))
    await vi.waitFor(() => expect(channel.messages.fetch).toHaveBeenCalledOnce())
    release()
    const results = await Promise.race([
      Promise.all(requests),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dialog replay timed out')), 5_000)),
    ])

    expect(results).toHaveLength(24)
    for (const result of results) {
      expect(result._).not.toBe('messages.dialogsNotModified')
      const dialogs = result as tl.messages.RawDialogs
      expect(dialogs.dialogs).toHaveLength(1)
      expect(dialogs.messages).toMatchObject([
        { _: 'message', message: 'unread' },
      ])
    }
    expect(channel.messages.fetch).toHaveBeenCalledOnce()
    platform.stop()
  })
})
