import type { Database } from '@cordisjs/plugin-database'
import { randomBytes, randomInt } from 'node:crypto'
import type { AuthSessionRow, PlatformSessionRow } from './models.js'
import type { IMPlatform, IMPlatformAccount, IMUser, PlatformSession } from './platform.js'
import type { JsonValue } from './platform.js'
import { generateLoginSecret } from './login-code.js'
import { sessionFromRow } from './platform-manager.js'

export interface ProvisionedPlatformAccount {
  auth: AuthSessionRow
  profile: IMUser
  session: PlatformSession
}

/** Coalesce startup scans and registry events for the same platform entry. */
export class PlatformAccountProvisioner {
  private readonly _pending = new Map<string, Promise<ProvisionedPlatformAccount | undefined>>()

  constructor(private readonly _database: Database) {}

  provision(platformId: string, platform: IMPlatform): Promise<ProvisionedPlatformAccount | undefined> {
    const existing = this._pending.get(platformId)
    if (existing) return existing
    const pending = provisionPlatformAccount(this._database, platformId, platform)
    this._pending.set(platformId, pending)
    pending.finally(() => {
      if (this._pending.get(platformId) === pending) this._pending.delete(platformId)
    }).catch(() => {})
    return pending
  }
}

/** Replace every non-888 virtual phone, including inactive adapters. */
export async function migrateLegacyVirtualPhones(database: Database): Promise<number> {
  const legacy = (await database.get('mtproto_auth_session', {}))
    .filter(auth => !is888VirtualPhone(auth.virtualPhone))
  for (const auth of legacy) {
    await database.set('mtproto_auth_session', { id: auth.id }, {
      virtualPhone: await allocateVirtualPhone(database),
    })
  }
  return legacy.length
}

/**
 * Ask an adapter for its own account and keep exactly one canonical login
 * identity for that Cordis platform entry.
 */
export async function provisionPlatformAccount(
  database: Database,
  platformId: string,
  platform: IMPlatform,
  account?: IMPlatformAccount,
): Promise<ProvisionedPlatformAccount | undefined> {
  if (!platform.getAccount && !account) return
  const resolved = account ?? await platform.getAccount!()
  validateAccount(resolved)
  const deterministicVirtualPhone = platform.platformKind === 'qq'
    ? qqVirtualPhone(resolved.user)
    : undefined

  const existingSessions = await database.get('mtproto_platform_session', { platformId })
  let row = existingSessions[0]
  const metadata = {
    ...(resolved.user.metadata ?? {}),
    firstName: resolved.user.firstName,
    ...(resolved.user.lastName ? { lastName: resolved.user.lastName } : {}),
    ...(resolved.user.username ? { username: resolved.user.username } : {}),
  }
  if (row) {
    await database.set('mtproto_platform_session', { id: row.id }, {
      userId: resolved.user.id,
      credentials: resolved.credentials ?? row.credentials,
      metadata,
      active: true,
    })
    row = {
      ...row,
      userId: resolved.user.id,
      credentials: resolved.credentials ?? row.credentials,
      metadata,
      active: true,
    }
  } else {
    row = {
      id: randomId(),
      platformId,
      userId: resolved.user.id,
      credentials: resolved.credentials ?? {},
      metadata,
      active: true,
      createdAt: new Date(),
    }
    await database.create('mtproto_platform_session', row)
  }

  // Old development databases may contain more than one session for an entry.
  // Keep their data but make the platform-provided identity the sole active one.
  for (const duplicate of existingSessions.slice(1)) {
    if (duplicate.active) await database.set('mtproto_platform_session', { id: duplicate.id }, { active: false })
  }

  await database.upsert('mtproto_im_user', [{
    platformId,
    platformUserId: resolved.user.id,
    firstName: resolved.user.firstName,
    lastName: resolved.user.lastName ?? null,
    username: resolved.user.username ?? null,
    avatar: (resolved.user.avatar ?? null) as unknown as JsonValue | null,
    metadata: resolved.user.metadata ?? {},
    updatedAt: new Date(),
  }], ['platformId', 'platformUserId'])

  const existingAuth = await database.get('mtproto_auth_session', { platformId })
  let auth = existingAuth.find(item => item.platformSessionId === row.id) ?? existingAuth[0]
  if (auth) {
    const totpSecret = auth.totpSecret || generateLoginSecret()
    const virtualPhone = deterministicVirtualPhone
      ?? (is888VirtualPhone(auth.virtualPhone) ? auth.virtualPhone : await allocateVirtualPhone(database))
    if (deterministicVirtualPhone) await ensureVirtualPhoneAvailable(database, virtualPhone, auth.id)
    await database.set('mtproto_auth_session', { id: auth.id }, {
      platformSessionId: row.id,
      totpSecret,
      virtualPhone,
    })
    auth = { ...auth, platformSessionId: row.id, totpSecret, virtualPhone }
  } else {
    const virtualPhone = deterministicVirtualPhone ?? await allocateVirtualPhone(database)
    if (deterministicVirtualPhone) await ensureVirtualPhoneAvailable(database, virtualPhone)
    auth = {
      id: randomId(),
      virtualPhone,
      totpSecret: generateLoginSecret(),
      platformId,
      platformSessionId: row.id,
    }
    await database.create('mtproto_auth_session', auth)
  }

  return { auth, profile: resolved.user, session: sessionFromRow(row, auth.virtualPhone) }
}

function validateAccount(account: IMPlatformAccount): void {
  if (!account?.user || typeof account.user.id !== 'string' || !account.user.id.trim()) {
    throw new Error('platform account must provide a non-empty user.id')
  }
  if (typeof account.user.firstName !== 'string' || !account.user.firstName.trim()) {
    throw new Error('platform account must provide a non-empty user.firstName')
  }
}

async function allocateVirtualPhone(database: Database): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const virtualPhone = `888${String(randomInt(0, 1_000_000)).padStart(6, '0')}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`
    if (!(await database.get('mtproto_auth_session', { virtualPhone })).length) return virtualPhone
  }
  throw new Error('failed to allocate a unique virtual phone')
}

async function ensureVirtualPhoneAvailable(database: Database, virtualPhone: string, authId?: string): Promise<void> {
  const owner = (await database.get('mtproto_auth_session', { virtualPhone })).find(auth => auth.id !== authId)
  if (owner) throw new Error(`QQ virtual phone ${virtualPhone} is already assigned to another auth session`)
}

function qqVirtualPhone(user: IMUser): string {
  const qq = user.metadata?.qq
  if (typeof qq !== 'string' || !/^[0-9]+$/.test(qq)) {
    throw new Error('QQ platform account must provide metadata.qq as a non-empty ASCII digit string')
  }
  return `888${qq}`
}

function is888VirtualPhone(phone: string): boolean {
  return phone.startsWith('888')
}

function randomId(): string {
  return randomBytes(16).toString('hex')
}
