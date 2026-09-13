import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry } from './platform-manager.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { UpdateManager } from './update-manager.js'

const session: PlatformSession = {
  platformSessionId: 'fanout-session', platformId: 'fanout-platform', userId: 'self',
  credentials: {}, metadata: { firstName: 'Current' }, virtualPhone: '888000000000001',
}

const DESKTOP_KEY = '0011223344556677'
const MOBILE_KEY = '8899aabbccddeeff'

const platform: IMPlatform = {
  capabilities: {
    history: false,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
  },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  // Two authorized devices (distinct permanent auth keys) on one platform session.
  for (const authKeyId of [DESKTOP_KEY, MOBILE_KEY]) {
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId, platformId: session.platformId, platformSessionId: session.platformSessionId,
    })
  }
  // Connections currently reachable per device; a device drops out by being removed.
  const online = new Set([DESKTOP_KEY, MOBILE_KEY])
  const sent: Array<{ authKeyId: string, update: tl.TypeUpdates }> = []
  const store = new MessageStore(ctx.database)
  const manager = new UpdateManager(
    ctx.database, new PlatformRegistry([[session.platformId, platform]]), store,
    (authKeyId, update) => {
      const hex = Buffer.from(authKeyId).toString('hex')
      if (!online.has(hex)) return 0
      sent.push({ authKeyId: hex, update })
      return 1
    },
  )
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store, manager, sent, online }
}

async function publishIncoming(store: MessageStore, manager: UpdateManager, text: string) {
  const conversation: IMConversation = { id: 'fanout', kind: 'direct', title: 'Fanout' }
  const message: IMMessage = {
    id: `fanout-${text}`, conversationId: conversation.id, senderId: 'alice', timestamp: 100,
    content: { parts: [{ type: 'text', text }] },
  }
  const result = await store.ingest(session, conversation, message)
  await manager.publish(session, { event: { type: 'message', conversation, message }, result })
}

describe('multi-device update fan-out', () => {
  it('leaves the row pending when one device is offline and replays it on return', async () => {
    const { store, manager, sent, online } = await createHarness()
    online.delete(MOBILE_KEY)

    await publishIncoming(store, manager, 'to desktop only')

    // The reachable device got the push; the offline one did not.
    expect(sent.map(({ authKeyId }) => authKeyId)).toEqual([DESKTOP_KEY])
    // A partial fan-out must not be recorded as published, or the offline
    // device could never be caught up by a replay.
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId))
      .toHaveLength(1)

    online.add(MOBILE_KEY)
    await expect(manager.retryPending(session.platformSessionId)).resolves.toBe(1)
    // Replay is per row, not per device, so the already-caught-up desktop gets
    // a second copy. That is safe: the client sees a pts it has already
    // applied and ignores it.
    expect(sent.filter(({ authKeyId }) => authKeyId === MOBILE_KEY)).toHaveLength(1)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(0)
  })

  it('records the row as published once every device has taken the push', async () => {
    const { store, manager, sent } = await createHarness()

    await publishIncoming(store, manager, 'to both devices')

    expect(sent.map(({ authKeyId }) => authKeyId).sort()).toEqual([DESKTOP_KEY, MOBILE_KEY].sort())
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(0)
  })

  it('keeps replaying past a row that still cannot reach an offline device', async () => {
    const { store, manager, sent, online } = await createHarness()
    online.delete(MOBILE_KEY)

    await publishIncoming(store, manager, 'first')
    await publishIncoming(store, manager, 'second')
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(2)

    // The mobile device is still away: both rows stay pending and neither run
    // should stop the other from being retried.
    await expect(manager.retryPending(session.platformSessionId)).resolves.toBe(0)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(2)

    online.add(MOBILE_KEY)
    await expect(manager.retryPending(session.platformSessionId)).resolves.toBe(2)
    expect(sent.filter(({ authKeyId }) => authKeyId === MOBILE_KEY)).toHaveLength(2)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(0)
  })
})
