import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import {
  cardUrl, messagePartText, messageText, telegramMessageId, telegramReplyToMessageId,
  type IMConversation, type IMConversationMember, type IMConversationPermissions, type IMDialog, type IMDialogPage,
  type IMMedia, type IMMediaInput,
  type IMEvent, type IMMessage, type IMMessageInput, type IMPlatform, type IMTextEntity, type IMTransferProgress,
  type IMUser,
  type PlatformSession,
} from './platform.js'
import { qqMessageSequenceFromMetadata, qqReplySequenceFromMetadata } from './message-id.js'
import {
  MessageActionUnavailableError, PlatformMessageActions, messageRuleAllows,
} from './message-actions.js'
import { makeUser } from './synthetic.js'
import { toUser, type MessageStore } from './message-store.js'
import { PlatformDataService } from './platform-manager.js'
import type { PlatformEventDeliveryOptions, PlatformEventPublishResult } from './platform-manager.js'
import type { IMMediaRow, IMUserRow } from './models.js'
import type { StagedMedia, UploadedFile, UploadManager } from './upload-manager.js'
import type { StickerRpc } from './sticker-rpc.js'
import type { ReactionRpc } from './reaction-rpc.js'
import type { TelegramResourceService } from './resource-provider.js'
import { probeImageDimensions } from './image-dimensions.js'
import { withAutoLinkEntities } from './message-entities.js'
import { registerVirtualConversation, virtualConversation } from './virtual-conversations.js'
import { getCardThumbnailFile, makeCardThumbnailPhoto, storageFileType } from './card-thumbnail.js'
import type { DraftStore, StoredDraft } from './draft-store.js'

type GetDialogsRequest = tl.messages.RawGetDialogsRequest
type GetPeerDialogsRequest = tl.messages.RawGetPeerDialogsRequest
type GetHistoryRequest = tl.messages.RawGetHistoryRequest
type GetMessagesRequest = tl.messages.RawGetMessagesRequest
type GetChannelMessagesRequest = tl.channels.RawGetMessagesRequest
type SendMessageRequest = tl.messages.RawSendMessageRequest
type SendMediaRequest = tl.messages.RawSendMediaRequest
type SendMultiMediaRequest = tl.messages.RawSendMultiMediaRequest
type UploadMediaRequest = tl.messages.RawUploadMediaRequest
type HistoryWindow = Partial<GetHistoryRequest> & Pick<GetHistoryRequest, 'limit'>

interface MessageRef {
  peerId: string
  platformMessageId: string
  ordinal: number
}

interface MaterializedMessage {
  source: IMMessage
  tlId: number
  ordinal: number
  groupedId?: string
  media?: IMMediaRow
}

interface ResolvedMediaUpload {
  media: IMMediaInput
  upload: UploadedFile
}

interface ResolvedStickerInput {
  sticker: import('./sticker-provider.js').IMStickerSendPlan
  providerId: string
  stickerId: string
}

export interface LegacyGetForumTopicsRequest {
  _: 'channels.getForumTopics'
  channel: tl.TypeInputChannel
  q?: string
  offsetDate: number
  offsetId: number
  offsetTopic: number
  limit: number
}

export interface LegacyGetForumTopicsByIdRequest {
  _: 'channels.getForumTopicsByID'
  channel: tl.TypeInputChannel
  topics: number[]
}

/**
 * Per-authorized-session bridge for dialog/history RPCs. Telegram's numeric
 * peer/message IDs are allocated here and reverse-mapped to opaque platform IDs.
 */
export class DialogRpc {
  private static readonly PEER_HYDRATION_TTL_MS = 5_000
  private readonly _peerToTl = new Map<string, number>()
  private readonly _tlToPeer = new Map<number, string>()
  private readonly _messageToTl = new Map<string, number>()
  private readonly _tlToMessage = new Map<number, MessageRef>()
  private _nextMessageId = 1
  private _pts = 1
  private readonly _sentByRandomId = new Map<string, Promise<tl.RawUpdateShortSentMessage>>()
  private readonly _sentMediaByRandomId = new Map<string, Promise<tl.TypeUpdates>>()
  private _selfId = 0
  private _selfUser?: IMUser
  private readonly _data?: PlatformDataService
  private readonly _store?: MessageStore
  private readonly _historyCache = new Map<string, MaterializedMessage[]>()
  private readonly _historyCacheMetadata = new Map<
    string,
    { requestKey: string, storeRevision: number, freshUntil: number }
  >()
  private readonly _dialogCache = new Map<string, IMDialog>()
  private readonly _readInboxMaxMessageIds = new Map<string, string>()
  private readonly _conversations = new Map<string, import('./platform.js').IMConversation>()
  private readonly _peerUsers = new Map<string, tl.RawUser>()
  private readonly _pendingPeerUsers = new Map<string, Promise<tl.RawUser>>()
  private readonly _platformUsers = new Map<string, IMUser<any>>()
  private readonly _pendingPlatformUsers = new Map<string, Promise<IMUser<any> | null>>()
  /** Platform user IDs from the latest authoritative contacts snapshot. */
  private readonly _contactUserIds = new Set<string>()
  private readonly _topicToConversation = new Map<number, string>()
  private readonly _conversationToTopic = new Map<string, number>()
  private readonly _avatarMedia = new Map<string, IMMedia<any>>()
  private readonly _memberCursors = new Map<string, Map<number, string | null>>()
  private readonly _searchCursors = new Map<string, string>()
  private readonly _actions: PlatformMessageActions
  private _peersHydratedAt = 0
  private _peerHydration?: Promise<void>
  private _userHydration?: Promise<void>

  constructor(
    private readonly _platform: IMPlatform<any>,
    private readonly _session: PlatformSession,
    store?: MessageStore,
    private readonly _uploads?: UploadManager,
    private readonly _onTransferProgress?: (session: PlatformSession, progress: IMTransferProgress) => void | Promise<void>,
    private readonly _dcId = 1,
    private readonly _stickers?: StickerRpc,
    private readonly _reactions?: ReactionRpc,
    private readonly _resources?: TelegramResourceService,
    private readonly _onLocalEvent?: (
      session: PlatformSession,
      event: IMEvent,
      options?: PlatformEventDeliveryOptions,
    ) => Promise<PlatformEventPublishResult>,
    private readonly _authKeyId?: string,
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    private readonly _drafts?: DraftStore,
    private readonly _onDraftUpdate?: (
      session: PlatformSession,
      update: tl.RawUpdateDraftMessage,
      excludeAuthKeyId?: string,
    ) => Promise<void>,
  ) {
    this._actions = new PlatformMessageActions(_platform, _session)
    if (store) {
      this._store = store
      this._data = new PlatformDataService(_platform, _session, store, _onTrace)
    }
  }

  async getDialogs(req: GetDialogsRequest): Promise<tl.messages.TypeDialogs> {
    await this._hydrateUsers()
    const requestedOffsetPeer = req.offsetPeer._ === 'inputPeerEmpty'
      ? undefined
      : this._tlToPeer.get(inputPeerId(req.offsetPeer))
    const loaded = await this._loadDialogPage({
      limit: clampLimit(req.limit) + 1,
      afterId: requestedOffsetPeer,
    })
    // Preserve the platform's authoritative order. Re-sorting each page makes
    // Telegram's last offset peer point into the middle of the upstream page,
    // causing the next request to overlap or repeat the first page.
    const all = loaded.dialogs.slice()
    await this._persistUsers(all
      .filter((dialog) => dialog.conversation.kind === 'direct')
      .map((dialog) => ({
        id: dialog.conversation.id,
        firstName: dialog.conversation.title,
        avatar: dialog.conversation.avatar,
      })))
    await this._syncStoredUsers()
    for (const dialog of all) {
      this._conversations.set(dialog.conversation.id, dialog.conversation)
      this._peerId(dialog.conversation.id)
    }

    // PlatformDataService has already persisted any previews exposed by
    // getDialogs. Never fan a stored dialog-list request out into upstream
    // history calls, including for rows whose platform preview is temporarily
    // absent during cold start. The no-store path still allocates Telegram IDs
    // oldest-first from history.
    if (!this._store) await Promise.all(all.map((dialog) => this._loadHistory(dialog.conversation.id)))
    const drafts = await this._mainDrafts()
    const materialized = await Promise.all(all.map((dialog) =>
      this._materializeDialog(dialog, drafts.get(dialog.conversation.id))))
    let start = 0
    if (req.offsetPeer._ !== 'inputPeerEmpty') {
      const offsetPeer = this._tlToPeer.get(inputPeerId(req.offsetPeer))
      const index = offsetPeer === undefined ? -1 : materialized.findIndex((item) => item.source.conversation.id === offsetPeer)
      if (index >= 0) start = index + 1
    } else if (req.offsetId > 0 || req.offsetDate > 0) {
      const index = materialized.findIndex((item) =>
        item.dialog.topMessage === req.offsetId
        || item.source.lastMessage?.timestamp === req.offsetDate,
      )
      if (index >= 0) start = index + 1
    }

    const limit = clampLimit(req.limit)
    const page = materialized.slice(start, start + limit)
    const total = loaded.total ?? (loaded.nextCursor ? all.length + 1 : all.length)
    const sliced = start > 0 || page.length < total
    const result = {
      _: sliced ? 'messages.dialogsSlice' : 'messages.dialogs',
      ...(sliced ? { count: total } : {}),
      dialogs: page.map((item) => item.dialog),
      messages: page.flatMap((item) => item.message ? [item.message] : []),
      chats: uniqueChats(page.flatMap((item) => item.chat ? [item.chat] : [])),
      users: uniqueUsers(page.flatMap((item) => item.users)),
    }
    return result as unknown as tl.messages.TypeDialogs
  }

  async getPeerDialogs(req: GetPeerDialogsRequest): Promise<tl.messages.RawPeerDialogs> {
    await this._hydratePeers()
    let loaded = [...this._dialogCache.values()]
    const missingRequestedPeer = req.peers.some((requested) => {
      if (requested._ === 'inputDialogPeerFolder') return false
      const peerId = this._tlToPeer.get(inputPeerId(requested.peer))
      return peerId !== undefined && !this._dialogCache.has(peerId)
    })
    if (missingRequestedPeer) {
      loaded = await this._loadDialogs({ limit: Math.max(100, req.peers.length) })
    }
    const byId = new Map(loaded.map((dialog) => {
      this._peerId(dialog.conversation.id)
      return [dialog.conversation.id, dialog]
    }))
    const selected: IMDialog[] = []
    const seen = new Set<string>()

    for (const requested of req.peers) {
      if (requested._ === 'inputDialogPeerFolder') {
        // The bridge currently exposes one unarchived folder. Telegram clients
        // may use this constructor to request every dialog in that folder.
        if (requested.folderId === 0) {
          for (const dialog of loaded) {
            if (!seen.has(dialog.conversation.id)) selected.push(dialog)
            seen.add(dialog.conversation.id)
          }
        }
        continue
      }
      const peerId = this._resolvePeer(requested.peer)
      const dialog = byId.get(peerId)
      if (!dialog || seen.has(peerId)) continue
      selected.push(dialog)
      seen.add(peerId)
    }

    if (!this._store) {
      await Promise.all(selected.map((dialog) => this._loadHistory(dialog.conversation.id)))
    }
    const drafts = await this._mainDrafts()
    const materialized = await Promise.all(selected.map((dialog) =>
      this._materializeDialog(dialog, drafts.get(dialog.conversation.id))))
    const state = await this._store?.getUpdateState(this._session.platformSessionId)
    return {
      _: 'messages.peerDialogs',
      dialogs: materialized.map((item) => item.dialog),
      messages: materialized.flatMap((item) => item.message ? [item.message] : []),
      chats: uniqueChats(materialized.flatMap((item) => item.chat ? [item.chat] : [])),
      users: uniqueUsers(materialized.flatMap((item) => item.users)),
      state: {
        _: 'updates.state', pts: state?.pts ?? this._pts, qts: state?.qts ?? 0,
        date: state?.date ?? Math.floor(Date.now() / 1000), seq: state?.seq ?? 0, unreadCount: 0,
      },
    }
  }

  async saveDraft(req: tl.messages.RawSaveDraftRequest): Promise<tl.TlObject> {
    if (!this._drafts) throw new RpcError(500, 'DRAFT_STORE_UNAVAILABLE')
    if (req.richMessage) throw new RpcError(400, 'DRAFT_RICH_MESSAGE_UNSUPPORTED')
    await this._hydratePeers()
    const scope = await this._resolveDraftScope(req.peer, req.replyTo)
    const date = Math.floor(Date.now() / 1000)
    if (hasDraftContent(req)) {
      const draft: tl.RawDraftMessage = {
        _: 'draftMessage',
        noWebpage: req.noWebpage,
        invertMedia: req.invertMedia,
        replyTo: req.replyTo,
        message: req.message,
        entities: req.entities,
        media: req.media,
        date,
        effect: req.effect,
        suggestedPost: req.suggestedPost,
      }
      await this._drafts.save(
        this._session.platformSessionId, scope.conversationId, scope.topMsgId, draft,
      )
      await this._publishDraft(scope.conversationId, scope.topMsgId, draft)
    } else {
      await this._drafts.remove(
        this._session.platformSessionId, scope.conversationId, scope.topMsgId,
      )
      await this._publishDraft(scope.conversationId, scope.topMsgId, {
        _: 'draftMessageEmpty', date,
      })
    }
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async getAllDrafts(): Promise<tl.TypeUpdates> {
    await this._hydratePeers()
    const drafts = await this._drafts?.list(this._session.platformSessionId) ?? []
    const state = await this._store?.getUpdateState(this._session.platformSessionId)
    return {
      _: 'updates',
      updates: drafts.map((stored) => this._makeDraftUpdate(stored)),
      users: [], chats: [],
      date: state?.date ?? Math.floor(Date.now() / 1000),
      seq: state?.seq ?? 0,
    }
  }

  async getHistory(req: GetHistoryRequest): Promise<tl.messages.TypeMessages> {
    const startedAt = performance.now()
    this._onTrace?.(
      'history rpc profile stage=start offsetId=%d addOffset=%d limit=%d',
      req.offsetId, req.addOffset, req.limit,
    )
    await this._hydratePeers()
    const hydrateMs = performance.now() - startedAt
    const peerId = this._resolvePeer(req.peer)
    const loadAt = performance.now()
    const all = await this._loadHistory(peerId, req)
    const loadMs = performance.now() - loadAt
    const selectAt = performance.now()
    const filtered = all.filter((item) => {
      // A negative add_offset asks for a window which starts before (newer
      // than) offset_id. Keep both sides of the anchor until the window has
      // been selected below; filtering here used to make every unread-window
      // request empty.
      if (req.addOffset >= 0 && req.offsetId > 0 && item.tlId >= req.offsetId) return false
      if (req.offsetDate > 0 && item.source.timestamp >= req.offsetDate) return false
      if (req.maxId > 0 && item.tlId >= req.maxId) return false
      if (req.minId > 0 && item.tlId <= req.minId) return false
      return true
    })
    const anchorIndex = req.addOffset < 0 && req.offsetId > 0
      ? filtered.findIndex((item) => item.tlId === req.offsetId)
      : -1
    const offsetIndex = anchorIndex >= 0
      ? anchorIndex + 1
      : req.addOffset < 0 && req.offsetId > 0
        ? filtered.findIndex((item) => item.tlId < req.offsetId)
        : 0
    const start = Math.max(0, (offsetIndex < 0 ? filtered.length : offsetIndex) + req.addOffset)
    const page = filtered.slice(start, start + clampLimit(req.limit))
    const selectMs = performance.now() - selectAt
    const conversation = this._conversation(peerId)
    const sendersAt = performance.now()
    const senders = await this._messageSenders(page.map((item) => item.source))
    const peerUser = conversation.kind === 'direct'
      ? [await this._getPeerUser(peerId, conversation.title)]
      : []
    const sendersMs = performance.now() - sendersAt
    const projectAt = performance.now()
    const result = {
      _: page.length < filtered.length || start > 0 ? 'messages.messagesSlice' : 'messages.messages',
      ...(page.length < filtered.length || start > 0 ? { count: filtered.length } : {}),
      messages: page.map((item) => this._makeMessage(item)),
      topics: [],
      chats: uniqueChats([
        ...(conversation.kind === 'direct' ? [] : [this._makeChat(conversation)]),
        ...this._linkedChats(page.map((item) => item.source)),
      ]),
      users: uniqueUsers([...peerUser, ...senders, this._makeSelfUser()]),
    } as unknown as tl.messages.TypeMessages
    const projectMs = performance.now() - projectAt
    this._onTrace?.(
      'history rpc profile peer=%s offsetId=%d addOffset=%d limit=%d loaded=%d filtered=%d returned=%d hydrateMs=%d loadMs=%d selectMs=%d sendersMs=%d projectMs=%d totalMs=%d',
      peerId, req.offsetId, req.addOffset, req.limit, all.length, filtered.length, page.length,
      profileMilliseconds(hydrateMs), profileMilliseconds(loadMs), profileMilliseconds(selectMs),
      profileMilliseconds(sendersMs), profileMilliseconds(projectMs),
      profileMilliseconds(performance.now() - startedAt),
    )
    return result
  }

  async search(req: tl.messages.RawSearchRequest): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const conversation = this._conversation(peerId)
    if (req.filter._ === 'inputMessagesFilterPinned') return this._emptyMessages(conversation)
    if (this._platform.searchMessages) return this._searchPlatform(req, peerId, conversation)
    const all = await this._loadHistory(peerId, {
      offsetId: req.offsetId, offsetDate: req.maxDate, addOffset: req.addOffset,
      limit: req.limit, maxId: req.maxId, minId: req.minId,
    })
    const query = req.q.toLocaleLowerCase()
    const filtered = all.filter((item) => {
      if (req.offsetId > 0 && item.tlId >= req.offsetId) return false
      if (req.minDate > 0 && item.source.timestamp <= req.minDate) return false
      if (req.maxDate > 0 && item.source.timestamp >= req.maxDate) return false
      if (req.maxId > 0 && item.tlId >= req.maxId) return false
      if (req.minId > 0 && item.tlId <= req.minId) return false
      if (query && !messageText(item.source).toLocaleLowerCase().includes(query)) return false
      return matchesMessageFilter(item, req.filter)
    })
    const start = Math.max(0, req.addOffset)
    const page = filtered.slice(start, start + clampLimit(req.limit))
    const users = await this._messageSenders(page.map((item) => item.source))
    return {
      _: page.length < filtered.length || start > 0 ? 'messages.messagesSlice' : 'messages.messages',
      ...(page.length < filtered.length || start > 0 ? { count: filtered.length } : {}),
      messages: page.map((item) => this._makeMessage(item)), topics: [],
      chats: uniqueChats([
        ...(conversation.kind === 'direct' ? [] : [this._makeChat(conversation)]),
        ...this._linkedChats(page.map((item) => item.source)),
      ]),
      users: uniqueUsers([...users, this._makeSelfUser()]),
    } as unknown as tl.messages.TypeMessages
  }

