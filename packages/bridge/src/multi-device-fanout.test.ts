import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import type { ServerConnection } from '@mtproto-relay/mtproto'
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
  it('recovers an offline device independently even after another device received the live push', async () => {
    const { store, manager, sent, online } = await createHarness()
    online.delete(MOBILE_KEY)
    await publishIncoming(store, manager, 'to desktop only')
    expect(sent.map(({ authKeyId }) => authKeyId)).toEqual([DESKTOP_KEY])
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(0)
    const request = { _: 'updates.getDifference' as const, pts: 1, date: 0, qts: 0 }
    const mobile = await manager.getDifference(session.platformSessionId, request)
    expect(mobile).toMatchObject({ _: 'updates.difference', newMessages: [{ message: 'to desktop only' }] })
    // Published does not consume the journal for other cursors.
    expect(await manager.getDifference(session.platformSessionId, request)).toEqual(mobile)
    expect(sent).toHaveLength(1)
  })

  it('still delivers a new live event once to every online device', async () => {
    const { store, manager, sent } = await createHarness()
    await publishIncoming(store, manager, 'to both devices')
    expect(sent.map(({ authKeyId }) => authKeyId).sort()).toEqual([DESKTOP_KEY, MOBILE_KEY].sort())
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(0)
  })

  it('reconnects in constant work without loading or broadcasting the pending journal', async () => {
    const { store, manager, sent, online } = await createHarness()
    online.clear()
    for (let i = 0; i < 8; i++) await publishIncoming(store, manager, 'offline-' + i)
    expect(await store.getPendingUpdateDeliveries(session.platformSessionId)).toHaveLength(8)
    const loadPending = vi.spyOn(store, 'getPendingUpdateDeliveries').mockRejectedValue(new Error('must not replay globally'))
    online.add(DESKTOP_KEY)
    online.add(MOBILE_KEY)
    const send = vi.fn()
    const callbacks: Array<() => void | Promise<void>> = []
    manager.requestRecovery({
      connection: { closed: false } as ServerConnection,
      sendUpdate: send,
      afterResponse: callback => { callbacks.push(callback) },
    })
    expect(send).not.toHaveBeenCalled()
    expect(callbacks).toHaveLength(1)
    await callbacks[0]()
    expect(send).toHaveBeenCalledExactlyOnceWith({ _: 'updatesTooLong' })
    expect(loadPending).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    const difference = await manager.getDifference(session.platformSessionId, {
      _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
    })
    expect(difference).toMatchObject({ _: 'updates.difference' })
    if (difference._ !== 'updates.difference') throw new Error('missing difference')
    expect(difference.newMessages).toHaveLength(8)
  })

  it('does not notify a transport that closed before its first response', async () => {
    const { manager } = await createHarness()
    const connection = { closed: false }
    const callbacks: Array<() => void | Promise<void>> = []
    const send = vi.fn()
    manager.requestRecovery({ connection: connection as ServerConnection, sendUpdate: send, afterResponse: callback => { callbacks.push(callback) } })
    connection.closed = true
    await callbacks[0]()
    expect(send).not.toHaveBeenCalled()
  })
})
