import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import { defineModels, IMPlatformService, SystemPeerService, type IMEvent, type PlatformSession } from '@mtproto-relay/bridge'
import * as botfather from '@mtproto-relay/botfather'

const postPublicWebhook = vi.fn()
vi.mock('./webhook.js', () => ({ postPublicWebhook }))

const telegramBotApi = await import('./index.js')
const session: PlatformSession = { platformId: 'static', platformSessionId: 'webhook-owner', userId: 'owner', credentials: {}, metadata: { firstName: 'Owner' } }
const platform = { capabilities: { history: false, send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 }, conversations: { groups: false, channels: false, subchannels: false } }, async subscribe() { return () => {} }, async sendMessage() { throw new Error('unused') } }

interface Fixture { ctx: Context, token: string, conversationId: string, events: IMEvent[], stop(): Promise<void> }
const fixtures: Fixture[] = []

afterEach(async () => { postPublicWebhook.mockReset(); await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop())) })

async function createFixture(): Promise<Fixture> {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: ':memory:' })
  const server = ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await Promise.all([database, sqlite, server])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  await ctx.database.create('mtproto_platform_session', { id: session.platformSessionId, platformId: session.platformId, userId: session.userId, credentials: {}, metadata: {}, active: true, createdAt: new Date() })
  const imPlatform = new IMPlatformService(ctx)
  const peers = new SystemPeerService(ctx)
  imPlatform.activateSession('static', platform, session)
  const events: IMEvent[] = []
  peers.attach(async (eventSession, event) => {
    events.push(event)
    if (event.type === 'message') imPlatform.emitCommittedEvent(eventSession, { event, result: {} as never })
  })
  const father = ctx.plugin(botfather, { verifierSecret: 'test-verifier-secret' })
  await father
  const issued = await ctx.botRegistry.create({ platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }, 'Webhook Bot', 'webhook_bot')
  const api = ctx.plugin(telegramBotApi, {})
  await api
  const fixture = { ctx, token: issued.token, conversationId: issued.bot.conversationId, events, async stop() {
    await api.dispose(); await father.dispose(); await server.dispose(); await sqlite.dispose(); await database.dispose()
  } }
  fixtures.push(fixture)
  return fixture
}

function endpoint(fixture: Fixture, method: string): URL { return new URL(`/bot${fixture.token}/${method}`, fixture.ctx.server.baseUrl) }

async function userMessage(fixture: Fixture, text: string): Promise<void> {
  const peer = await fixture.ctx.systemPeer.resolve(session, fixture.conversationId)
  if (!peer) throw new Error('missing bot peer')
  await fixture.ctx.systemPeer.emit(session, { type: 'message', conversation: peer.peer.conversation, message: {
    id: `webhook:${text}`, conversationId: peer.peer.id, senderId: session.userId, content: { parts: [{ type: 'text', text }] }, timestamp: 1_700_001_001, outgoing: true,
  } })
}

async function api(fixture: Fixture, method: string, body?: Record<string, unknown>): Promise<{ result: Record<string, unknown> }> {
  const response = await fetch(endpoint(fixture, method), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  return response.json() as Promise<{ result: Record<string, unknown> }>
}

describe('Telegram Bot API webhook delivery', () => {
  it('keeps failed updates, retries timeouts, sends secrets, and serializes delivery', async () => {
    const fixture = await createFixture()
    expect(await api(fixture, 'setWebhook', { url: 'https://hook.example/updates', secret_token: 'secret-value' })).toMatchObject({ result: true })
    expect((await api(fixture, 'getWebhookInfo')).result).toMatchObject({ url: 'https://hook.example/updates' })
    let releaseFirst: (() => void) | undefined
    postPublicWebhook
      .mockRejectedValueOnce(new Error('webhook request timed out'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce(undefined)

    await userMessage(fixture, 'one')
    await vi.waitFor(async () => expect(await fixture.ctx.database.get('mtproto_bot_api_update', {})).toHaveLength(1))
    await vi.waitFor(() => expect(postPublicWebhook).toHaveBeenCalledTimes(1))
    expect(postPublicWebhook).toHaveBeenLastCalledWith(new URL('https://hook.example/updates'), expect.any(String), 'secret-value')
    await vi.waitFor(async () => expect((await api(fixture, 'getWebhookInfo')).result).toMatchObject({ pending_update_count: 1, last_error_message: 'webhook request timed out' }))

    await new Promise((resolve) => setTimeout(resolve, 1_050))
    await vi.waitFor(() => expect(postPublicWebhook).toHaveBeenCalledTimes(2))
    await userMessage(fixture, 'two')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(postPublicWebhook).toHaveBeenCalledTimes(2)
    releaseFirst!()
    await vi.waitFor(() => expect(postPublicWebhook).toHaveBeenCalledTimes(3))
    expect(JSON.parse(postPublicWebhook.mock.calls[1][1] as string)).toMatchObject({ update_id: 1, message: { text: 'one' } })
    expect(JSON.parse(postPublicWebhook.mock.calls[2][1] as string)).toMatchObject({ update_id: 2, message: { text: 'two' } })
    await vi.waitFor(async () => expect((await api(fixture, 'getWebhookInfo')).result).toMatchObject({ pending_update_count: 0 }))
  }, 10_000)

  it('pauses pending webhook delivery for an inactive owner and resumes after activation', async () => {
    const fixture = await createFixture()
    postPublicWebhook.mockResolvedValue(undefined)
    expect(await api(fixture, 'setWebhook', { url: 'https://hook.example/updates' })).toMatchObject({ result: true })
    const originalGet = fixture.ctx.botRegistry.get.bind(fixture.ctx.botRegistry)
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(fixture.ctx.botRegistry, 'get').mockImplementation(async (id) => {
      if (++calls === 2) await blocked
      return originalGet(id)
    })

    await userMessage(fixture, 'paused')
    await vi.waitFor(async () => expect(await fixture.ctx.database.get('mtproto_bot_api_update', {})).toHaveLength(1))
    await fixture.ctx.database.set('mtproto_platform_session', { id: session.platformSessionId }, { active: false })
    release()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(postPublicWebhook).not.toHaveBeenCalled()
    expect(await fixture.ctx.database.get('mtproto_bot_api_update', {})).toHaveLength(1)

    await fixture.ctx.database.set('mtproto_platform_session', { id: session.platformSessionId }, { active: true })
    fixture.ctx.imPlatform.deactivateSession('static', platform)
    fixture.ctx.imPlatform.activateSession('static', platform, session)
    await vi.waitFor(() => expect(postPublicWebhook).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => expect(await fixture.ctx.database.get('mtproto_bot_api_update', {})).toHaveLength(0))
  })
})
