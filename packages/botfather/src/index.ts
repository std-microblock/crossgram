import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Service, type Context } from 'cordis'
import z from 'schemastery'
import {
  type IMConversation, type IMMessage, type PlatformSession, type SystemPeer, type SystemPeerProvider, SystemPeerService,
} from '@mtproto-relay/bridge'
import { defineBotModels, type BotIdentityRow } from './models.js'

export interface Config {
  verifierSecret: string
}

export const Config = z.object({
  verifierSecret: z.string().role('secret').required(),
})

export const name = 'botfather'
export const inject = ['database', 'model', 'systemPeer']

export interface BotIdentity {
  id: string
  ownerPlatformId: string
  ownerPlatformSessionId: string
  ownerUserId: string
  name: string
  username: string
  conversationId: string
  tokenVersion: number
  enabled: boolean
  revokedAt?: Date
}

export interface IssuedBot {
  bot: BotIdentity
  token: string
}

export class BotUsernameTakenError extends Error {
  constructor() { super('BOT_USERNAME_TAKEN') }
}

interface Owner {
  platformId: string
  platformSessionId: string
  userId: string
}

/** Durable token verifier and identity registry. Raw Bot API tokens never leave the caller's stack. */
export class BotRegistry extends Service {
  private readonly _listeners = new Set<(bot: BotIdentity) => void>()
  private readonly _tokenLocks = new Map<string, Promise<void>>()

  constructor(ctx: Context, private readonly _verifierSecret: string) {
    super(ctx, 'botRegistry')
  }

  async create(owner: Owner, name: string, username: string): Promise<IssuedBot> {
    const usernameNormalized = normalizeUsername(username)
    if (!validUsername(username)) throw new Error('BOT_USERNAME_INVALID')
    const [existingUsername] = await this.ctx.database.get('mtproto_bot_identity', { usernameNormalized })
    if (existingUsername) throw new BotUsernameTakenError()
    const now = new Date()
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = String(randomBotId())
      const token = issueToken(id)
      const row: BotIdentityRow = {
        id,
        ownerPlatformId: owner.platformId,
        ownerPlatformSessionId: owner.platformSessionId,
        ownerUserId: owner.userId,
        name,
        username,
        usernameNormalized,
        conversationId: botConversationId(id),
        tokenVersion: 1,
        tokenVerifier: this._verifier(token, 1),
        enabled: true,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      try {
        await this.ctx.database.create('mtproto_bot_identity', row)
        const bot = publicBot(row)
        this._changed(bot)
        return { bot, token }
      } catch (error) {
        if (!isUniqueError(error)) throw error
        const [taken] = await this.ctx.database.get('mtproto_bot_identity', { usernameNormalized })
        if (taken) throw new BotUsernameTakenError()
        // The username is still available, so this was a random numeric bot-ID collision.
      }
    }
    throw new Error('BOT_ID_ALLOCATION_FAILED')
  }

  async verifyToken(token: string): Promise<BotIdentity | undefined> {
    const id = tokenId(token)
    if (!id) return
    const [row] = await this.ctx.database.get('mtproto_bot_identity', { id })
    if (!row || !row.enabled || row.revokedAt || !(await this._ownerSessionActive(row))) return
    const expected = Buffer.from(row.tokenVerifier, 'base64url')
    const actual = Buffer.from(this._verifier(token, row.tokenVersion), 'base64url')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return
    return publicBot(row)
  }

  /** Atomically validate a raw token and snapshot its current version. */
  async authenticate(token: string): Promise<BotIdentity | undefined> {
    const id = tokenId(token)
    if (!id) return
    return this._withTokenLock(id, () => this.verifyToken(token))
  }

  /** Serialize token verification with reset/revoke and an immediate side effect. */
  async withToken<T>(token: string, callback: (bot: BotIdentity) => Promise<T>): Promise<T | undefined> {
    const id = tokenId(token)
    if (!id) return
    return this._withTokenLock(id, async () => {
      const bot = await this.verifyToken(token)
      return bot ? callback(bot) : undefined
    })
  }

  async get(id: string): Promise<BotIdentity | undefined> {
    const [row] = await this.ctx.database.get('mtproto_bot_identity', { id })
    return row?.enabled && !row.revokedAt && await this._ownerSessionActive(row) ? publicBot(row) : undefined
  }

