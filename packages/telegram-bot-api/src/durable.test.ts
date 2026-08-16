import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import { defineModels, IMPlatformService, SystemPeerService, type IMEvent, type PlatformSession } from '@mtproto-relay/bridge'
import * as botfather from '@mtproto-relay/botfather'

const postPublicWebhook = vi.fn().mockRejectedValue(new Error('offline'))
vi.mock('./webhook.js', () => ({ postPublicWebhook }))

const telegramBotApi = await import('./index.js')

const session: PlatformSession = { platformId: 'static', platformSessionId: 'durable-owner', userId: 'owner', credentials: {}, metadata: { firstName: 'Owner' } }
const platform = { capabilities: { history: false, send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 }, conversations: { groups: false, channels: false, subchannels: false } }, async subscribe() { return () => {} }, async sendMessage() { throw new Error('unused') } }
const directories: string[] = []

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

interface Fixture {
  ctx: Context
  token: string
  conversationId: string
  events: IMEvent[]
  stop(): Promise<void>
}

async function start(path: string, token?: string, conversationId?: string): Promise<Fixture> {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: pathToFileURL(path).href })
  const server = ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await Promise.all([database, sqlite, server])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const [storedSession] = await ctx.database.get('mtproto_platform_session', { id: session.platformSessionId })
  if (!storedSession) await ctx.database.create('mtproto_platform_session', {
    id: session.platformSessionId, platformId: session.platformId, userId: session.userId,
    credentials: {}, metadata: {}, active: true, createdAt: new Date(),
  })
  const imPlatform = new IMPlatformService(ctx)
  const peers = new SystemPeerService(ctx)
  imPlatform.activateSession('static', platform, session)
  const events: IMEvent[] = []
  peers.attach(async (eventSession, event) => {
    events.push(event)
    if (event.type === 'message') imPlatform.emitCommittedEvent(eventSession, { event, result: {} as never })
  }, async () => {})
  const father = ctx.plugin(botfather, { verifierSecret: 'durable-test-verifier-secret' })
  await father
  let issued: botfather.IssuedBot | undefined
  if (!token) issued = await ctx.botRegistry.create({ platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }, 'Durable Echo', 'durable_echo')
  const api = ctx.plugin(telegramBotApi, {})
  await api
  const bot = issued?.bot ?? (await ctx.botRegistry.verifyToken(token!))
  if (!bot) throw new Error('durable bot did not restore')
  return {
    ctx, token: issued?.token ?? token!, conversationId: issued?.bot.conversationId ?? conversationId ?? bot.conversationId, events,
    async stop() { await api.dispose(); await father.dispose(); await server.dispose(); await sqlite.dispose(); await database.dispose() },
  }
}

function endpoint(fixture: Fixture, method: string, token = fixture.token): URL { return new URL(`/bot${token}/${method}`, fixture.ctx.server.baseUrl) }

