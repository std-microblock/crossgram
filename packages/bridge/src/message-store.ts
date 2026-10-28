import type { Database } from '@cordisjs/plugin-database'
import { $, type Query } from '@cordisjs/plugin-database'
import type { UpdateJson, UpdateStoreBackend } from '@mtproto-relay/update-store'
import { MemoryUpdateStoreBackend } from '@mtproto-relay/update-store-memory'
import type {
  IMConversationRow, IMMediaRow, IMMessageAliasRow, IMMessageReactionRow, IMMessageRow, IMRequestRow, IMUserRow,
  TlMessagePartRow,
} from './models.js'
import {
  isArticleMessage, isServiceMessage, messageText, telegramReplyToMessageId,
  type IMConversation, type IMDialog, type IMMessage, type IMMessageContent, type IMMessageTarget, type IMRequest,
  type IMReactionActor, type IMReactionContext, type IMReactionDefinition,
  type IMUser, type JsonObject, type JsonValue, type PlatformSession,
} from './platform.js'
import {
  clampedTimestampMessageIdBucket, initialTimestampMessageIdEpoch, messageIdBucketStart,
  qqMessageSequenceFromMetadata, qqReplySequenceFromMetadata,
  TELEGRAM_MESSAGE_ID_MAX, TIMESTAMP_MESSAGE_ID_SLOTS,
} from './message-id.js'
import {
  REQUEST_INBOX_CONVERSATION_ID, requestInboxConversation, requestInboxMessage, requestTimestamp,
} from './request-inbox.js'
import type { MessageProjectionPipeline, MessageProjectionPlan } from './message-projection.js'
import { jsonContains, jsonEquals } from './stable-json.js'
import {
  escapeRegExpLiteral, mediaSearchKind, messageSearchKinds, messageSearchText, partKindsMatchSearchKinds,
  SEARCH_KIND, type MessageSearchContext,
} from './message-search.js'

export interface MessageSearchQuery {
  /** 限定会话（平台会话 ID）；缺省时在整个账号内搜索。 */
  platformConversationIds?: readonly string[]
  /** 已归一化的查询词，全部需命中。 */
  terms: readonly string[]
  /** 发送者在 `mtproto_im_user` 中的行号。 */
  senderUserId?: number
  /** 不含端点的时间下界（Unix 秒）。 */
  minTimestamp?: number
  /** 不含端点的时间上界（Unix 秒）。 */
  maxTimestamp?: number
  /** `SEARCH_KIND` 位掩码，任一位命中即可；0 或缺省表示不过滤。 */
  kinds?: number
  /** 翻页锚点：只返回严格早于该消息的结果。 */
  before?: { timestamp: number, messageId: number }
  limit: number
}

export interface SearchedMessage extends ProjectedMessage {
  /** `mtproto_im_message` 行号，用作翻页锚点。 */
  messageId: number
  /** 该消息的 `SEARCH_KIND` 位掩码，供分片级精确过滤。 */
  searchKinds: number
}

export interface MessageSearchResult {
  messages: SearchedMessage[]
  hasMore: boolean
}

export interface SearchPartIndexEntry {
  tlMessageId: number
  timestamp: number
  /** `mtproto_im_message` 行号。 */
  messageId: number
}

/**
 * 分片级索引的原始行：额外带上判定媒体类别所需的上下文，
 * 好让一次扫描的结果能被多个 `kinds` 掩码复用。
 */
interface SearchPartIndexRow extends SearchPartIndexEntry {
  ordinal: number
  /** 该分片自身媒体对应的 `SEARCH_KIND` 位（分片没有媒体时为 0）。 */
  partKind: number
  /** 整条消息的 `SEARCH_KIND` 位掩码。 */
  messageKinds: number
}

/** 一次分片索引扫描的结果；同一份数据会被裁成多个 `kinds` 掩码的子集。 */
interface SearchPartIndexCacheEntry {
  /** 该次扫描覆盖的平台会话；为空表示整个账号。 */
  conversationIds: readonly string[]
  /** 扫描时下推到 SQL 的掩码；`0` 表示没有按媒体类别过滤。 */
  mask: number
  /** 结果落地的时间，用于 TTL；未落地时为 0。 */
  settledAt: number
  rows?: SearchPartIndexRow[]
  /** 在飞行中的同一次扫描，用来合并同一轮打开会话里的重复请求。 */
  pending?: Promise<SearchPartIndexRow[]>
}

const SEARCH_INDEX_CHUNK = 500
/** 分片/媒体取用同时发起的批数：单批约 80 毫秒，串行 41 批要 3 秒多。 */
const SEARCH_INDEX_CHUNK_CONCURRENCY = 3
/**
 * 分片索引缓存的存活时间。
 *
 * 客户端打开一个会话会同时发 `messages.getSearchCounters`（一次 9 个过滤器）、
 * `messages.getSearchResultsPositions`（另外几个）与若干 `messages.search`，
 * 它们共享同一批「消息 → 分片」数据；而每次全量扫描在线上 16 万条消息的群里要 4~5 秒，
 * 十几个过滤器叠起来足以把数据库读到饱和，让同一条连接上的 `messages.getHistory` 拿不到连接。
 * 缓存按「会话 + 其余查询条件」保存一份扫描结果，写入侧再按会话精确失效。
 */
const SEARCH_INDEX_CACHE_TTL = 30_000
const SEARCH_INDEX_CACHE_LIMIT = 8
/** 单次结果超过这么多条分片就不再留在内存里：这台机器本来就吃紧，宁可下次重扫。 */
const SEARCH_INDEX_CACHE_MAX_ROWS = 40_000

export interface IngestResult {
  message: IMMessageRow
  created: boolean
  changed: boolean
  projection: TlMessagePartRow[]
  addedTlMessageIds: number[]
  removedTlMessageIds: number[]
}

export interface RequestUpsertResult {
  request: IMRequest
  created: boolean
  changed: boolean
  previous?: IMRequest
}

export interface RequestIngestResult extends RequestUpsertResult {
  message: IngestResult
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

// 发布方持有无 payload 预留记录的最大宽限期；超时后读取侧视为卡死并直接清理。
const CLAIMED_DELIVERY_GRACE_SECONDS = 30
const STORED_REPLY_TO_KEY = '__mtprotoRelayReplyToId'

function storedReplyToId(metadata: JsonObject): string | undefined {
  const value = metadata[STORED_REPLY_TO_KEY]
  return typeof value === 'string' ? value : undefined
}
const STORED_SENDER_TITLE_KEY = '__mtprotoRelaySenderTitle'
const STORED_RECALLED_KEY = '__mtprotoRelayRecalled'
const STORED_CONVERSATION_SELF_ROLE_KEY = '__mtprotoRelaySelfRole'
const STORED_CONVERSATION_SELF_PERMISSIONS_KEY = '__mtprotoRelaySelfPermissions'

export class MessageStore {
  private static readonly _writeTails = new WeakMap<Database, Promise<void>>()
  private _revision = 0
  private _peerRevision = 0
  /** 共享媒体分片索引的短期缓存，见 `SEARCH_INDEX_CACHE_TTL`。 */
  private readonly _partIndexCache = new Map<string, SearchPartIndexCacheEntry>()
  /** 文本搜索精确计数的短期缓存（同一个键由 `_countCacheKey` 定义）。 */
  private readonly _countCache = new Map<
    string,
    { value: number, at: number, conversationIds: readonly string[] }
  >()

  constructor(
    private readonly _database: Database,
    updateDeliveryRetention = UPDATE_DELIVERY_RETENTION,
    private readonly _updateStore: UpdateStoreBackend = new MemoryUpdateStoreBackend({
      retention: updateDeliveryRetention,
    }),
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    private readonly _messageProjection?: MessageProjectionPipeline,
  ) {}

  get revision(): number {
    return this._revision
  }

  /** 会话资料变更版本号（普通消息收发不递增）。 */
  get peerRevision(): number {
    return this._peerRevision
  }


  async upsertUser(session: PlatformSession, user: IMUser): Promise<IMUserRow> {
    return this._write(() => this._database.withTransaction(async (database) =>
      this._upsertUser(database, session.platformId, user, new Date())))
  }

  async upsertRequest(session: PlatformSession, request: IMRequest): Promise<RequestUpsertResult> {
    return this._write(() => this._database.withTransaction((database) =>
      this._upsertRequest(database, session, request, new Date())), 'request-upsert', true)
  }

