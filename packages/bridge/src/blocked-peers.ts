import type { Database } from '@cordisjs/plugin-database'
import type { IMMessage, IMReactionContext } from './platform.js'
import type { MessageStore } from './message-store.js'
import type { BlockedPeerRow } from './models.js'

export type BlockedContentMode = 'show' | 'hide-user' | 'hide-related'

export interface BlockedPeerChange {
  changed: boolean
  row?: BlockedPeerRow
}

/** Durable Telegram blocklist plus the bridge-specific content visibility policy. */
export class BlockedPeerStore {
  private readonly _blocked = new Map<string, Set<string>>()
  private readonly _loading = new Map<string, Promise<Set<string>>>()

  constructor(
    private readonly _database: Database,
    readonly mode: BlockedContentMode = 'hide-user',
  ) {}

  async ensureLoaded(platformSessionId: string): Promise<Set<string>> {
    const cached = this._blocked.get(platformSessionId)
    if (cached) return cached
    const pending = this._loading.get(platformSessionId)
    if (pending) return pending
    const loading = this._database.get('mtproto_blocked_peer', { platformSessionId })
      .then((rows) => {
        const result = new Set(rows.map((row) => row.platformUserId))
        this._blocked.set(platformSessionId, result)
        return result
      })
      .finally(() => this._loading.delete(platformSessionId))
    this._loading.set(platformSessionId, loading)
    return loading
  }

  async block(platformSessionId: string, platformUserId: string): Promise<BlockedPeerChange> {
    const blocked = await this.ensureLoaded(platformSessionId)
    if (blocked.has(platformUserId)) {
      const [row] = await this._database.get('mtproto_blocked_peer', {
        platformSessionId, platformUserId,
      })
      return { changed: false, row }
    }
    const row = {
      platformSessionId, platformUserId, blockedAt: new Date(),
    }
    await this._database.upsert('mtproto_blocked_peer', [row], ['platformSessionId', 'platformUserId'])
    blocked.add(platformUserId)
    const [persisted] = await this._database.get('mtproto_blocked_peer', {
      platformSessionId, platformUserId,
    })
    return { changed: true, row: persisted }
  }

  async unblock(platformSessionId: string, platformUserId: string): Promise<BlockedPeerChange> {
    const blocked = await this.ensureLoaded(platformSessionId)
    if (!blocked.has(platformUserId)) return { changed: false }
    const [row] = await this._database.get('mtproto_blocked_peer', {
      platformSessionId, platformUserId,
    })
    await this._database.remove('mtproto_blocked_peer', { platformSessionId, platformUserId })
    blocked.delete(platformUserId)
    return { changed: true, row }
  }

  async list(platformSessionId: string): Promise<BlockedPeerRow[]> {
    await this.ensureLoaded(platformSessionId)
    return this._database.select('mtproto_blocked_peer', { platformSessionId })
      .orderBy('blockedAt', 'desc').execute()
  }

  isBlocked(platformSessionId: string, platformUserId: string): boolean {
    return this._blocked.get(platformSessionId)?.has(platformUserId) ?? false
  }

  async hidesMessage(
    platformSessionId: string,
    message: IMMessage,
    store?: Pick<MessageStore, 'findReplyTarget'>,
  ): Promise<boolean> {
    await this.ensureLoaded(platformSessionId)
    if (this.mode === 'show') return false
    if (this.isBlocked(platformSessionId, message.senderId)) return true
    if (this.mode !== 'hide-related') return false
    if (message.content.parts.some((part) => part.type === 'text'
      && part.entities?.some((entity) => entity.type === 'mention'
        && this.isBlocked(platformSessionId, entity.userId)))) return true
    const replied = await store?.findReplyTarget(platformSessionId, message)
    return replied ? this.isBlocked(platformSessionId, replied.source.senderId) : false
  }

  filterReactionContext(
    platformSessionId: string,
    context: IMReactionContext | undefined,
  ): IMReactionContext | undefined {
    if (!context || this.mode === 'show') return context
    const reactions = context.reactions.flatMap((summary) => {
      const actors = summary.recentActors ?? []
      const blockedActors = actors.filter((actor) => this.isBlocked(platformSessionId, actor.userId)).length
      const count = Math.max(0, summary.count - blockedActors)
      if (!count) return []
      return [{
        ...summary,
        count,
        recentActors: actors.length
          ? actors.filter((actor) => !this.isBlocked(platformSessionId, actor.userId))
          : summary.recentActors,
      }]
    })
    return { ...context, reactions }
  }

  filterMessageReactions(platformSessionId: string, message: IMMessage): IMMessage {
    const reactionContext = this.filterReactionContext(platformSessionId, message.reactionContext)
    return reactionContext === message.reactionContext ? message : { ...message, reactionContext }
  }
}
