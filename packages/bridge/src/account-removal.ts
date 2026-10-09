import type { Database } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'

/** The Cordis configuration-tree surface the account page needs. */
export interface PlatformEntryLoader {
  entries(): Iterable<PlatformEntry>
}
export interface PlatformEntry {
  /** Loader key, qualified with the tree path for entries inside a config file. */
  id: string
  options: { id: string }
  parent: { tree: { remove(id: string): void } }
}

export interface PlatformAccountRemovalCounts {
  platformSessions: number
  authSessions: number
  authBindings: number
  clientAuthorizations: number
  authorizationSettings: number
}

/**
 * Loader-owned configuration tree, when this deployment keeps plugin entries in
 * a file. Without it an entry only exists in memory, so the bridge cannot make a
 * deletion durable and refuses instead.
 */
export function platformEntryLoader(ctx: Context): PlatformEntryLoader | undefined {
  const loader = ctx.get('loader') as PlatformEntryLoader | undefined
  return loader && typeof loader.entries === 'function' ? loader : undefined
}

/**
 * The loader entry that provisions this platform account, if a config file owns it.
 *
 * A platform entry loaded from a config file reports its configured id, while the
 * loader keys the same entry with the path of the tree that loaded it, so both
 * spellings are accepted.
 */
export function platformEntry(ctx: Context, platformId: string): PlatformEntry | undefined {
  const loader = platformEntryLoader(ctx)
  if (!loader) return undefined
  const entries = [...loader.entries()]
  return entries.find(entry => entry.id === platformId)
    ?? entries.find(entry => entry.options?.id === platformId)
}

/** Whether the Cordis loader owns this entry id and can delete it. */
export function isLoaderManagedEntry(ctx: Context, entryId: string): boolean {
  return platformEntry(ctx, entryId) !== undefined
}

/**
 * Delete the plugin entry that provisions a platform account. The entry is
 * removed through the tree that owns it, which is also the tree that writes the
 * configuration file back, so the account cannot return on the next start.
 */
export function removePlatformEntry(ctx: Context, entryId: string): void {
  const entry = platformEntry(ctx, entryId)
  if (!entry) {
    throw new Error(`平台条目 ${entryId} 不是由配置文件管理的，请到插件页面手动停用它。`)
  }
  entry.parent.tree.remove(entry.options.id)
}

/**
 * Remove the login surface of one platform entry: the platform session, its
 * virtual phone, TOTP secret and two-step password, the bindings of every
 * Telegram client signed in through it, and their authorizations.
 *
 * Message and conversation history is deliberately left alone: it is scoped by
 * platform session, so it is unreachable once the session is gone, while the
 * identity rows stay reusable if the same entry id is configured again.
 */
export async function removePlatformAccount(
  database: Database,
  platformId: string,
  revokeAuthKeys: (authKeyIds: string[]) => Promise<void> = async () => {},
): Promise<PlatformAccountRemovalCounts> {
  await database.prepared()
  const [sessions, authSessions, bindings] = await Promise.all([
    database.get('mtproto_platform_session', { platformId }),
    database.get('mtproto_auth_session', { platformId }),
    database.get('mtproto_auth_binding', { platformId }),
  ])
  const platformSessionIds = [...new Set([
    ...sessions.map(session => session.id),
    ...authSessions.map(auth => auth.platformSessionId),
  ])]
  let clientAuthorizations = 0
  let authorizationSettings = 0
  for (const platformSessionId of platformSessionIds) {
    const [clients, settings] = await Promise.all([
      database.get('mtproto_client_authorization', { platformSessionId }),
      database.get('mtproto_authorization_settings', { platformSessionId }),
    ])
    clientAuthorizations += clients.length
    authorizationSettings += settings.length
    await Promise.all([
      database.remove('mtproto_client_authorization', { platformSessionId }),
      database.remove('mtproto_authorization_settings', { platformSessionId }),
    ])
  }
  await Promise.all([
    database.remove('mtproto_auth_binding', { platformId }),
    database.remove('mtproto_auth_session', { platformId }),
    database.remove('mtproto_platform_session', { platformId }),
  ])
  // Revoke after the rows are gone, so a client cannot re-authorize in between.
  await revokeAuthKeys(bindings.map(binding => binding.authKeyId))
  return {
    platformSessions: sessions.length,
    authSessions: authSessions.length,
    authBindings: bindings.length,
    clientAuthorizations,
    authorizationSettings,
  }
}

/** Telegram clients signed in through one platform entry. */
export async function countPlatformClientAuthorizations(
  database: Database,
  platformId: string,
): Promise<number> {
  await database.prepared()
  const [sessions, authSessions] = await Promise.all([
    database.get('mtproto_platform_session', { platformId }),
    database.get('mtproto_auth_session', { platformId }),
  ])
  const platformSessionIds = [...new Set([
    ...sessions.map(session => session.id),
    ...authSessions.map(auth => auth.platformSessionId),
  ])]
  let count = 0
  for (const platformSessionId of platformSessionIds) {
    count += (await database.get('mtproto_client_authorization', { platformSessionId })).length
  }
  return count
}
