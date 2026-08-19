import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { describe, expect, it, vi } from 'vitest'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import { PlatformDataService } from './platform-manager.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformId: 'history-performance',
  platformSessionId: 'history-performance-session',
  userId: 'self',
  credentials: {},
  metadata: {},
}

function message(id: number, conversationId: string): IMMessage {
  return {
    id: String(id),
    sourceIds: [`native-${id}`],
    conversationId,
    senderId: `sender-${id % 5}`,
    timestamp: id,
    content: { parts: [{ type: 'text', text: `message ${id}` }] },
  }
}

describe('history read performance e2e', () => {
  it('shares only the active upstream read and persists a large page through real SQLite', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()

    const conversation: IMConversation = { id: 'room', kind: 'group', title: 'Room' }
    const firstPage = Array.from({ length: 50 }, (_, index) => message(index + 1, conversation.id))
    const release = Promise.withResolvers<void>()
    const getHistory = vi.fn(async () => {
      await release.promise
      return { messages: firstPage.slice().reverse() }
    })
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      getHistory,
    }
    const store = new MessageStore(ctx.database)
    await store.upsertConversation(session, conversation)
    const data = new PlatformDataService(platform, session, store)

    try {
      const reads = Promise.all([
        data.syncHistory(conversation.id, { limit: 50 }),
        data.syncHistory(conversation.id, { limit: 50 }),
        data.syncHistory(conversation.id, { limit: 50 }),
      ])
      await vi.waitFor(() => expect(getHistory).toHaveBeenCalledOnce())
      release.resolve()
      await reads

      expect(await store.readHistory(session.platformSessionId, conversation.id, { limit: 50 }))
        .toMatchObject(firstPage.slice().reverse().map((source) => ({ id: source.id })))

      await data.syncHistory(conversation.id, { limit: 50 })
      expect(getHistory).toHaveBeenCalledTimes(2)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
})
