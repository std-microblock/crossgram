import type { Database } from '@cordisjs/plugin-database'
import type { PlatformSessionRow } from './models.js'
import { MessageStore } from './message-store.js'
import type {
  IMConversation, IMDialog, IMEvent, IMHistoryPage, IMHistoryQuery, IMPlatform, PlatformSession, Unsubscribe,
} from './platform.js'

export class PlatformRegistry {
  private readonly _platforms = new Map<string, IMPlatform>()

  constructor(platforms: readonly IMPlatform[]) {
    for (const platform of platforms) {
      if (this._platforms.has(platform.id)) throw new Error(`duplicate IM platform ID: ${platform.id}`)
      this._platforms.set(platform.id, platform)
    }
  }

  get(id: string): IMPlatform | undefined {
    return this._platforms.get(id)
  }

  get ids(): string[] {
    return [...this._platforms.keys()]
  }

  require(id: string): IMPlatform {
    const platform = this.get(id)
    if (!platform) throw new Error(`IM platform is not registered: ${id}`)
    return platform
  }
}

/** Owns one durable event subscription per active platform session. */
export class PlatformSubscriptionManager {
  private readonly _subscriptions = new Map<string, Promise<Unsubscribe>>()
  private readonly _eventQueues = new Map<string, Promise<void>>()

  constructor(
    private readonly _database: Database,
    private readonly _registry: PlatformRegistry,
    private readonly _store: MessageStore,
    private readonly _onError: (error: unknown, session?: PlatformSession) => void = () => {},
  ) {}

  async startActiveSessions(): Promise<void> {
    const rows = await this._database.get('mtproto_platform_session', { active: true })
    await Promise.all(rows.map(async (row) => {
      const session = sessionFromRow(row)
      try {
        await this.ensure(session)
      } catch (error) {
        this._onError(error, session)
      }
    }))
  }

  async ensure(session: PlatformSession): Promise<void> {
    const existing = this._subscriptions.get(session.platformSessionId)
    if (existing) {
      await existing
      return
    }
    const platform = this._registry.require(session.platformId)
    const pending = platform.subscribe(session, (event) => this._enqueue(session, event))
    this._subscriptions.set(session.platformSessionId, pending)
    try {
      await pending
    } catch (error) {
      if (this._subscriptions.get(session.platformSessionId) === pending) {
        this._subscriptions.delete(session.platformSessionId)
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const subscriptions = [...this._subscriptions.values()]
    this._subscriptions.clear()
    const queues = [...this._eventQueues.values()]
    await Promise.allSettled(queues)
    const unsubscribes = await Promise.allSettled(subscriptions)
    await Promise.allSettled(unsubscribes.map(async (result) => {
      if (result.status === 'fulfilled') await result.value()
    }))
  }

  private _enqueue(session: PlatformSession, event: IMEvent): Promise<void> {
    const key = session.platformSessionId
    const previous = this._eventQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this._ingestEvent(session, event))
    this._eventQueues.set(key, current)
    current.catch((error) => this._onError(error, session)).finally(() => {
      if (this._eventQueues.get(key) === current) this._eventQueues.delete(key)
    })
    return current
  }

  private async _ingestEvent(session: PlatformSession, event: IMEvent): Promise<void> {
    if (event.type === 'conversation') {
      await this._store.upsertConversation(session, event.conversation)
    } else if (event.type === 'message') {
      await this._store.ingest(session, event.conversation, event.message)
    }
  }
}

/** Synchronizes optional upstream history into the canonical database before reads. */
export class PlatformDataService {
  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    private readonly _store: MessageStore,
  ) {}

  async getDialogs(query: { limit?: number, afterId?: string } = {}): Promise<IMDialog[]> {
    if (this._platform.capabilities.history && this._platform.getDialogs) {
      const page = await this._platform.getDialogs(this._session, query)
      await this._ingestDialogs(page.dialogs)
    }
    return this._store.listDialogs(this._session.platformSessionId, {
      limit: query.limit,
      afterConversationId: query.afterId,
    })
  }

  async getHistory(conversationId: string, query: IMHistoryQuery = { limit: 100 }): Promise<IMHistoryPage> {
    let conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    if (!conversation) {
      await this.getDialogs()
      conversation = await this._store.getConversation(this._session.platformSessionId, conversationId)
    }
    conversation ??= { id: conversationId, kind: 'direct', title: conversationId }

    if (this._platform.capabilities.history && this._platform.getHistory) {
      const page = await this._platform.getHistory(this._session, { id: conversationId }, query)
      for (const message of page.messages.slice().sort((left, right) => right.timestamp - left.timestamp)) {
        await this._store.ingest(this._session, conversation, message, { allocation: 'history' })
      }
    }
    return {
      messages: await this._store.readHistory(
        this._session.platformSessionId, conversationId, { limit: query.limit ?? 100 },
      ),
    }
  }

  private async _ingestDialogs(dialogs: readonly IMDialog[]): Promise<void> {
    for (const dialog of dialogs) {
      await this._store.upsertConversation(this._session, dialog.conversation, dialog.unreadCount)
      if (dialog.lastMessage) await this._store.ingest(this._session, dialog.conversation, dialog.lastMessage)
    }
  }
}

export function sessionFromRow(row: PlatformSessionRow): PlatformSession {
  return {
    platformSessionId: row.id,
    platformId: row.platformId,
    userId: row.userId,
    credentials: row.credentials,
    metadata: row.metadata,
  }
}