async function call(fixture: Fixture, method: string, body?: Record<string, unknown>, token = fixture.token): Promise<Record<string, any>> {
  const response = await fetch(endpoint(fixture, method, token), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  return response.json() as Promise<Record<string, any>>
}

async function incoming(fixture: Fixture, id: string, text: string): Promise<void> {
  const peer = await fixture.ctx.systemPeer.resolve(session, fixture.conversationId)
  if (!peer) throw new Error('missing durable bot peer')
  await fixture.ctx.systemPeer.emit(session, { type: 'message', conversation: peer.peer.conversation, message: {
    id, conversationId: peer.peer.id, senderId: session.userId, content: { parts: [{ type: 'text', text }] }, timestamp: 1_700_001_001, outgoing: true,
  } })
}

describe('durable Telegram Bot API state', () => {
  it('restores token, unacknowledged updates, webhook configuration, chats, and canonical message IDs from file SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-bot-api-durable-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    let fixture = await start(path)
    await incoming(fixture, 'canonical:one', 'one')
    await vi.waitFor(async () => expect((await call(fixture, 'getUpdates')).result).toHaveLength(1))
    const update = (await call(fixture, 'getUpdates')).result[0]
    const updateId = update.update_id
    const chatId = update.message.chat.id
    const incomingMessageId = update.message.message_id
    expect(await call(fixture, 'setWebhook', { url: 'https://hook.example/updates', allowed_updates: ['message'] })).toMatchObject({ ok: true })
    await vi.waitFor(async () => expect(await call(fixture, 'getWebhookInfo')).toMatchObject({ result: { pending_update_count: 1, last_error_message: 'offline' } }))
    await fixture.stop()

    fixture = await start(path, fixture.token, fixture.conversationId)
    expect(await call(fixture, 'getWebhookInfo')).toMatchObject({ ok: true, result: { url: 'https://hook.example/updates', pending_update_count: 1, last_error_message: 'offline', allowed_updates: ['message'] } })
    expect(await call(fixture, 'getUpdates')).toMatchObject({ ok: false, error_code: 409 })
    await call(fixture, 'deleteWebhook')
    expect(await call(fixture, `getUpdates?offset=${updateId + 1}`)).toMatchObject({ ok: true, result: [] })
    await incoming(fixture, 'canonical:two', 'two')
    await vi.waitFor(async () => expect((await call(fixture, 'getUpdates')).result).toHaveLength(1))
    const restored = (await call(fixture, 'getUpdates')).result[0]
    expect(restored.update_id).toBeGreaterThan(updateId)
    expect(restored.message.message_id).toBeGreaterThan(incomingMessageId)
    const sent = await call(fixture, 'sendMessage', { chat_id: chatId, text: 'after restart' })
    expect(sent).toMatchObject({ ok: true, result: { chat: { id: chatId } } })
    expect(sent.result.message_id).toBeGreaterThan(restored.message.message_id)
    expect(await call(fixture, 'sendMessage', { chat_id: 999_999, text: 'nope' })).toMatchObject({ ok: false, error_code: 400 })
    const raw = JSON.stringify(await fixture.ctx.database.get('mtproto_bot_api_update', {}))
    expect(raw).not.toContain(fixture.token)
    await fixture.stop()
  }, 20_000)

  it('isolates durable queues, chats, and projections across bots and clears old token generations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-bot-api-generations-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    const fixture = await start(path)
    const second = await fixture.ctx.botRegistry.create({ platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }, 'Second Durable', 'second_durable')
    expect(await call(fixture, 'getMe', undefined, second.token)).toMatchObject({ ok: true, result: { username: 'second_durable' } })
    await incoming(fixture, 'first:one', 'first')
    await vi.waitFor(async () => expect(await fixture.ctx.database.get('mtproto_bot_api_update', { botId: fixture.token.split(':', 1)[0] })).toHaveLength(1))
    expect(await fixture.ctx.botRegistry.byConversation(session.platformSessionId, second.bot.conversationId)).toMatchObject({ id: second.bot.id })
    const secondPeer = await fixture.ctx.systemPeer.resolve(session, second.bot.conversationId)
    if (!secondPeer) throw new Error('missing second durable peer')
    expect(secondPeer.peer.id).toBe(second.bot.conversationId)
    await fixture.ctx.systemPeer.emit(session, { type: 'message', conversation: secondPeer.peer.conversation, message: {
      id: 'second:one', conversationId: secondPeer.peer.id, senderId: session.userId, content: { parts: [{ type: 'text', text: 'second' }] }, timestamp: 1_700_001_002, outgoing: true,
    } })
    await vi.waitFor(async () => {
      expect((await call(fixture, 'getUpdates')).result).toHaveLength(1)
      const secondResult = (await call(fixture, 'getUpdates', undefined, second.token)).result
      expect(secondResult, JSON.stringify(await fixture.ctx.database.get('mtproto_bot_api_update', {}))).toHaveLength(1)
    })
    const first = (await call(fixture, 'getUpdates')).result[0]
    const secondUpdate = (await call(fixture, 'getUpdates', undefined, second.token)).result[0]
    expect(first.message.chat.id).toBe(secondUpdate.message.chat.id)
    expect(first.message.message_id).toBe(secondUpdate.message.message_id)
    const replacement = await fixture.ctx.botRegistry.reset({ platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }, 'durable_echo')
    expect(replacement).toBeDefined()
    expect(await call(fixture, 'getUpdates', undefined, fixture.token)).toMatchObject({ ok: false, error_code: 401 })
    expect(await call(fixture, 'getUpdates', undefined, replacement!.token)).toMatchObject({ ok: true, result: [] })
    await fixture.stop()
  }, 20_000)
})
