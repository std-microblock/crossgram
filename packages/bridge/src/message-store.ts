import type { Database } from '@cordisjs/plugin-database'
import type {
  IMConversationRow, IMMediaRow, IMMessageAliasRow, IMMessageReactionRow, IMMessageRow, IMUserRow,
  TlMessagePartRow,
} from './models.js'
import {
  messageMedia, messageText, telegramReplyToMessageId,
  type IMConversation, type IMDialog, type IMMessage, type IMMessageContent, type IMMessageTarget,
  type IMReactionActor, type IMReactionContext, type IMReactionDefinition,
  type IMUser, type JsonObject, type JsonValue, type PlatformSession,
} from './platform.js'
import {
  clampedTimestampMessageIdBucket, initialTimestampMessageIdEpoch, messageIdBucketStart,
  qqMessageSequenceFromMetadata, qqReplySequenceFromMetadata,
  TELEGRAM_MESSAGE_ID_MAX, TIMESTAMP_MESSAGE_ID_SLOTS,
} from './message-id.js'
import { MemoryUpdateDeliveryJournal, type UpdateDeliveryJournal } from './update-journal.js'

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

export interface ReactionResult {
  changed: boolean
  message: IMMessage
  tlMessageIds: number[]
}

export interface ReadResult {
  conversation: IMConversation
  message: IMMessage
  tlMessageId: number
  unreadCount: number
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

export interface StoredMessageLookup {
  conversationId: string
  platformMessageId: string
}

export interface IngestOptions {
  allocation?: 'live' | 'history'
}

interface HistoryIngestPrefetch {
  usersByPlatformId: Map<string, IMUserRow>
  aliasesByPlatformId: Map<string, IMMessageAliasRow>
  messagesById: Map<number, IMMessageRow>
  messagesByPrimaryId: Map<string, IMMessageRow>
  projectionsByMessageId: Map<number, TlMessagePartRow[]>
}

interface ProjectionAllocationCache {
  epochs: Map<string, number>
}

export interface StoredHistoryQuery {
  limit: number
  beforeTimestamp?: number
  minTimestamp?: number
  maxTimestamp?: number
  order?: 'asc' | 'desc'
}

const TIMESTAMP_ALLOCATION_VERSION = 1
export const UPDATE_DELIVERY_RETENTION = 1_000
export const ACCOUNT_UPDATE_SCOPE = 'account'
const STORED_REPLY_TO_KEY = '__mtprotoRelayReplyToId'

/** Durable canonical store shared by history sync, push ingestion, and sends. */
export class MessageStore {
  /** Serialize writes across every store facade sharing the same database. */
  private static readonly _writeTails = new WeakMap<Database, Promise<void>>()
  private _revision = 0
  private readonly _latestMessages = new Map<number, IMMessageRow | undefined>()
  private _dialogCachePreparation?: Promise<void>

  constructor(
    private readonly _database: Database,
    updateDeliveryRetention = UPDATE_DELIVERY_RETENTION,
    private readonly _updateJournal: UpdateDeliveryJournal = new MemoryUpdateDeliveryJournal(updateDeliveryRetention),
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
  ) {}

  /** Monotonic process-local version used to invalidate materialized read caches. */
  get revision(): number {
    return this._revision
  }

  async prepareDialogCache(): Promise<void> {
    if (this._dialogCachePreparation) return this._dialogCachePreparation
    const pending = (async () => {
      const conversations = await this._database.get('mtproto_im_conversation', {})
      const latestRows = await Promise.all(conversations.map(async (conversation) => {
        const [latest] = await this._database.select('mtproto_im_message', {
          conversationId: conversation.id, deleted: false,
        }).orderBy('timestamp', 'desc').orderBy('id', 'desc').limit(1).execute()
        return latest
      }))
      for (const [index, conversation] of conversations.entries()) {
        this._latestMessages.set(conversation.id, latestRows[index])
      }
      this._onTrace?.(
        'dialog cache prepared conversations=%d messages=%d',
        conversations.length, latestRows.filter(Boolean).length,
      )
    })()
    this._dialogCachePreparation = pending
    try {
      await pending
    } finally {
      if (this._dialogCachePreparation === pending) this._dialogCachePreparation = undefined
    }
  }

  async upsertUser(session: PlatformSession, user: IMUser): Promise<IMUserRow> {
    return this._write(() => this._database.withTransaction(async (database) =>
      this._upsertUser(database, session.platformId, user, new Date())))
  }

  async upsertUsers(session: PlatformSession, users: readonly IMUser[]): Promise<IMUserRow[]> {
    if (!users.length) return []
    return this._write(() => this._database.withTransaction(async (database) => {
      const now = new Date()
      const inputs = uniquePlatformUsers(users)
      const platformUserIds = inputs.map((user) => user.id)
      const existing = await database.get('mtproto_im_user', {
        platformId: session.platformId,
        platformUserId: { $in: platformUserIds },
      })
      const merged = new Map(existing.map((row) => [row.platformUserId, toUser(row)]))
      for (const input of inputs) merged.set(input.id, mergePlatformUser(merged.get(input.id), input))
      await database.upsert('mtproto_im_user', inputs.map((input) => {
        const user = merged.get(input.id)!
        return {
          platformId: session.platformId,
          platformUserId: user.id,
          firstName: user.firstName,
          lastName: user.lastName ?? null,
          username: user.username ?? null,
          avatar: (user.avatar ?? null) as unknown as JsonValue | null,
          metadata: user.metadata ?? {},
          updatedAt: now,
        }
      }), ['platformId', 'platformUserId'])
      const rows = await database.get('mtproto_im_user', {
        platformId: session.platformId,
        platformUserId: { $in: platformUserIds },
      })
      const byPlatformId = new Map(rows.map((row) => [row.platformUserId, row]))
      return inputs.map((input) => {
        const row = byPlatformId.get(input.id)
        if (!row) throw new Error(`failed to persist platform user ${session.platformId}:${input.id}`)
        return row
      })
    }))
  }

  async getUser(platformId: string, platformUserId: string): Promise<IMUserRow | undefined> {
    const [row] = await this._database.get('mtproto_im_user', { platformId, platformUserId })
    return row
  }

  async getUserByTlId(platformId: string, id: number): Promise<IMUserRow | undefined> {
    const [row] = await this._database.get('mtproto_im_user', { platformId, id })
    return row
  }

  async listUsers(platformId: string): Promise<IMUserRow[]> {
    return this._database.select('mtproto_im_user', { platformId }).orderBy('id').execute()
  }

  async readUsers(platformId: string, platformUserIds: readonly string[]): Promise<IMUserRow[]> {
    if (!platformUserIds.length) return []
    return this._database.get('mtproto_im_user', {
      platformId,
      platformUserId: { $in: [...new Set(platformUserIds)] },
    })
  }

  async ingest(
    session: PlatformSession,
    conversation: IMConversation,
    source: IMMessage,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    return (await this.ingestMany(session, conversation, [source], options))[0]
  }

  async ingestMany(
    session: PlatformSession,
    conversation: IMConversation,
    sources: readonly IMMessage[],
    options: IngestOptions = {},
  ): Promise<IngestResult[]> {
    for (const source of sources) {
      if (source.conversationId !== conversation.id) {
        throw new Error('message conversation does not match ingestion target')
      }
    }
    if (!sources.length) return []
    const results = await this._write(() => this._database.withTransaction(async (database) => {
      const now = new Date()
      const allocationCache: ProjectionAllocationCache = { epochs: new Map() }
      const conversationRow = await this._upsertConversation(database, session, conversation, undefined, now)
      if (!conversationRow) throw new Error('failed to persist conversation')
      const historyPrefetch = options.allocation === 'history' && sources.length > 1
        ? await this._prefetchHistoryIngest(database, session, conversationRow, sources, now)
        : undefined
      const results: IngestResult[] = []
      for (const source of sources) {
        results.push(await this._ingestMessage(
          database, session, conversationRow, source, options, now, allocationCache, historyPrefetch,
        ))
      }
      return results
    }), options.allocation === 'history' ? 'history-ingest' : 'ingest', true)
    this._rememberLatestMessages(results.map((result) => result.message))
    return results
  }

