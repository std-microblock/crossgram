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
    published: false, claimedAt: null, payload: null,
  }
}

async function start(path: string, retention = 2, retentionSeconds?: number) {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: pathToFileURL(path).href })
  const store = ctx.plugin(DatabaseUpdateStore, {
    retention,
    ...(retentionSeconds === undefined ? {} : { retentionSeconds }),
  })
  let updateStore!: UpdateStoreBackend
  let storeService!: DatabaseUpdateStore
  let databaseService!: DatabaseService
  const consumer = Object.assign((consumerCtx: Context) => {
    updateStore = consumerCtx.updateStore
    storeService = consumerCtx.updateStore as DatabaseUpdateStore
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
    store: storeService,
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

    await second.updateStore.claim('a-3', 1_700_000_000)
    expect(await second.updateStore.get('a-3')).toMatchObject({ claimedAt: 1_700_000_000 })

    await second.updateStore.remove('a-2')
    expect(await second.updateStore.get('a-2')).toBeUndefined()
    expect((await second.updateStore.getAfter('a', 'account', 1, 10)).map((row) => row.eventKey))
      .toEqual(['a-3'])
  })

  it('aggregates changed channel scopes and pages the date scan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-update-store-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const { updateStore } = await start(join(directory, 'updates.sqlite'), 100)
    const payload = { _: 'updates', updates: [], users: [], chats: [] }
    const withPayload = async (eventKey: string, pts: number, scope: string) => {
      await updateStore.create(delivery(eventKey, 'a', pts, scope))
      await updateStore.setPayload(eventKey, payload)
    }

    await withPayload('account-1', 2, 'account')
    await withPayload('alpha-1', 2, 'channel:10')
    await withPayload('alpha-2', 3, 'channel:10')
    await withPayload('beta-1', 2, 'channel:11')
    // A reservation whose payload is not durable yet is not announced.
    await updateStore.create({ ...delivery('pending', 'a', 4, 'channel:12'), date: 104 })

    // One grouped row per changed channel: the row count follows the channels,
    // never the number of deliveries they retain.
    expect(await updateStore.getChangedChannelScopes('a', 0)).toEqual([
      { scope: 'channel:10', pts: 3, firstDeliveryId: 2 },
      { scope: 'channel:11', pts: 2, firstDeliveryId: 4 },
    ])
    expect(await updateStore.getChangedChannelScopes('a', 105)).toEqual([])
    // The date scan is a page, so a cursor from days ago cannot load the journal.
    expect((await updateStore.getSince('a', 0, 2)).map((row) => row.eventKey))
      .toEqual(['account-1', 'alpha-1'])
    expect(await updateStore.getSince('a', 0, 0)).toEqual([])
  })

  it('drops deliveries past the age cap and keeps the ones inside it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-update-store-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    // `delivery()` stamps `date = 100 + pts`, so the cap is measured on the same
    // synthetic timeline: 100 seconds of retention from t=203s keeps date 103+.
    const { updateStore, store } = await start(join(directory, 'updates.sqlite'), 100, 100)
    await updateStore.create(delivery('old', 'a', 2))
    await updateStore.create(delivery('edge', 'a', 3))
    await updateStore.create(delivery('fresh', 'a', 4))

    expect(await store.pruneExpired(203_000)).toBe(1)
    expect(await updateStore.get('old')).toBeUndefined()
    expect(await updateStore.get('edge')).toBeDefined()
    expect(await updateStore.get('fresh')).toBeDefined()
    // Sweeping again with the same clock removes nothing, and moving the clock
    // past the whole journal clears it.
    expect(await store.pruneExpired(203_000)).toBe(0)
    expect(await store.pruneExpired(600_000)).toBe(2)
    expect(await updateStore.get('edge')).toBeUndefined()
    expect(await updateStore.get('fresh')).toBeUndefined()
  })

  it('keeps every delivery when the age cap is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-update-store-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const { updateStore, store } = await start(join(directory, 'updates.sqlite'), 100, 0)
    await updateStore.create(delivery('old', 'a', 2))

    expect(await store.pruneExpired(600_000)).toBe(0)
    expect(await updateStore.get('old')).toBeDefined()
  })
})