  private async _searchPlatform(
    req: tl.messages.RawSearchRequest,
    peerId: string,
    conversation: IMConversation,
  ): Promise<tl.messages.TypeMessages> {
    const fromUserId = req.fromId?._ === 'inputPeerSelf'
      ? this._session.userId
      : req.fromId?._ === 'inputPeerUser'
        ? this._tlToPeer.get(req.fromId.userId)
        : undefined
    const fingerprint = JSON.stringify([
      peerId, req.q, req.filter._, fromUserId ?? '', req.minDate, req.maxDate,
    ])
    const cursor = req.offsetId > 0
      ? this._searchCursors.get(`${fingerprint}:${req.offsetId}`)
      : undefined
    let maxTimestamp = req.maxDate > 0 ? req.maxDate : undefined
    if (req.offsetId > 0 && !cursor) {
      const cached = this._historyCache.get(peerId)?.find((item) => item.tlId === req.offsetId)?.source
      const stored = !cached && this._store
        ? await this._store.findProjectedByTlId(this._session.platformSessionId, req.offsetId, peerId)
        : undefined
      const anchorTimestamp = cached?.timestamp ?? stored?.source.timestamp
      if (anchorTimestamp !== undefined) {
        maxTimestamp = Math.min(maxTimestamp ?? anchorTimestamp, anchorTimestamp)
      }
    }
    const fetchLimit = Math.max(1, Math.min(
      clampLimit(req.limit) + Math.max(0, req.addOffset),
      200,
    ))
    const query = {
      query: req.q,
      cursor,
      limit: fetchLimit,
      fromUserId,
      minTimestamp: req.minDate > 0 ? req.minDate : undefined,
      maxTimestamp,
      mediaKind: searchMediaKind(req.filter),
    } as const
    const upstream = this._data
      ? await this._data.searchMessages(peerId, query)
      : await this._platform.searchMessages!(this._session, { id: peerId }, query)
    const materialized = await this._materializeSearchMessages(peerId, upstream.messages)
    const normalizedQuery = req.q.toLocaleLowerCase()
    const filtered = materialized.filter((item) => {
      if (req.offsetId > 0 && !cursor && item.tlId >= req.offsetId) return false
      if (req.minDate > 0 && item.source.timestamp <= req.minDate) return false
      if (req.maxDate > 0 && item.source.timestamp >= req.maxDate) return false
      if (req.maxId > 0 && item.tlId >= req.maxId) return false
      if (req.minId > 0 && item.tlId <= req.minId) return false
      if (normalizedQuery && !messageText(item.source).toLocaleLowerCase().includes(normalizedQuery)) return false
      return matchesMessageFilter(item, req.filter)
    })
    const start = Math.max(0, req.addOffset)
    const page = filtered.slice(start, start + clampLimit(req.limit))
    if (upstream.nextCursor && page.length) {
      this._searchCursors.set(`${fingerprint}:${page.at(-1)!.tlId}`, upstream.nextCursor)
      while (this._searchCursors.size > 1024) {
        const oldest = this._searchCursors.keys().next().value as string | undefined
        if (!oldest) break
        this._searchCursors.delete(oldest)
      }
    }
    const users = await this._messageSenders(page.map((item) => item.source))
    const sliced = Boolean(upstream.nextCursor || cursor || req.offsetId > 0 || start > 0)
    return {
      _: sliced ? 'messages.messagesSlice' : 'messages.messages',
      ...(sliced ? { count: upstream.total ?? page.length + (upstream.nextCursor ? 1 : 0) } : {}),
      messages: page.map((item) => this._makeMessage(item)), topics: [],
      chats: uniqueChats([
        ...(conversation.kind === 'direct' ? [] : [this._makeChat(conversation)]),
        ...this._linkedChats(page.map((item) => item.source)),
      ]),
      users: uniqueUsers([...users, this._makeSelfUser()]),
    } as unknown as tl.messages.TypeMessages
  }

  private async _materializeSearchMessages(
    peerId: string,
    messages: readonly IMMessage[],
  ): Promise<MaterializedMessage[]> {
    if (this._store) {
      const output: MaterializedMessage[] = []
      for (const source of messages) {
        const projected = await this._store.findProjectedByPlatformId(
          this._session.platformSessionId, peerId, source.id,
        )
        if (!projected) continue
        for (const part of projected.parts) {
          const item: MaterializedMessage = {
            source: projected.source,
            tlId: part.tlMessageId,
            ordinal: part.ordinal,
            groupedId: part.groupedId ?? undefined,
            media: projected.media.find((entry) => entry.id === part.mediaId),
          }
          this._rememberMessage(item)
          output.push(item)
        }
      }
      await this._rememberReplyTargets(output.map((item) => item.source))
      return output
    }
    for (const source of messages.slice().sort((left, right) => left.timestamp - right.timestamp)) {
      this._messageId(peerId, source.id)
    }
    return messages.map((source) => {
      const item: MaterializedMessage = {
        source,
        tlId: telegramMessageId(source) ?? this._messageId(peerId, source.id),
        ordinal: 0,
      }
      this._rememberMessage(item)
      return item
    })
  }

  async readHistory(req: tl.messages.RawReadHistoryRequest): Promise<tl.messages.RawAffectedMessages> {
    await this._hydratePeers()
    const conversationId = this._resolvePeer(req.peer)
    await this._markRead(conversationId, req.maxId)
    const state = await this._store?.getUpdateState(this._session.platformSessionId)
    return { _: 'messages.affectedMessages', pts: state?.pts ?? this._pts, ptsCount: 0 }
  }