  async ingestDialogs(session: PlatformSession, dialogs: readonly IMDialog[]): Promise<void> {
    for (const dialog of dialogs) {
      for (const message of [dialog.lastMessage, dialog.readInboxMaxMessage]) {
        if (message && message.conversationId !== dialog.conversation.id) {
          throw new Error('message conversation does not match ingestion target')
        }
      }
    }
    if (!dialogs.length) return
    const messages = await this._write(() => this._database.withTransaction(async (database) => {
      const now = new Date()
      const allocationCache: ProjectionAllocationCache = { epochs: new Map() }
      const messages: IMMessageRow[] = []
      const existingConversations = new Map((await database.get('mtproto_im_conversation', {
        platformSessionId: session.platformSessionId,
      })).map((row) => [row.platformConversationId, row]))
      await database.upsert('mtproto_im_conversation', dialogs.map((dialog) => ({
        platformSessionId: session.platformSessionId,
        platformConversationId: dialog.conversation.id,
        kind: dialog.conversation.kind,
        title: dialog.conversation.title,
        parentPlatformConversationId: dialog.conversation.parentId ?? null,
        spacePlatformId: dialog.conversation.spaceId ?? null,
        avatar: (dialog.conversation.avatar
          ?? existingConversations.get(dialog.conversation.id)?.avatar
          ?? null) as JsonValue | null,
        metadata: dialog.conversation.metadata ?? {},
        unreadCount: dialog.unreadCount,
        updatedAt: now,
      })), ['platformSessionId', 'platformConversationId'])
      const conversationRows = new Map((await database.get('mtproto_im_conversation', {
        platformSessionId: session.platformSessionId,
      })).map((row) => [row.platformConversationId, row]))
      for (const dialog of dialogs) {
        const conversationRow = conversationRows.get(dialog.conversation.id)
          ?? existingConversations.get(dialog.conversation.id)
        if (!conversationRow) throw new Error('failed to persist conversation')
        if (dialog.lastMessage) {
          const result = await this._ingestMessage(
            database, session, conversationRow, dialog.lastMessage, {}, now, allocationCache,
          )
          messages.push(result.message)
        }
        if (
          dialog.readInboxMaxMessage
          && dialog.readInboxMaxMessage.id !== dialog.lastMessage?.id
        ) {
          const result = await this._ingestMessage(
            database,
            session,
            conversationRow,
            dialog.readInboxMaxMessage,
            { allocation: 'history' },
            now,
            allocationCache,
          )
          messages.push(result.message)
        }
      }
      return messages
    }), 'dialog-ingest', true)
    this._rememberLatestMessages(messages)
  }

