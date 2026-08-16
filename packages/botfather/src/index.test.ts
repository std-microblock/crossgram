import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels, IMPlatformService, SystemPeerService, type IMEvent, type PlatformSession } from '@mtproto-relay/bridge'
import * as botfather from './index.js'

const owner: PlatformSession = { platformId: 'static', platformSessionId: 'owner-session', userId: 'owner', credentials: {}, metadata: {} }
const other: PlatformSession = { ...owner, platformSessionId: 'other-session', userId: 'other' }
const platform = { capabilities: { history: false, send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 }, conversations: { groups: false, channels: false, subchannels: false } }, async subscribe() { return () => {} }, async sendMessage() { throw new Error('unused') } }
const fixtures: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(fixtures.splice(0).map((stop) => stop())))

async function createFixture() {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: ':memory:' })
  await Promise.all([database, sqlite])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  await ctx.database.create('mtproto_platform_session', {
    id: owner.platformSessionId, platformId: owner.platformId, userId: owner.userId,
    credentials: {}, metadata: {}, active: true, createdAt: new Date(),
  })
  const imPlatform = new IMPlatformService(ctx)
  const peers = new SystemPeerService(ctx)
  imPlatform.activateSession('static', platform, owner)
  const events: IMEvent[] = []
  const transientTexts: string[] = []
  const transientOptions: Array<{ nonCapturable?: boolean } | undefined> = []
  peers.attach(
    async (_session, event) => { events.push(event) },
    async (_session, _conversation, event, options) => {
      transientTexts.push((event.content.parts[0] as { text: string }).text)
      transientOptions.push(options)
    },
  )
  botfather.apply(ctx, { verifierSecret: 'stable-test-secret' })
  await peers.bootstrap(owner)
  fixtures.push(async () => { await sqlite.dispose(); await database.dispose() })
  return { ctx, events, peers, transientTexts, transientOptions }
}

function userMessage(text: string) {
  return { id: `user:${text}`, conversationId: botfather.BOT_FATHER_CONVERSATION_ID, senderId: owner.userId, content: { parts: [{ type: 'text' as const, text }] }, timestamp: 1_700_000_000, outgoing: true }
}

describe('BotRegistry and BotFather system peer', () => {
  it('stores only an HMAC verifier and rejects invalid tokens', async () => {
    const { ctx } = await createFixture()
    const issued = await ctx.botRegistry.create(owner, 'First bot', 'first_bot')
    expect(issued.token).toMatch(/^\d+:[A-Za-z0-9_-]{43}$/u)
    expect(await ctx.botRegistry.verifyToken(issued.token)).toMatchObject({ username: 'first_bot' })
    expect(await ctx.botRegistry.verifyToken('999:wrong')).toBeUndefined()
    const [row] = await ctx.database.get('mtproto_bot_identity', { id: issued.bot.id })
    expect(JSON.stringify(row)).not.toContain(issued.token)
    expect(row.tokenVerifier).not.toBe(issued.token)
  })

  it('persists reset and revoke state and prevents cross-session ownership', async () => {
    const { ctx } = await createFixture()
    const issued = await ctx.botRegistry.create(owner, 'First bot', 'first_bot')
    const replacement = await ctx.botRegistry.reset(owner, 'FIRST_BOT')
    expect(replacement).toBeDefined()
    expect(await ctx.botRegistry.verifyToken(issued.token)).toBeUndefined()
    expect(await ctx.botRegistry.verifyToken(replacement!.token)).toMatchObject({ id: issued.bot.id })
    expect(await ctx.botRegistry.reset(other, 'first_bot')).toBeUndefined()
    expect(await ctx.botRegistry.revoke(other, 'first_bot')).toBeUndefined()
    await ctx.botRegistry.revoke(owner, 'first_bot')
    expect(await ctx.botRegistry.verifyToken(replacement!.token)).toBeUndefined()
  })

  it('rejects a bot after its retained platform session is rebound to another user', async () => {
    const { ctx } = await createFixture()
    const issued = await ctx.botRegistry.create(owner, 'Rebound bot', 'rebound_bot')
    await ctx.database.set('mtproto_platform_session', { id: owner.platformSessionId }, { userId: 'replacement' })
    expect(await ctx.botRegistry.verifyToken(issued.token)).toBeUndefined()
    expect(await ctx.botRegistry.byConversation(owner.platformSessionId, issued.bot.conversationId)).toBeUndefined()
    expect(await ctx.botRegistry.reset(owner, 'rebound_bot')).toBeUndefined()
  })

  it('bootstraps BotFather and runs the per-session newbot flow without persisting a token reply', async () => {
    const { ctx, events, peers, transientTexts, transientOptions } = await createFixture()
    expect(events.some((event) => event.type === 'message' && event.conversation.id === botfather.BOT_FATHER_CONVERSATION_ID)).toBe(true)
    const father = await peers.resolve(owner, botfather.BOT_FATHER_CONVERSATION_ID)
    if (!father) throw new Error('missing BotFather peer')
    expect(father.peer.conversation.metadata).toMatchObject({ bridgeOwned: true, localOnly: true, bot: true })
    await peers.receive(owner, father, userMessage('/newbot'))
    await peers.receive(owner, father, userMessage('My test bot'))
    await peers.receive(owner, father, userMessage('my_test_bot'))
    expect(await ctx.botRegistry.list(owner)).toMatchObject([{ username: 'my_test_bot' }])
    expect(await ctx.botRegistry.list(other)).toEqual([])
    await peers.receive(owner, father, userMessage('/mybots'))
    await peers.receive(owner, father, userMessage('/token my_test_bot'))
    await peers.receive(owner, father, userMessage('/revoke my_test_bot'))
    await peers.receive(owner, father, userMessage('/cancel'))
    await peers.receive(owner, father, userMessage('/newbot'))
    await peers.receive(owner, father, userMessage('Duplicate'))
    await peers.receive(owner, father, userMessage('my_test_bot'))
    expect(await ctx.botRegistry.list(owner)).toHaveLength(1)
    const persistedText = events.filter((event): event is Extract<IMEvent, { type: 'message' }> => event.type === 'message')
      .map((event) => (event.message.content.parts[0] as { text?: string }).text ?? '').join('\n')
    expect(persistedText).toContain('Token generated')
    expect(persistedText).toContain('@my_test_bot')
    expect(persistedText).toContain('Token reset')
    expect(persistedText).toContain('revoked')
    expect(persistedText).toContain('Cancelled')
    expect(persistedText).toContain('already taken')
    expect(persistedText).not.toMatch(/\d+:[A-Za-z0-9_-]{43}/u)
    expect(transientTexts.join('\n')).toMatch(/\d+:[A-Za-z0-9_-]{43}/u)
    expect(transientOptions).toEqual(expect.arrayContaining([{ nonCapturable: true }]))
  })
})