  async getScheduledHistory(
    req: tl.messages.RawGetScheduledHistoryRequest,
  ): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    return this._emptyMessages(this._conversation(this._resolvePeer(req.peer)))
  }

  async getMessages(req: GetMessagesRequest): Promise<tl.messages.TypeMessages> {
    await this._hydrateAllMessages()
    return this._getMessages(req.id)
  }

  async getChannelMessages(req: GetChannelMessagesRequest): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    const conversation = this._resolveChannel(req.channel)
    await this._loadHistory(conversation.id, { limit: Math.max(1, req.id.length) })
    return this._getMessages(req.id, conversation.id)
  }

  private async _getMessages(
    ids: readonly tl.TypeInputMessage[],
    expectedPeerId?: string,
  ): Promise<tl.messages.TypeMessages> {
    const users = new Map<number, tl.RawUser>()
    const messages: tl.TypeMessage[] = []
    const linkedSources: IMMessage[] = []

    for (const input of ids) {
      const requestedId = input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
      let ref = this._tlToMessage.get(requestedId)
      const refConversation = ref ? this._conversations.get(ref.peerId) : undefined
      if (ref && (expectedPeerId
        ? ref.peerId !== expectedPeerId
        : refConversation?.kind !== 'direct' && (!refConversation || !this._isVirtualConversation(refConversation)))) {
        ref = undefined
      }
      if (!ref && this._store) {
        const projected = await this._store.findProjectedByTlId(
          this._session.platformSessionId,
          requestedId,
          expectedPeerId,
          expectedPeerId ? undefined : 'direct',
        )
        if (projected) {
          for (const part of projected.parts) {
            this._rememberMessage({
              source: projected.source,
              tlId: part.tlMessageId,
              ordinal: part.ordinal,
              groupedId: part.groupedId ?? undefined,
              media: projected.media.find((entry) => entry.id === part.mediaId),
            })
          }
          ref = this._tlToMessage.get(requestedId)
        }
      }
      if (!ref) {
        messages.push({ _: 'messageEmpty', id: requestedId } as tl.RawMessageEmpty)
        continue
      }
      const projected = this._store
        ? await this._store.findProjectedByTlId(this._session.platformSessionId, requestedId, ref.peerId)
        : undefined
      const history = projected
        ? projected.parts.map((part): MaterializedMessage => ({
            source: projected.source,
            tlId: part.tlMessageId,
            ordinal: part.ordinal,
            groupedId: part.groupedId ?? undefined,
            media: projected.media.find((entry) => entry.id === part.mediaId),
          }))
        : await this._loadHistory(ref.peerId, {
            limit: this._isVirtualConversation(this._conversation(ref.peerId)) ? 200 : 1,
          })
      const found = history.find((item) => item.tlId === requestedId)
      if (!found) {
        messages.push({ _: 'messageEmpty', id: requestedId } as tl.RawMessageEmpty)
        continue
      }
      messages.push(this._makeMessage(found))
      linkedSources.push(found.source)
      const sender = await this._getMessageSender(found.source)
      users.set(sender.id, sender)
    }

    const self = this._makeSelfUser()
    users.set(self.id, self)
    const expectedConversation = expectedPeerId ? this._conversation(expectedPeerId) : undefined
    return {
      _: expectedConversation ? 'messages.channelMessages' : 'messages.messages',
      ...(expectedConversation ? { pts: this._pts, count: messages.length } : {}),
      messages, topics: [],
      chats: uniqueChats([
        ...(expectedConversation ? [this._makeChat(expectedConversation)] : []),
        ...this._linkedChats(linkedSources),
      ]),
      users: [...users.values()],
    } as unknown as tl.messages.TypeMessages
  }

  getPinnedDialogs(): tl.messages.RawPeerDialogs {
    return {
      _: 'messages.peerDialogs', dialogs: [], messages: [], chats: [], users: [],
      state: {
        _: 'updates.state', pts: this._pts, qts: 0,
        date: Math.floor(Date.now() / 1000), seq: 0, unreadCount: 0,
      },
    }
  }

  async getContacts(): Promise<tl.contacts.RawContacts> {
    await this._hydrateUsers()
    const platformUsers: IMUser<any>[] = []
    if (this._platform.getContacts) {
      let cursor: string | undefined
      do {
        const page = await this._platform.getContacts(this._session, { cursor, limit: 500 })
        platformUsers.push(...page.users)
        for (const user of page.users) this._platformUsers.set(user.id, user)
        cursor = page.nextCursor
      } while (cursor && platformUsers.length < 100_000)
    }
    const contactUsers = platformUsers.filter((user) => user.id !== this._session.userId)
    let users: tl.RawUser[]
    if (this._platform.getContacts) {
      const resolvedUsers = contactUsers
        .sort((left, right) => left.firstName.localeCompare(right.firstName))
      await this._persistUsers(resolvedUsers)
      this._contactUserIds.clear()
      for (const user of resolvedUsers) this._contactUserIds.add(user.id)
      // A previous projection may have cached the same user as a non-contact,
      // or a removed friend as a contact. Rebuild it from this snapshot.
      this._peerUsers.clear()
      users = resolvedUsers.map((user) => {
        this._conversations.set(user.id, { id: user.id, kind: 'direct', title: user.firstName })
        return this._makePeerUser(user)
      })
    } else {
      const directDialogs = (await this._loadDialogs({ limit: 500 }))
        .filter((dialog) => dialog.conversation.kind === 'direct')
        .sort((left, right) => left.conversation.title.localeCompare(right.conversation.title))
      this._contactUserIds.clear()
      for (const dialog of directDialogs) this._contactUserIds.add(dialog.conversation.id)
      this._peerUsers.clear()
      users = await Promise.all(directDialogs.map((dialog) =>
        this._getPeerUser(dialog.conversation.id, dialog.conversation.title)))
    }
    return {
      _: 'contacts.contacts',
      contacts: users.map((user) => ({ _: 'contact', userId: user.id, mutual: true })),
      savedCount: users.length,
      users: uniqueUsers(users),
    }
  }

  resolveUsername(req: tl.contacts.RawResolveUsernameRequest): tl.contacts.RawResolvedPeer {
    const match = /^bridgechat_(\d+)$/.exec(req.username)
    const tlId = match ? Number(match[1]) : 0
    const conversation = tlId ? virtualConversation(this._session.platformSessionId, tlId) : undefined
    if (!conversation || !this._isVirtualConversation(conversation)) {
      throw new RpcError(400, 'USERNAME_NOT_OCCUPIED')
    }
    this._conversations.set(conversation.id, conversation)
    this._peerToTl.set(conversation.id, tlId)
    this._tlToPeer.set(tlId, conversation.id)
    return {
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: tlId },
      chats: [this._makeChat(conversation)], users: [],
    }
  }

  async getUsers(req: tl.users.RawGetUsersRequest): Promise<tl.TypeUser[]> {
    await this._hydratePeers()
    return Promise.all(req.id.map((input) => this._getInputUser(input)))
  }

  async getFullUser(req: tl.users.RawGetFullUserRequest): Promise<tl.users.RawUserFull> {
    await this._hydratePeers()
    const user = await this._getInputUser(req.id)
    const peerId = req.id._ === 'inputUserSelf'
      ? this._session.userId
      : req.id._ === 'inputUser' || req.id._ === 'inputUserFromMessage'
        ? this._tlToPeer.get(req.id.userId)
        : undefined
    let profile = peerId ? this._platformUsers.get(peerId) : undefined
    if (!profile && peerId && this._platform.getUser) {
      try {
        profile = await this._getPlatformUser(peerId) ?? undefined
      } catch {
        // Extended profile data is optional. A transient profile lookup must
        // not make an otherwise resolvable users.getFullUser request fail.
      }
    }
    const about = profile?.about
    return {
      _: 'users.userFull',
      fullUser: {
        _: 'userFull',
        id: user.id,
        ...(about !== undefined ? { about } : {}),
        settings: { _: 'peerSettings' },
        notifySettings: { _: 'peerNotifySettings' },
        commonChatsCount: 0,
      },
      chats: [],
      users: [user],
    }
  }

  async getPeerSettings(req: tl.messages.RawGetPeerSettingsRequest): Promise<tl.messages.RawPeerSettings> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const conversation = this._conversation(peerId)
    return {
      _: 'messages.peerSettings', settings: { _: 'peerSettings' },
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      users: conversation.kind === 'direct' ? [await this._getPeerUser(peerId)] : [],
    }
  }

  async getFullChat(req: tl.messages.RawGetFullChatRequest): Promise<tl.messages.RawChatFull> {
    await this._hydratePeers()
    const conversation = this._resolveChat(req.chatId)
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: req.chatId, about: '',
        participants: {
          _: 'chatParticipants', chatId: req.chatId,
          participants: [{ _: 'chatParticipantCreator', userId: this._selfId }],
          version: 1,
        },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
        notifySettings: { _: 'peerNotifySettings' }, botInfo: [],
      },
      chats: [this._makeChat(conversation)], users: [this._makeSelfUser()],
    }
  }

  async getFullChannel(req: tl.channels.RawGetFullChannelRequest): Promise<tl.messages.RawChatFull> {
    await this._hydratePeers()
    const conversation = this._resolveChannel(req.channel)
    const reactionContext = await this._platform.getAvailableReactions?.(
      this._session, { conversationId: conversation.id },
    )
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'channelFull', id: this._peerId(conversation.id), about: '',
        canViewParticipants: true,
        participantsCount: Number(conversation.metadata?.participantsCount ?? 0),
        readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0,
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
        notifySettings: { _: 'peerNotifySettings' }, botInfo: [], pts: this._pts,
        availableReactions: this._reactions?.chatReactions(conversation.id, reactionContext),
      },
      chats: [this._makeChat(conversation)], users: [this._makeSelfUser()],
    }
  }

  async getChannels(req: tl.channels.RawGetChannelsRequest): Promise<tl.messages.RawChats> {
    await this._hydratePeers()
    return {
      _: 'messages.chats',
      chats: uniqueChats(req.id.map((channel) => this._makeChat(this._resolveChannel(channel)))),
    }
  }

  async readChannelHistory(req: tl.channels.RawReadHistoryRequest): Promise<tl.TlObject> {
    await this._hydratePeers()
    const conversation = this._resolveChannel(req.channel)
    await this._markRead(conversation.id, req.maxId)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async readChannelMessageContents(req: tl.channels.RawReadMessageContentsRequest): Promise<tl.TlObject> {
    await this._hydratePeers()
    this._resolveChannel(req.channel)
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async getForumTopics(
    req: tl.messages.RawGetForumTopicsRequest | tl.messages.RawGetForumTopicsByIDRequest,
  ): Promise<tl.messages.RawForumTopics> {
    await this._hydratePeers()
    const parentId = this._resolvePeer(req.peer)
    const parent = this._conversation(parentId)
    if (parent.kind !== 'channel') throw new RpcError(400, 'CHANNEL_FORUM_MISSING')
    let count: number
    let page: Array<{ topic: tl.RawForumTopic, top: MaterializedMessage }>
    if (req._ === 'messages.getForumTopics' && this._platform.getSubdialogs) {
      if (req.offsetTopic && !this._topicToConversation.has(req.offsetTopic)) await this._ensureTopics(parentId)
      const afterId = req.offsetTopic ? this._topicToConversation.get(req.offsetTopic) : undefined
      const loaded = await this._loadSubdialogPage(parentId, { limit: clampLimit(req.limit), afterId })
      const children = loaded.dialogs.map((dialog) => dialog.conversation)
        .filter((child) => !req.q || child.title.toLowerCase().includes(req.q.toLowerCase()))
      page = await Promise.all(children.map((child) => this._materializeTopic(parent, child)))
      count = loaded.total ?? page.length
    } else {
      await this._ensureTopics(parentId)
      const children = this._subchannels(parentId)
      const selected = req._ === 'messages.getForumTopicsByID'
        ? children.filter((child) => req.topics.includes(this._conversationToTopic.get(child.id) ?? -1))
        : children.filter((child) => !req.q || child.title.toLowerCase().includes(req.q.toLowerCase()))
      const materialized = await Promise.all(selected.map((child) => this._materializeTopic(parent, child)))
      const offset = req._ === 'messages.getForumTopics'
        ? Math.max(0, materialized.findIndex((item) => item.topic.id === req.offsetTopic) + 1)
        : 0
      const limit = req._ === 'messages.getForumTopics' ? clampLimit(req.limit) : materialized.length
      page = materialized.slice(offset, offset + limit)
      count = materialized.length
    }
    const users = await this._messageSenders(page.map((item) => item.top.source))
    return {
      _: 'messages.forumTopics', count,
      topics: page.map((item) => item.topic),
      messages: page.map((item) => this._makeMessage(item.top)),
      chats: [this._makeChat(parent)], users: uniqueUsers([...users, this._makeSelfUser()]), pts: this._pts,
    }
  }

  async getLegacyForumTopics(
    req: LegacyGetForumTopicsRequest | LegacyGetForumTopicsByIdRequest,
  ): Promise<tl.messages.RawForumTopics> {
    if (req.channel._ !== 'inputChannel') throw new RpcError(400, 'CHANNEL_INVALID')
    const peer: tl.RawInputPeerChannel = {
      _: 'inputPeerChannel', channelId: req.channel.channelId, accessHash: req.channel.accessHash,
    }
    return this.getForumTopics(req._ === 'channels.getForumTopics'
      ? {
          _: 'messages.getForumTopics', peer, q: req.q,
          offsetDate: req.offsetDate, offsetId: req.offsetId,
          offsetTopic: req.offsetTopic, limit: req.limit,
        }
      : { _: 'messages.getForumTopicsByID', peer, topics: req.topics })
  }

  async getReplies(req: tl.messages.RawGetRepliesRequest): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    const parentId = this._resolvePeer(req.peer)
    await this._ensureTopics(parentId)
    const childId = this._topicToConversation.get(req.msgId)
    const child = childId ? this._conversation(childId) : undefined
    if (!child || child.parentId !== parentId) throw new RpcError(400, 'MSG_ID_INVALID')
    const all = await this._loadHistory(child.id, {
      offsetId: req.offsetId, offsetDate: req.offsetDate, addOffset: req.addOffset,
      limit: req.limit, maxId: req.maxId, minId: req.minId,
    })
    const filtered = all.filter((item) => {
      if (req.offsetId > 0 && item.tlId >= req.offsetId) return false
      if (req.offsetDate > 0 && item.source.timestamp >= req.offsetDate) return false
      if (req.maxId > 0 && item.tlId >= req.maxId) return false
      if (req.minId > 0 && item.tlId <= req.minId) return false
      return true
    })
    const page = filtered.slice(Math.max(0, req.addOffset), Math.max(0, req.addOffset) + clampLimit(req.limit))
    const topic = (await this._materializeTopic(this._conversation(parentId), child)).topic
    const users = await this._messageSenders(page.map((item) => item.source))
    return {
      _: 'messages.channelMessages', pts: this._pts, count: filtered.length,
      messages: page.map((item) => this._makeMessage(item)), topics: [topic],
      chats: [this._makeChat(this._conversation(parentId))],
      users: uniqueUsers([...users, this._makeSelfUser()]),
    }
  }

  async getChannelParticipant(
    req: tl.channels.RawGetParticipantRequest,
  ): Promise<tl.channels.RawChannelParticipant> {
    await this._hydratePeers()
    const conversation = this._resolveChannel(req.channel)
    const userId = req.participant._ === 'inputPeerSelf'
      ? this._session.userId
      : req.participant._ === 'inputPeerUser'
        ? this._tlToPeer.get(req.participant.userId)
        : undefined
    const member = userId && this._platform.getConversationMember
      ? await this._platform.getConversationMember(this._session, { id: conversation.id }, userId)
      : (await this._allMembers(conversation.id)).find((item) => item.user.id === userId)
    if (!member) throw new RpcError(400, 'USER_NOT_PARTICIPANT')
    return {
      _: 'channels.channelParticipant',
      participant: this._makeChannelParticipant(member),
      chats: [this._makeChat(conversation)], users: [this._makeMemberUser(member)],
    }
  }

  async getChannelParticipants(
    req: tl.channels.RawGetParticipantsRequest,
  ): Promise<tl.channels.RawChannelParticipants> {
    await this._hydratePeers()
    const conversation = this._resolveChannel(req.channel)
    const offset = Math.max(0, req.offset)
    const limit = Math.max(0, req.limit)
    if (req.filter._ === 'channelParticipantsRecent') {
      const page = await this._memberPage(conversation.id, offset, limit)
      const count = page.total
        ?? (Number(conversation.metadata?.participantsCount ?? 0)
          || offset + page.members.length + (page.nextCursor ? 1 : 0))
      return {
        _: 'channels.channelParticipants', count,
        participants: page.members.map((member) => this._makeChannelParticipant(member)),
        chats: [this._makeChat(conversation)],
        users: page.members.map((member) => this._makeMemberUser(member)),
      }
    }
    // The platform member API is cursor-paged and has no filtered-list
    // primitive. Do not turn Telegram's eager admin/search probes into a full
    // upstream scan: filter only the requested member window. The returned
    // count deliberately describes this bounded result so clients do not
    // automatically chase every remaining unfiltered page.
    const page = await this._memberPage(conversation.id, offset, limit)
    let members = page.members
    if (req.filter._ === 'channelParticipantsAdmins') {
      members = members.filter((member) => member.role === 'owner' || member.role === 'administrator')
    } else if (req.filter._ === 'channelParticipantsSearch') {
      const query = req.filter.q.toLocaleLowerCase()
      members = members.filter((member) =>
        `${member.user.firstName} ${member.user.lastName ?? ''} ${member.user.username ?? ''}`
          .toLocaleLowerCase().includes(query))
    } else {
      members = []
    }
    const total = offset + members.length
    return {
      _: 'channels.channelParticipants', count: total,
      participants: members.map((member) => this._makeChannelParticipant(member)),
      chats: [this._makeChat(conversation)], users: members.map((member) => this._makeMemberUser(member)),
    }
  }

  async getSendAs(req: tl.channels.RawGetSendAsRequest): Promise<tl.channels.RawSendAsPeers> {
    await this._hydratePeers()
    this._resolvePeer(req.peer)
    return {
      _: 'channels.sendAsPeers', peers: [{ _: 'sendAsPeer', peer: { _: 'peerUser', userId: this._selfId } }],
      chats: [], users: [this._makeSelfUser()],
    }
  }

  async sendMessage(req: SendMessageRequest): Promise<tl.RawUpdateShortSentMessage> {
    const randomId = req.randomId.toString()
    const existing = this._sentByRandomId.get(randomId)
    if (existing) return existing

    const pending = this._sendMessage(req).then(async (result) => {
      if (req.clearDraft) await this._clearDraftAfterSend(req.peer, req.replyTo)
      return result
    })
    this._sentByRandomId.set(randomId, pending)
    try {
      return await pending
    } catch (error) {
      this._sentByRandomId.delete(randomId)
      throw error
    }
  }

  async sendMedia(req: SendMediaRequest): Promise<tl.TypeUpdates> {
    return this._sendMediaOnce(req.randomId.toString(), async () => {
      const resolved = await this._resolveSendMedia(req.media)
      const parts: IMMessageInput['parts'] = []
      if (req.message) parts.push(this._inputTextPart(req.message, req.entities))
      if ('sticker' in resolved) {
        parts.push({ type: 'sticker', sticker: resolved.sticker })
        const updates = await this._sendRichContent(req.peer, { parts }, [], [req.randomId], req.replyTo)
        await this._stickers?.markUsedByRef(resolved.providerId, resolved.stickerId)
        if (req.clearDraft) await this._clearDraftAfterSend(req.peer, req.replyTo)
        return updates
      }
      parts.push({ type: 'media', media: resolved.media })
      const updates = await this._sendRichContent(
        req.peer, { parts }, [resolved.upload], [req.randomId], req.replyTo,
      )
      if (req.clearDraft) await this._clearDraftAfterSend(req.peer, req.replyTo)
      return updates
    })
  }

  async sendMultiMedia(req: SendMultiMediaRequest): Promise<tl.TypeUpdates> {
    const randomId = req.multiMedia.map((item) => item.randomId.toString()).join(':')
    return this._sendMediaOnce(randomId, async () => {
      if (!req.multiMedia.length) throw new RpcError(400, 'MEDIA_EMPTY')
      const resolved = await Promise.all(req.multiMedia.map((item) => this._resolveSendMedia(item.media)))
      if (resolved.some((item) => 'sticker' in item)) throw new RpcError(400, 'MEDIA_INVALID')
      const mediaResolved = resolved as ResolvedMediaUpload[]
      const parts: IMMessageInput['parts'] = []
      const captions = req.multiMedia.map((item) => item.message).filter(Boolean)
      if (captions.length) parts.push(this._multiMediaCaption(req.multiMedia))
      for (const item of mediaResolved) parts.push({ type: 'media', media: item.media })
      const updates = await this._sendRichContent(
        req.peer,
        { parts },
        mediaResolved.map((item) => item.upload),
        req.multiMedia.map((item) => item.randomId),
        req.replyTo,
      )
      if (req.clearDraft) await this._clearDraftAfterSend(req.peer, req.replyTo)
      return updates
    })
  }

  async deleteMessages(
    req: tl.messages.RawDeleteMessagesRequest | tl.channels.RawDeleteMessagesRequest,
    channel?: tl.TypeInputChannel,
  ): Promise<tl.messages.RawAffectedMessages> {
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    // Message ownership and action policy must be evaluated against a fresh
    // upstream preview rather than the short-lived read-side peer cache.
    await this._hydratePeers(true)
    const expectedConversation = channel ? this._resolveChannel(channel).id : undefined
    const grouped = new Map<string, Array<{
      source: IMMessage<any>
      targetId: string
    }>>()
    for (const tlId of req.id) {
      const projected = await this._store.findProjectedByTlId(
        this._session.platformSessionId, tlId, expectedConversation,
        expectedConversation ? undefined : 'direct',
      )
      if (!projected) throw new RpcError(400, 'MSG_ID_INVALID')
      const ordinal = projected.parts.find((part) => part.tlMessageId === tlId)?.ordinal ?? 0
      const targets = grouped.get(projected.source.conversationId) ?? []
      targets.push({
        source: projected.source,
        targetId: projected.source.sourceIds?.[ordinal] ?? projected.source.id,
      })
      grouped.set(projected.source.conversationId, targets)
    }

    const affected = new Set<number>()
    for (const [conversationId, targets] of grouped) {
      const conversation = this._conversation(conversationId)
      const policy = this._platform.capabilities.messageActions?.delete
      const now = Math.floor(Date.now() / 1000)
      const allowed = targets.every(({ source }) => messageRuleAllows(
        source.outgoing || source.senderId === this._session.userId ? policy?.own : policy?.others,
        source.timestamp,
        now,
      ))
      if (!allowed) throw new RpcError(400, 'MESSAGE_DELETE_FORBIDDEN')
      try {
        await this._actions.delete(
          conversation,
          [...new Set(targets.map((target) => target.targetId))],
          req._ === 'channels.deleteMessages' || !!req.revoke,
        )
      } catch (error) {
        this._throwMessageAction(error, 'MESSAGE_DELETE_FORBIDDEN')
      }
      const result = await this._store.deleteMessages(
        this._session, conversation, [...new Set(targets.map((target) => target.source.id))],
      )
      result.tlMessageIds.forEach((id) => affected.add(id))
      const cache = this._historyCache.get(conversationId)
      if (cache) this._historyCache.set(conversationId, cache.filter((item) => !affected.has(item.tlId)))
    }
    const ptsCount = affected.size
    const pts = await this._reservePts(
      ptsCount,
      Math.floor(Date.now() / 1000),
      expectedConversation ? this._conversation(expectedConversation) : undefined,
    )
    return { _: 'messages.affectedMessages', pts, ptsCount }
  }

  async editMessage(req: tl.messages.RawEditMessageRequest): Promise<tl.TypeUpdates> {
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    if (req.scheduleDate !== undefined) throw new RpcError(400, 'SCHEDULED_MESSAGES_UNAVAILABLE')
    if (req.media || req.richMessage || req.message === undefined) throw new RpcError(400, 'MESSAGE_EDIT_UNSUPPORTED')
    if (!req.message.length) throw new RpcError(400, 'MESSAGE_EMPTY')
    if (Array.from(req.message).length > this._platform.capabilities.send.maxTextLength) {
      throw new RpcError(400, 'MESSAGE_TOO_LONG')
    }
    await this._hydratePeers()
    const conversationId = this._resolvePeer(req.peer)
    const projected = await this._store.findProjectedByTlId(
      this._session.platformSessionId, req.id, conversationId,
    )
    if (!projected) throw new RpcError(400, 'MSG_ID_INVALID')
    const editPolicy = this._platform.capabilities.messageActions?.edit
    if (
      editPolicy?.maxAgeSeconds !== undefined
      && Math.floor(Date.now() / 1000) - projected.source.timestamp > editPolicy.maxAgeSeconds
    ) {
      throw new RpcError(400, 'MESSAGE_EDIT_TIME_EXPIRED')
    }
    const ordinal = projected.parts.find((part) => part.tlMessageId === req.id)?.ordinal ?? 0
    let edited: Awaited<ReturnType<PlatformMessageActions['edit']>>
    try {
      edited = await this._actions.edit({
        conversationId, messageId: projected.source.id,
        targetId: projected.source.sourceIds?.[ordinal] ?? projected.source.id,
      }, { parts: [{ type: 'text', text: req.message }] })
    } catch (error) {
      this._throwMessageAction(error, 'MESSAGE_EDIT_FORBIDDEN')
    }
    const conversation = this._conversation(conversationId)
    const source: IMMessage<any> = { ...edited!.message, conversationId, outgoing: true }
    const now = source.timestamp || Math.floor(Date.now() / 1000)
    if (edited!.replacedMessageId && this._onLocalEvent) {
      const replacementKey = `${edited!.replacedMessageId}:${source.id}`
      const delivery = { excludeAuthKeyId: this._authKeyId, deliveredViaRpc: true }
      const deleted = await this._onLocalEvent(this._session, {
        type: 'message-delete',
        eventId: `local-edit-replace:${replacementKey}`,
        conversation,
        messageIds: [edited!.replacedMessageId],
        timestamp: now,
      }, delivery)
      const replacement = await this._onLocalEvent(
        this._session,
        { type: 'message', conversation, message: source },
        delivery,
      )
      this._historyCache.delete(conversationId)
      // The requester receives the same durable PTS-bearing updates as the
      // observer sockets, but in the edit RPC response instead of as a push.
      const payloads = [deleted, replacement]
        .map((published) => published as tl.RawUpdates | undefined)
        .filter((payload): payload is tl.RawUpdates => payload?._ === 'updates')
      if (payloads.length === 1) return payloads[0]
      if (payloads.length > 1) {
        const first = payloads[0]
        const last = payloads.at(-1)!
        return {
          _: 'updatesCombined',
          updates: payloads.flatMap((payload) => payload.updates),
          users: uniqueUsers(payloads.flatMap((payload) => payload.users) as tl.RawUser[]),
          chats: uniqueChats(payloads.flatMap((payload) => payload.chats)),
          date: last.date,
          seqStart: first.seq,
          seq: last.seq,
        }
      }
      return this._updates(conversation, [], now)
    }
    const updates: tl.TypeUpdate[] = []
    let ptsCount = 0
    if (edited!.replacedMessageId) {
      const deleted = await this._store.deleteMessages(
        this._session, conversation, [edited!.replacedMessageId],
      )
      ptsCount += deleted.tlMessageIds.length
      updates.push({
        _: this._isTelegramChannel(conversation) ? 'updateDeleteChannelMessages' : 'updateDeleteMessages',
        ...(this._isTelegramChannel(conversation) ? { channelId: this._peerId(conversationId) } : {}),
        messages: deleted.tlMessageIds, pts: 0, ptsCount: deleted.tlMessageIds.length,
      } as tl.TypeUpdate)
    }
    const persisted = await this._store.ingest(this._session, conversation, source)
    ptsCount += edited!.replacedMessageId ? persisted.projection.length : 1
    let pts = await this._reservePts(ptsCount, now, conversation) - ptsCount
    for (const update of updates) {
      if (update._ === 'updateDeleteMessages' || update._ === 'updateDeleteChannelMessages') {
        update.pts = pts += update.ptsCount
      }
    }
    if (edited!.replacedMessageId) {
      for (const part of persisted.projection) {
        const item = await this._projectedItem(part.tlMessageId, conversationId)
        updates.push({
          _: this._isTelegramChannel(conversation) ? 'updateNewChannelMessage' : 'updateNewMessage',
          message: this._makeMessage(item), pts: ++pts, ptsCount: 1,
        } as tl.TypeUpdate)
      }
    } else {
      const item = await this._projectedItem(req.id, conversationId)
      updates.push({
        _: this._isTelegramChannel(conversation) ? 'updateEditChannelMessage' : 'updateEditMessage',
        message: this._makeMessage(item), pts: ++pts, ptsCount: 1,
      } as tl.TypeUpdate)
    }
    return this._updates(conversation, updates, now)
  }

  async forwardMessages(req: tl.messages.RawForwardMessagesRequest): Promise<tl.TypeUpdates> {
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    if (req.scheduleDate !== undefined) throw new RpcError(400, 'SCHEDULED_MESSAGES_UNAVAILABLE')
    if (req.id.length !== req.randomId.length) throw new RpcError(400, 'RANDOM_ID_INVALID')
    await this._hydratePeers()
    const fromId = this._resolvePeer(req.fromPeer)
    const toId = this._resolveMessageTarget(req.toPeer, req.replyTo)
    const sourceIds: string[] = []
    for (const tlId of req.id) {
      const projected = await this._store.findProjectedByTlId(this._session.platformSessionId, tlId, fromId)
      if (!projected) throw new RpcError(400, 'MSG_ID_INVALID')
      const ordinal = projected.parts.find((part) => part.tlMessageId === tlId)?.ordinal ?? 0
      sourceIds.push(projected.source.sourceIds?.[ordinal] ?? projected.source.id)
    }
    let forwarded: IMMessage<any>[]
    try {
      forwarded = await this._actions.forward(
        { id: fromId }, sourceIds, { id: toId }, { dropAuthor: req.dropAuthor },
      )
    } catch (error) {
      this._throwMessageAction(error, 'MESSAGE_FORWARD_FORBIDDEN')
    }
    const conversation = this._conversation(toId)
    const projections = []
    for (const output of forwarded!) {
      const source: IMMessage<any> = { ...output, conversationId: toId, outgoing: true }
      const persisted = await this._store.ingest(this._session, conversation, source)
      projections.push(...persisted.projection)
    }
    let pts = await this._reservePts(
      projections.length,
      Math.floor(Date.now() / 1000),
      conversation,
    ) - projections.length
    const updates: tl.TypeUpdate[] = []
    for (const [index, part] of projections.entries()) {
      const item = await this._projectedItem(part.tlMessageId, toId)
      if (req.randomId[index]) {
        updates.push({ _: 'updateMessageID', id: part.tlMessageId, randomId: req.randomId[index] })
      }
      updates.push({
        _: this._isTelegramChannel(conversation) ? 'updateNewChannelMessage' : 'updateNewMessage',
        message: this._makeMessage(item), pts: ++pts, ptsCount: 1,
      } as tl.TypeUpdate)
    }
    return this._updates(conversation, updates, Math.floor(Date.now() / 1000))
  }

  async uploadMedia(req: UploadMediaRequest): Promise<tl.TypeMessageMedia> {
    if (!this._uploads) throw new RpcError(400, 'MEDIA_UPLOAD_UNAVAILABLE')
    await this._hydratePeers()
    this._resolvePeer(req.peer)
    const resolved = await this._resolveUploadedMedia(req.media)
    const staged: StagedMedia = { ...resolved, timestamp: Math.floor(Date.now() / 1000) }
    this._uploads.stage(staged)
    return makeStagedMessageMedia(staged, this._dcId)
  }

  async getFile(req: tl.upload.RawGetFileRequest): Promise<tl.upload.TypeFile> {
    const offset = safeOffset(req.offset)
    if (offset < 0 || req.limit <= 0) throw new RpcError(400, 'OFFSET_INVALID')
    if (req.location._ === 'inputStickerSetThumb') {
      const bytes = await this._stickers?.getSetThumb(req.location.stickerset, offset, req.limit)
      if (!bytes) throw new RpcError(400, 'LOCATION_INVALID')
      return {
        _: 'upload.file', type: { _: 'storage.fileWebp' },
        mtime: Math.floor(Date.now() / 1000), bytes,
      }
    }
    if (req.location._ === 'inputPeerPhotoFileLocation') {
      const media = this._avatarMedia.get(req.location.photoId.toString())
        ?? await this._resolveAvatarMedia(req.location.peer, req.location.photoId)
      if (!media || !this._platform.downloadMedia) throw new RpcError(400, 'LOCATION_INVALID')
      return {
        _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: Math.floor(Date.now() / 1000),
        bytes: await this._downloadMediaRange(media, offset, req.limit),
      }
    }
    if (req.location._ !== 'inputDocumentFileLocation' && req.location._ !== 'inputPhotoFileLocation') {
      throw new RpcError(400, 'LOCATION_INVALID')
    }
    if (req.location._ === 'inputPhotoFileLocation') {
      const thumbnail = await getCardThumbnailFile(req.location, offset, req.limit)
      if (thumbnail) return {
        _: 'upload.file', type: storageFileType(thumbnail.mimeType),
        mtime: Math.floor(Date.now() / 1000), bytes: thumbnail.bytes,
      }
    }
    if (req.location._ === 'inputDocumentFileLocation') {
      // 官方资源优先：按真实 doc id 从本地 TGS 仓库回源
      const official = await this._resources?.getFile(req.location.id)
      if (official) {
        const isTgs = official.mimeType === 'application/x-tgsticker'
        return {
          _: 'upload.file',
          type: { _: isTgs ? 'storage.fileUnknown' : 'storage.fileWebp' },
          mtime: Math.floor(Date.now() / 1000),
          bytes: official.bytes.subarray(offset, offset + req.limit),
        }
      }
      const reaction = await this._reactions?.getFile(req.location.id.toNumber(), offset, req.limit)
      if (reaction) {
        return {
          _: 'upload.file',
          type: { _: reaction.mimeType === 'image/webp' ? 'storage.fileWebp' : 'storage.fileUnknown' },
          mtime: Math.floor(Date.now() / 1000), bytes: reaction.bytes,
        }
      }
      const sticker = await this._stickers?.getFile(
        req.location.id.toNumber(), offset, req.limit, req.location.fileReference, req.location.thumbSize,
      )
      if (sticker) {
        return {
          _: 'upload.file', type: { _: req.location.thumbSize ? 'storage.fileWebp' : 'storage.fileUnknown' },
          mtime: Math.floor(Date.now() / 1000), bytes: sticker,
        }
      }
    }
    if (!this._uploads || !this._store || !this._platform.downloadMedia) {
      throw new RpcError(400, 'FILE_DOWNLOAD_UNAVAILABLE')
    }
    const staged = this._uploads.getStaged(this._session.platformSessionId, req.location.id.toString())
    if (staged) {
      return {
        _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: staged.timestamp,
        bytes: await readSourceRange(staged.media.source, offset, req.limit),
      }
    }
    const stored = await this._store.getMedia(this._session.platformSessionId, req.location.id.toNumber())
    if (!stored) throw new RpcError(400, 'FILE_ID_INVALID')
    const media = req.location.thumbSize === 'm' && stored.media.preview
      ? previewMedia(stored.media)
      : stored.media
    return {
      _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: stored.timestamp,
      bytes: await this._downloadMediaRange(media, offset, req.limit),
    }
  }

  private async _resolveAvatarMedia(peer: tl.TypeInputPeer, photoId: Long): Promise<IMMedia<any> | undefined> {
    await this._hydratePeers()
    let media: IMMedia<any> | undefined
    if (peer._ === 'inputPeerSelf') {
      media = (await this._platform.getUser?.(this._session, this._session.userId))?.avatar
    } else if (peer._ === 'inputPeerUser') {
      let userId = this._tlToPeer.get(peer.userId)
      if (!userId && this._store) {
        const row = await this._store.getUserByTlId(this._session.platformId, peer.userId)
        if (row) {
          this._registerUser(row)
          userId = row.platformUserId
        }
      }
      if (userId) {
        const upstream = await this._platform.getUser?.(this._session, userId)
        const stored = upstream ? undefined : await this._store?.getUser(this._session.platformId, userId)
        media = upstream?.avatar ?? (stored ? toUser(stored).avatar : undefined)
      }
    } else if (peer._ === 'inputPeerChat' || peer._ === 'inputPeerChannel') {
      const conversationId = this._tlToPeer.get(inputPeerId(peer))
      if (conversationId) media = this._conversation(conversationId).avatar
    }
    if (!media || stableId(`avatar:${media.id}`) !== photoId.toNumber()) return
    this._avatarMedia.set(photoId.toString(), media)
    return media
  }

  private async _downloadMediaRange(media: IMMedia<any>, offset: number, limit: number): Promise<Uint8Array> {
    if (!this._platform.downloadMedia) throw new RpcError(400, 'FILE_DOWNLOAD_UNAVAILABLE')
    const chunks: Uint8Array[] = []
    let size = 0
    const stream = this._platform.downloadMedia(this._session, media, {
      offset, limit,
      onProgress: (progress) => this._onTransferProgress?.(this._session, progress),
    })
    for await (const chunk of stream) {
      const remaining = limit - size
      if (remaining <= 0) break
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(accepted)
      size += accepted.length
    }
    const bytes = new Uint8Array(size)
    let position = 0
    for (const chunk of chunks) {
      bytes.set(chunk, position)
      position += chunk.length
    }
    return bytes
  }

  async getAvailableReactions(): Promise<tl.messages.RawAvailableReactions> {
    return this._resources?.availableReactions()
      ?? { _: 'messages.availableReactions', hash: 0, reactions: [] }
  }

  async getAvailableEffects(): Promise<tl.messages.RawAvailableEffects> {
    return this._resources?.availableEffects()
      ?? { _: 'messages.availableEffects', hash: 0, effects: [], documents: [] }
  }

  async getTopReactions(limit: number): Promise<tl.messages.RawReactions> {
    return await this._reactions?.topReactions(limit)
      ?? { _: 'messages.reactions', hash: Long.ZERO, reactions: [] }
  }

  async getRecentReactions(limit: number): Promise<tl.messages.RawReactions> {
    return await this._reactions?.recentReactions(limit)
      ?? { _: 'messages.reactions', hash: Long.ZERO, reactions: [] }
  }

  async clearRecentReactions(): Promise<tl.TlObject> {
    await this._reactions?.clearRecentReactions()
    return { _: 'boolTrue' } as unknown as tl.TlObject
  }

  async getEmojiStickers(): Promise<tl.messages.RawAllStickers> {
    return this._reactions?.getEmojiStickers()
      ?? { _: 'messages.allStickers', hash: Long.ZERO, sets: [] }
  }

  async getReactionStickerSet(
    req: tl.messages.RawGetStickerSetRequest,
  ): Promise<tl.messages.TypeStickerSet | undefined> {
    const ss = req.stickerset
    if (ss._ === 'inputStickerSetAnimatedEmoji') return this._resources?.stickerSet('emoji')
    if (ss._ === 'inputStickerSetAnimatedEmojiAnimations') {
      return this._resources?.stickerSet('emoji_animations')
    }
    if (ss._ === 'inputStickerSetEmojiGenericAnimations') {
      return this._resources?.stickerSet('emoji_generic')
    }
    return this._reactions?.getStickerSet(req)
  }

  getCustomEmojiDocuments(req: tl.messages.RawGetCustomEmojiDocumentsRequest) {
    return this._reactions?.getCustomEmojiDocuments(req.documentId) ?? []
  }

  async sendReaction(req: tl.messages.RawSendReactionRequest): Promise<tl.TypeUpdates> {
    if (!this._platform.capabilities.reactions?.write || !this._platform.setMessageReactions) {
      throw new RpcError(400, 'REACTION_INVALID')
    }
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const projected = await this._store?.findProjectedByTlId(
      this._session.platformSessionId, req.msgId, peerId,
    )
    if (!projected) throw new RpcError(400, 'MSG_ID_INVALID')
    const target = {
      conversationId: peerId,
      messageId: projected.source.id,
      targetId: projected.source.sourceIds?.[0] ?? projected.source.id,
    }
    const context = await this._platform.getAvailableReactions?.(this._session, target)
      ?? projected.source.reactionContext
      ?? { available: [], reactions: [], maxSelected: 0 }
    const selected = (req.reaction ?? []).map((reaction) =>
      this._reactions!.resolveInput(peerId, reaction, context))
    if (selected.length > context.maxSelected) throw new RpcError(400, 'REACTIONS_TOO_MANY')
    const previouslySelected = new Set(context.reactions
      .filter((reaction) => reaction.selected)
      .map((reaction) => reaction.key))
    const newlySelected = selected.filter((definition) => !previouslySelected.has(definition.key))
    const updated = await this._platform.setMessageReactions(
      this._session, target, selected.map((item) => item.key),
    )
    const conversation = this._conversation(peerId)
    const result = await this._store!.setReactions(this._session, conversation, target, updated)
    await this._reactions!.markUsed(peerId, newlySelected)
    const update: tl.RawUpdateMessageReactions = {
      _: 'updateMessageReactions',
      peer: this._conversationPeer(conversation),
      msgId: req.msgId,
      reactions: this._reactions!.messageReactions(peerId, result.message, (id) => this._userId(id)),
    }
    const recentUpdate: tl.TypeUpdate[] = newlySelected.length
      ? [{ _: 'updateRecentReactions' }]
      : []
    return {
      _: 'updates', updates: [update, ...recentUpdate],
      users: [this._makeSelfUser()],
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      date: Math.floor(Date.now() / 1000), seq: 0,
    }
  }

  async getMessagesReactions(req: tl.messages.RawGetMessagesReactionsRequest): Promise<tl.TypeUpdates> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const conversation = this._conversation(peerId)
    const updates: tl.TypeUpdate[] = []
    for (const id of req.id) {
      const projected = await this._store?.findProjectedByTlId(this._session.platformSessionId, id, peerId)
      if (!projected) continue
      updates.push({
        _: 'updateMessageReactions', peer: this._conversationPeer(conversation),
        msgId: id,
        reactions: this._reactions!.messageReactions(peerId, projected.source, (userId) => this._userId(userId)),
      } as tl.RawUpdateMessageReactions)
    }
    return {
      _: 'updates', updates, users: [this._makeSelfUser()],
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      date: Math.floor(Date.now() / 1000), seq: 0,
    }
  }

  async getMessageReactionsList(
    req: tl.messages.RawGetMessageReactionsListRequest,
  ): Promise<tl.messages.RawMessageReactionsList> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const projected = await this._store?.findProjectedByTlId(this._session.platformSessionId, req.id, peerId)
    if (!projected) throw new RpcError(400, 'MSG_ID_INVALID')
    const target = {
      conversationId: peerId,
      messageId: projected.source.id,
      targetId: projected.source.sourceIds?.[0] ?? projected.source.id,
    }
    const refreshed = await this._platform.getMessageReactions?.(this._session, target)
    const context = refreshed
      ? (await this._store!.setReactions(
          this._session, this._conversation(peerId), target, refreshed,
        )).message.reactionContext
      : projected.source.reactionContext
    const filter = req.reaction && context
      ? this._reactions!.resolveInput(peerId, req.reaction, context).key
      : undefined
    const definitions = new Map((context?.available ?? []).map((item) => [item.key, item]))
    const actors = (context?.reactions ?? []).flatMap((summary) =>
      summary.key === filter || filter === undefined
        ? (summary.recentActors ?? []).map((actor) => ({ summary, actor }))
        : [])
      .slice(0, Math.max(0, req.limit))
    const users = await Promise.all([...new Set(actors.map(({ actor }) => actor.userId))]
      .map((id) => this._getPeerUser(id)))
    return {
      _: 'messages.messageReactionsList',
      count: (context?.reactions ?? []).reduce((count, summary) =>
        summary.key === filter || filter === undefined ? count + summary.count : count, 0),
      reactions: actors.map(({ summary, actor }) => ({
        _: 'messagePeerReaction',
        peerId: { _: 'peerUser', userId: this._userId(actor.userId) },
        date: actor.timestamp ?? projected.source.timestamp,
        reaction: this._reactions!.toTlReaction(peerId, definitions.get(summary.key)!),
        my: actor.userId === this._session.userId || undefined,
      })),
      chats: [],
      users: uniqueUsers([...users, this._makeSelfUser()]),
    }
  }

  peerTlId(peerId: string): number {
    return this._peerId(peerId)
  }

  async userTlId(platformUserId: string): Promise<number> {
    await this._hydrateUsers()
    const stored = await this._store?.getUser(this._session.platformId, platformUserId)
    if (stored) {
      this._registerUser(stored)
      return stored.id
    }
    if (!this._store && this._peerToTl.has(platformUserId)) return this._userId(platformUserId)
    await this._getPeerUser(platformUserId)
    return this._userId(platformUserId)
  }

  private async _sendMessage(req: SendMessageRequest): Promise<tl.RawUpdateShortSentMessage> {
    if (!this._platform.capabilities.send.text) throw new RpcError(400, 'MESSAGE_SEND_UNAVAILABLE')
    if (!req.message.length) throw new RpcError(400, 'MESSAGE_EMPTY')
    if (Array.from(req.message).length > this._platform.capabilities.send.maxTextLength) {
      throw new RpcError(400, 'MESSAGE_TOO_LONG')
    }
    if (req.scheduleDate !== undefined) throw new RpcError(400, 'SCHEDULED_MESSAGES_UNAVAILABLE')

    await this._hydratePeers()
    const peerId = this._resolveMessageTarget(req.peer, req.replyTo)
    const replyToId = await this._resolveReplyToId(peerId, req.replyTo)
    const sent = await this._platform.sendMessage(
      this._session,
      { id: peerId },
      { parts: [this._inputTextPart(req.message, req.entities)], replyToId },
    )
    const source: IMMessage = { ...sent, conversationId: peerId, outgoing: true }
    let persisted: Awaited<ReturnType<MessageStore['ingest']>> | undefined
    if (this._store) {
      const conversation = await this._store.getConversation(this._session.platformSessionId, peerId)
        ?? { id: peerId, kind: 'direct' as const, title: peerId }
      persisted = await this._store.ingest(this._session, conversation, source)
    }
    const id = persisted?.projection[0]?.tlMessageId ?? this._messageId(peerId, source.id)
    this._rememberMessage({ source, tlId: id, ordinal: 0 })
    const pts = await this._reservePts(1, source.timestamp)
    return {
      _: 'updateShortSentMessage', out: true, id, pts, ptsCount: 1, date: source.timestamp,
    }
  }

  private async _sendMediaOnce(randomId: string, send: () => Promise<tl.TypeUpdates>): Promise<tl.TypeUpdates> {
    const existing = this._sentMediaByRandomId.get(randomId)
    if (existing) return existing
    const pending = send()
    this._sentMediaByRandomId.set(randomId, pending)
    try {
      return await pending
    } catch (error) {
      this._sentMediaByRandomId.delete(randomId)
      throw error
    }
  }

  private async _resolveUploadedMedia(media: tl.TypeInputMedia): Promise<ResolvedMediaUpload> {
    if (!this._uploads) throw new RpcError(400, 'MEDIA_UPLOAD_UNAVAILABLE')
    if (media._ !== 'inputMediaUploadedPhoto' && media._ !== 'inputMediaUploadedDocument') {
      throw new RpcError(400, 'MEDIA_INVALID')
    }
    const file = media.file
    if (file._ !== 'inputFile' && file._ !== 'inputFileBig') throw new RpcError(400, 'FILE_ID_INVALID')
    const upload = await this._uploads.open(
      this._session.platformSessionId,
      file.id.toString(),
      file.parts,
    ).catch((error) => {
      throw new RpcError(400, `FILE_PARTS_INVALID: ${String(error)}`)
    })
    const kind = media._ === 'inputMediaUploadedPhoto' ? 'image' : 'file'
    const attribute = media._ === 'inputMediaUploadedDocument'
      ? media.attributes.find((item) => item._ === 'documentAttributeFilename')
      : undefined
    const videoAttribute = media._ === 'inputMediaUploadedDocument'
      ? media.attributes.find((item) => item._ === 'documentAttributeVideo')
      : undefined
    const detected = kind === 'image' ? await probeImageDimensions(upload.source) : undefined
    return {
      media: {
        kind,
        name: attribute?._ === 'documentAttributeFilename' ? attribute.fileName : file.name,
        mimeType: media._ === 'inputMediaUploadedDocument' ? media.mimeType : inferImageMime(file.name),
        size: upload.source.size,
        width: detected?.width ?? (videoAttribute?._ === 'documentAttributeVideo' ? videoAttribute.w : undefined),
        height: detected?.height ?? (videoAttribute?._ === 'documentAttributeVideo' ? videoAttribute.h : undefined),
        duration: videoAttribute?._ === 'documentAttributeVideo' ? videoAttribute.duration : undefined,
        source: upload.source,
      },
      upload,
    }
  }

  private async _resolveSendMedia(media: tl.TypeInputMedia): Promise<ResolvedMediaUpload | ResolvedStickerInput> {
    if (media._ === 'inputMediaUploadedPhoto' || media._ === 'inputMediaUploadedDocument') {
      return this._resolveUploadedMedia(media)
    }
    if (!this._uploads) throw new RpcError(400, 'MEDIA_UPLOAD_UNAVAILABLE')
    if (media._ !== 'inputMediaPhoto' && media._ !== 'inputMediaDocument') {
      throw new RpcError(400, 'MEDIA_INVALID')
    }
    if (media.id._ !== 'inputPhoto' && media.id._ !== 'inputDocument') {
      throw new RpcError(400, 'MEDIA_INVALID')
    }
    if (media._ === 'inputMediaDocument' && media.id._ === 'inputDocument') {
      const sticker = await this._stickers?.resolveSend(media.id)
      if (sticker) {
        return {
          sticker: sticker.plan,
          providerId: sticker.providerId,
          stickerId: sticker.stickerId,
        }
      }
    }
    const staged = this._uploads.getStaged(this._session.platformSessionId, media.id.id.toString())
    if (!staged) throw new RpcError(400, 'MEDIA_INVALID')
    return staged
  }

  private async _sendRichContent(
    inputPeer: tl.TypeInputPeer,
    content: IMMessageInput,
    uploads: UploadedFile[],
    randomIds: Long[],
    replyTo?: tl.TypeInputReplyTo,
  ): Promise<tl.TypeUpdates> {
    const media = content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
    const stickers = content.parts.flatMap((part) => part.type === 'sticker' ? [part.sticker] : [])
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
    if (media.length > this._platform.capabilities.send.maxMedia) throw new RpcError(400, 'MEDIA_TOO_MANY')
    if (media.some((item) => item.kind === 'image') && !this._platform.capabilities.send.images) {
      throw new RpcError(400, 'PHOTO_SEND_UNAVAILABLE')
    }
    if (media.some((item) => item.kind === 'file') && !this._platform.capabilities.send.files) {
      throw new RpcError(400, 'FILE_SEND_UNAVAILABLE')
    }
    if (text && media.length && !this._platform.capabilities.send.mixed) {
      throw new RpcError(400, 'MIXED_SEND_UNAVAILABLE')
    }
    if (stickers.length > 1) throw new RpcError(400, 'STICKERS_TOO_MUCH')
    if (stickers.some((item) => item.type === 'native') && !this._platform.capabilities.stickers?.native) {
      throw new RpcError(400, 'STICKER_SEND_UNAVAILABLE')
    }
    if (stickers.some((item) => item.type === 'upload') && !this._platform.capabilities.stickers?.upload) {
      throw new RpcError(400, 'STICKER_SEND_UNAVAILABLE')
    }
    if (Array.from(text).length > this._platform.capabilities.send.maxTextLength) {
      throw new RpcError(400, 'MESSAGE_TOO_LONG')
    }

    await this._hydratePeers()
    const peerId = this._resolveMessageTarget(inputPeer, replyTo)
    const replyToId = await this._resolveReplyToId(peerId, replyTo)
    const sent = await this._platform.sendMessage(this._session, { id: peerId }, {
      ...content, replyToId,
    }, {
      onProgress: (progress) => this._onTransferProgress?.(this._session, progress),
    })
    const source: IMMessage = { ...sent, conversationId: peerId, outgoing: true }
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    const conversation = await this._store.getConversation(this._session.platformSessionId, peerId)
      ?? { id: peerId, kind: 'direct' as const, title: peerId }
    const persisted = await this._store.ingest(this._session, conversation, source)
    await Promise.all(uploads.map((upload) => this._uploads!.complete(upload)))

    const updates: tl.TypeUpdate[] = []
    let pts = await this._reservePts(persisted.projection.length, source.timestamp, conversation)
      - persisted.projection.length
    for (const [index, part] of persisted.projection.entries()) {
      const projected = await this._store.findProjectedByTlId(
        this._session.platformSessionId, part.tlMessageId, peerId,
      )
      if (!projected) throw new RpcError(500, 'MESSAGE_PROJECTION_NOT_FOUND')
      const item: MaterializedMessage = {
        source: projected.source,
        tlId: part.tlMessageId,
        ordinal: part.ordinal,
        groupedId: part.groupedId ?? undefined,
        media: projected.media.find((entry) => entry.id === part.mediaId),
      }
      this._rememberMessage(item)
      const randomId = randomIds[index]
      if (randomId) {
        updates.push({ _: 'updateMessageID', id: part.tlMessageId, randomId })
      }
      updates.push({
        _: this._isTelegramChannel(conversation) ? 'updateNewChannelMessage' : 'updateNewMessage',
        message: this._makeMessage(item), pts: ++pts, ptsCount: 1,
      } as tl.TypeUpdate)
    }
    const target = this._conversation(peerId)
    return {
      _: 'updates', updates,
      users: target.kind === 'direct'
        ? uniqueUsers([this._makeSelfUser(), await this._getPeerUser(peerId)])
        : [this._makeSelfUser()],
      chats: target.kind === 'direct' ? [] : [this._makeChat(target)],
      date: source.timestamp, seq: 0,
    }
  }

  private async _projectedItem(tlMessageId: number, conversationId: string): Promise<MaterializedMessage> {
    const projected = await this._store?.findProjectedByTlId(
      this._session.platformSessionId, tlMessageId, conversationId,
    )
    if (!projected) throw new RpcError(500, 'MESSAGE_PROJECTION_NOT_FOUND')
    const part = projected.parts.find((entry) => entry.tlMessageId === tlMessageId)
    if (!part) throw new RpcError(500, 'MESSAGE_PROJECTION_NOT_FOUND')
    const item: MaterializedMessage = {
      source: projected.source, tlId: part.tlMessageId, ordinal: part.ordinal,
      groupedId: part.groupedId ?? undefined,
      media: projected.media.find((entry) => entry.id === part.mediaId),
    }
    this._rememberMessage(item)
    return item
  }

  private _updates(
    conversation: import('./platform.js').IMConversation,
    updates: tl.TypeUpdate[],
    date: number,
  ): tl.TypeUpdates {
    return {
      _: 'updates', updates, users: [this._makeSelfUser()],
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)], date, seq: 0,
    }
  }

  private _throwMessageAction(error: unknown, fallback: string): never {
    if (error instanceof RpcError) throw error
    if (error instanceof MessageActionUnavailableError) throw new RpcError(400, fallback)
    throw new RpcError(400, fallback)
  }

  private async _reservePts(
    count: number,
    date: number,
    conversation?: import('./platform.js').IMConversation,
  ): Promise<number> {
    if (this._store) {
      const channelId = conversation && this._isTelegramChannel(conversation)
        ? this._peerId(conversation.id)
        : undefined
      return (await this._store.advancePts(this._session.platformSessionId, count, date, channelId)).pts
    }
    this._pts += count
    return this._pts
  }

  private async _materializeDialog(source: IMDialog, storedDraft?: StoredDraft) {
    const platformPeerId = source.conversation.id
    this._conversations.set(platformPeerId, source.conversation)
    const peer = this._conversationPeer(source.conversation)
    const users = source.conversation.kind === 'direct'
      ? [this._makePeerUser({
          id: platformPeerId,
          firstName: source.conversation.title,
          avatar: source.conversation.avatar,
        })]
      : source.lastMessage
        ? [await this._getMessageSender(source.lastMessage)]
        : []
    const chat = source.conversation.kind === 'direct' ? undefined : this._makeChat(source.conversation)
    const unpersistedReadInboxMaxId = source.unreadCount > 0 && source.readInboxMaxMessage && !this._store
      ? this._messageId(platformPeerId, source.readInboxMaxMessage.id)
      : undefined
    let projected = source.lastMessage
      ? this._historyCache.get(platformPeerId)?.filter((item) =>
          item.source.id === source.lastMessage!.id || item.source.sourceIds?.includes(source.lastMessage!.id))
      : undefined
    if (source.lastMessage && !projected?.length && this._store) {
      const stored = await this._store.findProjectedByPlatformId(
        this._session.platformSessionId,
        platformPeerId,
        source.lastMessage.id,
      )
      projected = stored?.parts.map((part): MaterializedMessage => ({
        source: stored.source,
        tlId: part.tlMessageId,
        ordinal: part.ordinal,
        groupedId: part.groupedId ?? undefined,
        media: stored.media.find((entry) => entry.id === part.mediaId),
      })).sort((left, right) => right.tlId - left.tlId)
      for (const item of projected ?? []) this._rememberMessage(item)
    }
    const top = projected?.[0]
    const topMessage = top?.tlId ?? (source.lastMessage ? this._messageId(platformPeerId, source.lastMessage.id) : 0)
    let readInboxMaxId = source.unreadCount > 0 ? 0 : topMessage
    if (source.unreadCount > 0 && source.readInboxMaxMessage) {
      let readProjection = this._historyCache.get(platformPeerId)?.filter((item) =>
        item.source.id === source.readInboxMaxMessage!.id
        || item.source.sourceIds?.includes(source.readInboxMaxMessage!.id))
      if (!readProjection?.length && this._store) {
        const stored = await this._store.findProjectedByPlatformId(
          this._session.platformSessionId,
          platformPeerId,
          source.readInboxMaxMessage.id,
        )
        readProjection = stored?.parts.map((part): MaterializedMessage => ({
          source: stored.source,
          tlId: part.tlMessageId,
          ordinal: part.ordinal,
          groupedId: part.groupedId ?? undefined,
          media: stored.media.find((entry) => entry.id === part.mediaId),
        }))
      }
      readInboxMaxId = readProjection?.reduce((maximum, item) => Math.max(maximum, item.tlId), 0)
        ?? unpersistedReadInboxMaxId
        ?? this._messageId(platformPeerId, source.readInboxMaxMessage.id)
    }
    const message = source.lastMessage
      ? this._makeMessage(top ?? { source: source.lastMessage, tlId: topMessage, ordinal: 0 })
      : undefined
    const dialog: tl.RawDialog = {
      _: 'dialog',
      peer,
      topMessage,
      readInboxMaxId,
      readOutboxMaxId: topMessage,
      unreadCount: source.unreadCount,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      unreadPollVotesCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
      draft: storedDraft?.draft,
    }
    return { source, dialog, message, users, chat }
  }

  private async _loadHistory(peerId: string, request: HistoryWindow = { limit: 1 }): Promise<MaterializedMessage[]> {
    const startedAt = performance.now()
    this._onTrace?.('history load profile stage=start peer=%s limit=%d', peerId, request.limit ?? 1)
    if (this._data && this._store) {
      const requestKey = historyWindowKey(request)
      const cached = this._historyCache.get(peerId)
      const cacheMetadata = this._historyCacheMetadata.get(peerId)
      if (
        cached
        && cacheMetadata?.requestKey === requestKey
        && cacheMetadata.storeRevision === this._store.revision
        && cacheMetadata.freshUntil > startedAt
      ) {
        this._onTrace?.(
          'history load profile peer=%s cache=true materialized=%d totalMs=%d',
          peerId, cached.length, profileMilliseconds(performance.now() - startedAt),
        )
        return cached
      }
      const anchorId = request.offsetId || request.maxId || undefined
      const anchorAt = performance.now()
      const anchor = anchorId
        ? await this._store.findProjectedByTlId(this._session.platformSessionId, anchorId, peerId)
        : undefined
      const anchorMs = performance.now() - anchorAt
      const fetchLimit = Math.max(1, Math.min(
        (request.limit ?? 1) + Math.abs(request.addOffset ?? 0) + 1,
        200,
      ))
      const negativeOffset = (request.addOffset ?? 0) < 0
      const readInboxMaxMessageId = this._readInboxMaxMessageIds.get(peerId)
      const aroundUnread = negativeOffset && anchor && (
        anchor.source.id === readInboxMaxMessageId
        || anchor.source.sourceIds?.includes(readInboxMaxMessageId ?? '')
      )
      const upstreamAt = performance.now()
      if (aroundUnread) {
        // Telegram Desktop opens an unread dialog with
        // offset_id=read_inbox_max_id and a negative add_offset. Let adapters
        // perform their initial unread-aware fetch (QQNT uses firstUnreadSeq).
        await this._data.syncHistory(peerId, { limit: fetchLimit })
      } else if (negativeOffset && anchor) {
        // A generic jump also needs both sides of its anchor, but must not be
        // mistaken for QQNT's conversation-level unread anchor.
        const sourceAnchor = { id: anchor.source.id, timestamp: anchor.source.timestamp }
        await this._data.syncHistory(peerId, { limit: fetchLimit, after: sourceAnchor })
        await this._data.syncHistory(peerId, { limit: fetchLimit, before: sourceAnchor })
      } else {
        await this._data.syncHistory(peerId, {
          limit: fetchLimit,
          before: anchor ? { id: anchor.source.id, timestamp: anchor.source.timestamp } : undefined,
        })
      }
      const upstreamMs = performance.now() - upstreamAt
      const usersAt = performance.now()
      await this._syncStoredUsers()
      const usersMs = performance.now() - usersAt
      const projectAt = performance.now()
      const projectionRevision = this._store.revision
      const projected = await this._store.readProjectedHistory(this._session.platformSessionId, peerId, {
        limit: fetchLimit,
        beforeTimestamp: request.offsetDate && request.offsetDate > 0 ? request.offsetDate : undefined,
        maxTimestamp: !negativeOffset ? anchor?.source.timestamp : undefined,
      })
      const projectionReadMs = performance.now() - projectAt
      const materializeAt = performance.now()
      const history = projected.flatMap(({ source, parts, media }) => parts.map((part) => {
        const item: MaterializedMessage = {
          source,
          tlId: part.tlMessageId,
          ordinal: part.ordinal,
          groupedId: part.groupedId ?? undefined,
          media: media.find((entry) => entry.id === part.mediaId),
        }
        this._rememberMessage(item)
        return item
      })).sort((a, b) => b.source.timestamp - a.source.timestamp || b.tlId - a.tlId)
      const materializeMs = performance.now() - materializeAt
      const repliesAt = performance.now()
      await this._rememberReplyTargets(history.map((item) => item.source))
      const repliesMs = performance.now() - repliesAt
      this._historyCache.set(peerId, history)
      if (projectionRevision === this._store.revision) {
        this._historyCacheMetadata.set(peerId, {
          requestKey,
          storeRevision: projectionRevision,
          freshUntil: performance.now() + PlatformDataService.HISTORY_SYNC_FRESH_MS,
        })
      } else {
        this._historyCacheMetadata.delete(peerId)
      }
      this._onTrace?.(
        'history load profile peer=%s anchorId=%d anchorFound=%s fetchLimit=%d aroundUnread=%s projected=%d materialized=%d anchorMs=%d upstreamMs=%d usersMs=%d projectionReadMs=%d materializeMs=%d repliesMs=%d totalMs=%d',
        peerId, anchorId ?? 0, Boolean(anchor), fetchLimit, Boolean(aroundUnread), projected.length, history.length,
        profileMilliseconds(anchorMs), profileMilliseconds(upstreamMs), profileMilliseconds(usersMs),
        profileMilliseconds(projectionReadMs), profileMilliseconds(materializeMs), profileMilliseconds(repliesMs),
        profileMilliseconds(performance.now() - startedAt),
      )
      return history
    }

    const history = (await this._requireHistory(this._platform.getHistory).call(
      this._platform, this._session, { id: peerId }, { limit: request.limit },
    )).messages
    const materialized = history.slice().sort((a, b) => a.timestamp - b.timestamp).map((source) => {
      const item: MaterializedMessage = {
        source, tlId: telegramMessageId(source) ?? this._messageId(peerId, source.id), ordinal: 0,
      }
      this._rememberMessage(item)
      return item
    }).sort((a, b) => b.source.timestamp - a.source.timestamp || b.tlId - a.tlId)
    this._historyCache.set(peerId, materialized)
    this._onTrace?.(
      'history load profile peer=%s store=false fetched=%d materialized=%d totalMs=%d',
      peerId, history.length, materialized.length, profileMilliseconds(performance.now() - startedAt),
    )
    return materialized
  }

  private async _hydrateAllMessages(): Promise<void> {
    const dialogs = await this._loadDialogs()
    await Promise.all(dialogs.map((dialog) => this._loadHistory(dialog.conversation.id)))
  }

  private async _hydrateUsers(): Promise<void> {
    if (this._selfId) return
    if (this._userHydration) return this._userHydration
    const pending = (async () => {
      if (!this._store) {
        this._selfId = stableId(`self:${this._session.platformSessionId}`)
        return
      }
      let rows = await this._store.listUsers(this._session.platformId)
      let self = rows.find((row) => row.platformUserId === this._session.userId)
      if (!self) {
        const profile = await this._platform.getUser?.(this._session, this._session.userId)
          ?? {
            id: this._session.userId,
            firstName: String(this._session.metadata.firstName ?? 'Bridge'),
            lastName: this._session.metadata.lastName as string | undefined,
            username: this._session.metadata.username as string | undefined,
            metadata: this._session.metadata,
          }
        self = await this._store.upsertUser(this._session, profile)
        rows = [...rows, self]
      }
      for (const row of rows) this._registerUser(row)
      this._selfId = self.id
    })()
    this._userHydration = pending
    try {
      await pending
    } finally {
      if (this._userHydration === pending) this._userHydration = undefined
    }
  }

  private async _syncStoredUsers(): Promise<void> {
    if (!this._store) return
    for (const row of await this._store.listUsers(this._session.platformId)) this._registerUser(row)
  }

  private async _persistUsers(users: readonly IMUser[]): Promise<void> {
    if (!users.length) return
    if (!this._store) {
      for (const user of users) this._peerId(user.id)
      return
    }
    for (const row of await this._store.upsertUsers(this._session, users)) this._registerUser(row)
  }

  private _registerUser(row: IMUserRow): void {
    const existingPlatformId = this._tlToPeer.get(row.id)
    if (existingPlatformId && existingPlatformId !== row.platformUserId) {
      throw new Error(`Telegram user ID ${row.id} is already mapped to ${existingPlatformId}`)
    }
    this._peerToTl.set(row.platformUserId, row.id)
    this._tlToPeer.set(row.id, row.platformUserId)
    const user = toUser(row)
    if (row.platformUserId === this._session.userId) {
      this._selfId = row.id
      this._selfUser = user
    }
    if (user.avatar) {
      const photoId = Long.fromNumber(stableId(`avatar:${user.avatar.id}`))
      this._avatarMedia.set(photoId.toString(), user.avatar)
    }
  }

  private _userId(platformUserId: string): number {
    const id = this._peerToTl.get(platformUserId)
    if (id !== undefined) return id
    if (!this._store) return this._peerId(platformUserId)
    throw new Error(`platform user was not persisted before projection: ${platformUserId}`)
  }

  private async _hydratePeers(force = false): Promise<void> {
    await this._hydrateUsers()
    if (!force && Date.now() - this._peersHydratedAt < DialogRpc.PEER_HYDRATION_TTL_MS) return
    if (this._peerHydration) return this._peerHydration

    const pending = this._loadDialogs().then(async (dialogs) => {
      const storedConversations = await this._store?.listConversations(this._session.platformSessionId) ?? []
      const directUsers = dialogs
        .filter((dialog) => dialog.conversation.kind === 'direct')
        .map((dialog) => ({
          id: dialog.conversation.id,
          firstName: dialog.conversation.title,
          avatar: dialog.conversation.avatar,
        }))
      await this._persistUsers(directUsers)
      for (const conversation of storedConversations) {
        this._conversations.set(conversation.id, conversation)
        this._peerId(conversation.id)
      }
      for (const dialog of dialogs) {
        this._conversations.set(dialog.conversation.id, dialog.conversation)
        this._peerId(dialog.conversation.id)
      }
      await this._syncStoredUsers()
      this._peersHydratedAt = Date.now()
    })
    this._peerHydration = pending
    try {
      await pending
    } finally {
      if (this._peerHydration === pending) this._peerHydration = undefined
    }
  }

  private async _loadDialogs(query: { limit?: number, afterId?: string } = { limit: 100 }): Promise<IMDialog[]> {
    return (await this._loadDialogPage(query)).dialogs
  }

  private async _loadDialogPage(
    query: { limit?: number, afterId?: string } = { limit: 100 },
  ): Promise<IMDialogPage> {
    const page = this._data
      ? await this._data.getDialogsPage(query)
      : await this._requireHistory(this._platform.getDialogs).call(this._platform, this._session, query)
    const dialogs = page.dialogs
    for (const dialog of dialogs) {
      this._dialogCache.set(dialog.conversation.id, dialog)
      this._conversations.set(dialog.conversation.id, dialog.conversation)
      if (dialog.readInboxMaxMessage) {
        this._readInboxMaxMessageIds.set(dialog.conversation.id, dialog.readInboxMaxMessage.id)
      } else {
        this._readInboxMaxMessageIds.delete(dialog.conversation.id)
      }
    }
    return { ...page, dialogs: dialogs.filter((dialog) => !this._isSubchannel(dialog.conversation)) }
  }

  private async _loadSubdialogPage(
    parentId: string,
    query: { limit?: number, afterId?: string },
  ): Promise<IMDialogPage> {
    const load = this._platform.getSubdialogs
    if (!load) return { dialogs: [], total: 0 }
    const page = this._data
      ? await this._data.getSubdialogsPage(parentId, query)
      : await load.call(this._platform, this._session, { id: parentId }, query)
    for (const dialog of page.dialogs) {
      this._dialogCache.set(dialog.conversation.id, dialog)
      this._conversations.set(dialog.conversation.id, dialog.conversation)
      if (dialog.readInboxMaxMessage) {
        this._readInboxMaxMessageIds.set(dialog.conversation.id, dialog.readInboxMaxMessage.id)
      }
    }
    await this._syncStoredUsers()
    return page
  }

  private async _getInputUser(input: tl.TypeInputUser): Promise<tl.TypeUser> {
    if (input._ === 'inputUserSelf') return this._makeSelfUser()
    if (input._ !== 'inputUser' && input._ !== 'inputUserFromMessage') {
      throw new RpcError(400, 'USER_ID_INVALID')
    }
    let peerId = this._tlToPeer.get(input.userId)
    if (!peerId && this._store) {
      const row = await this._store.getUserByTlId(this._session.platformId, input.userId)
      if (row) {
        this._registerUser(row)
        peerId = row.platformUserId
      }
    }
    if (!peerId) throw new RpcError(400, 'USER_ID_INVALID')
    return this._getPeerUser(peerId)
  }

  private _makeMessage(item: MaterializedMessage): tl.TypeMessage {
    const { source, tlId } = item
    const conversation = this._conversation(source.conversationId)
    const sticker = source.content.parts.find((part) => part.type === 'sticker')
    const card = source.content.parts.find((part) => part.type === 'card')
    const reply = this._messageReplyHeader(source)
    return projectTlMessage({
      conversation,
      source,
      tlId,
      ordinal: item.ordinal,
      fromId: {
        _: 'peerUser',
        userId: source.outgoing ? this._selfId : this._userId(source.senderId),
      },
      peerId: this._conversationPeer(conversation),
      groupedId: item.groupedId ?? undefined,
      media: item.media
        ? makeTlMessageMedia(item.media, source.timestamp, this._dcId)
        : sticker?.type === 'sticker'
          ? this._stickers?.makeMessageMedia(sticker.sticker)
          : card?.type === 'card'
            ? makeTlCardPreview(card.card, this._dcId)
            : this._conversationPreviewMedia(source),
      entities: item.ordinal === 0 ? this._messageEntities(source) : undefined,
      reactions: source.reactionContext?.reactions.length
        ? this._reactions?.messageReactions(source.conversationId, source, (id) => this._userId(id))
        : undefined,
      replyToTlId: reply?.replyToMsgId,
      topicId: this._topicReplyHeader(conversation, tlId)?.replyToTopId,
    })
  }

  private _rememberMessage(item: MaterializedMessage): void {
    const key = `${item.source.conversationId}\u0000${item.source.id}\u0000${item.ordinal}`
    this._messageToTl.set(key, item.tlId)
    const sourceId = item.source.sourceIds?.[item.ordinal]
    if (sourceId) this._messageToTl.set(`${item.source.conversationId}\u0000${sourceId}\u00000`, item.tlId)
    const nativeSequence = qqMessageSequenceFromMetadata(item.source.metadata)
    if (nativeSequence !== undefined && item.ordinal === 0) {
      this._messageToTl.set(qqSequenceKey(item.source.conversationId, nativeSequence), item.tlId)
    }
    this._tlToMessage.set(item.tlId, {
      peerId: item.source.conversationId,
      platformMessageId: item.source.id,
      ordinal: item.ordinal,
    })
  }

  private async _rememberReplyTargets(messages: readonly IMMessage[]): Promise<void> {
    if (!this._store) return
    const targets = new Map<string, { conversationId: string, targetId: string }>()
    for (const message of messages) {
      const qqReplySequence = qqReplySequenceFromMetadata(message.metadata)
      if (qqReplySequence !== undefined) {
        const key = qqSequenceKey(message.conversationId, qqReplySequence)
        if (!this._messageToTl.has(key)) {
          const projected = await this._store.findProjectedByNativeSequence(
            this._session.platformSessionId, message.conversationId, qqReplySequence,
          )
          if (projected) {
            for (const part of projected.parts) this._rememberMessage({
              source: projected.source,
              tlId: part.tlMessageId,
              ordinal: part.ordinal,
              groupedId: part.groupedId ?? undefined,
              media: projected.media.find((entry) => entry.id === part.mediaId),
            })
          }
        }
        if (this._messageToTl.has(key)) continue
      } else if (telegramReplyToMessageId(message)) {
        continue
      }
      if (!message.replyToId) continue
      const key = `${message.conversationId}\u0000${message.replyToId}\u00000`
      if (!this._messageToTl.has(key)) targets.set(key, {
        conversationId: message.conversationId, targetId: message.replyToId,
      })
    }
    await Promise.all([...targets.values()].map(async ({ conversationId, targetId }) => {
      let projected = await this._store!.findProjectedByPlatformId(
        this._session.platformSessionId, conversationId, targetId,
      )
      if (!projected && this._data) {
        await this._data.getMessage(conversationId, targetId).catch(() => null)
        projected = await this._store!.findProjectedByPlatformId(
          this._session.platformSessionId, conversationId, targetId,
        )
      }
      if (!projected) return
      for (const part of projected.parts) this._rememberMessage({
        source: projected.source,
        tlId: part.tlMessageId,
        ordinal: part.ordinal,
        groupedId: part.groupedId ?? undefined,
        media: projected.media.find((entry) => entry.id === part.mediaId),
      })
    }))
  }

  private _messageReplyHeader(source: IMMessage): tl.RawMessageReplyHeader | undefined {
    const qqReplySequence = qqReplySequenceFromMetadata(source.metadata)
    if (qqReplySequence !== undefined) {
      const replyToMsgId = this._messageToTl.get(qqSequenceKey(source.conversationId, qqReplySequence))
      if (replyToMsgId) return { _: 'messageReplyHeader', replyToMsgId }
    }
    const nativeReplyTo = qqReplySequence === undefined ? telegramReplyToMessageId(source) : undefined
    if (nativeReplyTo) return { _: 'messageReplyHeader', replyToMsgId: nativeReplyTo }
    if (!source.replyToId) return
    const replyToMsgId = this._messageToTl.get(
      `${source.conversationId}\u0000${source.replyToId}\u00000`,
    )
    return replyToMsgId ? { _: 'messageReplyHeader', replyToMsgId } : undefined
  }

  private _messageEntities(source: IMMessage): tl.TypeMessageEntity[] | undefined {
    const output: tl.TypeMessageEntity[] = []
    let base = 0
    const rendered = source.content.parts.flatMap((part) => {
      const text = messagePartText(part)
      return text ? [{ part, text }] : []
    })
    for (const [index, { part, text }] of rendered.entries()) {
      for (const entity of part.type === 'text' ? part.entities ?? [] : []) {
        if (entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > text.length) continue
        if (entity.type === 'mention') {
          output.push({
            _: 'messageEntityMentionName',
            offset: base + entity.offset,
            length: entity.length,
            userId: this._userId(entity.userId),
          })
        } else if (entity.type === 'conversation-link') {
          output.push({
            _: 'messageEntityTextUrl', offset: base + entity.offset, length: entity.length,
            url: this._conversationLinkUrl(entity.conversation),
          })
        } else if (entity.definition.presentation.type === 'custom' && this._reactions) {
          const reaction = this._reactions.toTlReaction(source.conversationId, entity.definition)
          if (reaction._ === 'reactionCustomEmoji') output.push({
            _: 'messageEntityCustomEmoji', offset: base + entity.offset, length: entity.length,
            documentId: reaction.documentId,
          })
        }
      }
      if (part.type === 'card') {
        const url = cardUrl(part.card)
        if (url) output.push({
          _: 'messageEntityTextUrl', offset: base, length: text.length, url,
        })
      }
      base += text.length + (index + 1 < rendered.length ? 1 : 0)
    }
    return output.length ? output : undefined
  }

  private _conversationPreviewMedia(source: IMMessage): tl.RawMessageMediaWebPage | undefined {
    const linked = source.content.parts
      .filter((part) => part.type === 'text')
      .flatMap((part) => part.entities ?? [])
      .find((entity) => entity.type === 'conversation-link')
    if (!linked || linked.type !== 'conversation-link') return

    return makeTlConversationPreview(
      linked.conversation,
      this._conversationLinkUrl(linked.conversation),
    )
  }

  private _conversationLinkUrl(conversation: import('./platform.js').IMConversation): string {
    const chatId = this._peerId(conversation.id)
    this._conversations.set(conversation.id, conversation)
    return registerVirtualConversation(this._session.platformSessionId, chatId, conversation)
  }

  private _linkedChats(messages: readonly IMMessage[]): tl.TypeChat[] {
    const conversations = new Map<string, import('./platform.js').IMConversation>()
    for (const message of messages) {
      for (const part of message.content.parts) {
        if (part.type !== 'text') continue
        for (const entity of part.entities ?? []) {
          if (entity.type !== 'conversation-link') continue
          conversations.set(entity.conversation.id, entity.conversation)
        }
      }
    }
    return [...conversations.values()].map((conversation) => {
      this._conversations.set(conversation.id, conversation)
      this._peerId(conversation.id)
      return this._makeChat(conversation)
    })
  }

  private _inputTextPart(text: string, entities?: tl.TypeMessageEntity[]): IMMessageInput['parts'][number] {
    const mapped: IMTextEntity[] = []
    for (const entity of entities ?? []) {
      const input = entity as any
      if (entity._ === 'messageEntityCustomEmoji') {
        const definition = this._reactions?.resolveCustomEmoji(Number(input.documentId))
        if (definition && input.offset >= 0 && input.length > 0 && input.offset + input.length <= text.length) {
          mapped.push({ type: 'custom-emoji', offset: input.offset, length: input.length, definition })
        }
        continue
      }
      if (entity._ !== 'inputMessageEntityMentionName' && entity._ !== 'messageEntityMentionName') continue
      let userId: string | undefined
      if (input.userId?._ === 'inputUserSelf') userId = this._session.userId
      else if (input.userId?._ === 'inputUser') userId = this._tlToPeer.get(Number(input.userId.userId))
      else if (input.userId !== undefined) userId = this._tlToPeer.get(Number(input.userId))
      if (!userId || input.offset < 0 || input.length <= 0 || input.offset + input.length > text.length) continue
      mapped.push({ type: 'mention', offset: input.offset, length: input.length, userId })
    }
    return { type: 'text', text, entities: mapped.length ? mapped : undefined }
  }

  private _multiMediaCaption(items: SendMultiMediaRequest['multiMedia']): IMMessageInput['parts'][number] {
    const parts = items.filter((item) => item.message).map((item) =>
      this._inputTextPart(item.message, item.entities))
    const text = parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
    const entities: IMTextEntity[] = []
    let base = 0
    for (const [index, part] of parts.entries()) {
      if (part.type === 'text') {
        entities.push(...(part.entities ?? []).map((entity) => ({ ...entity, offset: entity.offset + base })))
        base += part.text.length + (index + 1 < parts.length ? 1 : 0)
      }
    }
    return { type: 'text', text, entities: entities.length ? entities : undefined }
  }

  private async _resolveReplyToId(
    conversationId: string,
    replyTo?: tl.TypeInputReplyTo,
  ): Promise<string | undefined> {
    if (replyTo?._ !== 'inputReplyToMessage' || !this._store) return
    const projected = await this._store.findProjectedByTlId(
      this._session.platformSessionId, replyTo.replyToMsgId, conversationId,
    )
    if (!projected) return
    const ordinal = projected.parts.find((part) => part.tlMessageId === replyTo.replyToMsgId)?.ordinal ?? 0
    return projected.source.sourceIds?.[ordinal] ?? projected.source.id
  }

  private _emptyMessages(conversation: import('./platform.js').IMConversation): tl.messages.RawMessages {
    return {
      _: 'messages.messages', messages: [], topics: [],
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      users: [this._makeSelfUser()],
    }
  }

  private async _getPeerUser(peerId: string, fallbackName?: string): Promise<tl.RawUser> {
    if (peerId === this._session.userId) return this._makeSelfUser()
    const cached = this._peerUsers.get(peerId)
    if (cached) return cached
    const pending = this._pendingPeerUsers.get(peerId)
    if (pending) return pending
    const lookup = this._getPlatformUser(peerId)
      .then(async (upstream) => {
        const stored = upstream ? undefined : await this._store?.getUser(this._session.platformId, peerId)
        const user = upstream ?? (stored ? toUser(stored) : { id: peerId, firstName: fallbackName ?? peerId })
        await this._persistUsers([user])
        return this._makePeerUser(user)
      })
      .then((user) => {
        this._peerUsers.set(peerId, user)
        return user
      })
      .finally(() => this._pendingPeerUsers.delete(peerId))
    this._pendingPeerUsers.set(peerId, lookup)
    return lookup
  }

  private _getPlatformUser(peerId: string): Promise<IMUser<any> | null> {
    const cached = this._platformUsers.get(peerId)
    if (cached) return Promise.resolve(cached)
    const pending = this._pendingPlatformUsers.get(peerId)
    if (pending) return pending
    const lookup = Promise.resolve()
      .then(() => this._platform.getUser?.(this._session, peerId) ?? null)
      .then((user) => {
        if (user) this._platformUsers.set(peerId, user)
        return user
      })
      .finally(() => this._pendingPlatformUsers.delete(peerId))
    this._pendingPlatformUsers.set(peerId, lookup)
    return lookup
  }

  private async _getMessageSender(message: IMMessage<any>): Promise<tl.RawUser> {
    if (message.senderId === this._session.userId) return this._makeSelfUser(message.sender?.avatar)
    if (!message.sender || (
      message.sender.firstName === message.sender.id
      && !message.sender.lastName
      && !message.sender.username
      && !message.sender.avatar
      && Object.keys(message.sender.metadata ?? {}).length === 0
    )) return this._getPeerUser(message.senderId)
    await this._persistUsers([message.sender])
    const user = this._makePeerUser(message.sender)
    this._peerUsers.set(message.senderId, user)
    return user
  }

  private async _messageSenders(messages: readonly IMMessage<any>[]): Promise<tl.RawUser[]> {
    const senders = new Map<string, IMMessage<any>>()
    for (const message of messages) senders.set(message.senderId, message)
    return Promise.all([...senders.values()].map((message) => this._getMessageSender(message)))
  }

  private async _allMembers(conversationId: string): Promise<IMConversationMember<any>[]> {
    if (!this._platform.capabilities.members?.list || !this._platform.getConversationMembers) return []
    const members: IMConversationMember<any>[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    do {
      const page = await this._platform.getConversationMembers(
        this._session, { id: conversationId }, { cursor, limit: 100 },
      )
      members.push(...page.members)
      cursor = page.nextCursor
      if (cursor && seenCursors.has(cursor)) break
      if (cursor) seenCursors.add(cursor)
    } while (cursor && members.length < 10_000)
    await this._persistUsers(members.map((member) => member.user))
    return members
  }

  private async _memberPage(
    conversationId: string,
    offset: number,
    limit: number,
  ): Promise<import('./platform.js').IMConversationMemberPage<any>> {
    if (!this._platform.capabilities.members?.list || !this._platform.getConversationMembers || limit <= 0) {
      return { members: [] }
    }
    let cursors = this._memberCursors.get(conversationId)
    if (!cursors) {
      cursors = new Map([[0, null]])
      this._memberCursors.set(conversationId, cursors)
    }
    let start = [...cursors.keys()].filter((known) => known <= offset).sort((a, b) => b - a)[0] ?? 0
    let cursor = cursors.get(start) ?? undefined
    let knownTotal: number | undefined
    while (start < offset) {
      const skipped = await this._platform.getConversationMembers(
        this._session, { id: conversationId }, { cursor, limit: offset - start },
      )
      knownTotal = skipped.total ?? knownTotal
      start += skipped.members.length
      cursor = skipped.nextCursor
      if (cursor) cursors.set(start, cursor)
      if (!cursor || !skipped.members.length) return { members: [], total: knownTotal ?? start }
    }
    const page = await this._platform.getConversationMembers(
      this._session, { id: conversationId }, { cursor, limit },
    )
    await this._persistUsers(page.members.map((member) => member.user))
    const nextOffset = offset + page.members.length
    if (page.nextCursor) cursors.set(nextOffset, page.nextCursor)
    return page
  }

  private _makeMemberUser(member: IMConversationMember<any>): tl.RawUser {
    return member.user.id === this._session.userId
      ? this._makeSelfUser(member.user.avatar)
      : this._makePeerUser(member.user)
  }

  private _makeChannelParticipant(member: IMConversationMember<any>): tl.TypeChannelParticipant {
    const self = member.user.id === this._session.userId
    const userId = self ? this._selfId : this._userId(member.user.id)
    if (member.role === 'owner') {
      return {
        _: 'channelParticipantCreator', userId,
        adminRights: makeAdminRights(member.permissions), rank: member.title,
      }
    }
    if (member.role === 'administrator') {
      return {
        _: 'channelParticipantAdmin', self: self || undefined, userId,
        promotedBy: this._selfId, date: member.joinedAt ?? 0,
        adminRights: makeAdminRights(member.permissions), rank: member.title,
      }
    }
    if (self) {
      return {
        _: 'channelParticipantSelf', userId, inviterId: this._selfId,
        date: member.joinedAt ?? 0, rank: member.title,
      }
    }
    return { _: 'channelParticipant', userId, date: member.joinedAt ?? 0, rank: member.title }
  }

  private _makePeerUser(user: IMUser): tl.RawUser {
    const contact = this._contactUserIds.has(user.id)
    return makeUser({
      id: this._userId(user.id), firstName: user.firstName,
      lastName: user.lastName, username: user.username,
      contact: contact || undefined, mutualContact: contact || undefined,
      photo: user.avatar ? this._makeAvatarPhoto(user.avatar, 'user') : undefined,
    })
  }

  private _makeSelfUser(avatar?: IMMedia<any>): tl.RawUser {
    const profile = this._selfUser
    const photo = avatar ?? profile?.avatar
    return makeUser({
      id: this._selfId,
      self: true,
      premium: true,
      firstName: profile?.firstName ?? String(this._session.metadata.firstName ?? 'Bridge'),
      lastName: profile?.lastName ?? this._session.metadata.lastName as string | undefined,
      username: profile?.username ?? this._session.metadata.username as string | undefined,
      photo: photo ? this._makeAvatarPhoto(photo, 'user') : undefined,
    })
  }

  private _resolvePeer(peer: tl.TypeInputPeer): string {
    if (peer._ !== 'inputPeerUser' && peer._ !== 'inputPeerChat' && peer._ !== 'inputPeerChannel') {
      throw new RpcError(400, 'PEER_ID_INVALID')
    }
    const tlId = inputPeerId(peer)
    let id = this._tlToPeer.get(tlId)
    if (!id && peer._ === 'inputPeerChat') {
      const virtual = virtualConversation(this._session.platformSessionId, tlId)
      if (virtual) {
        this._conversations.set(virtual.id, virtual)
        this._peerToTl.set(virtual.id, tlId)
        this._tlToPeer.set(tlId, virtual.id)
        id = virtual.id
      }
    }
    if (!id) throw new RpcError(400, 'PEER_ID_INVALID')
    const conversation = this._conversation(id)
    if (peer._ === 'inputPeerUser' && conversation.kind !== 'direct') throw new RpcError(400, 'PEER_ID_INVALID')
    if (peer._ === 'inputPeerChat' && !this._isVirtualConversation(conversation)) throw new RpcError(400, 'PEER_ID_INVALID')
    if (peer._ === 'inputPeerChannel' && !this._isTelegramChannel(conversation)) throw new RpcError(400, 'PEER_ID_INVALID')
    return id
  }

  private _resolveChat(chatId: number): import('./platform.js').IMConversation {
    let peerId = this._tlToPeer.get(chatId)
    if (!peerId) {
      const virtual = virtualConversation(this._session.platformSessionId, chatId)
      if (virtual) {
        this._conversations.set(virtual.id, virtual)
        this._peerToTl.set(virtual.id, chatId)
        this._tlToPeer.set(chatId, virtual.id)
        peerId = virtual.id
      }
    }
    const conversation = peerId ? this._conversation(peerId) : undefined
    if (!conversation || !this._isVirtualConversation(conversation)) throw new RpcError(400, 'CHAT_ID_INVALID')
    return conversation
  }

  private _resolveChannel(channel: tl.TypeInputChannel): import('./platform.js').IMConversation {
    if (channel._ !== 'inputChannel') throw new RpcError(400, 'CHANNEL_INVALID')
    const peerId = this._tlToPeer.get(channel.channelId)
    const conversation = peerId ? this._conversation(peerId) : undefined
    if (!conversation || !this._isTelegramChannel(conversation)) throw new RpcError(400, 'CHANNEL_INVALID')
    return conversation
  }

  private _resolveMessageTarget(peer: tl.TypeInputPeer, replyTo?: tl.TypeInputReplyTo): string {
    const parentId = this._resolvePeer(peer)
    if (replyTo?._ !== 'inputReplyToMessage') return parentId
    const topicId = replyTo.topMsgId ?? replyTo.replyToMsgId
    const childId = this._topicToConversation.get(topicId)
    return childId && this._conversation(childId).parentId === parentId ? childId : parentId
  }

  private async _resolveDraftScope(
    peer: tl.TypeInputPeer,
    replyTo?: tl.TypeInputReplyTo,
  ): Promise<{ conversationId: string, topMsgId: number }> {
    const parentId = this._resolvePeer(peer)
    if (replyTo?._ !== 'inputReplyToMessage') return { conversationId: parentId, topMsgId: 0 }
    if (replyTo.topMsgId !== undefined && !this._topicToConversation.has(replyTo.topMsgId)) {
      const parent = this._conversation(parentId)
      if (parent.kind === 'channel') await this._ensureTopics(parentId)
    }
    const topMsgId = replyTo.topMsgId
      ?? (this._topicToConversation.has(replyTo.replyToMsgId) ? replyTo.replyToMsgId : 0)
    const childId = topMsgId ? this._topicToConversation.get(topMsgId) : undefined
    if (!childId || this._conversation(childId).parentId !== parentId) {
      return { conversationId: parentId, topMsgId: 0 }
    }
    return { conversationId: childId, topMsgId }
  }

  private async _mainDrafts(): Promise<Map<string, StoredDraft>> {
    const drafts = await this._drafts?.list(this._session.platformSessionId) ?? []
    return new Map(drafts.filter((draft) => draft.topMsgId === 0)
      .map((draft) => [draft.conversationId, draft]))
  }

  private _makeDraftUpdate(stored: {
    conversationId: string
    topMsgId: number
    draft: tl.TypeDraftMessage
  }): tl.RawUpdateDraftMessage {
    const conversation = this._conversation(stored.conversationId)
    const display = stored.topMsgId && conversation.parentId
      ? this._conversation(conversation.parentId)
      : conversation
    return {
      _: 'updateDraftMessage',
      peer: this._conversationPeer(display),
      topMsgId: stored.topMsgId || undefined,
      draft: stored.draft,
    }
  }

  private async _publishDraft(
    conversationId: string,
    topMsgId: number,
    draft: tl.TypeDraftMessage,
  ): Promise<void> {
    if (!this._onDraftUpdate) return
    const update = this._makeDraftUpdate({ conversationId, topMsgId, draft })
    await this._onDraftUpdate(this._session, update, this._authKeyId)
  }

  private async _clearDraftAfterSend(peer: tl.TypeInputPeer, replyTo?: tl.TypeInputReplyTo): Promise<void> {
    if (!this._drafts) return
    try {
      const scope = await this._resolveDraftScope(peer, replyTo)
      await this._drafts.remove(this._session.platformSessionId, scope.conversationId, scope.topMsgId)
      await this._publishDraft(scope.conversationId, scope.topMsgId, {
        _: 'draftMessageEmpty', date: Math.floor(Date.now() / 1000),
      })
    } catch (error) {
      this._onTrace?.('draft clear after send failed: %s', String(error))
    }
  }

  private _conversation(peerId: string): import('./platform.js').IMConversation {
    return this._conversations.get(peerId) ?? { id: peerId, kind: 'direct', title: peerId }
  }

  private _conversationPeer(conversation: import('./platform.js').IMConversation): tl.TypePeer {
    if (this._isVirtualConversation(conversation)) {
      return { _: 'peerChat', chatId: this._peerId(conversation.id) }
    }
    const target = this._isSubchannel(conversation)
      ? this._conversation(conversation.parentId!)
      : conversation
    const id = this._peerId(target.id)
    if (this._isTelegramChannel(target)) return { _: 'peerChannel', channelId: id }
    return { _: 'peerUser', userId: id }
  }

  private _makeChat(conversation: import('./platform.js').IMConversation): tl.TypeChat {
    const id = this._peerId(conversation.id)
    if (this._isVirtualConversation(conversation)) {
      return {
        _: 'chat', creator: true, id, title: conversation.title,
        photo: conversation.avatar ? this._makeAvatarPhoto(conversation.avatar, 'chat') : { _: 'chatPhotoEmpty' },
        participantsCount: 1, date: 0, version: 1,
      }
    }
    const broadcast = conversation.metadata?.broadcast === true
    return {
      _: 'channel', creator: true, id, accessHash: Long.ONE, title: conversation.title,
      broadcast: broadcast || undefined, megagroup: !broadcast || undefined,
      forum: !broadcast && (
        this._subchannels(conversation.id).length > 0
        || conversation.metadata?.hasSubchannels === true
      ) || undefined,
      photo: conversation.avatar ? this._makeAvatarPhoto(conversation.avatar, 'chat') : { _: 'chatPhotoEmpty' }, date: 0,
      participantsCount: Number(conversation.metadata?.participantsCount ?? 0),
    }
  }

  private _makeAvatarPhoto(media: IMMedia<any>, kind: 'user'): tl.RawUserProfilePhoto
  private _makeAvatarPhoto(media: IMMedia<any>, kind: 'chat'): tl.RawChatPhoto
  private _makeAvatarPhoto(media: IMMedia<any>, kind: 'user' | 'chat'): tl.RawUserProfilePhoto | tl.RawChatPhoto {
    const photoId = Long.fromNumber(stableId(`avatar:${media.id}`))
    this._avatarMedia.set(photoId.toString(), media)
    return kind === 'user'
      ? { _: 'userProfilePhoto', photoId, dcId: this._dcId }
      : { _: 'chatPhoto', photoId, dcId: this._dcId }
  }

  private _isSubchannel(conversation: import('./platform.js').IMConversation): boolean {
    return conversation.kind === 'channel'
      && !!conversation.parentId
      && this._conversations.get(conversation.parentId)?.kind === 'channel'
  }

  private _isTelegramChannel(conversation: import('./platform.js').IMConversation): boolean {
    return !this._isVirtualConversation(conversation)
      && (conversation.kind === 'channel' || conversation.kind === 'group')
  }

  private _isVirtualConversation(conversation: import('./platform.js').IMConversation): boolean {
    return conversation.metadata?.virtual === true
  }

  private _subchannels(parentId: string): import('./platform.js').IMConversation[] {
    return [...this._conversations.values()]
      .filter((conversation) => conversation.kind === 'channel' && conversation.parentId === parentId)
      .sort((left, right) => left.title.localeCompare(right.title))
  }

  private async _ensureTopics(parentId: string): Promise<void> {
    const parent = this._conversation(parentId)
    for (const child of this._subchannels(parentId)) await this._materializeTopic(parent, child)
  }

  private async _materializeTopic(
    parent: import('./platform.js').IMConversation,
    child: import('./platform.js').IMConversation,
  ): Promise<{ topic: tl.RawForumTopic, top: MaterializedMessage }> {
    const stored = await this._storedTopicSeed(child.id)
    const history = stored.length ? stored : await this._loadHistory(child.id, { limit: 100 })
    const top = history[0]
    const oldest = history.at(-1)
    if (!top || !oldest) throw new RpcError(500, 'FORUM_TOPIC_EMPTY')
    const topicId = await this._store?.getOldestTlMessageId(this._session.platformSessionId, child.id)
      ?? oldest.tlId
    this._topicToConversation.set(topicId, child.id)
    this._conversationToTopic.set(child.id, topicId)
    return {
      top,
      topic: {
        _: 'forumTopic', id: topicId, date: oldest.source.timestamp,
        peer: { _: 'peerChannel', channelId: this._peerId(parent.id) },
        title: child.title, iconColor: 0x6fb9f0, topMessage: top.tlId,
        readInboxMaxId: top.tlId, readOutboxMaxId: top.tlId,
        unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0,
        fromId: { _: 'peerUser', userId: this._userId(oldest.source.senderId) },
        notifySettings: { _: 'peerNotifySettings' },
        draft: (await this._drafts?.get(
          this._session.platformSessionId, child.id, topicId,
        ))?.draft,
      },
    }
  }

  private async _storedTopicSeed(conversationId: string): Promise<MaterializedMessage[]> {
    const cached = this._historyCache.get(conversationId)
    if (cached?.length) return cached
    if (!this._store) return []
    const projected = await this._store.readProjectedHistory(
      this._session.platformSessionId, conversationId, { limit: 1 },
    )
    const history = projected.flatMap(({ source, parts, media }) => parts.map((part): MaterializedMessage => ({
      source,
      tlId: part.tlMessageId,
      ordinal: part.ordinal,
      groupedId: part.groupedId ?? undefined,
      media: media.find((entry) => entry.id === part.mediaId),
    }))).sort((left, right) => right.source.timestamp - left.source.timestamp || right.tlId - left.tlId)
    for (const item of history) this._rememberMessage(item)
    if (history.length) this._historyCache.set(conversationId, history)
    return history
  }

  private _topicReplyHeader(
    conversation: import('./platform.js').IMConversation,
    messageId: number,
  ): tl.RawMessageReplyHeader | undefined {
    if (!this._isSubchannel(conversation)) return
    const topicId = this._conversationToTopic.get(conversation.id)
    if (!topicId || topicId === messageId) return
    return {
      _: 'messageReplyHeader', forumTopic: true,
      replyToMsgId: topicId, replyToTopId: topicId,
    }
  }

  private _peerId(peerId: string): number {
    const existing = this._peerToTl.get(peerId)
    if (existing !== undefined) return existing
    const id = this._allocate(`peer:${peerId}`, this._tlToPeer)
    this._peerToTl.set(peerId, id)
    this._tlToPeer.set(id, peerId)
    return id
  }

  private _messageId(peerId: string, messageId: string): number {
    const key = `${peerId}\u0000${messageId}`
    const existing = this._messageToTl.get(key)
    if (existing !== undefined) return existing
    while (this._tlToMessage.has(this._nextMessageId)) this._nextMessageId++
    if (this._nextMessageId > 0x7fffffff) throw new RpcError(500, 'MESSAGE_ID_EXHAUSTED')
    const id = this._nextMessageId++
    this._messageToTl.set(key, id)
    this._tlToMessage.set(id, { peerId, platformMessageId: messageId, ordinal: 0 })
    return id
  }

  private _allocate(seed: string, occupied: Map<number, unknown>): number {
    let candidate = stableId(seed)
    while (candidate === this._selfId || occupied.has(candidate)) {
      candidate = candidate === 0x7fffffff ? 1 : candidate + 1
    }
    return candidate
  }

  private _requireHistory<T extends Function>(method: T | undefined): T {
    if (!this._platform.capabilities.history || !method) throw new RpcError(400, 'HISTORY_UNAVAILABLE')
    return method
  }

  private async _markRead(displayConversationId: string, tlMessageId: number): Promise<void> {
    if (!this._platform.capabilities.readState?.markRead || !this._platform.markRead || tlMessageId <= 0) return
    const projected = this._store
      ? await this._store.findProjectedByTlId(this._session.platformSessionId, tlMessageId)
      : undefined
    const ref = projected?.source ?? (() => {
      const known = this._tlToMessage.get(tlMessageId)
      if (!known) return
      return { id: known.platformMessageId, conversationId: known.peerId }
    })()
    if (!ref) return
    const target = this._conversation(ref.conversationId)
    if (target.id !== displayConversationId && target.parentId !== displayConversationId) return
    await this._platform.markRead(this._session, {
      conversationId: target.id,
      messageId: ref.id,
    })
    const cached = this._dialogCache.get(target.id)
    if (cached) {
      this._dialogCache.set(target.id, {
        ...cached,
        unreadCount: 0,
        readInboxMaxMessage: projected?.source,
      })
    }
  }
}

