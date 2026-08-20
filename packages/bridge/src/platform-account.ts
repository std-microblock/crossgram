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

// Keep generated identities inside NANP's reserved fictional 555-0100 through
// 555-0199 blocks. Multiple valid area codes provide enough space without
// assigning numbers that could belong to real subscribers.
const VIRTUAL_PHONE_AREA_CODES = [
  '201', '202', '203', '205', '206', '207', '208', '209', '210', '212',
  '213', '214', '215', '216', '217', '218', '219', '220', '223', '224',
] as const

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

/** Replace every legacy Telegram test-range identity, including inactive adapters. */
export async function migrateLegacyVirtualPhones(database: Database): Promise<number> {
  const legacy = (await database.get('mtproto_auth_session', {}))
    .filter(auth => isLegacyVirtualPhone(auth.virtualPhone))
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
    const virtualPhone = isLegacyVirtualPhone(auth.virtualPhone)
      ? await allocateVirtualPhone(database)
      : auth.virtualPhone
    await database.set('mtproto_auth_session', { id: auth.id }, {
      platformSessionId: row.id,
      totpSecret,
      virtualPhone,
    })
    auth = { ...auth, platformSessionId: row.id, totpSecret, virtualPhone }
  } else {
    auth = {
      id: randomId(),
      virtualPhone: await allocateVirtualPhone(database),
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
    const areaCode = VIRTUAL_PHONE_AREA_CODES[randomInt(0, VIRTUAL_PHONE_AREA_CODES.length)]
    const virtualPhone = `1${areaCode}55501${String(randomInt(0, 100)).padStart(2, '0')}`
    if (!(await database.get('mtproto_auth_session', { virtualPhone })).length) return virtualPhone
  }
  throw new Error('failed to allocate a unique virtual phone')
}

function isLegacyVirtualPhone(phone: string): boolean {
  return phone.startsWith('999') || phone.startsWith('888')
}

function randomId(): string {
  return randomBytes(16).toString('hex')
}
