import type { Database } from '@cordisjs/plugin-database'
import type {
  IMConversationRow, IMMediaRow, IMMessageAliasRow, IMMessageRow, TlMessagePartRow,
} from './models.js'
import {
  messageMedia, messageText,
  type IMConversation, type IMDialog, type IMMessage, type IMMessageContent, type JsonValue, type PlatformSession,
} from './platform.js'

export interface IngestResult {
  message: IMMessageRow
  created: boolean
  changed: boolean
  projection: TlMessagePartRow[]
}

export interface DeleteResult {
  changed: boolean
  messageIds: number[]
  tlMessageIds: number[]
}

export interface ProjectedMessage {
  source: IMMessage
  parts: TlMessagePartRow[]
  media: IMMediaRow[]
}

export interface StoredMedia {
  media: import('./platform.js').IMMedia
  timestamp: number
}

export interface IngestOptions {
  allocation?: 'live' | 'history'
}

export interface StoredHistoryQuery {
  limit: number
  beforeTimestamp?: number
  maxTimestamp?: number
}

const MESSAGE_ID_MIDPOINT = 0x40000000

/** Durable canonical store shared by history sync, push ingestion, and sends. */
export class MessageStore {
  private _writeTail = Promise.resolve()

  constructor(private readonly _database: Database) {}