  async byConversation(platformSessionId: string, conversationId: string): Promise<BotIdentity | undefined> {
    const [row] = await this.ctx.database.get('mtproto_bot_identity', {
      ownerPlatformSessionId: platformSessionId,
      conversationId,
    })
    return row && await this._ownerSessionActive(row) ? publicBot(row) : undefined
  }

  async list(owner: Owner): Promise<BotIdentity[]> {
    const rows = await this.ctx.database.select('mtproto_bot_identity', {
      ownerPlatformId: owner.platformId,
      ownerPlatformSessionId: owner.platformSessionId,
      ownerUserId: owner.userId,
    }).orderBy('createdAt').execute()
    return rows.map(publicBot)
  }

  async reset(owner: Owner, username: string): Promise<IssuedBot | undefined> {
    const row = await this._owned(owner, username)
    if (!row) return
    return this._withTokenLock(row.id, async () => {
      const current = await this._ownedById(owner, row.id)
      if (!current || !current.enabled || current.revokedAt) return
      const token = issueToken(current.id)
      const tokenVersion = current.tokenVersion + 1
      await this.ctx.database.set('mtproto_bot_identity', { id: current.id }, {
        tokenVersion,
        tokenVerifier: this._verifier(token, tokenVersion),
        updatedAt: new Date(),
      })
      const bot = { ...publicBot(current), tokenVersion }
      this._changed(bot)
      return { bot, token }
    })
  }

  async revoke(owner: Owner, username: string): Promise<BotIdentity | undefined> {
    const row = await this._owned(owner, username)
    if (!row) return
    return this._withTokenLock(row.id, async () => {
      const current = await this._ownedById(owner, row.id)
      if (!current || !current.enabled || current.revokedAt) return
      const revokedAt = new Date()
      await this.ctx.database.set('mtproto_bot_identity', { id: current.id }, {
        enabled: false,
        revokedAt,
        updatedAt: revokedAt,
      })
      const bot = { ...publicBot(current), enabled: false, revokedAt }
      this._changed(bot)
      return bot
    })
  }

  onChanged(listener: (bot: BotIdentity) => void): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  private async _owned(owner: Owner, username: string): Promise<BotIdentityRow | undefined> {
    const [row] = await this.ctx.database.get('mtproto_bot_identity', {
      usernameNormalized: normalizeUsername(username),
      ownerPlatformId: owner.platformId,
      ownerPlatformSessionId: owner.platformSessionId,
      ownerUserId: owner.userId,
    })
    return row && await this._ownerSessionActive(row) ? row : undefined
  }

  private async _ownerSessionActive(row: BotIdentityRow): Promise<boolean> {
    const [session] = await this.ctx.database.get('mtproto_platform_session', {
      id: row.ownerPlatformSessionId,
      platformId: row.ownerPlatformId,
      userId: row.ownerUserId,
      active: true,
    })
    return Boolean(session)
  }

  private async _ownedById(owner: Owner, id: string): Promise<BotIdentityRow | undefined> {
    const [row] = await this.ctx.database.get('mtproto_bot_identity', {
      id,
      ownerPlatformId: owner.platformId,
      ownerPlatformSessionId: owner.platformSessionId,
      ownerUserId: owner.userId,
    })
    return row
  }

  private async _withTokenLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = this._tokenLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this._tokenLocks.set(id, current)
    await previous.catch(() => {})
    try {
      return await callback()
    } finally {
      release()
      if (this._tokenLocks.get(id) === current) this._tokenLocks.delete(id)
    }
  }

  private _verifier(token: string, version: number): string {
    return createHmac('sha256', this._verifierSecret).update(`${version}:${token}`).digest('base64url')
  }

  private _changed(bot: BotIdentity): void {
    for (const listener of [...this._listeners]) {
      try { listener(bot) } catch (error) {
        this.ctx.logger('botfather').warn('bot registry listener failed: %s', String(error))
      }
    }
  }
}

class BotFatherProvider implements SystemPeerProvider {
  private readonly _flows = new Map<string, { stage: 'name' | 'username', name?: string }>()

  constructor(private readonly _registry: BotRegistry) {}

