import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from '../../bridge/src/models.js'
import { migrateLegacyQQGroupAliasUsers } from './user-name-migration.js'

describe('legacy QQ group-card user migration', () => {
  it('restores profile nicknames, removes global aliases, and is idempotent', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()

    try {
      const now = new Date()
      await ctx.database.create('mtproto_im_user', {
        platformId: 'qqnt', platformUserId: 'legacy', firstName: 'Group Alias', lastName: null,
        username: '42', avatar: null, metadata: {
          qq: '42', qqName: 'Profile Name', qqGroupAlias: 'Group Alias',
        }, updatedAt: now,
      })
      await ctx.database.create('mtproto_im_user', {
        platformId: 'qqnt', platformUserId: 'missing-name', firstName: 'Only Known Name', lastName: null,
        username: null, avatar: null, metadata: { qqGroupAlias: 'Old Alias' }, updatedAt: now,
      })
      await ctx.database.create('mtproto_im_user', {
        platformId: 'qqnt', platformUserId: 'current', firstName: 'Buddy Remark', lastName: null,
        username: null, avatar: null, metadata: { qqName: 'Profile Name' }, updatedAt: now,
      })
      await ctx.database.create('mtproto_im_user', {
        platformId: 'discord', platformUserId: 'other', firstName: 'Other Alias', lastName: null,
        username: null, avatar: null, metadata: {
          qqName: 'Other Profile', qqGroupAlias: 'Other Alias',
        }, updatedAt: now,
      })

      await expect(migrateLegacyQQGroupAliasUsers(ctx.database, 'qqnt')).resolves.toBe(2)
      const rows = await ctx.database.get('mtproto_im_user', { platformId: 'qqnt' })
      const users = Object.fromEntries(rows.map((row) => [row.platformUserId, row]))
      expect(users.legacy).toMatchObject({
        firstName: 'Profile Name', metadata: { qq: '42', qqName: 'Profile Name' },
      })
      expect(users.legacy.metadata).not.toHaveProperty('qqGroupAlias')
      expect(users['missing-name']).toMatchObject({ firstName: 'Only Known Name', metadata: {} })
      expect(users.current).toMatchObject({
        firstName: 'Buddy Remark', metadata: { qqName: 'Profile Name' },
      })
      await expect(migrateLegacyQQGroupAliasUsers(ctx.database, 'qqnt')).resolves.toBe(0)
      await expect(ctx.database.get('mtproto_im_user', { platformId: 'discord' })).resolves.toMatchObject([{
        firstName: 'Other Alias', metadata: { qqGroupAlias: 'Other Alias' },
      }])
    } finally {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    }
  })
})