function makeAdminRights(permissions?: IMConversationPermissions): tl.RawChatAdminRights {
  return {
    _: 'chatAdminRights',
    changeInfo: permissions?.manageConversation ?? true,
    postMessages: permissions?.manageConversation ?? true,
    editMessages: permissions?.editAnyMessage ?? true,
    deleteMessages: permissions?.deleteAnyMessage ?? true,
    banUsers: permissions?.manageMembers ?? true,
    inviteUsers: permissions?.inviteMembers ?? true,
    pinMessages: permissions?.pinMessages ?? true,
    addAdmins: permissions?.manageMembers ?? true,
    manageCall: permissions?.manageConversation ?? true,
    manageTopics: permissions?.manageConversation ?? true,
    other: permissions?.manageConversation ?? true,
  }
}

function clampLimit(limit: number): number {
  return Math.max(0, Math.min(Math.trunc(limit), 100))
}

function matchesMessageFilter(item: MaterializedMessage, filter: tl.TypeMessagesFilter): boolean {
  if (filter._ === 'inputMessagesFilterEmpty') return true
  if (filter._ === 'inputMessagesFilterPhotos' || filter._ === 'inputMessagesFilterPhotoVideo') {
    return item.media?.kind === 'image'
  }
  if (filter._ === 'inputMessagesFilterDocument') return item.media?.kind === 'file'
  return false
}

