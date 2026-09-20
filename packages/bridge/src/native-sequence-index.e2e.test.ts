import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import PostgresDriver from '@cordisjs/plugin-database-postgres'
import { defineModels } from './models.js'

// Opt-in, loopback-only disposable database. Never point this at production.
// CROSSGRAM_TEST_POSTGRES_PORT=55439 CROSSGRAM_TEST_POSTGRES_USER=crossgram_test
const port = Number(process.env.CROSSGRAM_TEST_POSTGRES_PORT)
const user = process.env.CROSSGRAM_TEST_POSTGRES_USER ?? 'postgres'
const exec = promisify(execFile)
const nativeIndex = 'index:mtproto_tl_message_part:conversationId+nativeSequence'

describe.skipIf(!port)('native-sequence PostgreSQL migration', () => {
  it('repairs the truncated-name collision and uses indexed seeks under concurrent readers', async () => {
    const database = 'crossgram_index_' + randomUUID().replaceAll('-', '')
    const admin = (sql: string) => exec('psql', [
      '-X', '-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ], { windowsHide: true })
    await admin('CREATE DATABASE ' + database)
    let ctx: Context | undefined
    const fibers: Array<{ dispose(): Promise<unknown> }> = []
    const stop = async () => {
      for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
    }
    const start = async (legacy: boolean) => {
      ctx = new Context()
      const databaseFiber = ctx.plugin(Database)
      fibers.push(databaseFiber)
      await databaseFiber
      const driverFiber = ctx.plugin(PostgresDriver, { host: '127.0.0.1', port, user, password: '', database })
      fibers.push(driverFiber)
      await driverFiber
      await new Promise(resolve => setTimeout(resolve, 25))
      const context = ctx
      defineModels({ model: { extend(table: string, fields: unknown, options: any) {
        if (legacy && table === 'mtproto_tl_message_part') options = {
          ...options, indexes: options.indexes.map((keys: string | string[]) =>
            Array.isArray(keys) && keys.join('+') === 'conversationId+nativeSequence'
              ? ['platformSessionId', ...keys] : keys),
        }
        context.model.extend(table as never, fields as never, options)
      } } } as never)
      await ctx.database.prepared()
      return ctx.database.drivers.find(driver => driver instanceof PostgresDriver) as PostgresDriver
    }
    try {
      let driver = await start(true)
      const indexes = () => driver.getIndexes('mtproto_tl_message_part')
      expect((await indexes()).some(index => 'nativeSequence' in index.keys)).toBe(false)
      await driver.query(
        'INSERT INTO mtproto_tl_message_part ("platformSessionId", "conversationId", "messageId", scope, "tlMessageId", "nativeSequence", ordinal) ' +
        "SELECT 'account-' || (g % 4), g % 100, g, 'scope-' || (g % 100), g, g / 100, 0 FROM generate_series(1, 30000) g")
      await driver.query('ANALYZE mtproto_tl_message_part')
      const sql = 'SELECT * FROM mtproto_tl_message_part WHERE "conversationId" = 42 AND "nativeSequence" < 150 ORDER BY "nativeSequence" DESC LIMIT 1'
      const before = JSON.stringify(await driver.query('EXPLAIN (FORMAT JSON) ' + sql))
      // PostgreSQL 18 may use skip-scan here; either way the old plan must
      // read and sort a conversation instead of seeking by native sequence.
      expect(before).toContain('"Node Type":"Sort"')
      expect(before).not.toContain(nativeIndex)
      await stop()
      ctx = undefined
      driver = await start(false)
      expect(await indexes()).toEqual(expect.arrayContaining([expect.objectContaining({
        name: nativeIndex, keys: { conversationId: 'asc', nativeSequence: 'asc' },
      })]))
      const after = JSON.stringify(await driver.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql))
      expect(after).toContain(nativeIndex)
      expect(after).not.toContain('Seq Scan')
      expect(after).not.toContain('"Node Type":"Sort"')
      // The old allocator does not include platformSessionId: verify its actual query shape.
      const results = await Promise.all(Array.from({ length: 6 }, () =>
        ctx!.database.select('mtproto_tl_message_part', {
          conversationId: 42, nativeSequence: { $lt: 150 },
        }).orderBy('nativeSequence', 'desc').limit(1).execute()))
      for (const rows of results) expect(rows).toMatchObject([{ conversationId: 42, nativeSequence: 149 }])
      // Restarting with the repaired model must neither drop nor duplicate the index.
      await stop()
      ctx = undefined
      driver = await start(false)
      expect((await indexes()).filter(index => index.name === nativeIndex)).toHaveLength(1)
    } finally {
      await stop()
      await admin('DROP DATABASE ' + database + ' WITH (FORCE)')
    }
  }, 60_000)
})
