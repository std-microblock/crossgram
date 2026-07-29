import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { BlockedPeerStore } from './blocked-peers.js'
import { defineModels } from './models.js'
import type { IMMessage } from './platform.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore(mode: ConstructorParameters<typeof BlockedPeerStore>[1] = 'hide-user') {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store: new BlockedPeerStore(ctx.database, mode) }
}

function message(overrides: Partial<IMMessage> = {}): IMMessage {
  return {
    id: 'message', conversationId: 'group', senderId: 'alice', timestamp: 1_700_000_000,
    content: { parts: [{ type: 'text', text: 'hello' }] },
    ...overrides,
  }
}

describe('BlockedPeerStore', () => {
  it('persists block and unblock state per platform session', async () => {
    const { ctx, store } = await createStore()

    await expect(store.block('session-a', 'alice')).resolves.toMatchObject({ changed: true })
    await expect(store.block('session-a', 'alice')).resolves.toMatchObject({ changed: false })
    await store.block('session-b', 'bob')

    const resumed = new BlockedPeerStore(ctx.database)
    await resumed.ensureLoaded('session-a')
    await resumed.ensureLoaded('session-b')
    expect(resumed.isBlocked('session-a', 'alice')).toBe(true)
    expect(resumed.isBlocked('session-a', 'bob')).toBe(false)
    expect(resumed.isBlocked('session-b', 'bob')).toBe(true)
    await expect(resumed.unblock('session-a', 'alice')).resolves.toMatchObject({ changed: true })
    await expect(resumed.list('session-a')).resolves.toEqual([])
  })

  it('hides blocked senders and removes their known reaction actors', async () => {
    const { store } = await createStore('hide-user')
    await store.block('session', 'alice')
    const source = message({
      senderId: 'bob',
      reactionContext: {
        available: [{ key: 'like', presentation: { type: 'emoji', emoticon: '👍' } }],
        maxSelected: 1,
        reactions: [{
          key: 'like', count: 3,
          recentActors: [{ userId: 'alice' }, { userId: 'carol' }],
        }],
      },
    })

    await expect(store.hidesMessage('session', message())).resolves.toBe(true)
    await expect(store.hidesMessage('session', source)).resolves.toBe(false)
    expect(store.filterReactionContext('session', source.reactionContext)).toMatchObject({
      reactions: [{ key: 'like', count: 2, recentActors: [{ userId: 'carol' }] }],
    })
  })

  it('strict mode additionally hides mentions and replies targeting blocked users', async () => {
    const { ctx, store } = await createStore('hide-related')
    await store.block('session', 'alice')
    const mention = message({
      senderId: 'bob',
      content: {
        parts: [{
          type: 'text', text: '@Alice ping',
          entities: [{ type: 'mention', offset: 0, length: 6, userId: 'alice' }],
        }],
      },
    })
    const reply = message({ senderId: 'bob', replyToId: 'blocked-message' })
    const replyStore = {
      async findReplyTarget() {
        return { source: message({ id: 'blocked-message' }), parts: [], media: [] }
      },
    }

    await expect(store.hidesMessage('session', mention)).resolves.toBe(true)
    await expect(store.hidesMessage('session', reply, replyStore)).resolves.toBe(true)
    const visibleMode = new BlockedPeerStore(ctx.database, 'show')
    await visibleMode.ensureLoaded('session')
    await expect(visibleMode.hidesMessage('session', mention, replyStore)).resolves.toBe(false)
  })
})