function searchMediaKind(filter: tl.TypeMessagesFilter): 'image' | 'file' | undefined {
  if (filter._ === 'inputMessagesFilterPhotos' || filter._ === 'inputMessagesFilterPhotoVideo') return 'image'
  if (filter._ === 'inputMessagesFilterDocument') return 'file'
  return undefined
}

/** Stable positive signed-int ID used for synthetic Telegram entities. */
export function stableId(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 0x7ffffffe + 1
}

/** Builds a self-contained Telegram preview without asking Telegram to scrape QQ URLs. */
export function makeTlCardPreview(
  card: import('./platform.js').IMMessageCard,
  dcId = 1,
): tl.RawMessageMediaWebPage {
  const url = cardUrl(card) ?? 'https://im.qq.com/'
  let displayUrl = card.source || card.title
  try {
    displayUrl = new URL(url).hostname || displayUrl
  } catch {
    // The fallback above is always valid; keep a useful display label if a
    // future adapter supplies a non-standard URL.
  }
  return {
    _: 'messageMediaWebPage', manual: true, safe: true,
    webpage: {
      _: 'webPage',
      id: Long.fromNumber(stableId(`card-preview:${JSON.stringify(card)}`)),
      url, displayUrl, hash: 0,
      type: card.kind === 'mini-app' ? 'app' : card.kind === 'music' ? 'audio' : 'article',
      siteName: card.source || (card.kind === 'mini-app' ? 'QQ 小程序' : 'QQ'),
      title: card.title,
      description: card.description,
      photo: makeCardThumbnailPhoto(card.thumbnailUrl, dcId),
    },
  }
}