  async bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void> {
    const father = botFatherPeer()
    await peers.emit(session, { type: 'conversation', conversation: father.conversation })
    await peers.emit(session, {
      type: 'message',
      conversation: father.conversation,
      message: systemMessage(father.conversation, 'bridge:botfather:welcome', 'Welcome to BotFather. Send /newbot to create a bot.'),
    })
    for (const bot of await this._registry.list(ownerFrom(session))) {
      if (bot.enabled) await bootstrapBot(session, bot, peers)
    }
  }

  async resolve(session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined> {
    if (conversationId === BOT_FATHER_CONVERSATION_ID) return botFatherPeer()
    const bot = await this._registry.byConversation(session.platformSessionId, conversationId)
    return bot?.enabled ? botPeer(bot) : undefined
  }

  async receive(session: PlatformSession, peer: SystemPeer, message: IMMessage, peers: SystemPeerService): Promise<void> {
    if (peer.id !== BOT_FATHER_CONVERSATION_ID || message.outgoing !== true) return
    const text = plainText(message)
    if (text === undefined) return
    const owner = ownerFrom(session)
    if (text === '/cancel') {
      this._flows.delete(session.platformSessionId)
      await reply(session, peer.conversation, 'Cancelled.', peers)
      return
    }
    const flow = this._flows.get(session.platformSessionId)
    if (flow?.stage === 'name') {
      if (!text.trim()) return reply(session, peer.conversation, 'Please send a non-empty bot name.', peers)
      this._flows.set(session.platformSessionId, { stage: 'username', name: text.trim() })
      return reply(session, peer.conversation, 'Now send a username (5-32 letters, digits, or underscores).', peers)
    }
    if (flow?.stage === 'username') {
      if (!validUsername(text)) return reply(session, peer.conversation, 'That username is invalid. Try another one.', peers)
      try {
        const issued = await this._registry.create(owner, flow.name!, text)
        this._flows.delete(session.platformSessionId)
        await bootstrapBot(session, issued.bot, peers)
        await reply(session, peer.conversation, `Bot @${issued.bot.username} created. Token generated; it is shown once in a live message.`, peers)
        await transientToken(session, peer.conversation, issued.token, peers)
      } catch (error) {
        if (error instanceof BotUsernameTakenError) {
          return reply(session, peer.conversation, 'That username is already taken. Try another one.', peers)
        }
        throw error
      }
      return
    }
    if (text === '/newbot') {
      this._flows.set(session.platformSessionId, { stage: 'name' })
      return reply(session, peer.conversation, 'What should this bot be called?', peers)
    }
    if (text === '/mybots') {
      const bots = await this._registry.list(owner)
      return reply(session, peer.conversation, bots.length
        ? bots.map((bot) => `@${bot.username}${bot.enabled ? '' : ' (revoked)'}`).join('\n')
        : 'You do not have any bots yet.', peers)
    }
    const command = /^\/(token|revoke)\s+([^\s]+)$/u.exec(text)
    if (command?.[1] === 'token') {
      const issued = await this._registry.reset(owner, command[2])
      if (!issued) return reply(session, peer.conversation, 'Bot not found or unavailable.', peers)
      await reply(session, peer.conversation, 'Token reset. The new token is shown once in a live message.', peers)
      await transientToken(session, peer.conversation, issued.token, peers)
      return
    }
    if (command?.[1] === 'revoke') {
      const bot = await this._registry.revoke(owner, command[2])
      return reply(session, peer.conversation, bot ? `Bot @${bot.username} revoked.` : 'Bot not found or unavailable.', peers)
    }
    return reply(session, peer.conversation, 'Use /newbot, /mybots, /token <username>, /revoke <username>, or /cancel.', peers)
  }
}

export function apply(ctx: Context, config: Config): void {
  defineBotModels(ctx)
  const registry = new BotRegistry(ctx, config.verifierSecret)
  const provider = new BotFatherProvider(registry)
  const unregister = ctx.systemPeer.register(provider)
  void ctx.database.prepared().then(async () => {
    const rows = await ctx.database.get('mtproto_platform_session', { active: true })
    await Promise.all(rows.map((row) => ctx.systemPeer.bootstrap({
      platformId: row.platformId,
      platformSessionId: row.id,
      userId: row.userId,
      credentials: row.credentials,
      metadata: row.metadata,
    })))
  }).catch((error) => ctx.logger('botfather').warn('BotFather bootstrap recovery failed: %s', String(error)))
  ctx.effect(() => unregister, 'botfather.system-peer')
}

export const BOT_FATHER_CONVERSATION_ID = 'bridge:botfather'

export function botConversationId(id: string): string {
  return `bridge:bot:${id}`
}

export function validUsername(username: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(username)
}

function normalizeUsername(username: string): string {
  return username.toLocaleLowerCase('en-US')
}

function tokenId(token: string): string | undefined {
  return /^(\d+):[A-Za-z0-9_-]{43}$/u.exec(token)?.[1]
}

function issueToken(id: string): string {
  return `${id}:${randomBytes(32).toString('base64url')}`
}

function randomBotId(): number {
  return 100_000_000 + randomBytes(4).readUInt32BE() % 900_000_000
}

function publicBot(row: BotIdentityRow): BotIdentity {
  return {
    id: row.id,
    ownerPlatformId: row.ownerPlatformId,
    ownerPlatformSessionId: row.ownerPlatformSessionId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    username: row.username,
    conversationId: row.conversationId,
    tokenVersion: row.tokenVersion,
    enabled: row.enabled,
    revokedAt: row.revokedAt ?? undefined,
  }
}

function ownerFrom(session: PlatformSession): Owner {
  return { platformId: session.platformId, platformSessionId: session.platformSessionId, userId: session.userId }
}

function botFatherPeer(): SystemPeer {
  return {
    id: BOT_FATHER_CONVERSATION_ID,
    conversation: {
      id: BOT_FATHER_CONVERSATION_ID,
      kind: 'direct',
      title: 'BotFather',
      metadata: { bridgeOwned: true, localOnly: true, systemPeer: 'botfather', bot: true, username: 'BotFather' },
    },
  }
}

function botPeer(bot: BotIdentity): SystemPeer {
  return {
    id: bot.conversationId,
    conversation: {
      id: bot.conversationId,
      kind: 'direct',
      title: bot.name,
      metadata: { bridgeOwned: true, localOnly: true, systemPeer: 'bot', bot: true, botIdentityId: bot.id, username: bot.username },
    },
  }
}

async function bootstrapBot(session: PlatformSession, bot: BotIdentity, peers: SystemPeerService): Promise<void> {
  const peer = botPeer(bot)
  await peers.emit(session, { type: 'conversation', conversation: peer.conversation })
  await peers.emit(session, {
    type: 'message',
    conversation: peer.conversation,
    message: systemMessage(peer.conversation, `bridge:bot:${bot.id}:welcome`, `Welcome to @${bot.username}.`),
  })
}

async function reply(session: PlatformSession, conversation: IMConversation, text: string, peers: SystemPeerService): Promise<void> {
  await peers.emit(session, {
    type: 'message',
    conversation,
    message: systemMessage(conversation, `bridge:botfather:reply:${randomBytes(12).toString('hex')}`, text),
  })
}

async function transientToken(session: PlatformSession, conversation: IMConversation, token: string, peers: SystemPeerService): Promise<void> {
  await peers.emitTransient(session, conversation, systemMessage(
    conversation,
    `bridge:botfather:token:${randomBytes(12).toString('hex')}`,
    `Use this token once: ${token}`,
  ), { nonCapturable: true })
}

function systemMessage(conversation: IMConversation, id: string, text: string): IMMessage {
  return {
    id,
    conversationId: conversation.id,
    senderId: conversation.id,
    sender: {
      id: conversation.id,
      firstName: conversation.title,
      username: typeof conversation.metadata?.username === 'string' ? conversation.metadata.username : undefined,
      metadata: conversation.metadata,
    },
    content: { parts: [{ type: 'text', text }] },
    timestamp: Math.floor(Date.now() / 1_000),
    outgoing: false,
  }
}

function plainText(message: IMMessage): string | undefined {
  if (!message.content.parts.length || message.content.parts.some((part) => part.type !== 'text' || part.entities?.length)) return
  return message.content.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && /unique|duplicate|constraint/i.test(error.message)
}

declare module 'cordis' {
  interface Context {
    botRegistry: BotRegistry
  }
}