  /** 在同一事务中落库好友/入群申请及其收件箱投影消息。 */
  async ingestRequest(session: PlatformSession, request: IMRequest): Promise<RequestIngestResult> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const now = new Date()
      const stored = await this._upsertRequest(database, session, request, now)
      const conversation = requestInboxConversation()
      const conversationRow = await this._upsertConversation(database, session, conversation, undefined, now)
      const message = await this._ingestMessage(
        database, session, conversationRow, requestInboxMessage(stored.request), {}, now, { epochs: new Map() },
      )
      // 仅首次创建收件箱消息且状态为 pending 时递增未读数，防止后续重试或终态更新重复累加。
      if (message.created && stored.request.state === 'pending') {
        await database.set('mtproto_im_conversation', { id: conversationRow.id }, {
          unreadCount: conversationRow.unreadCount + 1,
          updatedAt: now,
        })
      }
      return { ...stored, message }
    }), 'request-ingest', true)
  }

  async getRequest(platformSessionId: string, platformRequestId: string): Promise<IMRequest | undefined> {
    const [row] = await this._database.get('mtproto_im_request', { platformSessionId, platformRequestId })
    return row ? requestFromRow(row) : undefined
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
    this._invalidateSearchPartIndex(conversation.id)
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
        metadata: conversationMetadata(
          dialog.conversation,
          existingConversations.get(dialog.conversation.id)?.metadata,
        ),
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
        let latestMessageRow: IMMessageRow | undefined
        if (dialog.lastMessage) {
          const result = await this._ingestMessage(
            database, session, conversationRow, dialog.lastMessage, {}, now, allocationCache,
          )
          latestMessageRow = result.message
          messages.push(result.message)
        }
        // 上游（QQ）只在按需拉取未读窗口时才给出已读边界；没有新边界时沿用上次已知的边界，
        // 否则会话会被报成「一条都没读」（`read_inbox_max_id = 0`），客户端的未读分隔线与定位都会失真。
        let readInboxMaxMessageId = conversationRow.readInboxMaxMessageId ?? null
        if (dialog.readInboxMaxMessage) {
          if (dialog.readInboxMaxMessage.id === dialog.lastMessage?.id) {
            readInboxMaxMessageId = latestMessageRow?.id ?? readInboxMaxMessageId
          } else {
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
            readInboxMaxMessageId = result.message.id
          }
        }
        if ((conversationRow.readInboxMaxMessageId ?? null) !== readInboxMaxMessageId) {
          await database.set('mtproto_im_conversation', { id: conversationRow.id }, { readInboxMaxMessageId })
          conversationRow.readInboxMaxMessageId = readInboxMaxMessageId
        }
      }
      return messages
    }), 'dialog-ingest', true)
    for (const dialog of dialogs) this._invalidateSearchPartIndex(dialog.conversation.id)
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
    const searchKinds = messageSearchKinds(source, await this._searchContext(database, session, conversationRow, source))
    const storedContent = persistMessageContent(source.content)
    // metadata 中还包含本表维护的附加字段（如 reactionMaxSelected），需用 jsonContains 判断并在更新时合并保留。
    const changed = !message || (!message.deleted && (
      message.senderUserId !== senderRow.id
      || message.text !== messageText(source)
      || !jsonEquals(message.content, storedContent)
      || message.timestamp !== source.timestamp
      || message.outgoing !== (source.outgoing ?? false)
      || message.platformGroupId !== (source.groupId ?? null)
      || !jsonContains(message.metadata, storedMetadata)
    ))
    if (message && existingAlias && !message.deleted && !changed) {
      if (message.searchKinds !== searchKinds) {
        // 旧数据补齐搜索字段，或回复目标后到导致提及判定变化；都不视为消息变更。
        const searchText = messageSearchText(source)
        await database.set('mtproto_im_message', { id: message.id }, { searchText, searchKinds })
        message = { ...message, searchText, searchKinds }
        historyPrefetch?.messagesById.set(message.id, message)
      }
      // 即使消息正文未变，上游也可能附带最新的回应汇总，需单独同步回应表。
      await this._replaceReactions(database, message.id, source.reactionContext, now)
      const projection = historyPrefetch?.projectionsByMessageId.get(message.id)
        ?? await database.select('mtproto_tl_message_part', { messageId: message.id })
          .orderBy('ordinal').execute()
      return { message, created: false, changed: false, projection, addedTlMessageIds: [], removedTlMessageIds: [] }
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
        searchText: messageSearchText(source),
        searchKinds,
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
        metadata: { ...message.metadata, ...storedMetadata },
        searchText: messageSearchText(source),
        searchKinds,
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
    })), ['conversationId', 'platformMessageId'])

    const media = source.content.parts.flatMap((part, partIndex) => part.type === 'media'
      ? [{ item: part.media, partIndex }]
      : [])
    const storedMedia: IMMediaRow[] = []
    for (const [ordinal, { item, partIndex }] of media.entries()) {
      const values = {
        messageId: message.id,
        ordinal,
        partIndex,
        platformMediaId: item.id,
        kind: item.kind,
        name: item.name ?? null,
        mimeType: item.mimeType ?? null,
        size: item.size ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        voice: item.voice === true,
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
    const { projection, addedTlMessageIds, removedTlMessageIds } = await this._ensureProjection(
      database, session, conversationRow, message, source, storedMedia,
      options.allocation ?? 'live',
      source.nativeOrderKey,
      allocationCache,
    )
    await this._replaceReactions(database, message.id, source.reactionContext, now)
    historyPrefetch?.projectionsByMessageId.set(message.id, projection)

    return { message, created, changed, projection, addedTlMessageIds, removedTlMessageIds }
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
          await database.remove('mtproto_message_mention', { messageId })
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
    this._invalidateSearchPartIndex(conversation.id)
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
  ): Promise<ReactionResult | undefined> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const conversationRow = await this._upsertConversation(database, session, conversation, undefined, new Date())
      const [alias] = await database.get('mtproto_im_message_alias', {
        platformSessionId: session.platformSessionId,
        conversationId: conversationRow.id,
        platformMessageId: target.targetId,
      })
      // QQNT 可能推送本地未缓存的旧消息的回应变更，此时直接忽略，后续拉取历史时会带上最新回应状态。
      if (!alias) return
      const [row] = await database.get('mtproto_im_message', { id: alias.messageId })
      if (!row || row.deleted) return
      const before = await database.select('mtproto_im_message_reaction', { messageId: row.id })
        .orderBy('nativeReactionKey').execute()
      await this._replaceReactions(database, row.id, context, new Date())
      const after = await database.select('mtproto_im_message_reaction', { messageId: row.id })
        .orderBy('nativeReactionKey').execute()
      const parts = await database.select('mtproto_tl_message_part', { messageId: row.id })
        .orderBy('ordinal').execute()
      return {
        changed: !jsonEquals(before.map(reactionComparable), after.map(reactionComparable)),
        message: await this._hydrateMessage(row, database),
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
      const laterIncoming = conversation.platformConversationId === REQUEST_INBOX_CONVERSATION_ID
        ? (await database.get('mtproto_im_message', {
            conversationId: conversation.id,
            deleted: false,
            outgoing: false,
          })).filter((candidate) => candidate.timestamp > message.timestamp
            || (candidate.timestamp === message.timestamp && candidate.id > message.id))
        : await database.get('mtproto_im_message', {
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

  async incrementConversationUnread(
    session: PlatformSession,
    conversation: IMConversation,
    amount = 1,
  ): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('amount must be a positive integer')
    await this._write(() => this._database.withTransaction(async (database) => {
      const row = await this._upsertConversation(database, session, conversation, undefined, new Date())
      await database.set('mtproto_im_conversation', { id: row.id }, {
        unreadCount: row.unreadCount + amount,
        updatedAt: new Date(),
      })
    }), 'conversation-unread', true)
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
    const predicate = anchor
      ? {
          platformSessionId,
          $or: [
            { updatedAt: { $lt: anchor.updatedAt } },
            { updatedAt: anchor.updatedAt, id: { $lt: anchor.id } },
          ],
        }
      : { platformSessionId }
    const conversations = await this._database.select('mtproto_im_conversation', predicate)
      .orderBy('updatedAt', 'desc').orderBy('id', 'desc').limit(limit).execute()
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
    return this._hydrateProjectedHistoryRows(rows, conversation)
  }

  async readAllProjectedHistory(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<ProjectedMessage[]> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return []
    const rows = await this._database.select('mtproto_im_message', {
      conversationId: conversation.id,
      deleted: false,
    }).orderBy('timestamp', 'desc').orderBy('id', 'desc').execute()
    return this._hydrateProjectedHistoryRows(rows, conversation)
  }

  private async _hydrateProjectedHistoryRows(
    rows: readonly IMMessageRow[],
    conversation: IMConversationRow,
  ): Promise<ProjectedMessage[]> {
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
    return this._hydrateProjectedRows(rows)
  }

  /**
   * 会话内已存的原生序号（QQ msgSeq），倒序去重，沿 `(conversationId, nativeSequence)` 索引读取。
   * 被删除的消息也算「已取过」，同样计入。
   */
  async readNativeSequences(
    platformSessionId: string,
    platformConversationId: string,
    options: { below?: number, limit: number },
  ): Promise<number[]> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    }, ['id'])
    if (!conversation) return []
    const rows = await this._database.select('mtproto_tl_message_part', {
      conversationId: conversation.id,
      nativeSequence: options.below !== undefined ? { $lt: options.below, $gt: 0 } : { $gt: 0 },
    }).orderBy('nativeSequence', 'desc')
      .limit(Math.max(1, Math.min(Math.trunc(options.limit), 10_000))).execute()
    const output: number[] = []
    for (const row of rows) {
      if (row.nativeSequence !== null && row.nativeSequence !== output.at(-1)) output.push(row.nativeSequence)
    }
    return output
  }

  /** 按 `mtproto_im_message` 行号读取投影消息（已删除的跳过），顺序与输入一致。 */
  async readProjectedByMessageIds(
    platformSessionId: string,
    messageIds: readonly number[],
  ): Promise<ProjectedMessage[]> {
    const unique = [...new Set(messageIds)]
    if (!unique.length) return []
    const rows = await this._database.get('mtproto_im_message', {
      id: { $in: unique }, platformSessionId, deleted: false,
    })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return this._hydrateProjectedRows(unique.flatMap((id) => {
      const row = byId.get(id)
      return row ? [row] : []
    }))
  }

  /**
   * 在本地投影过的消息中搜索，结果按 `(timestamp, id)` 倒序。
   *
   * 不依赖文本索引：沿 `(conversationId, timestamp)` 或 `(platformSessionId, timestamp)` 索引倒序扫描，
   * 对 `searchText` 做字面量子串匹配，取满 `limit + 1` 行即停止，多取的一行只用于判断是否还有更多。
   */
  async searchMessages(platformSessionId: string, query: MessageSearchQuery): Promise<MessageSearchResult> {
    const where = await this._searchPredicate(platformSessionId, query)
    if (!where) return { messages: [], hasMore: false }
    const limit = clampDatabaseLimit(query.limit)
    const rows = await this._database.select('mtproto_im_message', where)
      .orderBy('timestamp', 'desc').orderBy('id', 'desc').limit(limit + 1).execute()
    const page = rows.slice(0, limit)
    const hydrated = await this._hydrateProjectedRows(page)
    return {
      messages: hydrated.map((item, index) => ({
        ...item, messageId: page[index].id, searchKinds: page[index].searchKinds ?? 0,
      })),
      hasMore: rows.length > limit,
    }
  }

  /** 与 `searchMessages` 同条件的消息条数（按逻辑消息计）；需要扫完整个范围，只在首页调用。 */
  async countSearchMessages(platformSessionId: string, query: Omit<MessageSearchQuery, 'limit'>): Promise<number> {
    // 精确计数要扫完整个会话的 `searchText`（线上 16 万条消息约 1.2 秒）。客户端在等应答时
    // 会按 1.5 秒的重发间隔再问一遍，切标签页也会重问，所以短缓存直接决定搜索的手感。
    const key = this._countCacheKey(platformSessionId, query)
    const cached = this._countCache.get(key)
    if (cached && Date.now() - cached.at < SEARCH_INDEX_CACHE_TTL) return cached.value
    const where = await this._searchPredicate(platformSessionId, { ...query, limit: 0, before: undefined })
    if (!where) return 0
    const value = await this._database.eval('mtproto_im_message', (row) => $.count(row.id), where)
    this._countCache.set(key, {
      value, at: Date.now(), conversationIds: [...(query.platformConversationIds ?? [])],
    })
    while (this._countCache.size > SEARCH_INDEX_CACHE_LIMIT) {
      const oldest = this._countCache.keys().next().value
      if (oldest === undefined) break
      this._countCache.delete(oldest)
    }
    return value
  }

  private _countCacheKey(platformSessionId: string, query: Omit<MessageSearchQuery, 'limit'>): string {
    return JSON.stringify([
      platformSessionId,
      query.platformConversationIds ? [...query.platformConversationIds].sort() : null,
      [...query.terms].sort(),
      query.senderUserId ?? null,
      query.minTimestamp ?? null,
      query.maxTimestamp ?? null,
      query.kinds ?? 0,
      query.before ? [query.before.timestamp, query.before.messageId] : null,
    ])
  }

  /**
   * 列出满足条件的全部 Telegram 分片（不含正文），按 Telegram 消息 ID 倒序。
   * 用于共享媒体计数、日历与滚动条位置；按分片精确判定媒体类别。
   */
  async searchPartIndex(
    platformSessionId: string,
    query: Omit<MessageSearchQuery, 'limit' | 'before'>,
  ): Promise<SearchPartIndexEntry[]> {
    const [entries] = await this.searchPartIndexMany(platformSessionId, query, [query.kinds ?? 0])
    return entries
  }

  /**
   * 一次扫描同时给出多个 `kinds` 掩码的分片索引，返回值顺序与 `masks` 一一对应。
   *
   * 共享媒体页会一口气问 9 个过滤器的条数，再分别问滚动条位置；逐个过滤器各扫一遍全表是
   * 这类会话打不开的直接原因。这里把掩码并成一次扫描，再在内存里裁成各自的结果。
   */
  async searchPartIndexMany(
    platformSessionId: string,
    query: Omit<MessageSearchQuery, 'limit' | 'before'>,
    masks: readonly number[],
  ): Promise<SearchPartIndexEntry[][]> {
    const wanted = [...new Set(masks)]
    if (!wanted.length) return []
    const rows = await this._searchPartIndexRows(platformSessionId, query, wanted)
    // `0` 表示「不按媒体类别过滤」，要求把一条媒体都没有的消息也算进来；
    // 下推过类别的那次扫描覆盖不到这些行，需要单独再扫一次（客户端不会把它们混在同一批里）。
    const unfiltered = wanted.includes(0) && wanted.some((mask) => mask !== 0)
      ? await this._loadSearchPartIndexRows(platformSessionId, query, 0)
      : undefined
    return wanted.map((mask) => (mask === 0 && unfiltered ? unfiltered : rows)
      .filter((row) => (mask === 0
        ? row.ordinal === 0
        : partKindsMatchSearchKinds(row.messageKinds, row.ordinal, row.partKind, mask)))
      .map(({ tlMessageId, timestamp, messageId }) => ({ tlMessageId, timestamp, messageId })))
  }

  /** 拿到（或复用缓存里的）分片索引原始行；同一次请求的并发方共享同一个 promise。 */
  private async _searchPartIndexRows(
    platformSessionId: string,
    query: Omit<MessageSearchQuery, 'limit' | 'before'>,
    masks: readonly number[],
  ): Promise<SearchPartIndexRow[]> {
    const mask = masks.filter((value) => value !== 0).reduce((total, value) => total | value, 0)
    const key = this._searchIndexCacheKey(platformSessionId, query)
    const cached = this._partIndexCache.get(key)
    if (cached && this._searchIndexCovers(cached.mask, mask)) {
      if (cached.pending) return cached.pending
      if (cached.rows && Date.now() - cached.settledAt < SEARCH_INDEX_CACHE_TTL) return cached.rows
    }
    const entry: SearchPartIndexCacheEntry = {
      conversationIds: [...(query.platformConversationIds ?? [])],
      mask,
      settledAt: 0,
    }
    entry.pending = this._loadSearchPartIndexRows(platformSessionId, query, mask)
    this._partIndexCache.set(key, entry)
    this._trimSearchIndexCache()
    try {
      const rows = await entry.pending
      entry.pending = undefined
      if (rows.length > SEARCH_INDEX_CACHE_MAX_ROWS) {
        // 这一份太大，只服务本次请求；已在等待的调用方拿到的还是同一个 promise。
        if (this._partIndexCache.get(key) === entry) this._partIndexCache.delete(key)
        return rows
      }
      entry.rows = rows
      entry.settledAt = Date.now()
      return rows
    } catch (error) {
      if (this._partIndexCache.get(key) === entry) this._partIndexCache.delete(key)
      throw error
    }
  }

  private async _loadSearchPartIndexRows(
    platformSessionId: string,
    query: Omit<MessageSearchQuery, 'limit' | 'before'>,
    mask: number,
  ): Promise<SearchPartIndexRow[]> {
    const where = await this._searchPredicate(platformSessionId, {
      ...query, kinds: mask || undefined, limit: 0,
    })
    if (!where) return []
    const rows = await this._database.get('mtproto_im_message', where, ['id', 'timestamp', 'searchKinds'])
    const chunks: Array<typeof rows> = []
    for (let offset = 0; offset < rows.length; offset += SEARCH_INDEX_CHUNK) {
      chunks.push(rows.slice(offset, offset + SEARCH_INDEX_CHUNK))
    }
    const output: SearchPartIndexRow[] = []
    // 分片与媒体的取用是「按 500 个 id 一批」的随机读；串行执行时 41 批要 3 秒上下，
    // 限并发几批就能把这段压到亚秒，同时不至于把只有 10 条连接的连接池占满。
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++]!
        const messageIds = chunk.map((row) => row.id)
        // 媒体类别一定要取：同一份扫描结果会被裁成多个 `kinds` 掩码复用，
        // 少取一次媒体就少了一整类结果。
        const [parts, media] = await Promise.all([
          this._database.get('mtproto_tl_message_part', { messageId: { $in: messageIds } },
            ['messageId', 'mediaId', 'ordinal', 'tlMessageId']),
          this._database.get('mtproto_im_media', { messageId: { $in: messageIds } },
            ['id', 'kind', 'mimeType', 'voice']),
        ])
        const rowsById = new Map(chunk.map((row) => [row.id, row]))
        const mediaById = new Map(media.map((item) => [item.id, item]))
        for (const part of parts) {
          const row = rowsById.get(part.messageId)
          if (!row) continue
          output.push({
            tlMessageId: part.tlMessageId,
            timestamp: row.timestamp,
            messageId: row.id,
            ordinal: part.ordinal,
            partKind: mediaSearchKind(part.mediaId === null ? undefined : mediaById.get(part.mediaId)),
            messageKinds: row.searchKinds ?? 0,
          })
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(SEARCH_INDEX_CHUNK_CONCURRENCY, chunks.length) },
      worker,
    ))
    return output.sort((left, right) => right.tlMessageId - left.tlMessageId)
  }

  /**
   * 缓存里的扫描结果能否回答 `mask`。
   *
   * 下推的掩码越大结果越全，所以「缓存掩码包含请求掩码」时可以复用；
   * 没有下推类别过滤（缓存掩码为 `0`）的那次扫描本身就是全集，能回答任何掩码。
   * 反过来不行：只扫过照片的缓存回答不了「照片或视频」。
   */
  private _searchIndexCovers(cachedMask: number, mask: number): boolean {
    if (cachedMask === 0) return true
    if (mask === 0) return false
    return (cachedMask & mask) === mask
  }

  private _searchIndexCacheKey(
    platformSessionId: string,
    query: Omit<MessageSearchQuery, 'limit' | 'before'>,
  ): string {
    return JSON.stringify([
      platformSessionId,
      query.platformConversationIds ? [...query.platformConversationIds].sort() : null,
      [...query.terms].sort(),
      query.senderUserId ?? null,
      query.minTimestamp ?? null,
      query.maxTimestamp ?? null,
    ])
  }

  private _trimSearchIndexCache(): void {
    while (this._partIndexCache.size > SEARCH_INDEX_CACHE_LIMIT) {
      const oldest = this._partIndexCache.keys().next().value
      if (oldest === undefined) break
      this._partIndexCache.delete(oldest)
    }
  }

  /** 会话里的消息变了以后丢掉它的分片索引与计数缓存，下次重新扫描。 */
  private _invalidateSearchPartIndex(platformConversationId: string): void {
    for (const [key, entry] of this._partIndexCache) {
      if (!entry.conversationIds.length || entry.conversationIds.includes(platformConversationId)) {
        this._partIndexCache.delete(key)
      }
    }
    for (const [key, entry] of this._countCache) {
      if (!entry.conversationIds.length || entry.conversationIds.includes(platformConversationId)) {
        this._countCache.delete(key)
      }
    }
  }

  private _clearSearchPartIndex(): void {
    this._partIndexCache.clear()
    this._countCache.clear()
  }

  private async _searchPredicate(
    platformSessionId: string,
    query: MessageSearchQuery,
  ): Promise<Query.Expr<IMMessageRow> | undefined> {
    let conversationIds: number[] | undefined
    if (query.platformConversationIds) {
      if (!query.platformConversationIds.length) return
      const conversations = await this._database.get('mtproto_im_conversation', {
        platformSessionId,
        platformConversationId: { $in: [...new Set(query.platformConversationIds)] },
      }, ['id'])
      if (!conversations.length) return
      conversationIds = conversations.map((conversation) => conversation.id)
    }
    const and: Query.Expr<IMMessageRow>[] = query.terms.map((term) => ({
      searchText: { $regex: escapeRegExpLiteral(term) },
    }))
    if (query.before) {
      and.push({
        $or: [
          { timestamp: { $lt: query.before.timestamp } },
          { timestamp: query.before.timestamp, id: { $lt: query.before.messageId } },
        ],
      })
    }
    const timestamp: Query.FieldExpr<number> = {}
    if (query.minTimestamp !== undefined) timestamp.$gt = query.minTimestamp
    if (query.maxTimestamp !== undefined) timestamp.$lt = query.maxTimestamp
    // searchKinds 为空的旧行尚未建立搜索字段，统一排除；系统提示只在通话记录过滤中出现。
    const kinds: Query.FieldExpr<number | null> = { $exists: true }
    if (query.kinds) kinds.$bitsAnySet = query.kinds
    if (!(query.kinds && query.kinds & SEARCH_KIND.PHONE_CALL)) kinds.$bitsAllClear = SEARCH_KIND.SERVICE
    return {
      // 会话行号（`mtproto_im_conversation.id`）是全局唯一行号，单会话查询再带上 32 字节的
      // `platformSessionId` 是多余的；而 `mtproto_im_message_media_index` 里没有这一列，
      // 带上它 PostgreSQL 就无法 index-only scan，只能按 19 万行逐行回表。
      ...(conversationIds?.length === 1 ? {} : { platformSessionId }),
      deleted: false,
      searchKinds: kinds,
      ...(conversationIds
        ? { conversationId: conversationIds.length === 1 ? conversationIds[0] : { $in: conversationIds } }
        : {}),
      ...(query.senderUserId !== undefined ? { senderUserId: query.senderUserId } : {}),
      ...(Object.keys(timestamp).length ? { timestamp } : {}),
      ...(and.length ? { $and: and } : {}),
    } as Query.Expr<IMMessageRow>
  }

  /** 提及判定所需的上下文：账号自身 ID、会话类型、回复目标是否为自己发出的消息。 */
  private async _searchContext(
    database: Database,
    session: Pick<PlatformSession, 'userId'>,
    conversation: Pick<IMConversationRow, 'id' | 'kind'>,
    source: Pick<IMMessage, 'replyToId' | 'outgoing'>,
  ): Promise<MessageSearchContext> {
    let repliesToSelf = false
    if (source.replyToId && conversation.kind !== 'direct' && !source.outgoing) {
      const [alias] = await database.get('mtproto_im_message_alias', {
        conversationId: conversation.id, platformMessageId: source.replyToId,
      }, ['messageId'])
      if (alias) {
        const [target] = await database.get('mtproto_im_message', { id: alias.messageId }, ['outgoing'])
        repliesToSelf = target?.outgoing === true
      }
    }
    return {
      selfUserId: session.userId,
      conversationKind: conversation.kind as IMConversation['kind'],
      repliesToSelf,
    }
  }

  /**
   * 为旧数据补齐搜索字段，按行号升序每批处理 `batchSize` 行。
   * 返回本批处理的行数，0 表示已全部完成。
   */
  async rebuildSearchFields(batchSize = 1000): Promise<number> {
    const rows = await this._database.select('mtproto_im_message', { searchKinds: null })
      .orderBy('id').limit(clampDatabaseLimit(batchSize)).execute()
    if (!rows.length) return 0
    const sessionIds = [...new Set(rows.map((row) => row.platformSessionId))]
    const conversationIds = [...new Set(rows.map((row) => row.conversationId))]
    const [sessions, conversations] = await Promise.all([
      this._database.get('mtproto_platform_session', { id: { $in: sessionIds } }, ['id', 'userId']),
      this._database.get('mtproto_im_conversation', { id: { $in: conversationIds } }, ['id', 'kind']),
    ])
    const selfIds = new Map(sessions.map((row) => [row.id, row.userId]))
    const conversationsById = new Map(conversations.map((row) => [row.id, row]))
    await this._write(() => this._database.withTransaction(async (database) => {
      for (const row of rows) {
        const message = {
          content: hydrateMessageContent(row.content),
          outgoing: row.outgoing,
          replyToId: storedReplyToId(row.metadata),
        } as IMMessage
        const conversation = conversationsById.get(row.conversationId) ?? { id: row.conversationId, kind: 'direct' }
        const context = await this._searchContext(
          database, { userId: selfIds.get(row.platformSessionId) ?? '' }, conversation, message,
        )
        await database.set('mtproto_im_message', { id: row.id, searchKinds: null }, {
          searchText: messageSearchText(message),
          searchKinds: messageSearchKinds(message, context),
        })
      }
    }), 'search-rebuild')
    this._clearSearchPartIndex()
    return rows.length
  }
  private async _hydrateProjectedRows(rows: readonly IMMessageRow[]): Promise<ProjectedMessage[]> {
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

  async readExistingPlatformMessageIds(
    platformSessionId: string,
    platformConversationId: string,
    platformMessageIds: readonly string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(platformMessageIds)]
    if (!uniqueIds.length) return []
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return []
    const aliases = await this._database.get('mtproto_im_message_alias', {
      platformSessionId,
      conversationId: conversation.id,
      platformMessageId: { $in: uniqueIds },
    })
    if (!aliases.length) return []
    const liveRows = await this._database.get('mtproto_im_message', {
      id: { $in: [...new Set(aliases.map((alias) => alias.messageId))] },
      deleted: false,
    })
    const liveMessageIds = new Set(liveRows.map((row) => row.id))
    return aliases
      .filter((alias) => liveMessageIds.has(alias.messageId))
      .map((alias) => alias.platformMessageId)
  }

  async readMessageByRowId(platformSessionId: string, messageId: number): Promise<IMMessage | undefined> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return
    const [row] = await this._database.get('mtproto_im_message', { id: messageId, platformSessionId })
    if (!row || row.deleted) return
    return this._hydrateMessage(row)
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
    const parts = await this._database.select('mtproto_tl_message_part', {
      platformSessionId,
      conversationId: conversation.id,
      nativeSequence,
    }).orderBy('ordinal').orderBy('id').execute()
    if (!parts.length) return
    const rows = await this._database.get('mtproto_im_message', {
      id: { $in: [...new Set(parts.map((part) => part.messageId))] },
      deleted: false,
    })
    const rowsById = new Map(rows.map((row) => [row.id, row]))
    // QQ 灰条可能复用前一条普通消息的 msgSeq；存在普通消息时优先匹配普通消息，同类型候选按最早投影兜底。
    const candidates = parts.flatMap((part) => {
      const row = rowsById.get(part.messageId)
      return row ? [{ part, row }] : []
    }).sort((left, right) =>
      Number(messageRowHasServiceAction(left.row)) - Number(messageRowHasServiceAction(right.row))
      || left.part.ordinal - right.part.ordinal
      || left.part.id - right.part.id)
    const selected = candidates[0]
    if (!selected) return
    const { row } = selected
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

  /**
   * 将指向 QQ 灰条的回复重定向到同 msgSeq 的正文消息。
   * QQ 灰条（戳一戳、精华提示、撤回提示等）会复用所附着正文的 msgSeq，回复该位置时可能上报灰条自身的 ID。
   */
  async preferContentReplyTarget(
    platformSessionId: string,
    projected: ProjectedMessage,
  ): Promise<ProjectedMessage> {
    if (!isServiceMessage(projected.source)) return projected
    const nativeSequence = qqMessageSequenceFromMetadata(projected.source.metadata)
    if (nativeSequence === undefined) return projected
    const sibling = await this.findProjectedByNativeSequence(
      platformSessionId, projected.source.conversationId, nativeSequence,
    )
    return sibling && !isServiceMessage(sibling.source) ? sibling : projected
  }

  async findReplyTarget(
    platformSessionId: string,
    source: IMMessage,
  ): Promise<ProjectedMessage | undefined> {
    if (source.replyToId) {
      const projected = await this.findProjectedByPlatformId(
        platformSessionId, source.conversationId, source.replyToId,
      )
      if (projected) return this.preferContentReplyTarget(platformSessionId, projected)
    }
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
  }

  /** 更新消息的 Telegram 提及标记；已存在记录时不重置已读状态。 */
  async setMessageMentioned(
    platformSessionId: string,
    platformConversationId: string,
    tlMessageId: number,
    mentioned: boolean,
    unreadIfNew: boolean,
  ): Promise<boolean> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const [conversation] = await database.get('mtproto_im_conversation', {
        platformSessionId, platformConversationId,
      })
      if (!conversation) return false
      const [part] = await database.get('mtproto_tl_message_part', {
        platformSessionId, conversationId: conversation.id, tlMessageId, ordinal: 0,
      })
      if (!part) return false
      const [existing] = await database.get('mtproto_message_mention', { messageId: part.messageId })
      if (!mentioned) {
        if (existing) await database.remove('mtproto_message_mention', { messageId: part.messageId })
        return false
      }
      if (existing) {
        if (existing.tlMessageId !== tlMessageId) {
          await database.set('mtproto_message_mention', { messageId: part.messageId }, {
            tlMessageId, updatedAt: new Date(),
          })
        }
        return false
      }
      await database.create('mtproto_message_mention', {
        messageId: part.messageId,
        platformSessionId,
        conversationId: conversation.id,
        tlMessageId,
        unread: unreadIfNew,
        updatedAt: new Date(),
      })
      return unreadIfNew
    }), 'mention-state')
  }

  async countUnreadMentions(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<number> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return 0
    return this._database.select('mtproto_message_mention', {
      platformSessionId, conversationId: conversation.id, unread: true,
    }).execute().then((rows) => rows.length)
  }

  async countUnreadMentionsMany(
    platformSessionId: string,
    platformConversationIds: readonly string[],
  ): Promise<Map<string, number>> {
    const uniqueIds = [...new Set(platformConversationIds)]
    const counts = new Map(uniqueIds.map((id) => [id, 0]))
    if (!uniqueIds.length) return counts
    const conversations = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId: { $in: uniqueIds },
    })
    if (!conversations.length) return counts
    const byRowId = new Map(conversations.map((conversation) => [
      conversation.id, conversation.platformConversationId,
    ]))
    const mentions = await this._database.get('mtproto_message_mention', {
      platformSessionId, conversationId: { $in: [...byRowId.keys()] }, unread: true,
    })
    for (const mention of mentions) {
      const conversationId = byRowId.get(mention.conversationId)
      if (conversationId) counts.set(conversationId, (counts.get(conversationId) ?? 0) + 1)
    }
    return counts
  }

  async listUnreadMentions(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<ProjectedMessage[]> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return []
    const mentions = await this._database.select('mtproto_message_mention', {
      platformSessionId, conversationId: conversation.id, unread: true,
    }).orderBy('tlMessageId', 'desc').execute()
    if (!mentions.length) return []
    const messageIds = mentions.map((mention) => mention.messageId)
    const rows = await this._database.get('mtproto_im_message', {
      id: { $in: messageIds }, deleted: false,
    })
    if (!rows.length) return []
    const [sources, parts, media] = await Promise.all([
      this._hydrateMessages(rows, new Map([[conversation.id, conversation.platformConversationId]])),
      this._database.get('mtproto_tl_message_part', { messageId: { $in: messageIds } }),
      this._database.get('mtproto_im_media', { messageId: { $in: messageIds } }),
    ])
    const sourceByMessageId = new Map(rows.map((row, index) => [row.id, sources[index]]))
    const partsByMessage = groupByMessageId(parts, (left, right) => left.ordinal - right.ordinal)
    const mediaByMessage = groupByMessageId(media, (left, right) => left.ordinal - right.ordinal)
    return mentions.flatMap((mention) => {
      const source = sourceByMessageId.get(mention.messageId)
      return source ? [{
        source,
        parts: partsByMessage.get(mention.messageId) ?? [],
        media: mediaByMessage.get(mention.messageId) ?? [],
      }] : []
    })
  }

  async listUnreadMentionIds(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<Set<number>> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return new Set()
    const mentions = await this._database.get('mtproto_message_mention', {
      platformSessionId, conversationId: conversation.id, unread: true,
    })
    return new Set(mentions.map((mention) => mention.tlMessageId))
  }

  async markMentionIdsRead(
    platformSessionId: string,
    platformConversationId: string,
    tlMessageIds: readonly number[],
  ): Promise<number[]> {
    const uniqueIds = [...new Set(tlMessageIds)]
    if (!uniqueIds.length) return []
    return this._write(() => this._database.withTransaction(async (database) => {
      const [conversation] = await database.get('mtproto_im_conversation', {
        platformSessionId, platformConversationId,
      })
      if (!conversation) return []
      const query = {
        platformSessionId,
        conversationId: conversation.id,
        tlMessageId: { $in: uniqueIds },
        unread: true,
      }
      const rows = await database.get('mtproto_message_mention', query)
      if (!rows.length) return []
      await database.set('mtproto_message_mention', query, {
        unread: false, updatedAt: new Date(),
      })
      return rows.map((row) => row.tlMessageId).sort((left, right) => left - right)
    }), 'mention-content-read')
  }

  async markMentionsRead(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<number[]> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const [conversation] = await database.get('mtproto_im_conversation', {
        platformSessionId, platformConversationId,
      })
      if (!conversation) return []
      const rows = await database.get('mtproto_message_mention', {
        platformSessionId, conversationId: conversation.id, unread: true,
      })
      if (!rows.length) return []
      await database.set('mtproto_message_mention', {
        platformSessionId, conversationId: conversation.id, unread: true,
      }, { unread: false, updatedAt: new Date() })
      return rows.map((row) => row.tlMessageId).sort((left, right) => left - right)
    }), 'mention-read')
  }

  async getOldestTlMessageId(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<number | undefined> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return
    const [oldest] = await this._database.select('mtproto_im_message', {
      conversationId: conversation.id, deleted: false,
    }).orderBy('timestamp').limit(1).execute()
    if (!oldest) return
    const messages = await this._database.get('mtproto_im_message', {
      conversationId: conversation.id, deleted: false, timestamp: oldest.timestamp,
    })
    // 同一秒内可能有多条消息，先按 messageId 取回首条分片再比较 tlMessageId，
    // 这样不必维护「会话维度 + tlMessageId 有序」的索引。
    const parts = await this._database.get('mtproto_tl_message_part', {
      platformSessionId,
      messageId: { $in: messages.map((message) => message.id) },
      ordinal: 0,
    })
    return parts.reduce<number | undefined>(
      (smallest, part) => smallest === undefined || part.tlMessageId < smallest
        ? part.tlMessageId
        : smallest,
      undefined,
    )
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

  /** 为 RPC 响应预留 pts，不递增推送用的 seq。 */
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
        date: Math.max(current?.date ?? 0, date),
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
      const claimedAt = Math.floor(Date.now() / 1000)
      const existing = await this._updateStore.get(eventKey)
      if (existing) {
        // 复用此前未完成的预留记录时刷新认领时间，通知读取侧等待 payload 构建。
        await this._updateStore.claim(eventKey, claimedAt)
        return { ...existing, claimedAt }
      }

      const allocated = await this._database.withTransaction(async (database) => {
        const [current] = await database.get('mtproto_update_state', { platformSessionId })
        // updates.getDifference 依靠客户端传入的 date 发现错过的频道更新；即使回填旧消息也必须保持 date 单调递增。
        const deliveryDate = Math.max(current?.date ?? 0, date)
        const account = {
          platformSessionId,
          pts: (current?.pts ?? 1) + (channelId === undefined ? ptsCount : 0),
          qts: current?.qts ?? 0,
          seq: (current?.seq ?? 0) + 1,
          date: deliveryDate,
        }
        await database.upsert('mtproto_update_state', [account])
        if (channelId === undefined) {
          return { state: account, scope: ACCOUNT_UPDATE_SCOPE, seq: account.seq, date: deliveryDate }
        }
        const id = channelStateId(platformSessionId, channelId)
        const [currentChannel] = await database.get('mtproto_channel_update_state', { id })
        const channel = {
          id, platformSessionId, channelId: String(channelId),
          pts: (currentChannel?.pts ?? current?.pts ?? 1) + ptsCount,
          date: Math.max(currentChannel?.date ?? 0, deliveryDate),
        }
        await database.upsert('mtproto_channel_update_state', [channel])
        return { state: channel, scope: channelUpdateScope(channelId), seq: account.seq, date: deliveryDate }
      })
      return this._updateStore.create({
        eventKey, platformSessionId, scope: allocated.scope, pts: allocated.state.pts, ptsCount,
        seq: allocated.seq, date: allocated.date, published: false, claimedAt, payload: null,
      })
    })
  }

  async getUpdateDelivery(eventKey: string) {
    return this._updateStore.get(eventKey)
  }

  async markUpdatePublished(eventKey: string): Promise<void> {
    await this._write(() => this._updateStore.markPublished(eventKey))
  }

  async setUpdatePayload(eventKey: string, payload: UpdateJson): Promise<void> {
    await this._write(() => this._updateStore.setPayload(eventKey, payload))
  }

  async discardPendingUpdateDelivery(eventKey: string): Promise<boolean> {
    return this._discardUpdateDelivery(eventKey, false)
  }

  /** 清理未认领或已超过认领宽限期的无 payload 预留记录，防止卡死 difference 游标。 */
  async discardAbandonedUpdateDelivery(eventKey: string): Promise<boolean> {
    return this._discardUpdateDelivery(eventKey, true)
  }

  private async _discardUpdateDelivery(eventKey: string, onlyIfAbandoned: boolean): Promise<boolean> {
    return this._write(async () => {
      const delivery = await this._updateStore.get(eventKey)
      if (!delivery || delivery.payload) return false
      if (onlyIfAbandoned && delivery.claimedAt !== null
        && Math.floor(Date.now() / 1000) - delivery.claimedAt < CLAIMED_DELIVERY_GRACE_SECONDS) return false
      await this._updateStore.remove(eventKey)
      return true
    })
  }

  async getPendingUpdateDeliveries(platformSessionId: string) {
    return this._updateStore.getPending(platformSessionId)
  }

  async getUpdateDeliveriesAfter(platformSessionId: string, pts: number, limit = 101, channelId?: number) {
    return this._updateStore.getAfter(
      platformSessionId,
      channelId === undefined ? ACCOUNT_UPDATE_SCOPE : channelUpdateScope(channelId),
      pts,
      limit,
    )
  }

  /** 该频道保留窗口中最旧的 delivery；`pts - ptsCount` 之前的更新已被清理。 */
  async getFirstUpdateDelivery(platformSessionId: string, channelId?: number) {
    return this._updateStore.getFirst(
      platformSessionId,
      channelId === undefined ? ACCOUNT_UPDATE_SCOPE : channelUpdateScope(channelId),
    )
  }

  async getChannelUpdateDeliveriesSince(platformSessionId: string, date: number, limit: number) {
    return (await this._updateStore.getSince(platformSessionId, date, limit))
      .filter((delivery) => delivery.scope.startsWith('channel:'))
  }

  async getChangedChannelScopes(platformSessionId: string, date: number) {
    return this._updateStore.getChangedChannelScopes(platformSessionId, date)
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

  private async _upsertRequest(
    database: Database,
    session: PlatformSession,
    request: IMRequest,
    now: Date,
  ): Promise<RequestUpsertResult> {
    const [existing] = await database.get('mtproto_im_request', {
      platformSessionId: session.platformSessionId,
      platformRequestId: request.id,
    })
    const previous = existing ? requestFromRow(existing) : undefined
    // QQ 群通知等可能上报 createdAt=0；避免将收件箱消息时间设为 1970 年导致会话在客户端列表中隐身。
    const createdAt = [previous?.createdAt, request.createdAt]
      .find((value) => requestTimestamp(value) > 0)
    // 申请进入终态后不可逆，防止冷启动全量同步与实时处理并发时把已处理申请回退为 pending。
    const canonical: IMRequest = previous && previous.state !== 'pending'
      ? { ...previous, createdAt: createdAt ?? now.getTime() }
      : { ...request, createdAt: createdAt ?? now.getTime() }
    const stored = canonical as unknown as JsonObject
    const changed = !existing
      || existing.kind !== canonical.kind
      || existing.state !== canonical.state
      || !jsonEquals(existing.request, stored)
    if (changed) {
      await database.upsert('mtproto_im_request', [{
        platformSessionId: session.platformSessionId,
        platformRequestId: canonical.id,
        kind: canonical.kind,
        state: canonical.state,
        request: stored,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }], ['platformSessionId', 'platformRequestId'])
    }
    return { request: canonical, created: !existing, changed, previous }
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
    const values = {
      platformId,
      platformUserId: user.id,
      firstName: placeholder && existing ? existing.firstName : user.firstName,
      lastName: user.lastName ?? existing?.lastName ?? null,
      username: user.username ?? existing?.username ?? null,
      avatar: (user.avatar ?? existing?.avatar ?? null) as JsonValue | null,
      metadata: { ...existing?.metadata, ...user.metadata },
      updatedAt: now,
    }
    if (!existing) return database.create('mtproto_im_user', values)
    await database.set('mtproto_im_user', { id: existing.id }, values)
    return { ...existing, ...values }
  }

  private async _upsertConversation(
    database: Database,
    session: PlatformSession,
    conversation: IMConversation,
    unreadCount: number | undefined,
    now: Date,
  ): Promise<IMConversationRow> {
    // 私聊的第一条消息可能是自己发出的（sender 为自身），需在此确保对端用户记录已存在以便后续投影。
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
    const metadata = conversationMetadata(conversation, existing?.metadata)
    const peerChanged = !existing
      || existing.kind !== conversation.kind
      || existing.title !== conversation.title
      || existing.parentPlatformConversationId !== (conversation.parentId ?? null)
      || existing.spacePlatformId !== (conversation.spaceId ?? null)
      || !jsonEquals(existing.avatar, conversation.avatar ?? existing.avatar ?? null)
      || !jsonEquals(existing.metadata, metadata)
    const values = {
      platformSessionId: session.platformSessionId,
      platformConversationId: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      parentPlatformConversationId: conversation.parentId ?? null,
      spacePlatformId: conversation.spaceId ?? null,
      avatar: (conversation.avatar ?? existing?.avatar ?? null) as JsonValue | null,
      metadata,
      unreadCount: unreadCount ?? existing?.unreadCount ?? 0,
      updatedAt: now,
    }
    const row = existing
      ? { ...existing, ...values }
      : await database.create('mtproto_im_conversation', values)
    if (existing) await database.set('mtproto_im_conversation', { id: existing.id }, values)
    if (peerChanged) this._peerRevision++
    return row
  }

  private async _ensureProjection(
    database: Database,
    session: PlatformSession,
    conversation: IMConversationRow,
    message: IMMessageRow,
    source: IMMessage,
    media: IMMediaRow[],
    allocation: 'live' | 'history',
    nativeOrderKey: string | undefined,
    allocationCache: ProjectionAllocationCache,
  ): Promise<{ projection: TlMessagePartRow[], addedTlMessageIds: number[], removedTlMessageIds: number[] }> {
    const platformSessionId = session.platformSessionId
    const defaultPlan = (): MessageProjectionPlan => {
      const article = isArticleMessage(source)
      return {
        parts: article
          ? [{ mediaPartIndex: media[0]?.partIndex }]
          : media.length
            ? media.map((item) => ({ mediaPartIndex: item.partIndex }))
            : [{}],
        grouped: !article && media.length > 1 && new Set(media.map((item) => item.kind)).size === 1,
      }
    }
    const plan = this._messageProjection
      ? await this._messageProjection.plan({
          session,
          target: {
            conversation: toConversation(conversation),
            title: conversation.title,
          },
          source,
          allocation,
        }, defaultPlan)
      : defaultPlan()
    if (!plan.parts.length) throw new Error('message projection plan must contain at least one part')
    const addedTlMessageIds: number[] = []
    const removedTlMessageIds: number[] = []
    const count = plan.parts.length
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
      removedTlMessageIds.push(...existing.map((part) => part.tlMessageId))
      for (const part of existing) await database.remove('mtproto_tl_message_part', { id: part.id })
      existing = []
    } else if (existing.length > count) {
      const removed = existing.slice(count)
      removedTlMessageIds.push(...removed.map((part) => part.tlMessageId))
      for (const part of removed) {
        await database.remove('mtproto_tl_message_part', { id: part.id })
      }
      existing = existing.slice(0, count)
    }
    // 实时消息的排序键后续可能被回执或历史记录补全，但已下发给客户端的 tlMessageId 不可改变，仅原地更新排序字段。
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
    const groupable = plan.grouped && count > 1
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
      addedTlMessageIds.push(...ids)
      await database.upsert('mtproto_tl_message_part', ids.map((tlMessageId, index) => {
        const ordinal = existing.length + index
        return {
          platformSessionId,
          conversationId: conversation.id,
          messageId: message.id,
          mediaId: projectionMediaId(plan, media, ordinal),
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
    const updatedProjection = await Promise.all(projection.map(async (part) => {
      const mediaId = projectionMediaId(plan, media, part.ordinal)
      if (part.mediaId === mediaId && part.groupedId === groupedId) return part
      await database.set('mtproto_tl_message_part', { id: part.id }, { mediaId, groupedId })
      return { ...part, mediaId, groupedId }
    }))
    return { projection: updatedProjection, addedTlMessageIds, removedTlMessageIds }
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
    // 相邻原生序号对应的旧 tlMessageId 之间可能已无空余整数，此时放宽顺序约束以保证消息能完成入库。
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
    const conversationIds = new Map(conversations.map((conversation) => [
      conversation.id, conversation.platformConversationId,
    ]))
    const hydrated = await this._hydrateMessages(rows, conversationIds)
    const hydratedById = new Map(rows.map((row, index) => [row.id, hydrated[index]]))
    // 已读边界消息通常不是最新消息，需单独取回；行已不存在时退回 undefined，由上层按未读计数决定。
    const boundaryRows = await this._messagesByIds(conversations
      .map((conversation) => conversation.readInboxMaxMessageId)
      .filter((id): id is number => typeof id === 'number' && id > 0)
      .filter((id) => !hydratedById.has(id)))
    const boundaries = await this._hydrateMessages(boundaryRows, conversationIds)
    const boundaryById = new Map(boundaryRows.map((row, index) => [row.id, boundaries[index]]))
    return conversations.map((conversation, index) => {
      const latest = latestRows[index]
      const boundaryId = conversation.readInboxMaxMessageId ?? undefined
      const readInboxMaxMessage = boundaryId === undefined
        ? undefined
        : hydratedById.get(boundaryId) ?? boundaryById.get(boundaryId)
      return {
        conversation: toConversation(conversation),
        unreadCount: conversation.unreadCount,
        lastMessage: latest ? hydratedById.get(latest.id) : undefined,
        ...(readInboxMaxMessage ? { readInboxMaxMessage } : {}),
      }
    })
  }

  private async _messagesByIds(ids: readonly number[]): Promise<IMMessageRow[]> {
    const unique = [...new Set(ids)]
    return unique.length ? this._database.get('mtproto_im_message', { id: { $in: unique } }) : []
  }

  private async _latestMessagesForConversations(
    conversationIds: readonly number[],
  ): Promise<Array<IMMessageRow | undefined>> {
    return Promise.all(conversationIds.map(async (conversationId) => {
      const [latest] = await this._database.select('mtproto_im_message', {
        conversationId, deleted: false,
      }).orderBy('timestamp', 'desc').orderBy('id', 'desc').limit(1).execute()
      return latest
    }))
  }

  private async _hydrateMessages(
    rows: readonly IMMessageRow[],
    knownConversationIds: ReadonlyMap<number, string> = new Map(),
    database: Database = this._database,
  ): Promise<IMMessage[]> {
    if (!rows.length) return []
    const messageIds = [...new Set(rows.map((row) => row.id))]
    const senderUserIds = [...new Set(rows.map((row) => row.senderUserId))]
    const missingConversationRowIds = [...new Set(rows
      .map((row) => row.conversationId)
      .filter((id) => !knownConversationIds.has(id)))]
    const [aliases, reactions, senders, conversations] = await Promise.all([
      database.get('mtproto_im_message_alias', { messageId: { $in: messageIds } }),
      database.get('mtproto_im_message_reaction', { messageId: { $in: messageIds } }),
      database.get('mtproto_im_user', { id: { $in: senderUserIds } }),
      missingConversationRowIds.length
        ? database.get('mtproto_im_conversation', { id: { $in: missingConversationRowIds } })
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

  private async _hydrateMessage(row: IMMessageRow, database: Database = this._database): Promise<IMMessage> {
    return (await this._hydrateMessages([row], new Map(), database))[0]
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
    const summaries = new Map(context.reactions
      .filter((reaction) => reaction.count > 0 || reaction.selected || reaction.recentActors?.length)
      .map((reaction) => [reaction.key, reaction]))
    // 仅持久化当前消息上实际出现的回应定义，避免将账号级完整回应表复制到每条消息造成写入风暴。
    const existing = await database.get('mtproto_im_message_reaction', { messageId })
    const definitions = new Map(context.available
      .filter((definition) => summaries.has(definition.key))
      .map((definition) => [definition.key, definition]))
    // QQNT 启动或重连期间全局回应表可能尚未加载完（available 为空）；保留库中已有的同 key 定义，防止回应被清空。
    for (const row of existing) {
      if (!definitions.has(row.nativeReactionKey) && summaries.has(row.nativeReactionKey)
        && row.definition && typeof row.definition === 'object' && !Array.isArray(row.definition)) {
        definitions.set(row.nativeReactionKey, row.definition as unknown as IMReactionContext['available'][number])
      }
    }
    const keys = new Set(definitions.keys())
    for (const stale of existing.filter((reaction) => !keys.has(reaction.nativeReactionKey))) {
      await database.remove('mtproto_im_message_reaction', { id: stale.id })
    }
    await database.upsert('mtproto_im_message_reaction', [...definitions].map(([key, definition]) => {
      const reaction = summaries.get(key)
      return {
      messageId, nativeReactionKey: key, count: reaction?.count ?? 0,
      selected: reaction?.selected ?? false,
      selectedOrder: reaction?.selectedOrder ?? 0,
      recentActors: (reaction?.recentActors ?? []) as unknown as Record<string, unknown>[],
      definition: definition as unknown as Record<string, unknown>, updatedAt: now,
    }
    }), ['messageId', 'nativeReactionKey'])
  }

  async pruneUpdateDeliveries(platformSessionId: string): Promise<void> {
    await this._write(() => this._updateStore.prune(platformSessionId, ACCOUNT_UPDATE_SCOPE))
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

function messageRowHasServiceAction(row: IMMessageRow): boolean {
  const content = row.content
  return typeof content === 'object' && content !== null && !Array.isArray(content)
    && 'serviceAction' in content && content.serviceAction !== undefined && content.serviceAction !== null
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
  const { replyToId, senderTitle, recalled, metadata } = hydrateMessageMetadata(row.metadata)
  const sender = toUser(senderRow)
  return {
    id: row.primaryPlatformMessageId,
    sourceIds: aliases.map((alias) => alias.platformMessageId),
    conversationId,
    senderId: sender.id,
    sender,
    senderTitle,
    content: hydrateMessageContent(row.content),
    timestamp: row.timestamp,
    outgoing: row.outgoing,
    recalled,
    groupId: row.platformGroupId ?? undefined,
    replyToId,
    metadata,
    reactionContext: reactions.length ? {
      available: reactions.map((reaction) => reaction.definition as unknown as IMReactionDefinition),
      reactions: reactions.filter((reaction) => reaction.count > 0 || reaction.selected).map((reaction) => ({
        key: reaction.nativeReactionKey, count: reaction.count,
        selected: reaction.selected,
        selectedOrder: reaction.selectedOrder || undefined,
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

function requestFromRow(row: IMRequestRow): IMRequest {
  return row.request as unknown as IMRequest
}

function toConversation(row: IMConversationRow): IMConversation {
  const hydrated = hydrateConversationMetadata(row.metadata)
  return {
    id: row.platformConversationId,
    kind: row.kind,
    title: row.title,
    parentId: row.parentPlatformConversationId ?? undefined,
    spaceId: row.spacePlatformId ?? undefined,
    avatar: row.avatar === null ? undefined : row.avatar as unknown as IMConversation['avatar'],
    selfRole: hydrated.selfRole,
    selfPermissions: hydrated.selfPermissions,
    metadata: hydrated.metadata,
  }
}

function conversationMetadata(
  conversation: IMConversation,
  existing?: JsonObject,
): JsonObject {
  const metadata: JsonObject = { ...conversation.metadata }
  const legacyRole = legacyConversationRole(conversation.metadata) ?? legacyConversationRole(existing)
  const selfRole = conversation.selfRole ?? storedConversationRole(existing) ?? legacyRole
  const selfPermissions = conversation.selfPermissions
    ?? (conversation.selfRole === undefined
      ? storedConversationPermissions(existing)
        ?? (legacyRole ? legacyQqConversationPermissions(legacyRole) : undefined)
      : undefined)
  if (selfRole) metadata[STORED_CONVERSATION_SELF_ROLE_KEY] = selfRole
  if (selfPermissions) {
    metadata[STORED_CONVERSATION_SELF_PERMISSIONS_KEY] = selfPermissions as unknown as JsonObject
  }
  return metadata
}

function hydrateConversationMetadata(metadata: JsonObject): {
  selfRole?: IMConversation['selfRole']
  selfPermissions?: IMConversation['selfPermissions']
  metadata: JsonObject
} {
  const publicMetadata = { ...metadata }
  delete publicMetadata[STORED_CONVERSATION_SELF_ROLE_KEY]
  delete publicMetadata[STORED_CONVERSATION_SELF_PERMISSIONS_KEY]
  const storedRole = storedConversationRole(metadata)
  const legacyRole = legacyConversationRole(metadata)
  return {
    selfRole: storedRole ?? legacyRole,
    selfPermissions: storedConversationPermissions(metadata)
      ?? (legacyRole ? legacyQqConversationPermissions(legacyRole) : undefined),
    metadata: publicMetadata,
  }
}

function storedConversationRole(metadata: JsonObject | undefined): IMConversation['selfRole'] | undefined {
  const role = metadata?.[STORED_CONVERSATION_SELF_ROLE_KEY]
  return isConversationRole(role) ? role : undefined
}

function legacyConversationRole(metadata: JsonObject | undefined): IMConversation['selfRole'] | undefined {
  const role = metadata?.qqSelfRole
  return isConversationRole(role) ? role : undefined
}

function storedConversationPermissions(
  metadata: JsonObject | undefined,
): IMConversation['selfPermissions'] | undefined {
  const permissions = metadata?.[STORED_CONVERSATION_SELF_PERMISSIONS_KEY]
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return
  const candidate = permissions as Record<string, unknown>
  const required = [
    'manageConversation', 'manageMembers', 'deleteAnyMessage', 'editAnyMessage',
    'pinMessages', 'inviteMembers',
  ] as const
  if (required.some((key) => typeof candidate[key] !== 'boolean')) return
  if (candidate.manageAdministrators !== undefined
    && typeof candidate.manageAdministrators !== 'boolean') return
  return permissions as unknown as NonNullable<IMConversation['selfPermissions']>
}

function isConversationRole(value: unknown): value is NonNullable<IMConversation['selfRole']> {
  return value === 'owner' || value === 'administrator' || value === 'member' || value === 'guest'
}

function legacyQqConversationPermissions(
  role: NonNullable<IMConversation['selfRole']>,
): NonNullable<IMConversation['selfPermissions']> {
  const administrator = role === 'owner' || role === 'administrator'
  return {
    manageConversation: administrator,
    manageMembers: administrator,
    deleteAnyMessage: administrator,
    editAnyMessage: administrator,
    pinMessages: administrator,
    inviteMembers: role !== 'guest',
    manageAdministrators: role === 'owner',
  }
}

function projectionMediaId(
  plan: MessageProjectionPlan,
  media: readonly IMMediaRow[],
  ordinal: number,
): number | null {
  const partIndex = plan.parts[ordinal]?.mediaPartIndex
  if (partIndex === undefined) return null
  return media.find((item) => item.partIndex === partIndex)?.id ?? null
}

function messageMetadata(message: IMMessage): JsonObject {
  return {
    ...message.metadata,
    ...(message.replyToId !== undefined ? { [STORED_REPLY_TO_KEY]: message.replyToId } : {}),
    ...(message.senderTitle !== undefined ? { [STORED_SENDER_TITLE_KEY]: message.senderTitle } : {}),
    ...(message.recalled === true ? { [STORED_RECALLED_KEY]: true } : {}),
  }
}

function hydrateMessageMetadata(metadata: JsonObject): {
  replyToId?: string
  senderTitle?: string
  recalled?: boolean
  metadata: JsonObject
} {
  const publicMetadata = { ...metadata }
  delete publicMetadata[STORED_REPLY_TO_KEY]
  delete publicMetadata[STORED_SENDER_TITLE_KEY]
  delete publicMetadata[STORED_RECALLED_KEY]
  const replyToId = typeof metadata[STORED_REPLY_TO_KEY] === 'string'
    ? metadata[STORED_REPLY_TO_KEY]
    : undefined
  const senderTitle = typeof metadata[STORED_SENDER_TITLE_KEY] === 'string'
    ? metadata[STORED_SENDER_TITLE_KEY]
    : undefined
  const recalled = metadata[STORED_RECALLED_KEY] === true ? true : undefined
  return { replyToId, senderTitle, recalled, metadata: publicMetadata }
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
    parts: content.parts.map((part) => {
      if (part.type === 'sticker' && part.sticker.outline) {
        return { ...part, sticker: { ...part.sticker, outline: [...part.sticker.outline] } }
      }
      if (part.type === 'media' && part.media.strippedThumbnail) {
        return { ...part, media: { ...part.media, strippedThumbnail: [...part.media.strippedThumbnail] } }
      }
      return part
    }),
  } as unknown as JsonValue
}

function hydrateMessageContent(value: JsonValue): IMMessageContent {
  const content = value as unknown as IMMessageContent
  return {
    ...content,
    parts: content.parts.map((part) => {
      if (part.type === 'sticker' && part.sticker.outline !== undefined) {
        return {
          ...part,
          sticker: {
            ...part.sticker,
            outline: hydrateByteArray(part.sticker.outline as unknown),
          },
        }
      }
      if (part.type === 'media' && part.media.strippedThumbnail !== undefined) {
        return {
          ...part,
          media: {
            ...part.media,
            strippedThumbnail: hydrateByteArray(part.media.strippedThumbnail as unknown),
          },
        }
      }
      return part
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
    selectedOrder: reaction.selectedOrder,
    recentActors: reaction.recentActors,
    definition: reaction.definition,
  }
}
