import { randomBytes } from 'node:crypto'

export interface LoginTokenIdentity {
  platformId: string
  platformSessionId: string
}

export interface LoginTokenClaim {
  identity: LoginTokenIdentity
  token: string
  authKeyId: string
}

interface LoginTokenEntry {
  authKeyId: string
  expiresAt: number
  identity?: LoginTokenIdentity
  claimed?: boolean
  source?: string
}

export class LoginTokenStoreFullError extends Error {
  constructor() {
    super('login token store is full')
  }
}

export class LoginTokenSourceLimitError extends Error {
  constructor() {
    super('login token source limit reached')
  }
}

/** In-memory, single-use QR login tokens. Never persist or log these values. */
export class LoginTokenStore {
  private readonly entries = new Map<string, LoginTokenEntry>()
  private readonly tokenByAuthKey = new Map<string, string>()
  private readonly approvedByAuthKey = new Map<string, string>()
  private readonly tokensBySource = new Map<string, Set<string>>()
  private nextCleanupAt = 0

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 1_024,
    private readonly maxEntriesPerSource = 64,
  ) {}

  issue(authKeyId: Uint8Array, token: Uint8Array = randomBytes(32), source?: string): Uint8Array {
    this.cleanupIfDue()
    const authKey = tokenKey(authKeyId)
    const previous = this.tokenByAuthKey.get(authKey)
    const previousEntry = previous ? this.get(previous) : undefined
    if (previousEntry?.identity || previousEntry?.claimed) throw new LoginTokenStoreFullError()
    const copy = new Uint8Array(token)
    const key = tokenKey(copy)
    if (key !== previous && this.entries.has(key)) throw new LoginTokenStoreFullError()
    if (
      source
      && (this.tokensBySource.get(source)?.size ?? 0) >= this.maxEntriesPerSource
      && previousEntry?.source !== source
    ) throw new LoginTokenSourceLimitError()
    if (!previousEntry && this.entries.size >= this.maxEntries && !this.evictOldest()) {
      throw new LoginTokenStoreFullError()
    }
    if (previous) this.delete(previous)
    const expiresAt = Math.floor((this.now() + this.ttlMs) / 1_000) * 1_000
    this.entries.set(key, { authKeyId: authKey, expiresAt, source })
    this.tokenByAuthKey.set(authKey, key)
    if (source) {
      const tokens = this.tokensBySource.get(source) ?? new Set<string>()
      tokens.add(key)
      this.tokensBySource.set(source, tokens)
    }
    return copy
  }

  approve(token: Uint8Array, identity: LoginTokenIdentity): Uint8Array | undefined {
    const key = tokenKey(token)
    const entry = this.get(key)
    if (!entry || entry.identity || entry.claimed) return
    entry.identity = identity
    this.approvedByAuthKey.set(entry.authKeyId, key)
    return new Uint8Array(Buffer.from(entry.authKeyId, 'hex'))
  }

  expiresAt(token: Uint8Array): number | undefined {
    return this.get(tokenKey(token))?.expiresAt
  }

  claim(token: Uint8Array, authKeyId: Uint8Array): LoginTokenClaim | undefined {
    return this.claimEntry(tokenKey(token), tokenKey(authKeyId))
  }

  claimApprovedForAuthKey(authKeyId: Uint8Array): LoginTokenClaim | undefined {
    const key = tokenKey(authKeyId)
    const token = this.approvedByAuthKey.get(key)
    return token ? this.claimEntry(token, key) : undefined
  }

  commit(claim: LoginTokenClaim): void {
    const entry = this.entries.get(claim.token)
    if (entry?.claimed && entry.authKeyId === claim.authKeyId) this.delete(claim.token)
  }

  rollback(claim: LoginTokenClaim): void {
    const entry = this.entries.get(claim.token)
    if (entry?.claimed && entry.authKeyId === claim.authKeyId) entry.claimed = false
  }

  private claimEntry(token: string, authKeyId: string): LoginTokenClaim | undefined {
    const entry = this.get(token)
    if (!entry || entry.authKeyId !== authKeyId || !entry.identity || entry.claimed) return
    entry.claimed = true
    return { token, authKeyId, identity: entry.identity }
  }

  private get(key: string): LoginTokenEntry | undefined {
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.expiresAt <= this.now()) {
      this.delete(key)
      return
    }
    return entry
  }

  private cleanupIfDue(): void {
    if (this.now() < this.nextCleanupAt) return
    this.expire()
    this.nextCleanupAt = this.now() + Math.min(this.ttlMs, 10_000)
  }

  private expire(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key)
    }
  }

  private evictOldest(): boolean {
    for (const [token, entry] of this.entries) {
      if (!entry.identity && !entry.claimed) {
        this.delete(token)
        return true
      }
    }
    return false
  }

  private delete(token: string): void {
    const entry = this.entries.get(token)
    if (!entry) return
    this.entries.delete(token)
    if (this.tokenByAuthKey.get(entry.authKeyId) === token) this.tokenByAuthKey.delete(entry.authKeyId)
    if (this.approvedByAuthKey.get(entry.authKeyId) === token) this.approvedByAuthKey.delete(entry.authKeyId)
    if (entry.source) {
      const tokens = this.tokensBySource.get(entry.source)
      tokens?.delete(token)
      if (!tokens?.size) this.tokensBySource.delete(entry.source)
    }
  }
}

/** Parses the `token` query parameter from a Telegram login QR URL. */
export function parseTelegramLoginToken(value: string): Uint8Array | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }
  if (url.protocol !== 'tg:' || url.hostname !== 'login' || (url.pathname && url.pathname !== '/')) return
  const encoded = url.searchParams.get('token')
  if (!encoded || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return
  const token = new Uint8Array(Buffer.from(encoded, 'base64url'))
  const canonical = Buffer.from(token).toString('base64url')
  const paddedCanonical = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, '=')
  return token.length === 32 && (encoded === canonical || encoded === paddedCanonical) ? token : undefined
}

function tokenKey(token: Uint8Array): string {
  return Buffer.from(token).toString('hex')
}
