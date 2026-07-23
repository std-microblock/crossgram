import type { Database } from '@cordisjs/plugin-database'
import { randomBytes, randomInt } from 'node:crypto'
import type { AuthSessionRow, PlatformSessionRow } from './models.js'
import type { IMPlatform, IMPlatformAccount, IMUser, PlatformSession } from './platform.js'
import { generateLoginSecret } from './login-code.js'
import { sessionFromRow } from './platform-manager.js'

export interface ProvisionedPlatformAccount {
  auth: AuthSessionRow
  profile: IMUser
  session: PlatformSession
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

  const existingAuth = await database.get('mtproto_auth_session', { platformId })
  let auth = existingAuth.find(item => item.platformSessionId === row.id) ?? existingAuth[0]
  if (auth) {
    const totpSecret = auth.totpSecret || generateLoginSecret()
    await database.set('mtproto_auth_session', { id: auth.id }, {
      platformSessionId: row.id,
      totpSecret,
    })
    auth = { ...auth, platformSessionId: row.id, totpSecret }
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

  return { auth, profile: resolved.user, session: sessionFromRow(row) }
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
    // 15 digits total, inside the reserved 999 prefix used by the route resolver.
    const virtualPhone = `999${String(randomInt(0, 1e6)).padStart(6, '0')}${String(randomInt(0, 1e6)).padStart(6, '0')}`
    if (!(await database.get('mtproto_auth_session', { virtualPhone })).length) return virtualPhone
  }
  throw new Error('failed to allocate a unique virtual phone')
}

function randomId(): string {
  return randomBytes(16).toString('hex')
}