/** Builds the native Telegram WebPage card used by virtual merged-forward chats. */
export function makeTlConversationPreview(
  conversation: IMConversation,
  url: string,
): tl.RawMessageMediaWebPage {
  const preview = conversation.metadata?.qqMultiForwardPreview
  return {
    _: 'messageMediaWebPage', manual: true, safe: true,
    webpage: {
      _: 'webPage',
      id: Long.fromNumber(stableId(`conversation-preview:${conversation.id}`)),
      url, displayUrl: conversation.title, hash: 0,
      type: 'telegram_message',
      title: conversation.title,
      description: typeof preview === 'string' && preview.trim()
        ? preview.trim()
        : '点击查看合并转发消息',
    },
  }
}

export function projectTlMessage(options: {
  conversation: IMConversation
  source: IMMessage
  tlId: number
  ordinal: number
  groupedId?: string
  fromId: tl.TypePeer
  peerId?: tl.TypePeer
  media?: tl.TypeMessageMedia
  entities?: tl.TypeMessageEntity[]
  reactions?: tl.RawMessageReactions
  replyToTlId?: number
  topicId?: number
}): tl.TypeMessage {
  const {
    conversation, source, tlId, ordinal,
    groupedId, fromId, peerId, media, entities, reactions, replyToTlId, topicId,
  } = options
  const conversationId = stableId(`peer:${conversation.id}`)
  if (ordinal === 0 && source.content.serviceAction) {
    return {
      _: 'messageService', out: source.outgoing || undefined, id: tlId,
      fromId,
      peerId: peerId ?? (conversation.kind === 'direct'
        ? { _: 'peerUser', userId: conversationId }
        : { _: 'peerChannel', channelId: conversationId }),
      replyTo: replyToTlId ? {
        _: 'messageReplyHeader', replyToMsgId: replyToTlId,
      } : topicId && topicId !== tlId ? {
        _: 'messageReplyHeader', forumTopic: true, replyToMsgId: topicId, replyToTopId: topicId,
      } : undefined,
      date: source.timestamp,
      action: { _: 'messageActionCustomAction', message: source.content.serviceAction.text },
    } as tl.RawMessageService
  }
  const text = ordinal === 0 ? messageText(source) : ''
  return {
    _: 'message', out: source.outgoing || undefined, id: tlId,
    fromId,
    peerId: peerId ?? (conversation.kind === 'direct'
      ? { _: 'peerUser', userId: conversationId }
      : { _: 'peerChannel', channelId: conversationId }),
    replyTo: replyToTlId ? {
      _: 'messageReplyHeader', replyToMsgId: replyToTlId,
    } : topicId && topicId !== tlId ? {
      _: 'messageReplyHeader', forumTopic: true, replyToMsgId: topicId, replyToTopId: topicId,
    } : undefined,
    date: source.timestamp,
    message: text,
    entities: ordinal === 0 ? withAutoLinkEntities(text, entities) : undefined,
    media,
    groupedId: groupedId ? Long.fromString(groupedId) : undefined,
    reactions,
  } as tl.RawMessage
}

