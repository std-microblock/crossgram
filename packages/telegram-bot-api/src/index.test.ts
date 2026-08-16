import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import { Bot } from 'node-telegram-bot-api'
import { defineModels, IMPlatformService, SystemPeerService, type IMEvent, type IMMessage, type PlatformSession } from '@mtproto-relay/bridge'
import * as telegramBotApi from './index.js'

const session: PlatformSession = { platformId: 'static', platformSessionId: 'bot-owner', userId: 'owner', credentials: {}, metadata: { firstName: 'Owner' } }
const platform = { capabilities: { history: false, send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 }, conversations: { groups: false, channels: false, subchannels: false } }, async subscribe() { return () => {} }, async sendMessage() { throw new Error('unused') } }

interface Fixture { ctx: Context, token: string, conversationId: string, events: IMEvent[], stop(): Promise<void> }
const fixtures: Fixture[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createFixture(path = ':memory:'): Promise<Fixture> {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: path === ':memory:' ? path : pathToFileURL(path).href })
  const server = ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await Promise.all([database, sqlite, server])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  await ctx.database.create('mtproto_platform_session', {
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
  })
  const api = ctx.plugin(telegramBotApi, { verifierSecret: 'test-verifier-secret' })
  await api
  const issued = await ctx.botRegistry.create({ platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }, 'Echo Bot', 'echo_bot')
  const fixture = { ctx, token: issued.token, conversationId: issued.bot.conversationId, events, async stop() {
    await api.dispose(); await server.dispose(); await sqlite.dispose(); await database.dispose()
  } }
  fixtures.push(fixture)
  return fixture
}

function endpoint(fixture: Fixture, method: string, token = fixture.token): URL { return new URL(`/bot${token}/${method}`, fixture.ctx.server.baseUrl) }

async function userMessage(fixture: Fixture, text: string): Promise<void> {
  const peer = await fixture.ctx.systemPeer.resolve(session, fixture.conversationId)
  if (!peer) throw new Error('missing bot peer')
  await fixture.ctx.systemPeer.emit(session, { type: 'message', conversation: peer.peer.conversation, message: {
    id: `user:${text}`, conversationId: peer.peer.id, senderId: session.userId, content: { parts: [{ type: 'text', text }] }, timestamp: 1_700_001_001, outgoing: true,
  } })
}

