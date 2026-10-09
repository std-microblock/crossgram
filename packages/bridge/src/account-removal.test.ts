import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import {
  countPlatformClientAuthorizations, isLoaderManagedEntry, platformEntry, removePlatformAccount,
  removePlatformEntry,
} from './account-removal.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

async function createDatabase() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return ctx.database
}

/** Seed one platform entry with a session, a virtual phone and one signed-in client. */
async function seedAccount(
  database: Awaited<ReturnType<typeof createDatabase>>,
  platformId: string,
  suffix: string,
) {
  await database.create('mtproto_platform_session', {
    id: `session-${suffix}`, platformId, userId: `user-${suffix}`, credentials: {},
    metadata: {}, active: true, createdAt: new Date(),
  })
  await database.create('mtproto_auth_session', {
    id: `auth-${suffix}`, virtualPhone: `8880000000000${suffix}`, totpSecret: 'secret',
    platformId, platformSessionId: `session-${suffix}`,
  })
  await database.create('mtproto_auth_binding', {
    authKeyId: `key-${suffix}`, platformId, platformSessionId: `session-${suffix}`,
  })
  await database.create('mtproto_client_authorization', {
    authKeyId: `key-${suffix}`, platformSessionId: `session-${suffix}`, apiId: 1,
    deviceModel: 'device', platform: 'Android', systemVersion: '1', appName: 'Telegram',
    appVersion: '1', dateCreated: 1, dateActive: 2, ip: '127.0.0.1', country: 'Local network',
    region: '', encryptedRequestsDisabled: false, callRequestsDisabled: false, unconfirmed: false,
  })
  await database.create('mtproto_authorization_settings', {
    platformSessionId: `session-${suffix}`, ttlDays: 180,
  })
}

describe('platform account removal', () => {
  it('removes one entry together with its login credentials and revokes its clients', async () => {
    const database = await createDatabase()
    await seedAccount(database, 'qqnt-2', '2')
    await seedAccount(database, 'qqnt', '1')
    const revoke = vi.fn(async () => {})

    await expect(removePlatformAccount(database, 'qqnt-2', revoke)).resolves.toEqual({
      platformSessions: 1,
      authSessions: 1,
      authBindings: 1,
      clientAuthorizations: 1,
      authorizationSettings: 1,
    })
    expect(revoke).toHaveBeenCalledWith(['key-2'])
    expect(await database.get('mtproto_platform_session', { platformId: 'qqnt-2' })).toEqual([])
    expect(await database.get('mtproto_auth_session', { platformId: 'qqnt-2' })).toEqual([])
    expect(await database.get('mtproto_auth_binding', { platformId: 'qqnt-2' })).toEqual([])
    expect(await database.get('mtproto_client_authorization', {})).toHaveLength(1)
    expect(await database.get('mtproto_authorization_settings', {})).toHaveLength(1)
    // The entry that keeps the account is untouched.
    expect(await database.get('mtproto_auth_session', { platformId: 'qqnt' })).toHaveLength(1)
    expect(await countPlatformClientAuthorizations(database, 'qqnt')).toBe(1)
    expect(await countPlatformClientAuthorizations(database, 'qqnt-2')).toBe(0)
  })

  it('removes a legacy entry whose auth session points at a session row that is gone', async () => {
    const database = await createDatabase()
    await seedAccount(database, 'legacy', 'l')
    await database.remove('mtproto_platform_session', { platformId: 'legacy' })

    await expect(removePlatformAccount(database, 'legacy')).resolves.toMatchObject({
      platformSessions: 0,
      authSessions: 1,
      clientAuthorizations: 1,
    })
    expect(await database.get('mtproto_auth_session', { platformId: 'legacy' })).toEqual([])
    expect(await database.get('mtproto_client_authorization', {})).toEqual([])
  })
})

describe('cordis entry removal', () => {
  /** Minimal stand-in for the loader tree, keyed the way the real loader keys entries. */
  const loader = (entries: Array<[string, string]>) => {
    const removed: string[] = []
    const tree = { remove: (id: string) => { removed.push(id) } }
    return {
      removed,
      service: {
        entries: () => entries.map(([id, configuredId]) => ({
          id,
          options: { id: configuredId },
          parent: { tree },
        })),
      },
    }
  }
  const context = (service?: unknown) => {
    const ctx = new Context()
    return {
      ctx,
      provide: () => ctx.provide('loader', service as never),
    }
  }

  it('deletes the entry through the tree that owns it', () => {
    const target = loader([['bridge01', 'bridge01'], ['qqnt-2', 'qqnt-2']])
    const { ctx, provide } = context(target.service)
    provide()
    expect(isLoaderManagedEntry(ctx, 'qqnt-2')).toBe(true)
    removePlatformEntry(ctx, 'qqnt-2')
    // The owning tree removes entries by their configured id, not by loader key.
    expect(target.removed).toEqual(['qqnt-2'])
  })

  it('finds an entry loaded from a config file under its qualified loader key', () => {
    const target = loader([['7ffc5890:qqnt', 'qqnt'], ['7ffc5890:qqnt-2', 'qqnt-2']])
    const { ctx, provide } = context(target.service)
    provide()
    expect(platformEntry(ctx, 'qqnt-2')?.id).toBe('7ffc5890:qqnt-2')
    removePlatformEntry(ctx, 'qqnt')
    expect(target.removed).toEqual(['qqnt'])
  })

  it('refuses to delete an entry the configuration file does not own', () => {
    const { ctx, provide } = context(loader([['bridge01', 'bridge01']]).service)
    provide()
    expect(isLoaderManagedEntry(ctx, 'qqnt-2')).toBe(false)
    expect(platformEntry(ctx, 'qqnt-2')).toBeUndefined()
    expect(() => removePlatformEntry(ctx, 'qqnt-2')).toThrow(
      '平台条目 qqnt-2 不是由配置文件管理的',
    )
    // A deployment without a loader keeps accounts undeletable rather than half deleted.
    const bare = new Context()
    expect(isLoaderManagedEntry(bare, 'qqnt-2')).toBe(false)
    expect(() => removePlatformEntry(bare, 'qqnt-2')).toThrow('不是由配置文件管理的')
  })
})