function uniqueUsers(users: tl.RawUser[]): tl.RawUser[] {
  return [...new Map(users.map((user) => [user.id, user])).values()]
}

function uniqueChats(chats: tl.TypeChat[]): tl.TypeChat[] {
  return [...new Map(chats.map((chat) => [chat.id, chat])).values()]
}

function inputPeerId(peer: tl.TypeInputPeer): number {
  if (peer._ === 'inputPeerUser') return peer.userId
  if (peer._ === 'inputPeerChat') return peer.chatId
  if (peer._ === 'inputPeerChannel') return peer.channelId
  return 0
}

function hasDraftContent(request: tl.messages.RawSaveDraftRequest): boolean {
  if (request.message.length || request.media || request.suggestedPost || request.richMessage) return true
  if (request.effect && !request.effect.isZero()) return true
  if (request.replyTo?._ === 'inputReplyToStory') return true
  if (request.replyTo?._ === 'inputReplyToMessage' && request.replyTo.replyToMsgId > 0) return true
  return false
}

function profileMilliseconds(value: number): number {
  return Math.round(value * 100) / 100
}

function historyWindowKey(request: HistoryWindow): string {
  return JSON.stringify([
    request.offsetId ?? 0,
    request.offsetDate ?? 0,
    request.addOffset ?? 0,
    request.limit,
    request.maxId ?? 0,
    request.minId ?? 0,
  ])
}