describe('dynamic Telegram Bot API', () => {
  it('verifies registry tokens before parsing a request body and never stores raw tokens', async () => {
    const fixture = await createFixture()
    const rejected = await fetch(endpoint(fixture, 'getMe', 'wrong-token'), { method: 'POST', body: 'x'.repeat(1_048_577) })
    expect(rejected.status).toBe(401)
    await expect((await fetch(endpoint(fixture, 'getMe'))).json()).resolves.toMatchObject({ ok: true, result: { username: 'echo_bot', is_bot: true } })
    const rows = await fixture.ctx.database.get('mtproto_bot_identity', {})
    expect(JSON.stringify(rows)).not.toContain(fixture.token)
    expect(rows[0].tokenVerifier).not.toBe(fixture.token)
  })

  it('isolates bot conversations and emits SDK replies into only the observed chat', async () => {
    const fixture = await createFixture()
    await userMessage(fixture, 'hello')
    await vi.waitFor(async () => {
      const response = await (await fetch(endpoint(fixture, 'getUpdates'))).json() as { result: Array<{ message: { chat: { id: number }, text: string } }> }
      expect(response.result).toHaveLength(1)
    })
    const updates = await (await fetch(endpoint(fixture, 'getUpdates'))).json() as { result: Array<{ message: { chat: { id: number }, text: string } }> }
    expect(updates.result).toHaveLength(1)
    expect(updates.result[0].message.text).toBe('hello')
    const sent = await (await fetch(endpoint(fixture, 'sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: updates.result[0].message.chat.id, text: 'reply' }) })).json()
    expect(sent).toMatchObject({ ok: true, result: { text: 'reply', from: { username: 'echo_bot' } } })
    expect(fixture.events.filter((event) => event.type === 'message').at(-1)).toMatchObject({ message: { conversationId: fixture.conversationId, outgoing: false, content: { parts: [{ text: 'reply' }] } } })
    const unavailable = await fetch(endpoint(fixture, 'sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 999_999, text: 'nope' }) })
    expect(unavailable.status).toBe(400)

    const second = await fixture.ctx.botRegistry.create({ platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }, 'Second Bot', 'second_bot')
    await fetch(endpoint(fixture, 'getMe', second.token))
    const secondPeer = await fixture.ctx.systemPeer.resolve(session, second.bot.conversationId)
    if (!secondPeer) throw new Error('missing second bot peer')
    await fixture.ctx.systemPeer.emit(session, { type: 'message', conversation: secondPeer.peer.conversation, message: {
      id: 'user:second', conversationId: secondPeer.peer.id, senderId: session.userId, content: { parts: [{ type: 'text', text: 'second only' }] }, timestamp: 1_700_001_002, outgoing: true,
    } })
    const firstBotAfterSecond = await (await fetch(endpoint(fixture, 'getUpdates?offset=2'))).json()
    expect(firstBotAfterSecond).toMatchObject({ ok: true, result: [] })
    await vi.waitFor(async () => {
      const updates = await (await fetch(endpoint(fixture, 'getUpdates', second.token))).json()
      expect(updates).toMatchObject({ ok: true, result: [{ message: { text: 'second only' } }] })
    })
  })

  it('does not let getUpdates hold reset or revoke behind its long-poll wait', async () => {
    const fixture = await createFixture()
    await fetch(endpoint(fixture, 'getMe'))
    const poll = fetch(endpoint(fixture, 'getUpdates?timeout=50')).then(async (response) => ({
      status: response.status, body: await response.json(),
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const reset = await fixture.ctx.botRegistry.reset({
      platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId,
    }, 'echo_bot')
    expect(reset).toBeDefined()
    const resetResult = await poll
    expect(resetResult).toMatchObject({ status: 401, body: { ok: false, error_code: 401 } })

    await fetch(endpoint(fixture, 'getMe', reset!.token))
    await userMessage(fixture, 'after reset')
    await vi.waitFor(async () => expect((await (await fetch(endpoint(fixture, 'getUpdates', reset!.token))).json()).result)
      .toMatchObject([{ message: { text: 'after reset' } }]))
    await fetch(endpoint(fixture, 'getUpdates?offset=2', reset!.token))
    const revokedPoll = fetch(endpoint(fixture, 'getUpdates?timeout=50', reset!.token)).then(async (response) => ({
      status: response.status, body: await response.json(),
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    await fixture.ctx.botRegistry.revoke({
      platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId,
    }, 'echo_bot')
    await expect(revokedPoll).resolves.toMatchObject({ status: 401, body: { ok: false, error_code: 401 } })
  }, 5_000)

  it('round trips local long polling through node-telegram-bot-api without api.telegram.org', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-bot-api-sdk-'))
    temporaryDirectories.push(directory)
    const fixture = await createFixture(join(directory, 'state.sqlite'))
    const localOrigin = new URL(fixture.ctx.server.baseUrl).origin
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
      if (url.origin !== localOrigin) throw new Error(`SDK attempted non-local access: ${url.href}`)
      return originalFetch(input, init)
    }))
    await fetch(endpoint(fixture, 'getMe'))
    const bot = new Bot(fixture.token, { apiRoot: fixture.ctx.server.baseUrl })
    bot.on('message', async (event) => { await event.reply(`echo: ${event.message!.text}`) })
    const polling = bot.startPolling()
    try {
      await userMessage(fixture, 'SDK')
      await vi.waitFor(() => expect(fixture.events.some((event) => event.type === 'message' && event.message.outgoing === false && (event.message.content.parts[0] as { text: string }).text === 'echo: SDK')).toBe(true), { timeout: 10_000, interval: 25 })
    } finally { bot.stop(); await polling }
  }, 15_000)
})
