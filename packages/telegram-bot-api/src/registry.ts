import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Service, type Context } from 'cordis'
import type { BotIdentityRow } from './bot-models.js'

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

export interface BotOwner {
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

  async create(owner: BotOwner, name: string, username: string): Promise<IssuedBot> {
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

  async list(owner: BotOwner): Promise<BotIdentity[]> {
    const rows = await this.ctx.database.select('mtproto_bot_identity', {
      ownerPlatformId: owner.platformId,
      ownerPlatformSessionId: owner.platformSessionId,
      ownerUserId: owner.userId,
    }).orderBy('createdAt').execute()
    return rows.map(publicBot)
  }

  /** Active bots across all owners, used only by the protected Crossgram management UI. */
  async listAll(): Promise<BotIdentity[]> {
    const rows = await this.ctx.database.select('mtproto_bot_identity', { enabled: true })
      .orderBy('createdAt').execute()
    return (await Promise.all(rows.map(async (row) =>
      row.revokedAt || !(await this._ownerSessionActive(row)) ? undefined : publicBot(row))))
      .filter((bot): bot is BotIdentity => Boolean(bot))
  }

  async reset(owner: BotOwner, username: string): Promise<IssuedBot | undefined> {
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

  async revoke(owner: BotOwner, username: string): Promise<BotIdentity | undefined> {
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

  private async _owned(owner: BotOwner, username: string): Promise<BotIdentityRow | undefined> {
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

  private async _ownedById(owner: BotOwner, id: string): Promise<BotIdentityRow | undefined> {
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
        this.ctx.logger('telegram-bot-api').warn('bot registry listener failed: %s', String(error))
      }
    }
  }
}

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

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && /unique|duplicate|constraint/i.test(error.message)
}

declare module 'cordis' {
  interface Context {
    botRegistry: BotRegistry
  }
}