export function makeTlMessageMedia(media: IMMediaRow, timestamp: number, dcId = 1): tl.TypeMessageMedia {
  const id = Long.fromNumber(media.id)
  // Real Telegram media always carries a non-zero access hash. The bridge
  // resolves downloads from its durable media row, so this synthetic hash is
  // only for clients (notably Desktop) that disable the download action when
  // access_hash is zero.
  const accessHash = Long.fromNumber(media.id)
  const fileReference = new TextEncoder().encode(`bridge-media:${media.id}`)
  if (media.kind === 'image') {
    const preview = media.preview
    return {
      _: 'messageMediaPhoto',
      photo: {
        _: 'photo', id, accessHash, fileReference, date: timestamp,
        sizes: [
          ...(media.strippedThumbnail?.byteLength ? [{
            _: 'photoStrippedSize' as const, type: 'i', bytes: new Uint8Array(media.strippedThumbnail),
          }] : []),
          ...(preview ? [{
            _: 'photoSize' as const, type: 'm', w: preview.width, h: preview.height,
            size: Math.min(preview.size, 0x7fffffff),
          }] : []),
          {
            _: 'photoSize', type: 'x', w: media.width ?? 1, h: media.height ?? 1,
            size: Math.min(media.size ?? 0, 0x7fffffff),
          },
        ],
        dcId,
      },
    }
  }
  const attributes: tl.TypeDocumentAttribute[] = [
    { _: 'documentAttributeFilename', fileName: media.name ?? 'file' },
  ]
  if (media.mimeType?.startsWith('video/')) attributes.push({
    _: 'documentAttributeVideo',
    nosound: media.mimeType === 'video/webm' ? true : undefined,
    supportsStreaming: true,
    duration: media.duration ?? 0, w: media.width ?? 1, h: media.height ?? 1,
  })
  return {
    _: 'messageMediaDocument',
    document: {
      _: 'document', id, accessHash, fileReference, date: timestamp,
      mimeType: media.mimeType ?? 'application/octet-stream', size: media.size ?? 0, dcId,
      thumbs: media.strippedThumbnail?.byteLength || media.preview ? [
        ...(media.strippedThumbnail?.byteLength ? [{
          _: 'photoStrippedSize' as const, type: 'i', bytes: new Uint8Array(media.strippedThumbnail),
        }] : []),
        ...(media.preview ? [{
          _: 'photoSize' as const, type: 'm', w: media.preview.width, h: media.preview.height,
          size: Math.min(media.preview.size, 0x7fffffff),
        }] : []),
      ] : undefined,
      attributes,
    },
  }
}

function previewMedia(media: IMMedia<any>): IMMedia<any> {
  const preview = media.preview!
  return {
    id: `${media.id}:preview`, kind: 'image', mimeType: preview.mimeType,
    size: preview.size, width: preview.width, height: preview.height, locator: preview.locator,
  }
}

function makeStagedMessageMedia(staged: StagedMedia, dcId: number): tl.TypeMessageMedia {
  const id = Long.fromString(staged.upload.fileId)
  const accessHash = id
  const fileReference = new TextEncoder().encode(`bridge-staged:${staged.upload.fileId}`)
  if (staged.media.kind === 'image') {
    return {
      _: 'messageMediaPhoto',
      photo: {
        _: 'photo', id, accessHash, fileReference, date: staged.timestamp,
        sizes: [{
          _: 'photoSize', type: 'x', w: staged.media.width ?? 1, h: staged.media.height ?? 1,
          size: Math.min(staged.media.size ?? staged.upload.source.size ?? 0, 0x7fffffff),
        }],
        dcId,
      },
    }
  }
  return {
    _: 'messageMediaDocument',
    document: {
      _: 'document', id, accessHash, fileReference, date: staged.timestamp,
      mimeType: staged.media.mimeType ?? 'application/octet-stream',
      size: staged.media.size ?? staged.upload.source.size ?? 0,
      dcId,
      attributes: documentAttributes(staged.media),
    },
  }
}

function documentAttributes(media: Pick<IMMedia<any>, 'name' | 'mimeType' | 'width' | 'height' | 'duration'>): tl.TypeDocumentAttribute[] {
  const attributes: tl.TypeDocumentAttribute[] = [
    { _: 'documentAttributeFilename', fileName: media.name ?? 'file' },
  ]
  if (media.mimeType?.startsWith('video/')) attributes.push({
    _: 'documentAttributeVideo',
    nosound: media.mimeType === 'video/webm' ? true : undefined,
    supportsStreaming: true,
    duration: media.duration ?? 0, w: media.width ?? 1, h: media.height ?? 1,
  })
  return attributes
}

function qqSequenceKey(conversationId: string, sequence: number): string {
  return `${conversationId}\u0000qq-sequence:${sequence}`
}

function safeOffset(value: unknown): number {
  const offset = typeof value === 'number'
    ? value
    : value && typeof value === 'object' && 'toNumber' in value
      ? (value as { toNumber(): number }).toNumber()
      : Number(value)
  if (!Number.isSafeInteger(offset)) throw new RpcError(400, 'OFFSET_INVALID')
  return offset
}

async function readSourceRange(
  source: import('./platform.js').IMMediaSource,
  offset: number,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let skipped = 0
  let size = 0
  for await (const chunk of source.stream()) {
    if (skipped + chunk.length <= offset) {
      skipped += chunk.length
      continue
    }
    const start = Math.max(0, offset - skipped)
    const remaining = limit - size
    if (remaining <= 0) break
    const accepted = chunk.subarray(start, start + remaining)
    chunks.push(accepted)
    size += accepted.length
    skipped += chunk.length
  }
  const result = new Uint8Array(size)
  let position = 0
  for (const chunk of chunks) {
    result.set(chunk, position)
    position += chunk.length
  }
  return result
}

function inferImageMime(name: string): string {
  const extension = name.toLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'image/jpeg'
}
