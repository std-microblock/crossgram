import type { Database } from '@cordisjs/plugin-database'
import type {
  IMConversationRow, IMMediaRow, IMMessageAliasRow, IMMessageRow, TlMessagePartRow,
} from './models.js'
import {
  messageMedia, messageText,
  type IMConversation, type IMDialog, type IMMessage, type IMMessageContent, type IMMessageTarget,
  type IMReactionActor, type IMReactionContext, type IMReactionDefinition,
  type IMUser, type JsonObject, type JsonValue, type PlatformSession,
} from './platform.js'
import {
  initialTimestampMessageIdEpoch, messageIdBucketStart, qqMessageSequenceFromMetadata,
  TELEGRAM_MESSAGE_ID_MAX, TIMESTAMP_MESSAGE_ID_SLOTS, timestampMessageIdBucket,
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

const TIMESTAMP_ALLOCATION_VERSION = 1
export const UPDATE_DELIVERY_RETENTION = 1_000
export const ACCOUNT_UPDATE_SCOPE = 'account'
const STORED_SENDER_KEY = '__mtprotoRelaySender'
const STORED_REPLY_TO_KEY = '__mtprotoRelayReplyToId'

/** Durable canonical store shared by history sync, push ingestion, and sends. */
export class MessageStore {
  private _writeTail = Promise.resolve()

  constructor(
    private readonly _database: Database,
    updateDeliveryRetention = UPDATE_DELIVERY_RETENTION,
    private readonly _updateJournal: UpdateDeliveryJournal = new MemoryUpdateDeliveryJournal(updateDeliveryRetention),
  ) {}

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
      const storedMetadata = messageMetadata(source)
      const changed = !message || (!message.deleted && (
        message.senderPlatformUserId !== source.senderId
        || message.text !== messageText(source)
        || JSON.stringify(message.content) !== JSON.stringify(source.content)
        || message.timestamp !== source.timestamp
        || message.outgoing !== (source.outgoing ?? false)
        || message.platformGroupId !== (source.groupId ?? null)
        || JSON.stringify(message.metadata) !== JSON.stringify(storedMetadata)
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
          metadata: storedMetadata,
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
          metadata: storedMetadata,
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
        duration: item.duration ?? null,
        preview: item.preview ?? null,
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
      await this._replaceReactions(database, message.id, source.reactionContext, now)

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
      || (nativeSequence !== undefined && part.nativeSequence !== nativeSequence)
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
      const epoch = await this._messageIdEpoch(database, scope, message.timestamp)
      const preferredId = timestampMessageIdBucket(epoch, message.timestamp)
      const bounds = nativeSequence === undefined
        ? {}
        : await this._nativeSequenceBounds(database, conversation.id, nativeSequence)
      const ids = await this._allocateSlottedMessageIds(
        database,
        scope,
        missing,
        preferredId,
        allocation,
        nativeSequence !== undefined,
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
          allocationVersion: TIMESTAMP_ALLOCATION_VERSION,
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
          const available: number[] = []
          for (let candidate = first; candidate <= last; candidate++) {
            if (existingIds.includes(candidate) || ids.includes(candidate)) continue
            const occupied = await database.get('mtproto_tl_message_part', { scope, tlMessageId: candidate })
            if (!occupied.length) available.push(candidate)
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

  private async _messageIdEpoch(database: Database, scope: string, timestamp: number): Promise<number> {
    const [existing] = await database.get('mtproto_message_id_epoch', { scope })
    if (existing) return existing.epoch
    const epoch = initialTimestampMessageIdEpoch(timestamp)
    await database.create('mtproto_message_id_epoch', { scope, epoch })
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

  private async _hydrateMessage(row: IMMessageRow): Promise<IMMessage> {
    const aliases = await this._database.select('mtproto_im_message_alias', { messageId: row.id })
      .orderBy('ordinal').execute()
    const reactions = await this._database.select('mtproto_im_message_reaction', { messageId: row.id })
      .orderBy('id').execute()
    const { sender, replyToId, metadata } = hydrateMessageMetadata(row.metadata)
    return {
      id: row.primaryPlatformMessageId,
      sourceIds: aliases.map((alias) => alias.platformMessageId),
      conversationId: (await this._conversationId(row.conversationId)),
      senderId: row.senderPlatformUserId,
      sender,
      content: row.content as unknown as IMMessageContent,
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

  private async _conversationId(id: number): Promise<string> {
    const [conversation] = await this._database.get('mtproto_im_conversation', { id })
    if (!conversation) throw new Error(`message references missing conversation ${id}`)
    return conversation.platformConversationId
  }

  async pruneUpdateDeliveries(platformSessionId: string): Promise<void> {
    await this._write(() => this._updateJournal.prune(platformSessionId, ACCOUNT_UPDATE_SCOPE))
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
    metadata: row.metadata,
  }
}

function messageMetadata(message: IMMessage): JsonObject {
  return {
    ...message.metadata,
    ...(message.sender
      ? { [STORED_SENDER_KEY]: message.sender as unknown as JsonValue }
      : {}),
    ...(message.replyToId !== undefined ? { [STORED_REPLY_TO_KEY]: message.replyToId } : {}),
  }
}

function hydrateMessageMetadata(metadata: JsonObject): {
  sender?: IMUser
  replyToId?: string
  metadata: JsonObject
} {
  const publicMetadata = { ...metadata }
  delete publicMetadata[STORED_SENDER_KEY]
  delete publicMetadata[STORED_REPLY_TO_KEY]
  const replyToId = typeof metadata[STORED_REPLY_TO_KEY] === 'string'
    ? metadata[STORED_REPLY_TO_KEY]
    : undefined
  const candidate = metadata[STORED_SENDER_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { replyToId, metadata: publicMetadata }
  }
  const sender = candidate as unknown as IMUser
  return typeof sender.id === 'string' && typeof sender.firstName === 'string'
    ? { sender, replyToId, metadata: publicMetadata }
    : { replyToId, metadata: publicMetadata }
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
