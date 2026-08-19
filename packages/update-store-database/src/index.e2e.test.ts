import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStoreBackend } from '@mtproto-relay/update-store'
import type { Database as DatabaseService } from '@cordisjs/plugin-database'
import DatabaseUpdateStore from './index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function delivery(eventKey: string, platformSessionId: string, pts: number, scope = 'account') {
  return {
    eventKey, platformSessionId, scope, pts, ptsCount: 1, seq: pts - 1, date: 100 + pts,
    published: false, payload: null,
  }
}

async function start(path: string, retention = 2) {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: pathToFileURL(path).href })
  const store = ctx.plugin(DatabaseUpdateStore, { retention })
  let updateStore!: UpdateStoreBackend
  let databaseService!: DatabaseService
  const consumer = Object.assign((consumerCtx: Context) => {
    updateStore = consumerCtx.updateStore
    databaseService = consumerCtx.database
  }, { inject: ['updateStore', 'database'] })
  const consumerFiber = ctx.plugin(consumer)
  await Promise.all([database, sqlite])
  await store.await()
  await consumerFiber.await()
  await expect.poll(() => updateStore).toBeDefined()
  let stopped = false
  const fixture = {
    ctx,
    updateStore,
    database: databaseService,
    async stop() {
      if (stopped) return
      stopped = true
      await consumerFiber.dispose()
      await store.dispose()
      await sqlite.dispose()
      await database.dispose()
      await ctx.fiber.dispose()
    },
  }
  cleanups.push(() => fixture.stop())
  return fixture
}

describe('DatabaseUpdateStore', () => {
  it('persists MessagePack update JSON across restarts and prunes indexed account scopes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-update-store-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'updates.sqlite')

    const first = await start(path)
    await first.updateStore.create(delivery('a-1', 'a', 2))
    await first.updateStore.create(delivery('a-channel', 'a', 2, 'channel:10'))
    await first.updateStore.create(delivery('b-1', 'b', 2))
    await first.updateStore.create(delivery('a-2', 'a', 3))
    await first.updateStore.create(delivery('a-3', 'a', 4))
    const payload = {
      _: 'updates', updates: [{ _: 'updateNewMessage', text: 'durable' }], users: [], chats: [],
    }
    await first.updateStore.setPayload('a-2', payload)
    await first.updateStore.markPublished('a-3')
    const [raw] = await first.database.get('mtproto_update_delivery', { eventKey: 'a-2' })
    expect(raw.payload).toBeInstanceOf(ArrayBuffer)
    expect(raw.payload!.byteLength).toBeGreaterThan(0)
    expect(raw.payload!.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(payload)))
    await first.stop()

    const second = await start(path)
    expect(await second.updateStore.get('a-1')).toBeUndefined()
    expect((await second.updateStore.get('a-2'))?.payload).toEqual(payload)
    expect((await second.updateStore.getAfter('a', 'account', 1, 10)).map((row) => row.eventKey))
      .toEqual(['a-2', 'a-3'])
    expect((await second.updateStore.getAfter('a', 'channel:10', 1, 10)).map((row) => row.eventKey))
      .toEqual(['a-channel'])
    expect((await second.updateStore.getPending('a')).map((row) => row.eventKey))
      .toEqual(['a-channel', 'a-2'])
  })
})