  async ingest(
    session: PlatformSession,
    conversation: IMConversation,
    source: IMMessage,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    if (source.conversationId !== conversation.id) {
      throw new Error('message conversation does not match ingestion target')
    }

    return this._write(() => this._database.withTransaction(async (database) => {
      const now = new Date()
      const conversationRow = await this._upsertConversation(database, session, conversation, undefined, now)
      if (!conversationRow) throw new Error('failed to persist conversation')

      const sourceIds = [...new Set([source.id, ...(source.sourceIds ?? [])])]
      let existingAlias: IMMessageAliasRow | undefined
      for (const platformMessageId of sourceIds) {
        ;[existingAlias] = await database.get('mtproto_im_message_alias', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          platformMessageId,
        })
        if (existingAlias) break
      }

      let message: IMMessageRow | undefined
      if (existingAlias) {
        ;[message] = await database.get('mtproto_im_message', { id: existingAlias.messageId })
      } else {
        ;[message] = await database.get('mtproto_im_message', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          primaryPlatformMessageId: source.id,
        })
      }

      const created = !message
      const changed = !message || (!message.deleted && (
        message.senderPlatformUserId !== source.senderId
        || message.text !== messageText(source)
        || JSON.stringify(message.content) !== JSON.stringify(source.content)
        || message.timestamp !== source.timestamp
        || message.outgoing !== (source.outgoing ?? false)
        || message.platformGroupId !== (source.groupId ?? null)
        || JSON.stringify(message.metadata) !== JSON.stringify(source.metadata ?? {})
      ))
      if (!message) {
        message = await database.create('mtproto_im_message', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          primaryPlatformMessageId: source.id,
          senderPlatformUserId: source.senderId,
          text: messageText(source),
          content: source.content as unknown as JsonValue,
          timestamp: source.timestamp,
          outgoing: source.outgoing ?? false,
          deleted: false,
          platformGroupId: source.groupId ?? null,
          metadata: source.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        })
      } else {
        await database.set('mtproto_im_message', { id: message.id }, {
          senderPlatformUserId: source.senderId,
          text: messageText(source),
          content: source.content as unknown as JsonValue,
          timestamp: source.timestamp,
          outgoing: source.outgoing ?? false,
          platformGroupId: source.groupId ?? null,
          metadata: source.metadata ?? {},
          updatedAt: now,
        })
        ;[message] = await database.get('mtproto_im_message', { id: message.id })
        if (!message) throw new Error('message disappeared during ingestion')
      }

      await database.upsert('mtproto_im_message_alias', sourceIds.map((platformMessageId, ordinal) => ({
        platformSessionId: session.platformSessionId,
        conversationId: conversationRow.id,
        platformMessageId,
        messageId: message!.id,
        ordinal,
      })), ['platformSessionId', 'conversationId', 'platformMessageId'])

      const media = messageMedia(source)
      await database.upsert('mtproto_im_media', media.map((item, ordinal) => ({
        messageId: message!.id,
        ordinal,
        partIndex: source.content.parts.findIndex((part) => part.type === 'media' && part.media === item),
        platformMediaId: item.id,
        kind: item.kind,
        name: item.name ?? null,
        mimeType: item.mimeType ?? null,
        size: item.size ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        locator: item.locator ?? null,
      })), ['messageId', 'ordinal'])

      let storedMedia = await database.select('mtproto_im_media', { messageId: message.id })
        .orderBy('ordinal').execute()
      for (const stale of storedMedia.filter((item) => item.ordinal >= media.length)) {
        await database.remove('mtproto_im_media', { id: stale.id })
      }
      storedMedia = storedMedia.filter((item) => item.ordinal < media.length)
      const projection = await this._ensureProjection(
        database, session.platformSessionId, conversationRow, message, storedMedia,
        options.allocation ?? 'live',
      )

      return { message, created, changed, projection }
    }))
  }

  async deleteMessages(
    session: PlatformSession,
    conversation: IMConversation,
    platformMessageIds: readonly string[],
  ): Promise<DeleteResult> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const conversationRow = await this._upsertConversation(database, session, conversation, undefined, new Date())
      const messageIds = new Set<number>()
      for (const platformMessageId of new Set(platformMessageIds)) {
        const [alias] = await database.get('mtproto_im_message_alias', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          platformMessageId,
        })
        if (alias) messageIds.add(alias.messageId)
      }

      const deletedMessageIds: number[] = []
      const tlMessageIds: number[] = []
      for (const messageId of messageIds) {
        const [message] = await database.get('mtproto_im_message', { id: messageId })
        if (!message) continue
        if (!message.deleted) {
          await database.set('mtproto_im_message', { id: messageId }, { deleted: true, updatedAt: new Date() })
          deletedMessageIds.push(messageId)
        }
        const parts = await database.select('mtproto_tl_message_part', { messageId })
          .orderBy('ordinal').execute()
        tlMessageIds.push(...parts.map((part) => part.tlMessageId))
      }
      return {
        changed: deletedMessageIds.length > 0,
        messageIds: deletedMessageIds,
        tlMessageIds,
      }
    }))
  }

  async upsertConversation(
    session: PlatformSession,
    conversation: IMConversation,
    unreadCount?: number,
  ): Promise<IMConversationRow> {
    return this._write(() => this._database.withTransaction((database) =>
      this._upsertConversation(database, session, conversation, unreadCount, new Date())))
  }

  async listDialogs(
    platformSessionId: string,
    query: { limit?: number, afterConversationId?: string } = {},
  ): Promise<IMDialog[]> {
    const limit = clampDatabaseLimit(query.limit ?? 100)
    const [anchor] = query.afterConversationId
      ? await this._database.get('mtproto_im_conversation', {
          platformSessionId, platformConversationId: query.afterConversationId,
        })
      : []
    let conversations = await this._database.select('mtproto_im_conversation', {
      platformSessionId,
      ...(anchor ? { updatedAt: { $lte: anchor.updatedAt } } : {}),
    }).orderBy('updatedAt', 'desc').limit(limit + (anchor ? 1 : 0)).execute()
    if (anchor) conversations = conversations.filter((item) => item.id !== anchor.id)
    conversations = conversations.slice(0, limit)
    return Promise.all(conversations.map(async (conversation) => {
      const [latest] = await this._database.select('mtproto_im_message', {
        conversationId: conversation.id, deleted: false,
      })
        .orderBy('timestamp', 'desc').limit(1).execute()
      return {
        conversation: toConversation(conversation),
        unreadCount: conversation.unreadCount,
        lastMessage: latest ? await this._hydrateMessage(latest) : undefined,
      }
    }))
  }

  async readHistory(
    platformSessionId: string,
    platformConversationId: string,
    query: StoredHistoryQuery = { limit: 100 },
  ): Promise<IMMessage[]> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return []
    const rows = await this._database.select('mtproto_im_message', {
      conversationId: conversation.id,
      deleted: false,
      ...(query.beforeTimestamp === undefined ? {} : { timestamp: { $lt: query.beforeTimestamp } }),
      ...(query.maxTimestamp === undefined ? {} : { timestamp: { $lte: query.maxTimestamp } }),
    }).orderBy('timestamp', 'desc').limit(clampDatabaseLimit(query.limit)).execute()
    return Promise.all(rows.map((row) => this._hydrateMessage(row)))
  }

  async readProjectedHistory(
    platformSessionId: string,
    platformConversationId: string,
    query: StoredHistoryQuery = { limit: 100 },
  ): Promise<ProjectedMessage[]> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return []
    const rows = await this._database.select('mtproto_im_message', {
      conversationId: conversation.id,
      deleted: false,
      ...(query.beforeTimestamp === undefined ? {} : { timestamp: { $lt: query.beforeTimestamp } }),
      ...(query.maxTimestamp === undefined ? {} : { timestamp: { $lte: query.maxTimestamp } }),
    }).orderBy('timestamp', 'desc').limit(clampDatabaseLimit(query.limit)).execute()
    return Promise.all(rows.map(async (row) => ({
      source: await this._hydrateMessage(row),
      parts: await this._database.select('mtproto_tl_message_part', { messageId: row.id })
        .orderBy('ordinal').execute(),
      media: await this._database.select('mtproto_im_media', { messageId: row.id })
        .orderBy('ordinal').execute(),
    })))
  }

  async findProjectedByTlId(
    platformSessionId: string,
    tlMessageId: number,
    platformConversationId?: string,
  ): Promise<ProjectedMessage | undefined> {
    let conversationId: number | undefined
    if (platformConversationId) {
      const [conversation] = await this._database.get('mtproto_im_conversation', {
        platformSessionId, platformConversationId,
      })
      if (!conversation) return
      conversationId = conversation.id
    }
    const [part] = await this._database.get('mtproto_tl_message_part', {
      platformSessionId,
      tlMessageId,
      ...(conversationId === undefined ? {} : { conversationId }),
    })
    if (!part) return
    const [row] = await this._database.get('mtproto_im_message', { id: part.messageId })
    if (!row || row.deleted) return
    return {
      source: await this._hydrateMessage(row),
      parts: await this._database.select('mtproto_tl_message_part', { messageId: row.id })
        .orderBy('ordinal').execute(),
      media: await this._database.select('mtproto_im_media', { messageId: row.id })
        .orderBy('ordinal').execute(),
    }
  }

  async getMedia(platformSessionId: string, mediaId: number): Promise<StoredMedia | undefined> {
    const [row] = await this._database.get('mtproto_im_media', { id: mediaId })
    if (!row) return
    const [message] = await this._database.get('mtproto_im_message', {
      id: row.messageId, platformSessionId,
    })
    if (!message) return
    return {
      media: {
        id: row.platformMediaId,
        kind: row.kind,
        name: row.name ?? undefined,
        mimeType: row.mimeType ?? undefined,
        size: row.size ?? undefined,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        locator: row.locator,
      },
      timestamp: message.timestamp,
    }
  }

  async getUpdateState(platformSessionId: string) {
    const [state] = await this._database.get('mtproto_update_state', { platformSessionId })
    return state ?? {
      platformSessionId, pts: 1, qts: 0, seq: 0, date: Math.floor(Date.now() / 1000),
    }
  }

  async advanceUpdateState(platformSessionId: string, ptsCount: number, date: number) {
    return this._write(() => this._database.withTransaction(async (database) => {
      const [current] = await database.get('mtproto_update_state', { platformSessionId })
      const state = {
        platformSessionId,
        pts: (current?.pts ?? 1) + ptsCount,
        qts: current?.qts ?? 0,
        seq: (current?.seq ?? 0) + 1,
        date,
      }
      await database.upsert('mtproto_update_state', [state])
      return state
    }))
  }

  async prepareUpdateDelivery(eventKey: string, platformSessionId: string, ptsCount: number, date: number) {
    return this._write(() => this._database.withTransaction(async (database) => {
      const [existing] = await database.get('mtproto_update_delivery', { eventKey })
      if (existing) return existing
      const [current] = await database.get('mtproto_update_state', { platformSessionId })
      const state = {
        platformSessionId,
        pts: (current?.pts ?? 1) + ptsCount,
        qts: current?.qts ?? 0,
        seq: (current?.seq ?? 0) + 1,
        date,
      }
      await database.upsert('mtproto_update_state', [state])
      return database.create('mtproto_update_delivery', {
        eventKey, platformSessionId, pts: state.pts, ptsCount, seq: state.seq, date, published: false,
      })
    }))
  }

  async getUpdateDelivery(eventKey: string) {
    const [delivery] = await this._database.get('mtproto_update_delivery', { eventKey })
    return delivery
  }

  async markUpdatePublished(eventKey: string): Promise<void> {
    await this._write(async () => {
      await this._database.set('mtproto_update_delivery', { eventKey }, { published: true })
    })
  }

  async getConversation(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<IMConversation | undefined> {
    const [row] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    return row ? toConversation(row) : undefined
  }

  async findByExternalId(
    platformSessionId: string,
    platformConversationId: string,
    platformMessageId: string,
  ): Promise<IMMessageRow | undefined> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return
    const [alias] = await this._database.get('mtproto_im_message_alias', {
      platformSessionId, conversationId: conversation.id, platformMessageId,
    })
    if (!alias) return
    const [message] = await this._database.get('mtproto_im_message', { id: alias.messageId })
    return message
  }

  async allocateIds(scope: string, count: number): Promise<number[]> {
    if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('count must be a positive integer')
    return this._write(() => this._database.withTransaction(async (database) => {
      return this._allocateIds(database, scope, count)
    }))
  }

  private async _upsertConversation(
    database: Database,
    session: PlatformSession,
    conversation: IMConversation,
    unreadCount: number | undefined,
    now: Date,
  ): Promise<IMConversationRow> {
    const [existing] = await database.get('mtproto_im_conversation', {
      platformSessionId: session.platformSessionId,
      platformConversationId: conversation.id,
    })
    await database.upsert('mtproto_im_conversation', [{
      platformSessionId: session.platformSessionId,
      platformConversationId: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      parentPlatformConversationId: conversation.parentId ?? null,
      spacePlatformId: conversation.spaceId ?? null,
      metadata: conversation.metadata ?? {},
      unreadCount: unreadCount ?? existing?.unreadCount ?? 0,
      updatedAt: now,
    }], ['platformSessionId', 'platformConversationId'])
    const [row] = await database.get('mtproto_im_conversation', {
      platformSessionId: session.platformSessionId,
      platformConversationId: conversation.id,
    })
    if (!row) throw new Error('failed to persist conversation')
    return row
  }

  private async _ensureProjection(
    database: Database,
    platformSessionId: string,
    conversation: IMConversationRow,
    message: IMMessageRow,
    media: IMMediaRow[],
    allocation: 'live' | 'history',
  ): Promise<TlMessagePartRow[]> {
    const count = Math.max(1, media.length)
    const scope = conversation.kind === 'channel'
      ? `channel:${platformSessionId}:${conversation.id}`
      : `account:${platformSessionId}`
    const existing = await database.select('mtproto_tl_message_part', { messageId: message.id })
      .orderBy('ordinal').execute()
    let groupedId = existing.find((part) => part.groupedId)?.groupedId ?? null
    if (count > 1 && !groupedId) {
      groupedId = String((await this._allocateIds(database, `group:${platformSessionId}`, 1))[0])
      if (existing.length) await database.set('mtproto_tl_message_part', { messageId: message.id }, { groupedId })
    }
    if (existing.length < count) {
      const ids = await this._allocateMessageIds(database, scope, count - existing.length, allocation)
      await database.upsert('mtproto_tl_message_part', ids.map((tlMessageId, index) => {
        const ordinal = existing.length + index
        return {
          platformSessionId,
          conversationId: conversation.id,
          messageId: message.id,
          mediaId: media[ordinal]?.id ?? null,
          scope,
          tlMessageId,
          groupedId,
          ordinal,
        }
      }), ['messageId', 'ordinal'])
    }
    return database.select('mtproto_tl_message_part', { messageId: message.id }).orderBy('ordinal').execute()
  }

  private async _allocateIds(database: Database, scope: string, count: number): Promise<number[]> {
    const [counter] = await database.get('mtproto_id_counter', { scope })
    const first = counter?.nextId ?? 1
    const nextId = first + count
    if (nextId - 1 > 0x7fffffff) throw new RangeError(`message ID scope exhausted: ${scope}`)
    await database.upsert('mtproto_id_counter', [{ scope, nextId }])
    return Array.from({ length: count }, (_, index) => first + index)
  }

  private async _allocateMessageIds(
    database: Database,
    scope: string,
    count: number,
    allocation: 'live' | 'history',
  ): Promise<number[]> {
    const counterScope = `${allocation}:${scope}`
    const [counter] = await database.get('mtproto_id_counter', { scope: counterScope })
    if (allocation === 'live') {
      const first = counter?.nextId ?? MESSAGE_ID_MIDPOINT
      const nextId = first + count
      if (nextId - 1 > 0x7fffffff) throw new RangeError(`message ID scope exhausted: ${scope}`)
      await database.upsert('mtproto_id_counter', [{ scope: counterScope, nextId }])
      return Array.from({ length: count }, (_, index) => first + index)
    }
    const end = counter?.nextId ?? MESSAGE_ID_MIDPOINT
    const first = end - count
    if (first <= 0) throw new RangeError(`message ID scope exhausted: ${scope}`)
    await database.upsert('mtproto_id_counter', [{ scope: counterScope, nextId: first }])
    return Array.from({ length: count }, (_, index) => first + index)
  }

  private async _hydrateMessage(row: IMMessageRow): Promise<IMMessage> {
    const aliases = await this._database.select('mtproto_im_message_alias', { messageId: row.id })
      .orderBy('ordinal').execute()
    return {
      id: row.primaryPlatformMessageId,
      sourceIds: aliases.map((alias) => alias.platformMessageId),
      conversationId: (await this._conversationId(row.conversationId)),
      senderId: row.senderPlatformUserId,
      content: row.content as unknown as IMMessageContent,
      timestamp: row.timestamp,
      outgoing: row.outgoing,
      groupId: row.platformGroupId ?? undefined,
      metadata: row.metadata,
    }
  }

  private async _conversationId(id: number): Promise<string> {
    const [conversation] = await this._database.get('mtproto_im_conversation', { id })
    if (!conversation) throw new Error(`message references missing conversation ${id}`)
    return conversation.platformConversationId
  }

  private async _write<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this._writeTail
    let release!: () => void
    this._writeTail = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => {})
    try {
      return await callback()
    } finally {
      release()
    }
  }
}

function toConversation(row: IMConversationRow): IMConversation {
  return {
    id: row.platformConversationId,
    kind: row.kind,
    title: row.title,
    parentId: row.parentPlatformConversationId ?? undefined,
    spaceId: row.spacePlatformId ?? undefined,
    metadata: row.metadata,
  }
}

function clampDatabaseLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), 500))
}