  private async _ingestMessage(
    database: Database,
    session: PlatformSession,
    conversationRow: IMConversationRow,
    source: IMMessage,
    options: IngestOptions,
    now: Date,
    allocationCache: ProjectionAllocationCache,
    historyPrefetch?: HistoryIngestPrefetch,
  ): Promise<IngestResult> {
    const platformSessionId = session.platformSessionId
    const sender = messageSender(source)
    const senderRow = historyPrefetch?.usersByPlatformId.get(sender.id)
      ?? await this._upsertUser(database, session.platformId, sender, now)
    if (!historyPrefetch) {
      for (const platformUserId of referencedUserIds(source)) {
        if (platformUserId === sender.id) continue
        await this._upsertUser(database, session.platformId, {
          id: platformUserId, firstName: platformUserId,
        }, now)
      }
    }
    const sourceIds = [...new Set([source.id, ...(source.sourceIds ?? [])])]
    let existingAlias: IMMessageAliasRow | undefined
    if (historyPrefetch) {
      existingAlias = sourceIds.map((id) => historyPrefetch.aliasesByPlatformId.get(id)).find(Boolean)
    } else {
      for (const platformMessageId of sourceIds) {
        ;[existingAlias] = await database.get('mtproto_im_message_alias', {
          platformSessionId,
          conversationId: conversationRow.id,
          platformMessageId,
        })
        if (existingAlias) break
      }
    }

    let message: IMMessageRow | undefined
    if (existingAlias && historyPrefetch) {
      message = historyPrefetch.messagesById.get(existingAlias.messageId)
    } else if (existingAlias) {
      ;[message] = await database.get('mtproto_im_message', { id: existingAlias.messageId })
    } else if (historyPrefetch) {
      message = historyPrefetch.messagesByPrimaryId.get(source.id)
    } else {
      ;[message] = await database.get('mtproto_im_message', {
        platformSessionId,
        conversationId: conversationRow.id,
        primaryPlatformMessageId: source.id,
      })
    }

    const created = !message
    const storedMetadata = messageMetadata(source)
    const storedContent = persistMessageContent(source.content)
    const changed = !message || (!message.deleted && (
      message.senderUserId !== senderRow.id
      || message.text !== messageText(source)
      || JSON.stringify(message.content) !== JSON.stringify(storedContent)
      || message.timestamp !== source.timestamp
      || message.outgoing !== (source.outgoing ?? false)
      || message.platformGroupId !== (source.groupId ?? null)
      || JSON.stringify(message.metadata) !== JSON.stringify(storedMetadata)
    ))
    if (message && existingAlias && !message.deleted && !changed) {
      const projection = historyPrefetch?.projectionsByMessageId.get(message.id)
        ?? await database.select('mtproto_tl_message_part', { messageId: message.id })
          .orderBy('ordinal').execute()
      return { message, created: false, changed: false, projection }
    }
    if (!message) {
      message = await database.create('mtproto_im_message', {
        platformSessionId,
        conversationId: conversationRow.id,
        primaryPlatformMessageId: source.id,
        senderUserId: senderRow.id,
        text: messageText(source),
        content: storedContent,
        timestamp: source.timestamp,
        outgoing: source.outgoing ?? false,
        deleted: false,
        platformGroupId: source.groupId ?? null,
        metadata: storedMetadata,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      await database.set('mtproto_im_message', { id: message.id }, {
        senderUserId: senderRow.id,
        text: messageText(source),
        content: storedContent,
        timestamp: source.timestamp,
        outgoing: source.outgoing ?? false,
        platformGroupId: source.groupId ?? null,
        metadata: storedMetadata,
        updatedAt: now,
      })
      ;[message] = await database.get('mtproto_im_message', { id: message.id })
      if (!message) throw new Error('message disappeared during ingestion')
    }
    historyPrefetch?.messagesById.set(message.id, message)
    for (const sourceId of sourceIds) historyPrefetch?.messagesByPrimaryId.set(sourceId, message)

    await database.upsert('mtproto_im_message_alias', sourceIds.map((platformMessageId, ordinal) => ({
      platformSessionId,
      conversationId: conversationRow.id,
      platformMessageId,
      messageId: message!.id,
      ordinal,
    })), ['platformSessionId', 'conversationId', 'platformMessageId'])

    const media = messageMedia(source)
    const storedMedia: IMMediaRow[] = []
    for (const [ordinal, item] of media.entries()) {
      const values = {
        messageId: message.id,
        ordinal,
        partIndex: source.content.parts.findIndex((part) => part.type === 'media' && part.media === item),
        platformMediaId: item.id,
        kind: item.kind,
        name: item.name ?? null,
        mimeType: item.mimeType ?? null,
        size: item.size ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        preview: item.preview ? { ...item.preview, locator: item.preview.locator as JsonValue } : null,
        strippedThumbnail: item.strippedThumbnail ? exactArrayBuffer(item.strippedThumbnail) : null,
        locator: (item.locator ?? null) as JsonValue,
      }
      let [stored] = await database.get('mtproto_im_media', {
        messageId: message.id, ordinal, platformMediaId: item.id,
      })
      if (stored) {
        await database.set('mtproto_im_media', { id: stored.id }, values)
        ;[stored] = await database.get('mtproto_im_media', { id: stored.id })
      } else {
        stored = await database.create('mtproto_im_media', values)
      }
      if (!stored) throw new Error('media disappeared during ingestion')
      storedMedia.push(stored)
    }
    const projection = await this._ensureProjection(
      database, platformSessionId, conversationRow, message, storedMedia,
      options.allocation ?? 'live',
      source.nativeOrderKey,
      allocationCache,
    )
    await this._replaceReactions(database, message.id, source.reactionContext, now)
    historyPrefetch?.projectionsByMessageId.set(message.id, projection)

    return { message, created, changed, projection }
  }

  async deleteMessages(
    session: PlatformSession,
    conversation: IMConversation,
    platformMessageIds: readonly string[],
  ): Promise<DeleteResult> {
    const deleted = await this._write(() => this._database.withTransaction(async (database) => {
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
        conversationRowId: conversationRow.id,
        changed: deletedMessageIds.length > 0,
        messageIds: deletedMessageIds,
        tlMessageIds,
      }
    }), 'message-delete', true)
    if (deleted.changed) this._latestMessages.delete(deleted.conversationRowId)
    return {
      changed: deleted.changed,
      messageIds: deleted.messageIds,
      tlMessageIds: deleted.tlMessageIds,
    }
  }

  async setReactions(
    session: PlatformSession,
    conversation: IMConversation,
    target: IMMessageTarget,
    context: IMReactionContext,
  ): Promise<ReactionResult> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const conversationRow = await this._upsertConversation(database, session, conversation, undefined, new Date())
      const [alias] = await database.get('mtproto_im_message_alias', {
        platformSessionId: session.platformSessionId,
        conversationId: conversationRow.id,
        platformMessageId: target.targetId,
      })
      if (!alias) throw new Error(`reaction target is not stored: ${target.targetId}`)
      const [row] = await database.get('mtproto_im_message', { id: alias.messageId })
      if (!row || row.deleted) throw new Error(`reaction target message is unavailable: ${target.targetId}`)
      const before = await database.select('mtproto_im_message_reaction', { messageId: row.id })
        .orderBy('nativeReactionKey').execute()
      await this._replaceReactions(database, row.id, context, new Date())
      const after = await database.select('mtproto_im_message_reaction', { messageId: row.id })
        .orderBy('nativeReactionKey').execute()
      const parts = await database.select('mtproto_tl_message_part', { messageId: row.id })
        .orderBy('ordinal').execute()
      return {
        changed: JSON.stringify(before.map(reactionComparable)) !== JSON.stringify(after.map(reactionComparable)),
        message: await this._hydrateMessage(row),
        tlMessageIds: parts.map((part) => part.tlMessageId),
      }
    }), 'message-reactions', true)
  }

  async markRead(
    session: PlatformSession,
    conversationId: string,
    upToMessageId: string,
  ): Promise<ReadResult | undefined> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const [conversation] = await database.get('mtproto_im_conversation', {
        platformSessionId: session.platformSessionId,
        platformConversationId: conversationId,
      })
      if (!conversation) return
      const [alias] = await database.get('mtproto_im_message_alias', {
        platformSessionId: session.platformSessionId,
        conversationId: conversation.id,
        platformMessageId: upToMessageId,
      })
      if (!alias) return
      const [message] = await database.get('mtproto_im_message', { id: alias.messageId })
      if (!message || message.deleted) return
      const parts = await database.select('mtproto_tl_message_part', { messageId: message.id })
        .orderBy('ordinal').execute()
      if (!parts.length) return
      const laterIncoming = await database.get('mtproto_im_message', {
        conversationId: conversation.id,
        deleted: false,
        outgoing: false,
        timestamp: { $gt: message.timestamp },
      })
      await database.set('mtproto_im_conversation', { id: conversation.id }, {
        unreadCount: laterIncoming.length,
        updatedAt: new Date(),
      })
      return {
        conversation: toConversation(conversation),
        message: await this._hydrateMessage(message),
        tlMessageId: Math.max(...parts.map((part) => part.tlMessageId)),
        unreadCount: laterIncoming.length,
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
    return this._hydrateDialogs(conversations)
  }

  async readDialogs(
    platformSessionId: string,
    platformConversationIds: readonly string[],
  ): Promise<IMDialog[]> {
    if (!platformConversationIds.length) return []
    const conversations = await this._database.get('mtproto_im_conversation', {
      platformSessionId,
      platformConversationId: { $in: [...new Set(platformConversationIds)] },
    })
    const byPlatformId = new Map(conversations.map((conversation) => [
      conversation.platformConversationId,
      conversation,
    ]))
    const ordered = platformConversationIds.flatMap((platformConversationId) => {
      const conversation = byPlatformId.get(platformConversationId)
      return conversation ? [conversation] : []
    })
    return this._hydrateDialogs(ordered)
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
      ...storedHistoryTimestampFilter(query),
    }).orderBy('timestamp', query.order ?? 'desc').limit(clampDatabaseLimit(query.limit)).execute()
    return this._hydrateMessages(rows, new Map([[conversation.id, conversation.platformConversationId]]))
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
      ...storedHistoryTimestampFilter(query),
    }).orderBy('timestamp', query.order ?? 'desc').limit(clampDatabaseLimit(query.limit)).execute()
    if (!rows.length) return []
    const messageIds = rows.map((row) => row.id)
    const senderUserIds = [...new Set(rows.map((row) => row.senderUserId))]
    const [aliases, reactions, senders, parts, media] = await Promise.all([
      this._database.get('mtproto_im_message_alias', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_message_reaction', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_user', { id: { $in: senderUserIds } }),
      this._database.get('mtproto_tl_message_part', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_media', { messageId: { $in: messageIds } }),
    ])
    const aliasesByMessage = groupByMessageId(aliases, (left, right) => left.ordinal - right.ordinal)
    const reactionsByMessage = groupByMessageId(reactions, (left, right) => left.id - right.id)
    const partsByMessage = groupByMessageId(parts, (left, right) => left.ordinal - right.ordinal)
    const mediaByMessage = groupByMessageId(media, (left, right) => left.ordinal - right.ordinal)
    const sendersById = new Map(senders.map((sender) => [sender.id, sender]))
    return rows.map((row) => {
      const sender = sendersById.get(row.senderUserId)
      if (!sender) throw new Error(`message references missing user ${row.senderUserId}`)
      return {
        source: hydrateMessage(
          row,
          aliasesByMessage.get(row.id) ?? [],
          reactionsByMessage.get(row.id) ?? [],
          sender,
          conversation.platformConversationId,
        ),
        parts: partsByMessage.get(row.id) ?? [],
        media: mediaByMessage.get(row.id) ?? [],
      }
    })
  }

  async listProjectedMessages(platformSessionId: string): Promise<ProjectedMessage[]> {
    const rows = await this._database.select('mtproto_im_message', {
      platformSessionId, deleted: false,
    }).orderBy('timestamp', 'desc').execute()
    if (!rows.length) return []
    const messageIds = rows.map((row) => row.id)
    const senderUserIds = [...new Set(rows.map((row) => row.senderUserId))]
    const conversationIds = [...new Set(rows.map((row) => row.conversationId))]
    const [aliases, reactions, senders, conversations, parts, media] = await Promise.all([
      this._database.get('mtproto_im_message_alias', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_message_reaction', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_user', { id: { $in: senderUserIds } }),
      this._database.get('mtproto_im_conversation', { id: { $in: conversationIds } }),
      this._database.get('mtproto_tl_message_part', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_media', { messageId: { $in: messageIds } }),
    ])
    const aliasesByMessage = groupByMessageId(aliases, (left, right) => left.ordinal - right.ordinal)
    const reactionsByMessage = groupByMessageId(reactions, (left, right) => left.id - right.id)
    const partsByMessage = groupByMessageId(parts, (left, right) => left.ordinal - right.ordinal)
    const mediaByMessage = groupByMessageId(media, (left, right) => left.ordinal - right.ordinal)
    const sendersById = new Map(senders.map((sender) => [sender.id, sender]))
    const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
    return rows.map((row) => {
      const sender = sendersById.get(row.senderUserId)
      const conversation = conversationsById.get(row.conversationId)
      if (!sender) throw new Error(`message references missing user ${row.senderUserId}`)
      if (!conversation) throw new Error(`message references missing conversation ${row.conversationId}`)
      return {
        source: hydrateMessage(
          row,
          aliasesByMessage.get(row.id) ?? [],
          reactionsByMessage.get(row.id) ?? [],
          sender,
          conversation.platformConversationId,
        ),
        parts: partsByMessage.get(row.id) ?? [],
        media: mediaByMessage.get(row.id) ?? [],
      }
    })
  }

  async readProjectedByPlatformIds(
    platformSessionId: string,
    targets: readonly StoredMessageLookup[],
  ): Promise<ProjectedMessage[]> {
    if (!targets.length) return []
    const platformConversationIds = [...new Set(targets.map((target) => target.conversationId))]
    const conversations = await this._database.get('mtproto_im_conversation', {
      platformSessionId,
      platformConversationId: { $in: platformConversationIds },
    })
    if (!conversations.length) return []
    const conversationsByPlatformId = new Map(conversations.map((conversation) => [
      conversation.platformConversationId, conversation,
    ]))
    const targetKeys = new Set(targets.flatMap((target) => {
      const conversation = conversationsByPlatformId.get(target.conversationId)
      return conversation ? [storedMessageLookupKey(conversation.id, target.platformMessageId)] : []
    }))
    const aliases = await this._database.get('mtproto_im_message_alias', {
      platformSessionId,
      conversationId: { $in: conversations.map((conversation) => conversation.id) },
      platformMessageId: { $in: [...new Set(targets.map((target) => target.platformMessageId))] },
    })
    const messageIds = [...new Set(aliases
      .filter((alias) => targetKeys.has(storedMessageLookupKey(alias.conversationId, alias.platformMessageId)))
      .map((alias) => alias.messageId))]
    if (!messageIds.length) return []
    const rows = await this._database.get('mtproto_im_message', { id: { $in: messageIds }, deleted: false })
    const knownConversationIds = new Map(conversations.map((conversation) => [
      conversation.id, conversation.platformConversationId,
    ]))
    const [sources, parts, media] = await Promise.all([
      this._hydrateMessages(rows, knownConversationIds),
      this._database.get('mtproto_tl_message_part', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_media', { messageId: { $in: messageIds } }),
    ])
    const partsByMessage = groupByMessageId(parts, (left, right) => left.ordinal - right.ordinal)
    const mediaByMessage = groupByMessageId(media, (left, right) => left.ordinal - right.ordinal)
    return rows.map((row, index) => ({
      source: sources[index],
      parts: partsByMessage.get(row.id) ?? [],
      media: mediaByMessage.get(row.id) ?? [],
    }))
  }

  async findProjectedByTlId(
    platformSessionId: string,
    tlMessageId: number,
    platformConversationId?: string,
    conversationKind?: IMConversation['kind'],
  ): Promise<ProjectedMessage | undefined> {
    let conversationId: number | undefined
    if (platformConversationId) {
      const [conversation] = await this._database.get('mtproto_im_conversation', {
        platformSessionId, platformConversationId,
      })
      if (!conversation) return
      conversationId = conversation.id
    }
    const parts = await this._database.get('mtproto_tl_message_part', {
      platformSessionId,
      tlMessageId,
      ...(conversationId === undefined ? {} : { conversationId }),
    })
    let part = parts[0]
    if (conversationId === undefined && conversationKind) {
      part = undefined
      for (const candidate of parts) {
        const [conversation] = await this._database.get('mtproto_im_conversation', { id: candidate.conversationId })
        if (conversation?.kind === conversationKind) {
          part = candidate
          break
        }
      }
    }
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

  async findProjectedByNativeSequence(
    platformSessionId: string,
    platformConversationId: string,
    nativeSequence: number,
  ): Promise<ProjectedMessage | undefined> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return
    const [part] = await this._database.select('mtproto_tl_message_part', {
      platformSessionId,
      conversationId: conversation.id,
      nativeSequence,
    }).orderBy('ordinal').limit(1).execute()
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

  async findProjectedByPlatformId(
    platformSessionId: string,
    platformConversationId: string,
    platformMessageId: string,
  ): Promise<ProjectedMessage | undefined> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return
    const [alias] = await this._database.get('mtproto_im_message_alias', {
      platformSessionId,
      conversationId: conversation.id,
      platformMessageId,
    })
    if (!alias) return
    const [row] = await this._database.get('mtproto_im_message', { id: alias.messageId })
    if (!row || row.deleted) return
    return {
      source: await this._hydrateMessage(row),
      parts: await this._database.select('mtproto_tl_message_part', { messageId: row.id })
        .orderBy('ordinal').execute(),
      media: await this._database.select('mtproto_im_media', { messageId: row.id })
        .orderBy('ordinal').execute(),
    }
  }

  async findReplyTarget(
    platformSessionId: string,
    source: IMMessage,
  ): Promise<ProjectedMessage | undefined> {
    const nativeSequence = qqReplySequenceFromMetadata(source.metadata)
    if (nativeSequence !== undefined) {
      const projected = await this.findProjectedByNativeSequence(
        platformSessionId, source.conversationId, nativeSequence,
      )
      if (projected) return projected
    }
    const telegramId = telegramReplyToMessageId(source)
    if (telegramId !== undefined) {
      const projected = await this.findProjectedByTlId(
        platformSessionId, telegramId, source.conversationId,
      )
      if (projected) return projected
    }
    return source.replyToId
      ? this.findProjectedByPlatformId(platformSessionId, source.conversationId, source.replyToId)
      : undefined
  }

  async getOldestTlMessageId(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<number | undefined> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return
    const [message] = await this._database.select('mtproto_im_message', {
      conversationId: conversation.id, deleted: false,
    }).orderBy('timestamp').limit(1).execute()
    if (!message) return
    const [part] = await this._database.select('mtproto_tl_message_part', { messageId: message.id })
      .orderBy('ordinal').limit(1).execute()
    return part?.tlMessageId
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
        duration: row.duration ?? undefined,
        preview: row.preview ?? undefined,
        strippedThumbnail: row.strippedThumbnail ? new Uint8Array(row.strippedThumbnail) : undefined,
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

  async getChannelUpdateState(platformSessionId: string, channelId: number) {
    const id = channelStateId(platformSessionId, channelId)
    const [state] = await this._database.get('mtproto_channel_update_state', { id })
    if (state) return state
    const account = await this.getUpdateState(platformSessionId)
    return { id, platformSessionId, channelId: String(channelId), pts: account.pts, date: account.date }
  }

  /** Reserve account pts for an RPC response without advancing the push-update seq. */
  async advancePts(platformSessionId: string, ptsCount: number, date: number, channelId?: number) {
    if (!Number.isSafeInteger(ptsCount) || ptsCount <= 0) {
      throw new RangeError('pts count must be a positive integer')
    }
    return this._write(() => this._database.withTransaction(async (database) => {
      const [current] = await database.get('mtproto_update_state', { platformSessionId })
      if (channelId !== undefined) {
        const id = channelStateId(platformSessionId, channelId)
        const [currentChannel] = await database.get('mtproto_channel_update_state', { id })
        const state = {
          id, platformSessionId, channelId: String(channelId),
          pts: (currentChannel?.pts ?? current?.pts ?? 1) + ptsCount,
          date,
        }
        await database.upsert('mtproto_channel_update_state', [state])
        return state
      }
      const state = {
        platformSessionId,
        pts: (current?.pts ?? 1) + ptsCount,
        qts: current?.qts ?? 0,
        seq: current?.seq ?? 0,
        date,
      }
      await database.upsert('mtproto_update_state', [state])
      return state
    }))
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

  async prepareUpdateDelivery(
    eventKey: string,
    platformSessionId: string,
    ptsCount: number,
    date: number,
    channelId?: number,
  ) {
    return this._write(async () => {
      const existing = await this._updateJournal.get(eventKey)
      if (existing) return existing

      const allocated = await this._database.withTransaction(async (database) => {
        const [current] = await database.get('mtproto_update_state', { platformSessionId })
        const account = {
          platformSessionId,
          pts: (current?.pts ?? 1) + (channelId === undefined ? ptsCount : 0),
          qts: current?.qts ?? 0,
          seq: (current?.seq ?? 0) + 1,
          date,
        }
        await database.upsert('mtproto_update_state', [account])
        if (channelId === undefined) return { state: account, scope: ACCOUNT_UPDATE_SCOPE, seq: account.seq }
        const id = channelStateId(platformSessionId, channelId)
        const [currentChannel] = await database.get('mtproto_channel_update_state', { id })
        const channel = {
          id, platformSessionId, channelId: String(channelId),
          pts: (currentChannel?.pts ?? current?.pts ?? 1) + ptsCount,
          date,
        }
        await database.upsert('mtproto_channel_update_state', [channel])
        return { state: channel, scope: channelUpdateScope(channelId), seq: account.seq }
      })
      return this._updateJournal.create({
        eventKey, platformSessionId, scope: allocated.scope, pts: allocated.state.pts, ptsCount,
        seq: allocated.seq, date, published: false,
        payload: '',
      })
    })
  }

  async getUpdateDelivery(eventKey: string) {
    return this._updateJournal.get(eventKey)
  }

  async markUpdatePublished(eventKey: string): Promise<void> {
    await this._write(() => this._updateJournal.markPublished(eventKey))
  }

  async setUpdatePayload(eventKey: string, payload: string): Promise<void> {
    await this._write(() => this._updateJournal.setPayload(eventKey, payload))
  }

  async getPendingUpdateDeliveries(platformSessionId: string) {
    return this._updateJournal.getPending(platformSessionId)
  }

  async getUpdateDeliveriesAfter(platformSessionId: string, pts: number, limit = 101, channelId?: number) {
    return this._updateJournal.getAfter(
      platformSessionId,
      channelId === undefined ? ACCOUNT_UPDATE_SCOPE : channelUpdateScope(channelId),
      pts,
      limit,
    )
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

  async listConversations(platformSessionId: string): Promise<IMConversation[]> {
    const rows = await this._database.get('mtproto_im_conversation', { platformSessionId })
    return rows.map(toConversation)
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

  private async _prefetchHistoryIngest(
    database: Database,
    session: PlatformSession,
    conversation: IMConversationRow,
    sources: readonly IMMessage[],
    now: Date,
  ): Promise<HistoryIngestPrefetch> {
    const usersByPlatformId = await this._upsertMessageUsers(database, session.platformId, sources, now)
    const sourceIds = [...new Set(sources.flatMap((source) => [source.id, ...(source.sourceIds ?? [])]))]
    const aliases = await database.get('mtproto_im_message_alias', {
      platformSessionId: session.platformSessionId,
      conversationId: conversation.id,
      platformMessageId: { $in: sourceIds },
    })
    const aliasesByPlatformId = new Map(aliases.map((alias) => [alias.platformMessageId, alias]))
    const aliasedMessageIds = [...new Set(aliases.map((alias) => alias.messageId))]
    const unresolvedPrimaryIds = sources
      .filter((source) => ![source.id, ...(source.sourceIds ?? [])]
        .some((id) => aliasesByPlatformId.has(id)))
      .map((source) => source.id)
    const [aliasedMessages, primaryMessages] = await Promise.all([
      aliasedMessageIds.length
        ? database.get('mtproto_im_message', { id: { $in: aliasedMessageIds } })
        : Promise.resolve([]),
      unresolvedPrimaryIds.length
        ? database.get('mtproto_im_message', {
            platformSessionId: session.platformSessionId,
            conversationId: conversation.id,
            primaryPlatformMessageId: { $in: unresolvedPrimaryIds },
          })
        : Promise.resolve([]),
    ])
    const messages = [...aliasedMessages, ...primaryMessages]
    const messagesById = new Map(messages.map((message) => [message.id, message]))
    const messagesByPrimaryId = new Map(messages.map((message) => [message.primaryPlatformMessageId, message]))
    const projections = messages.length
      ? await database.get('mtproto_tl_message_part', { messageId: { $in: [...messagesById.keys()] } })
      : []
    return {
      usersByPlatformId,
      aliasesByPlatformId,
      messagesById,
      messagesByPrimaryId,
      projectionsByMessageId: groupByMessageId(projections, (left, right) => left.ordinal - right.ordinal),
    }
  }

  private async _upsertMessageUsers(
    database: Database,
    platformId: string,
    sources: readonly IMMessage[],
    now: Date,
  ): Promise<Map<string, IMUserRow>> {
    const inputs = sources.flatMap((source) => [
      messageSender(source),
      ...[...referencedUserIds(source)]
        .filter((platformUserId) => platformUserId !== source.senderId)
        .map((platformUserId) => ({ id: platformUserId, firstName: platformUserId })),
    ])
    const platformUserIds = [...new Set(inputs.map((user) => user.id))]
    const existing = await database.get('mtproto_im_user', {
      platformId, platformUserId: { $in: platformUserIds },
    })
    const merged = new Map(existing.map((row) => [row.platformUserId, toUser(row)]))
    for (const input of inputs) merged.set(input.id, mergePlatformUser(merged.get(input.id), input))
    await database.upsert('mtproto_im_user', [...merged.values()].map((user) => ({
      platformId,
      platformUserId: user.id,
      firstName: user.firstName,
      lastName: user.lastName ?? null,
      username: user.username ?? null,
      avatar: (user.avatar ?? null) as unknown as JsonValue | null,
      metadata: user.metadata ?? {},
      updatedAt: now,
    })), ['platformId', 'platformUserId'])
    const rows = await database.get('mtproto_im_user', {
      platformId, platformUserId: { $in: platformUserIds },
    })
    return new Map(rows.map((row) => [row.platformUserId, row]))
  }

  private async _upsertUser(
    database: Database,
    platformId: string,
    user: IMUser,
    now: Date,
  ): Promise<IMUserRow> {
    const [existing] = await database.get('mtproto_im_user', {
      platformId, platformUserId: user.id,
    })
    const placeholder = user.firstName === user.id
      && !user.lastName && !user.username && !user.avatar
      && Object.keys(user.metadata ?? {}).length === 0
    await database.upsert('mtproto_im_user', [{
      platformId,
      platformUserId: user.id,
      firstName: placeholder && existing ? existing.firstName : user.firstName,
      lastName: user.lastName ?? existing?.lastName ?? null,
      username: user.username ?? existing?.username ?? null,
      avatar: (user.avatar ?? existing?.avatar ?? null) as JsonValue | null,
      metadata: { ...existing?.metadata, ...user.metadata },
      updatedAt: now,
    }], ['platformId', 'platformUserId'])
    const [row] = await database.get('mtproto_im_user', {
      platformId, platformUserId: user.id,
    })
    if (!row) throw new Error(`failed to persist platform user ${platformId}:${user.id}`)
    return row
  }

  private async _upsertConversation(
    database: Database,
    session: PlatformSession,
    conversation: IMConversation,
    unreadCount: number | undefined,
    now: Date,
  ): Promise<IMConversationRow> {
    // A direct conversation is also the peer identity used by Telegram. The
    // first durable event may be outgoing (so its sender is self), therefore
    // message-sender ingestion alone cannot guarantee that the peer exists
    // when the freshly committed message is projected.
    if (conversation.kind === 'direct') {
      await this._upsertUser(database, session.platformId, {
        id: conversation.id,
        firstName: conversation.title,
        avatar: conversation.avatar,
      }, now)
    }
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
      avatar: (conversation.avatar ?? existing?.avatar ?? null) as JsonValue | null,
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
    nativeOrderKey: string | undefined,
    allocationCache: ProjectionAllocationCache,
  ): Promise<TlMessagePartRow[]> {
    const count = Math.max(1, media.length)
    const scope = conversation.kind !== 'direct'
      ? `channel:${platformSessionId}:${conversation.parentPlatformConversationId ?? conversation.platformConversationId}`
      : `account:${platformSessionId}`
    const nativeSequence = qqMessageSequenceFromMetadata(message.metadata)
    let existing = await database.select('mtproto_tl_message_part', { messageId: message.id })
      .orderBy('ordinal').execute()
    const groupedIdBeforeMigration = existing.find((part) => part.groupedId)?.groupedId ?? null
    const requiresMigration = existing.some((part) => (
      part.scope !== scope
      || part.allocationVersion !== TIMESTAMP_ALLOCATION_VERSION
    ))
    if (requiresMigration) {
      for (const part of existing) await database.remove('mtproto_tl_message_part', { id: part.id })
      existing = []
    } else if (existing.length > count) {
      for (const part of existing.slice(count)) {
        await database.remove('mtproto_tl_message_part', { id: part.id })
      }
      existing = existing.slice(0, count)
    }
    // A live platform event can expose an optimistic ordering key before a
    // later status/history record supplies the final value. Telegram message
    // IDs are already visible to clients at that point and must remain
    // immutable: changing the projection would leave durable update payloads
    // referring to the old ID while a later recall deletes the new one.
    for (const part of existing) {
      const values = {
        ...(nativeSequence !== undefined && part.nativeSequence !== nativeSequence
          ? { nativeSequence }
          : {}),
        ...(nativeOrderKey !== undefined && part.nativeOrderKey !== nativeOrderKey
          ? { nativeOrderKey }
          : {}),
      }
      if (Object.keys(values).length) await database.set('mtproto_tl_message_part', { id: part.id }, values)
    }
    const groupable = count > 1 && new Set(media.map((item) => item.kind)).size === 1
    let groupedId = existing.find((part) => part.groupedId)?.groupedId ?? groupedIdBeforeMigration
    if (!groupable && groupedId) {
      groupedId = null
      await database.set('mtproto_tl_message_part', { messageId: message.id }, { groupedId: null })
    } else if (groupable && !groupedId) {
      groupedId = String((await this._allocateIds(database, `group:${platformSessionId}`, 1))[0])
      if (existing.length) await database.set('mtproto_tl_message_part', { messageId: message.id }, { groupedId })
    }
    if (existing.length < count) {
      const missing = count - existing.length
      const bounds = nativeSequence !== undefined
        ? await this._nativeSequenceBounds(database, conversation.id, nativeSequence)
        : nativeOrderKey !== undefined
          ? await this._nativeOrderKeyBounds(database, scope, nativeOrderKey)
          : {}
      const preferredId = nativeOrderKey === undefined
        ? clampedTimestampMessageIdBucket(
            await this._messageIdEpoch(database, scope, message.timestamp, allocationCache.epochs),
            message.timestamp,
          )
        : orderedMessagePreferredId(bounds)
      const ids = await this._allocateSlottedMessageIds(
        database,
        scope,
        missing,
        preferredId,
        allocation,
        nativeSequence !== undefined || nativeOrderKey !== undefined,
        existing.map((part) => part.tlMessageId),
        bounds,
      )
      await database.upsert('mtproto_tl_message_part', ids.map((tlMessageId, index) => {
        const ordinal = existing.length + index
        return {
          platformSessionId,
          conversationId: conversation.id,
          messageId: message.id,
          mediaId: media[ordinal]?.id ?? null,
          scope,
          tlMessageId,
          nativeSequence: nativeSequence ?? null,
          nativeOrderKey: nativeOrderKey ?? null,
          allocationVersion: TIMESTAMP_ALLOCATION_VERSION,
          groupedId,
          ordinal,
        }
      }), ['messageId', 'ordinal'])
    }
    const projection = await database.select('mtproto_tl_message_part', { messageId: message.id })
      .orderBy('ordinal').execute()
    for (const part of projection) {
      const mediaId = media[part.ordinal]?.id ?? null
      if (part.mediaId !== mediaId || part.groupedId !== groupedId) {
        await database.set('mtproto_tl_message_part', { id: part.id }, { mediaId, groupedId })
      }
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

  private async _allocateSlottedMessageIds(
    database: Database,
    scope: string,
    count: number,
    preferredId: number,
    allocation: 'live' | 'history',
    centerSlots: boolean,
    existingIds: readonly number[],
    bounds: { lowerExclusive?: number, upperExclusive?: number },
  ): Promise<number[]> {
    const preferredBucket = messageIdBucketStart(preferredId)
    const ids: number[] = []
    const preferForward = allocation === 'live' || count > 1 || existingIds.length > 0
    const collect = async (activeBounds: { lowerExclusive?: number, upperExclusive?: number }) => {
      const bucketRange = slottedMessageIdBucketRange(activeBounds)
      if (!bucketRange) return
      const maxDistance = Math.max(
        Math.abs(preferredBucket - bucketRange.first),
        Math.abs(bucketRange.last - preferredBucket),
      ) / TIMESTAMP_MESSAGE_ID_SLOTS
      for (let distance = 0; ids.length < count && distance <= maxDistance; distance++) {
        const buckets = distance === 0
          ? [preferredBucket]
          : preferForward
            ? [
                preferredBucket + distance * TIMESTAMP_MESSAGE_ID_SLOTS,
                preferredBucket - distance * TIMESTAMP_MESSAGE_ID_SLOTS,
              ]
            : [
                preferredBucket - distance * TIMESTAMP_MESSAGE_ID_SLOTS,
                preferredBucket + distance * TIMESTAMP_MESSAGE_ID_SLOTS,
              ]
        for (const bucket of buckets) {
          if (ids.length >= count) break
          if (bucket < bucketRange.first || bucket > bucketRange.last) continue
          const first = Math.max(bucket, (activeBounds.lowerExclusive ?? bucket - 1) + 1)
          const last = Math.min(
            bucket + TIMESTAMP_MESSAGE_ID_SLOTS - 1,
            (activeBounds.upperExclusive ?? bucket + TIMESTAMP_MESSAGE_ID_SLOTS) - 1,
          )
          const occupied = new Set((await database.get('mtproto_tl_message_part', {
            scope,
            tlMessageId: { $gte: first, $lte: last },
          })).map((part) => part.tlMessageId))
          const available: number[] = []
          for (let candidate = first; candidate <= last; candidate++) {
            if (existingIds.includes(candidate) || ids.includes(candidate)) continue
            if (!occupied.has(candidate)) available.push(candidate)
          }
          const candidates = centerSlots
            ? middleOut(available, preferForward)
            : available
          for (const candidate of candidates) {
            if (ids.length >= count) break
            ids.push(candidate)
          }
        }
      }
    }

    await collect(bounds)
    // Immutable legacy IDs can leave no integer between adjacent native sequences.
    // Preserve ingestion progress by relaxing ordering while retaining scope uniqueness.
    if (ids.length < count && (bounds.lowerExclusive !== undefined || bounds.upperExclusive !== undefined)) {
      await collect({})
    }
    if (ids.length < count) throw new RangeError(`message ID scope exhausted: ${scope}`)
    return ids.sort((left, right) => left - right)
  }

  private async _messageIdEpoch(
    database: Database,
    scope: string,
    timestamp: number,
    cache: Map<string, number>,
  ): Promise<number> {
    const cached = cache.get(scope)
    if (cached !== undefined) return cached
    const [existing] = await database.get('mtproto_message_id_epoch', { scope })
    if (existing) {
      cache.set(scope, existing.epoch)
      return existing.epoch
    }
    const epoch = initialTimestampMessageIdEpoch(timestamp)
    await database.create('mtproto_message_id_epoch', { scope, epoch })
    cache.set(scope, epoch)
    return epoch
  }

  private async _nativeSequenceBounds(
    database: Database,
    conversationId: number,
    nativeSequence: number,
  ): Promise<{ lowerExclusive?: number, upperExclusive?: number }> {
    const [previous] = await database.select('mtproto_tl_message_part', {
      conversationId,
      nativeSequence: { $lt: nativeSequence },
    }).orderBy('nativeSequence', 'desc').limit(1).execute()
    const [next] = await database.select('mtproto_tl_message_part', {
      conversationId,
      nativeSequence: { $gt: nativeSequence },
    }).orderBy('nativeSequence').limit(1).execute()
    const previousParts = previous?.nativeSequence === null || previous?.nativeSequence === undefined
      ? []
      : await database.get('mtproto_tl_message_part', {
          conversationId, nativeSequence: previous.nativeSequence,
        })
    const nextParts = next?.nativeSequence === null || next?.nativeSequence === undefined
      ? []
      : await database.get('mtproto_tl_message_part', {
          conversationId, nativeSequence: next.nativeSequence,
        })
    return {
      lowerExclusive: previousParts.length
        ? Math.max(...previousParts.map((part) => part.tlMessageId))
        : undefined,
      upperExclusive: nextParts.length
        ? Math.min(...nextParts.map((part) => part.tlMessageId))
        : undefined,
    }
  }

  private async _nativeOrderKeyBounds(
    database: Database,
    scope: string,
    nativeOrderKey: string,
  ): Promise<{ lowerExclusive?: number, upperExclusive?: number }> {
    const [previous] = await database.select('mtproto_tl_message_part', {
      scope,
      nativeOrderKey: { $lt: nativeOrderKey },
    }).orderBy('nativeOrderKey', 'desc').limit(1).execute()
    const [next] = await database.select('mtproto_tl_message_part', {
      scope,
      nativeOrderKey: { $gt: nativeOrderKey },
    }).orderBy('nativeOrderKey').limit(1).execute()
    const previousParts = previous?.nativeOrderKey
      ? await database.get('mtproto_tl_message_part', { scope, nativeOrderKey: previous.nativeOrderKey })
      : []
    const nextParts = next?.nativeOrderKey
      ? await database.get('mtproto_tl_message_part', { scope, nativeOrderKey: next.nativeOrderKey })
      : []
    return {
      lowerExclusive: previousParts.length
        ? Math.max(...previousParts.map((part) => part.tlMessageId))
        : undefined,
      upperExclusive: nextParts.length
        ? Math.min(...nextParts.map((part) => part.tlMessageId))
        : undefined,
    }
  }

  private async _hydrateDialogs(conversations: readonly IMConversationRow[]): Promise<IMDialog[]> {
    const latestRows = await this._latestMessagesForConversations(conversations.map((conversation) => conversation.id))
    const rows = latestRows.flatMap((row) => row ? [row] : [])
    const hydrated = await this._hydrateMessages(rows, new Map(conversations.map((conversation) => [
      conversation.id, conversation.platformConversationId,
    ])))
    const hydratedById = new Map(rows.map((row, index) => [row.id, hydrated[index]]))
    return conversations.map((conversation, index) => {
      const latest = latestRows[index]
      return {
        conversation: toConversation(conversation),
        unreadCount: conversation.unreadCount,
        lastMessage: latest ? hydratedById.get(latest.id) : undefined,
      }
    })
  }

  private async _latestMessagesForConversations(
    conversationIds: readonly number[],
  ): Promise<Array<IMMessageRow | undefined>> {
    if (!conversationIds.length) return []
    const missing = [...new Set(conversationIds.filter((conversationId) =>
      !this._latestMessages.has(conversationId)))]
    const loaded = await Promise.all(missing.map(async (conversationId) => {
      const [latest] = await this._database.select('mtproto_im_message', {
        conversationId, deleted: false,
      }).orderBy('timestamp', 'desc').orderBy('id', 'desc').limit(1).execute()
      return latest
    }))
    for (const [index, conversationId] of missing.entries()) {
      this._latestMessages.set(conversationId, loaded[index])
    }
    return conversationIds.map((conversationId) => this._latestMessages.get(conversationId))
  }

  private _rememberLatestMessages(rows: readonly IMMessageRow[]): void {
    for (const row of rows) {
      const current = this._latestMessages.get(row.conversationId)
      if (
        !this._latestMessages.has(row.conversationId)
        || !current
        || current.id === row.id
        || row.timestamp > current.timestamp
        || (row.timestamp === current.timestamp && row.id > current.id)
      ) {
        this._latestMessages.set(row.conversationId, row)
      }
    }
  }

  private async _hydrateMessages(
    rows: readonly IMMessageRow[],
    knownConversationIds: ReadonlyMap<number, string> = new Map(),
  ): Promise<IMMessage[]> {
    if (!rows.length) return []
    const messageIds = [...new Set(rows.map((row) => row.id))]
    const senderUserIds = [...new Set(rows.map((row) => row.senderUserId))]
    const missingConversationRowIds = [...new Set(rows
      .map((row) => row.conversationId)
      .filter((id) => !knownConversationIds.has(id)))]
    const [aliases, reactions, senders, conversations] = await Promise.all([
      this._database.get('mtproto_im_message_alias', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_message_reaction', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_user', { id: { $in: senderUserIds } }),
      missingConversationRowIds.length
        ? this._database.get('mtproto_im_conversation', { id: { $in: missingConversationRowIds } })
        : Promise.resolve([]),
    ])
    const aliasesByMessage = groupByMessageId(aliases, (left, right) => left.ordinal - right.ordinal)
    const reactionsByMessage = groupByMessageId(reactions, (left, right) => left.id - right.id)
    const sendersById = new Map(senders.map((sender) => [sender.id, sender]))
    const conversationIds = new Map(knownConversationIds)
    for (const conversation of conversations) {
      conversationIds.set(conversation.id, conversation.platformConversationId)
    }
    return rows.map((row) => {
      const sender = sendersById.get(row.senderUserId)
      if (!sender) throw new Error(`message references missing user ${row.senderUserId}`)
      const conversationId = conversationIds.get(row.conversationId)
      if (!conversationId) throw new Error(`message references missing conversation ${row.conversationId}`)
      return hydrateMessage(
        row,
        aliasesByMessage.get(row.id) ?? [],
        reactionsByMessage.get(row.id) ?? [],
        sender,
        conversationId,
      )
    })
  }

  private async _hydrateMessage(row: IMMessageRow): Promise<IMMessage> {
    return (await this._hydrateMessages([row]))[0]
  }

  private async _replaceReactions(
    database: Database,
    messageId: number,
    context: IMReactionContext | undefined,
    now: Date,
  ): Promise<void> {
    if (context === undefined) return
    const [message] = await database.get('mtproto_im_message', { id: messageId })
    if (message) {
      await database.set('mtproto_im_message', { id: messageId }, {
        metadata: { ...message.metadata, reactionMaxSelected: context.maxSelected },
      })
    }
    const definitions = new Map(context.available.map((definition) => [definition.key, definition]))
    const summaries = new Map(context.reactions.map((reaction) => [reaction.key, reaction]))
    const keys = new Set(definitions.keys())
    const existing = await database.get('mtproto_im_message_reaction', { messageId })
    for (const stale of existing.filter((reaction) => !keys.has(reaction.nativeReactionKey))) {
      await database.remove('mtproto_im_message_reaction', { id: stale.id })
    }
    await database.upsert('mtproto_im_message_reaction', [...definitions].map(([key, definition]) => {
      const reaction = summaries.get(key)
      return {
      messageId, nativeReactionKey: key, count: reaction?.count ?? 0,
      selected: reaction?.selected ?? false,
      recentActors: (reaction?.recentActors ?? []) as unknown as Record<string, unknown>[],
      definition: definition as unknown as Record<string, unknown>, updatedAt: now,
    }
    }), ['messageId', 'nativeReactionKey'])
  }

  async pruneUpdateDeliveries(platformSessionId: string): Promise<void> {
    await this._write(() => this._updateJournal.prune(platformSessionId, ACCOUNT_UPDATE_SCOPE))
  }

  private async _write<T>(
    callback: () => Promise<T>,
    operation = 'write',
    invalidatesHistory = false,
  ): Promise<T> {
    const queuedAt = performance.now()
    const previous = MessageStore._writeTails.get(this._database) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    MessageStore._writeTails.set(this._database, tail)
    if (operation === 'history-ingest') {
      this._onTrace?.('message store write profile operation=%s stage=queued', operation)
    }
    await previous.catch(() => {})
    const queueWaitMs = performance.now() - queuedAt
    if (operation === 'history-ingest') {
      this._onTrace?.(
        'message store write profile operation=%s stage=acquired queueWaitMs=%d',
        operation, profileMilliseconds(queueWaitMs),
      )
    }
    const executeAt = performance.now()
    try {
      const result = await callback()
      if (invalidatesHistory) this._revision++
      return result
    } finally {
      release()
      if (MessageStore._writeTails.get(this._database) === tail) {
        MessageStore._writeTails.delete(this._database)
      }
      const executeMs = performance.now() - executeAt
      if (operation === 'history-ingest' || queueWaitMs >= 25 || executeMs >= 50) {
        this._onTrace?.(
          'message store write profile operation=%s queueWaitMs=%d executeMs=%d',
          operation, profileMilliseconds(queueWaitMs), profileMilliseconds(executeMs),
        )
      }
    }
  }
}

function groupByMessageId<T extends { messageId: number }>(
  rows: readonly T[],
  compare: (left: T, right: T) => number,
): Map<number, T[]> {
  const grouped = new Map<number, T[]>()
  for (const row of rows) {
    const values = grouped.get(row.messageId)
    if (values) values.push(row)
    else grouped.set(row.messageId, [row])
  }
  for (const values of grouped.values()) values.sort(compare)
  return grouped
}

function storedMessageLookupKey(conversationId: number, platformMessageId: string): string {
  return `${conversationId}\u0000${platformMessageId}`
}

function hydrateMessage(
  row: IMMessageRow,
  aliases: readonly IMMessageAliasRow[],
  reactions: readonly IMMessageReactionRow[],
  senderRow: IMUserRow,
  conversationId: string,
): IMMessage {
  const { replyToId, metadata } = hydrateMessageMetadata(row.metadata)
  const sender = toUser(senderRow)
  return {
    id: row.primaryPlatformMessageId,
    sourceIds: aliases.map((alias) => alias.platformMessageId),
    conversationId,
    senderId: sender.id,
    sender,
    content: hydrateMessageContent(row.content),
    timestamp: row.timestamp,
    outgoing: row.outgoing,
    groupId: row.platformGroupId ?? undefined,
    replyToId,
    metadata,
    reactionContext: reactions.length ? {
      available: reactions.map((reaction) => reaction.definition as unknown as IMReactionDefinition),
      reactions: reactions.filter((reaction) => reaction.count > 0 || reaction.selected).map((reaction) => ({
        key: reaction.nativeReactionKey, count: reaction.count,
        selected: reaction.selected,
        recentActors: reaction.recentActors as unknown as IMReactionActor[],
      })),
      maxSelected: Number(row.metadata.reactionMaxSelected ?? 1),
    } : undefined,
  }
}

function profileMilliseconds(value: number): number {
  return Math.round(value * 100) / 100
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function channelStateId(platformSessionId: string, channelId: number): string {
  return `${encodeURIComponent(platformSessionId)}:${channelId}`
}

function channelUpdateScope(channelId: number): string {
  return `channel:${channelId}`
}

function toConversation(row: IMConversationRow): IMConversation {
  return {
    id: row.platformConversationId,
    kind: row.kind,
    title: row.title,
    parentId: row.parentPlatformConversationId ?? undefined,
    spaceId: row.spacePlatformId ?? undefined,
    avatar: row.avatar === null ? undefined : row.avatar as unknown as IMConversation['avatar'],
    metadata: row.metadata,
  }
}

function messageMetadata(message: IMMessage): JsonObject {
  return {
    ...message.metadata,
    ...(message.replyToId !== undefined ? { [STORED_REPLY_TO_KEY]: message.replyToId } : {}),
  }
}

function hydrateMessageMetadata(metadata: JsonObject): {
  replyToId?: string
  metadata: JsonObject
} {
  const publicMetadata = { ...metadata }
  delete publicMetadata[STORED_REPLY_TO_KEY]
  const replyToId = typeof metadata[STORED_REPLY_TO_KEY] === 'string'
    ? metadata[STORED_REPLY_TO_KEY]
    : undefined
  return { replyToId, metadata: publicMetadata }
}

export function toUser(row: IMUserRow): IMUser {
  return {
    id: row.platformUserId,
    firstName: row.firstName,
    lastName: row.lastName ?? undefined,
    username: row.username ?? undefined,
    avatar: row.avatar === null ? undefined : row.avatar as unknown as IMUser['avatar'],
    metadata: row.metadata,
  }
}

function uniquePlatformUsers(users: readonly IMUser[]): IMUser[] {
  return [...new Map(users.map((user) => [user.id, user])).values()]
}

function messageSender(message: IMMessage): IMUser {
  return message.sender?.id === message.senderId
    ? message.sender
    : { id: message.senderId, firstName: message.senderId }
}

function mergePlatformUser(existing: IMUser | undefined, incoming: IMUser): IMUser {
  const placeholder = incoming.firstName === incoming.id
    && !incoming.lastName && !incoming.username && !incoming.avatar
    && Object.keys(incoming.metadata ?? {}).length === 0
  return {
    id: incoming.id,
    firstName: placeholder && existing ? existing.firstName : incoming.firstName,
    lastName: incoming.lastName ?? existing?.lastName,
    username: incoming.username ?? existing?.username,
    avatar: incoming.avatar ?? existing?.avatar,
    metadata: { ...existing?.metadata, ...incoming.metadata },
  }
}

function persistMessageContent(content: IMMessageContent): JsonValue {
  return {
    ...content,
    parts: content.parts.map((part) => part.type === 'sticker' && part.sticker.outline
      ? { ...part, sticker: { ...part.sticker, outline: [...part.sticker.outline] } }
      : part),
  } as unknown as JsonValue
}

function hydrateMessageContent(value: JsonValue): IMMessageContent {
  const content = value as unknown as IMMessageContent
  return {
    ...content,
    parts: content.parts.map((part) => {
      if (part.type !== 'sticker' || part.sticker.outline === undefined) return part
      return {
        ...part,
        sticker: {
          ...part.sticker,
          outline: hydrateByteArray(part.sticker.outline as unknown),
        },
      }
    }),
  }
}

function hydrateByteArray(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return validBytes(value) ? Uint8Array.from(value) : undefined
  if (!value || typeof value !== 'object') return
  if ('type' in value && value.type === 'Buffer' && 'data' in value && Array.isArray(value.data)) {
    return validBytes(value.data) ? Uint8Array.from(value.data) : undefined
  }
  const entries = Object.entries(value)
    .map(([index, byte]) => [Number(index), byte] as const)
    .sort(([left], [right]) => left - right)
  if (!entries.every(([index, byte], position) => index === position && validByte(byte))) return
  return Uint8Array.from(entries.map(([, byte]) => byte as number))
}

function validBytes(value: unknown[]): value is number[] {
  return value.every(validByte)
}

function validByte(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255
}

function referencedUserIds(message: IMMessage): Set<string> {
  const ids = new Set<string>()
  for (const part of message.content.parts) {
    if (part.type !== 'text') continue
    for (const entity of part.entities ?? []) {
      if (entity.type === 'mention') ids.add(entity.userId)
    }
  }
  for (const reaction of message.reactionContext?.reactions ?? []) {
    for (const actor of reaction.recentActors ?? []) ids.add(actor.userId)
  }
  return ids
}

function storedHistoryTimestampFilter(query: StoredHistoryQuery): {
  timestamp?: { $lt?: number, $gte?: number, $lte?: number }
} {
  const timestamp = {
    ...(query.beforeTimestamp === undefined ? {} : { $lt: query.beforeTimestamp }),
    ...(query.minTimestamp === undefined ? {} : { $gte: query.minTimestamp }),
    ...(query.maxTimestamp === undefined ? {} : { $lte: query.maxTimestamp }),
  }
  return Object.keys(timestamp).length ? { timestamp } : {}
}

function clampDatabaseLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), 500))
}

function slottedMessageIdBucketRange(
  bounds: { lowerExclusive?: number, upperExclusive?: number },
): { first: number, last: number } | undefined {
  const firstCandidate = (bounds.lowerExclusive ?? 0) + 1
  const lastCandidate = (bounds.upperExclusive ?? TELEGRAM_MESSAGE_ID_MAX + 1) - 1
  const first = Math.max(TIMESTAMP_MESSAGE_ID_SLOTS, messageIdBucketStart(firstCandidate))
  const last = Math.min(
    messageIdBucketStart(TELEGRAM_MESSAGE_ID_MAX),
    messageIdBucketStart(lastCandidate),
  )
  return first <= last ? { first, last } : undefined
}

function orderedMessagePreferredId(
  bounds: { lowerExclusive?: number, upperExclusive?: number },
): number {
  let preferred = 0x40000000
  if (bounds.lowerExclusive !== undefined && bounds.upperExclusive !== undefined) {
    preferred = Math.floor((bounds.lowerExclusive + bounds.upperExclusive) / 2)
  } else if (bounds.lowerExclusive !== undefined) {
    preferred = bounds.lowerExclusive + 1
  } else if (bounds.upperExclusive !== undefined) {
    preferred = bounds.upperExclusive - 1
  }
  return Math.max(TIMESTAMP_MESSAGE_ID_SLOTS, Math.min(TELEGRAM_MESSAGE_ID_MAX, preferred))
}

function middleOut(values: readonly number[], preferForward: boolean): number[] {
  if (values.length < 2) return [...values]
  const middle = Math.floor((values.length - 1) / 2)
  const output = [values[middle]]
  for (let distance = 1; output.length < values.length; distance++) {
    const indices = preferForward
      ? [middle + distance, middle - distance]
      : [middle - distance, middle + distance]
    for (const index of indices) {
      if (index >= 0 && index < values.length) output.push(values[index])
    }
  }
  return output
}

function reactionComparable(reaction: import('./models.js').IMMessageReactionRow) {
  return {
    key: reaction.nativeReactionKey,
    count: reaction.count,
    selected: reaction.selected,
    recentActors: reaction.recentActors,
    definition: reaction.definition,
  }
}
