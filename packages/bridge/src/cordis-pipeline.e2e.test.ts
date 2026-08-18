import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { describe, expect, it } from 'vitest'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import { PlatformRegistry, PlatformSubscriptionManager } from './platform-manager.js'
import type {
  IMConversation,
  IMEvent,
  IMMessage,
  IMMessageInput,
  IMPlatform,
  PlatformCapabilities,
  PlatformSession,
  Unsubscribe,
} from './platform.js'

const capabilities: PlatformCapabilities = {
  history: false,
  send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
  conversations: { groups: true, channels: true, subchannels: false },
}

class EventPlatform implements IMPlatform {
  readonly capabilities = capabilities
  unsubscribeCalls = 0
  private handler?: (event: IMEvent) => void | Promise<void>

  async subscribe(_session: PlatformSession, handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe> {
    this.handler = handler
    return async () => {
      this.unsubscribeCalls++
      this.handler = undefined
    }
  }

  async emit(event: IMEvent): Promise<void> {
    if (!this.handler) throw new Error('platform session is not subscribed')
    await this.handler(event)
  }

  async sendMessage(
    _session: PlatformSession,
    conversation: { id: string },
    content: IMMessageInput,
  ): Promise<IMMessage> {
    return {
      id: 'sent', conversationId: conversation.id, senderId: 'self', timestamp: 1,
      outgoing: true, content: content as IMMessage['content'],
    }
  }
}

describe('bridge Cordis event pipeline e2e', () => {
  it('persists, publishes, observes, and unloads one adapter event through nested fibers', async () => {
    const ctx = new Context()
    const databaseFibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
    ]
    await Promise.all(databaseFibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()

    const platform = new EventPlatform()
    const session: PlatformSession = {
      platformId: 'event-platform', platformSessionId: 'event-session', userId: 'self',
      credentials: {}, metadata: {},
    }
    const conversation: IMConversation = { id: 'room', kind: 'group', title: 'Room' }
    const message: IMMessage = {
      id: 'message-1', conversationId: conversation.id, senderId: 'alice', timestamp: 1,
      content: { parts: [{ type: 'text', text: 'hello from the adapter' }] },
    }
    const stages: string[] = []
    const fibers: string[] = []
    ctx.on('bridge/platform-event', async function (_session, _event, _options, next) {
      stages.push('ingest')
      fibers.push(this.fiber.name)
      expect(this.bridgeSession).toEqual({ platform, session })
      expect(this.bridgeEvent.event).toMatchObject({ type: 'message' })
      return next()
    })
    ctx.on('bridge/platform-event/publish', async function (_session, _event, _options, next) {
      stages.push('publish')
      return next()
    })
    ctx.on('im-platform/event-committed', () => {
      stages.push('committed')
    })

    let manager!: PlatformSubscriptionManager
    const bridgeFiber = ctx.plugin(async (bridgeCtx) => {
      manager = new PlatformSubscriptionManager(
        ctx.database,
        new PlatformRegistry([['event-platform', platform]]),
        new MessageStore(ctx.database),
        undefined,
        async () => {
          stages.push('delivered')
          return { _: 'updates', updates: [], users: [], chats: [], date: 1, seq: 1 }
        },
        undefined,
        bridgeCtx,
      )
      await manager.ensure(session)
      return () => manager.stop()
    })
    await bridgeFiber

    try {
      await platform.emit({ type: 'message', conversation, message })

      expect(await new MessageStore(ctx.database).readHistory(session.platformSessionId, conversation.id))
        .toMatchObject([{ id: message.id, content: message.content }])
      expect(stages).toEqual(['ingest', 'publish', 'delivered', 'committed'])
      expect(fibers).toEqual(['platformEventFiber'])

      await bridgeFiber.dispose()
      expect(platform.unsubscribeCalls).toBe(1)
      await expect(platform.emit({ type: 'message', conversation, message })).rejects.toThrow('not subscribed')
    } finally {
      await bridgeFiber.dispose()
      for (const fiber of databaseFibers.reverse()) await fiber.dispose()
    }
  })
})
