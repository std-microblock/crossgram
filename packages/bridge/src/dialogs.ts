import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import {
  messageText, type IMConversationMember, type IMConversationPermissions, type IMDialog, type IMMedia, type IMMediaInput,
  type IMMessage, type IMMessageInput, type IMPlatform, type IMTransferProgress, type IMUser,
  type PlatformSession,
} from './platform.js'
import {
  MessageActionUnavailableError, PlatformMessageActions, messageRuleAllows,
} from './message-actions.js'
import { makeUser } from './synthetic.js'
import type { MessageStore } from './message-store.js'
import { PlatformDataService } from './platform-manager.js'
import type { IMMediaRow } from './models.js'
import type { StagedMedia, UploadedFile, UploadManager } from './upload-manager.js'
import type { StickerRpc } from './sticker-rpc.js'
import type { ReactionRpc } from './reaction-rpc.js'
import type { TelegramResourceService } from './resource-provider.js'

type GetDialogsRequest = tl.messages.RawGetDialogsRequest
type GetHistoryRequest = tl.messages.RawGetHistoryRequest
type GetMessagesRequest = tl.messages.RawGetMessagesRequest
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

/**
 * Per-authorized-session bridge for dialog/history RPCs. Telegram's numeric
 * peer/message IDs are allocated here and reverse-mapped to opaque platform IDs.
 */
export class DialogRpc {
  private readonly _peerToTl = new Map<string, number>()
  private readonly _tlToPeer = new Map<number, string>()
  private readonly _messageToTl = new Map<string, number>()
  private readonly _tlToMessage = new Map<number, MessageRef>()
  private _nextMessageId = 1
  private _pts = 1
  private readonly _sentByRandomId = new Map<string, Promise<tl.RawUpdateShortSentMessage>>()
  private readonly _sentMediaByRandomId = new Map<string, Promise<tl.TypeUpdates>>()
  private readonly _selfId: number
  private readonly _data?: PlatformDataService
  private readonly _store?: MessageStore
  private readonly _historyCache = new Map<string, MaterializedMessage[]>()
  private readonly _conversations = new Map<string, import('./platform.js').IMConversation>()
  private readonly _topicToConversation = new Map<number, string>()
  private readonly _conversationToTopic = new Map<string, number>()
  private readonly _avatarMedia = new Map<string, IMMedia<any>>()
  private readonly _memberCursors = new Map<string, Map<number, string | null>>()
  private readonly _actions: PlatformMessageActions

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
  ) {
    this._actions = new PlatformMessageActions(_platform, _session)
    this._selfId = this._allocate(`self:${_session.platformSessionId}`, new Map())
    if (store) {
      this._store = store
      this._data = new PlatformDataService(_platform, _session, store)
    }
  }

  async getDialogs(req: GetDialogsRequest): Promise<tl.messages.TypeDialogs> {
    const requestedOffsetPeer = req.offsetPeer._ === 'inputPeerUser'
      ? this._tlToPeer.get(req.offsetPeer.userId)
      : undefined
    const all = (await this._loadDialogs({
      limit: clampLimit(req.limit) + 1,
      afterId: requestedOffsetPeer,
    }))
      .slice()
      .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0))

    // PlatformDataService has already persisted any previews exposed by
    // getDialogs. Never fan a stored dialog-list request out into upstream
    // history calls, including for rows whose platform preview is temporarily
    // absent during cold start. The no-store path still allocates Telegram IDs
    // oldest-first from history.
    if (!this._store) await Promise.all(all.map((dialog) => this._loadHistory(dialog.conversation.id)))
    const materialized = await Promise.all(all.map((dialog) => this._materializeDialog(dialog)))
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
    const result = {
      _: start > 0 || page.length < all.length ? 'messages.dialogsSlice' : 'messages.dialogs',
      ...(start > 0 || page.length < all.length ? { count: all.length } : {}),
      dialogs: page.map((item) => item.dialog),
      messages: page.flatMap((item) => item.message ? [item.message] : []),
      chats: uniqueChats(page.flatMap((item) => item.chat ? [item.chat] : [])),
      users: uniqueUsers(page.flatMap((item) => item.users)),
    }
    return result as unknown as tl.messages.TypeDialogs
  }

  async getHistory(req: GetHistoryRequest): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const all = await this._loadHistory(peerId, req)
    const filtered = all.filter((item) => {
      if (req.offsetId > 0 && item.tlId >= req.offsetId) return false
      if (req.offsetDate > 0 && item.source.timestamp >= req.offsetDate) return false
      if (req.maxId > 0 && item.tlId >= req.maxId) return false
      if (req.minId > 0 && item.tlId <= req.minId) return false
      return true
    })
    const start = Math.max(0, req.addOffset)
    const page = filtered.slice(start, start + clampLimit(req.limit))
    const conversation = this._conversation(peerId)
    const senders = await this._messageSenders(page.map((item) => item.source))
    const peerUser = conversation.kind === 'direct'
      ? [await this._getPeerUser(peerId, conversation.title)]
      : []
    return {
      _: page.length < filtered.length || start > 0 ? 'messages.messagesSlice' : 'messages.messages',
      ...(page.length < filtered.length || start > 0 ? { count: filtered.length } : {}),
      messages: page.map((item) => this._makeMessage(item)),
      topics: [],
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      users: uniqueUsers([...peerUser, ...senders, this._makeSelfUser()]),
    } as unknown as tl.messages.TypeMessages
  }

  async search(req: tl.messages.RawSearchRequest): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const conversation = this._conversation(peerId)
    if (req.filter._ === 'inputMessagesFilterPinned') return this._emptyMessages(conversation)
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
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      users: uniqueUsers([...users, this._makeSelfUser()]),
    } as unknown as tl.messages.TypeMessages
  }

  async readHistory(req: tl.messages.RawReadHistoryRequest): Promise<tl.messages.RawAffectedMessages> {
    await this._hydratePeers()
    this._resolvePeer(req.peer)
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
    const users = new Map<number, tl.RawUser>()
    const messages: tl.TypeMessage[] = []

    for (const input of req.id) {
      const requestedId = input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
      let ref = this._tlToMessage.get(requestedId)
      if (!ref && this._store) {
        const projected = await this._store.findProjectedByTlId(this._session.platformSessionId, requestedId)
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
        : await this._loadHistory(ref.peerId, { limit: 1 })
      const found = history.find((item) => item.tlId === requestedId)
      if (!found) {
        messages.push({ _: 'messageEmpty', id: requestedId } as tl.RawMessageEmpty)
        continue
      }
      messages.push(this._makeMessage(found))
      const sender = await this._getMessageSender(found.source)
      users.set(sender.id, sender)
    }

    const self = this._makeSelfUser()
    users.set(self.id, self)
    return {
      _: 'messages.messages', messages, topics: [], chats: [], users: [...users.values()],
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
    const platformUsers: IMUser<any>[] = []
    if (this._platform.getContacts) {
      let cursor: string | undefined
      do {
        const page = await this._platform.getContacts(this._session, { cursor, limit: 500 })
        platformUsers.push(...page.users)
        cursor = page.nextCursor
      } while (cursor && platformUsers.length < 100_000)
    }
    const users = platformUsers.length
      ? platformUsers
        .sort((left, right) => left.firstName.localeCompare(right.firstName))
        .map((user) => {
          this._conversations.set(user.id, { id: user.id, kind: 'direct', title: user.firstName })
          return this._makePeerUser(user)
        })
      : await Promise.all((await this._loadDialogs({ limit: 500 }))
        .filter((dialog) => dialog.conversation.kind === 'direct')
        .sort((left, right) => left.conversation.title.localeCompare(right.conversation.title))
        .map((dialog) => this._getPeerUser(dialog.conversation.id, dialog.conversation.title)))
    return {
      _: 'contacts.contacts',
      contacts: users.map((user) => ({ _: 'contact', userId: user.id, mutual: true })),
      savedCount: users.length,
      users: uniqueUsers(users),
    }
  }

  async getUsers(req: tl.users.RawGetUsersRequest): Promise<tl.TypeUser[]> {
    await this._hydratePeers()
    return Promise.all(req.id.map((input) => this._getInputUser(input)))
  }

  async getFullUser(req: tl.users.RawGetFullUserRequest): Promise<tl.users.RawUserFull> {
    await this._hydratePeers()
    const user = await this._getInputUser(req.id)
    return {
      _: 'users.userFull',
      fullUser: {
        _: 'userFull',
        id: user.id,
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
    const peerId = this._tlToPeer.get(req.chatId)
    const conversation = peerId ? this._conversation(peerId) : undefined
    if (!conversation || !this._isTelegramGroup(conversation)) throw new RpcError(400, 'CHAT_ID_INVALID')
    const members = await this._allMembers(conversation.id)
    const participantUsers = members.map((member) => this._makeMemberUser(member))
    const reactionContext = await this._platform.getAvailableReactions?.(
      this._session, { conversationId: conversation.id },
    )
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: req.chatId, about: '',
        participants: {
          _: 'chatParticipants', chatId: req.chatId,
          participants: members.map((member): tl.TypeChatParticipant => {
            const userId = member.user.id === this._session.userId ? this._selfId : this._peerId(member.user.id)
            if (member.role === 'owner') return { _: 'chatParticipantCreator', userId }
            if (member.role === 'administrator') {
              return {
                _: 'chatParticipantAdmin', userId, inviterId: this._selfId,
                date: member.joinedAt ?? 0, rank: member.title,
              }
            }
            return {
              _: 'chatParticipant', userId, inviterId: this._selfId, date: member.joinedAt ?? 0,
            }
          }), version: 1,
        },
        notifySettings: { _: 'peerNotifySettings' },
        availableReactions: this._reactions?.chatReactions(conversation.id, reactionContext),
      },
      chats: [this._makeChat(conversation)], users: uniqueUsers([this._makeSelfUser(), ...participantUsers]),
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

  async getForumTopics(
    req: tl.messages.RawGetForumTopicsRequest | tl.messages.RawGetForumTopicsByIDRequest,
  ): Promise<tl.messages.RawForumTopics> {
    await this._hydratePeers()
    const parentId = this._resolvePeer(req.peer)
    const parent = this._conversation(parentId)
    if (parent.kind !== 'channel') throw new RpcError(400, 'CHANNEL_FORUM_MISSING')
    const children = this._subchannels(parentId)
    await this._ensureTopics(parentId)
    const selected = req._ === 'messages.getForumTopicsByID'
      ? children.filter((child) => req.topics.includes(this._conversationToTopic.get(child.id) ?? -1))
      : children.filter((child) => !req.q || child.title.toLowerCase().includes(req.q.toLowerCase()))
    const materialized = await Promise.all(selected.map((child) => this._materializeTopic(parent, child)))
    const offset = req._ === 'messages.getForumTopics'
      ? Math.max(0, materialized.findIndex((item) => item.topic.id === req.offsetTopic) + 1)
      : 0
    const limit = req._ === 'messages.getForumTopics' ? clampLimit(req.limit) : materialized.length
    const page = materialized.slice(offset, offset + limit)
    const users = await this._messageSenders(page.map((item) => item.top.source))
    return {
      _: 'messages.forumTopics', count: materialized.length,
      topics: page.map((item) => item.topic),
      messages: page.map((item) => this._makeMessage(item.top)),
      chats: [this._makeChat(parent)], users: uniqueUsers([...users, this._makeSelfUser()]), pts: this._pts,
    }
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
    let members = await this._allMembers(conversation.id)
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
    const total = members.length
    members = members.slice(offset, offset + limit)
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

    const pending = this._sendMessage(req)
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
      if (req.message) parts.push({ type: 'text', text: req.message })
      if ('sticker' in resolved) {
        parts.push({ type: 'sticker', sticker: resolved.sticker })
        const updates = await this._sendRichContent(req.peer, { parts }, [], [req.randomId], req.replyTo)
        await this._stickers?.markUsedByRef(resolved.providerId, resolved.stickerId)
        return updates
      }
      parts.push({ type: 'media', media: resolved.media })
      return this._sendRichContent(req.peer, { parts }, [resolved.upload], [req.randomId], req.replyTo)
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
      if (captions.length) parts.push({ type: 'text', text: captions.join('\n') })
      for (const item of mediaResolved) parts.push({ type: 'media', media: item.media })
      return this._sendRichContent(
        req.peer,
        { parts },
        mediaResolved.map((item) => item.upload),
        req.multiMedia.map((item) => item.randomId),
        req.replyTo,
      )
    })
  }

  async deleteMessages(
    req: tl.messages.RawDeleteMessagesRequest | tl.channels.RawDeleteMessagesRequest,
    channel?: tl.TypeInputChannel,
  ): Promise<tl.messages.RawAffectedMessages> {
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    await this._hydratePeers()
    const expectedConversation = channel ? this._resolveChannel(channel).id : undefined
    const grouped = new Map<string, Array<{
      source: IMMessage<any>
      targetId: string
    }>>()
    for (const tlId of req.id) {
      const projected = await this._store.findProjectedByTlId(
        this._session.platformSessionId, tlId, expectedConversation,
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
    const pts = await this._reservePts(ptsCount, Math.floor(Date.now() / 1000))
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
    let pts = await this._reservePts(ptsCount, now) - ptsCount
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
    let pts = await this._reservePts(projections.length, Math.floor(Date.now() / 1000)) - projections.length
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
          _: 'upload.file', type: { _: 'storage.fileWebp' },
          mtime: Math.floor(Date.now() / 1000), bytes: reaction,
        }
      }
      const sticker = await this._stickers?.getFile(req.location.id.toNumber(), offset, req.limit)
      if (sticker) {
        return {
          _: 'upload.file', type: { _: 'storage.fileUnknown' },
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
    return {
      _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: stored.timestamp,
      bytes: await this._downloadMediaRange(stored.media, offset, req.limit),
    }
  }

  private async _resolveAvatarMedia(peer: tl.TypeInputPeer, photoId: Long): Promise<IMMedia<any> | undefined> {
    await this._hydratePeers()
    let media: IMMedia<any> | undefined
    if (peer._ === 'inputPeerSelf') {
      media = (await this._platform.getUser?.(this._session, this._session.userId))?.avatar
    } else if (peer._ === 'inputPeerUser') {
      const userId = this._tlToPeer.get(peer.userId)
      if (userId) media = (await this._platform.getUser?.(this._session, userId))?.avatar
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

  getTopReactions(limit: number): tl.messages.RawReactions {
    return this._reactions?.topReactions(limit)
      ?? { _: 'messages.reactions', hash: Long.ZERO, reactions: [] }
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
    const updated = await this._platform.setMessageReactions(
      this._session, target, selected.map((item) => item.key),
    )
    const conversation = this._conversation(peerId)
    const result = await this._store!.setReactions(this._session, conversation, target, updated)
    const pts = await this._reservePts(1, Math.floor(Date.now() / 1000))
    const update: tl.RawUpdateMessageReactions = {
      _: 'updateMessageReactions',
      peer: this._conversationPeer(conversation),
      msgId: req.msgId,
      reactions: this._reactions!.messageReactions(peerId, result.message),
    }
    return {
      _: 'updates', updates: [update],
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
        msgId: id, reactions: this._reactions!.messageReactions(peerId, projected.source),
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
    const context = projected.source.reactionContext
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
      count: actors.length,
      reactions: actors.map(({ summary, actor }) => ({
        _: 'messagePeerReaction',
        peerId: { _: 'peerUser', userId: this._peerId(actor.userId) },
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

  private async _sendMessage(req: SendMessageRequest): Promise<tl.RawUpdateShortSentMessage> {
    if (!this._platform.capabilities.send.text) throw new RpcError(400, 'MESSAGE_SEND_UNAVAILABLE')
    if (!req.message.length) throw new RpcError(400, 'MESSAGE_EMPTY')
    if (Array.from(req.message).length > this._platform.capabilities.send.maxTextLength) {
      throw new RpcError(400, 'MESSAGE_TOO_LONG')
    }
    if (req.scheduleDate !== undefined) throw new RpcError(400, 'SCHEDULED_MESSAGES_UNAVAILABLE')

    await this._hydratePeers()
    const peerId = this._resolveMessageTarget(req.peer, req.replyTo)
    const sent = await this._platform.sendMessage(
      this._session,
      { id: peerId },
      { parts: [{ type: 'text', text: req.message }] },
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
    return {
      media: {
        kind,
        name: attribute?._ === 'documentAttributeFilename' ? attribute.fileName : file.name,
        mimeType: media._ === 'inputMediaUploadedDocument' ? media.mimeType : inferImageMime(file.name),
        size: upload.source.size,
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
    const sent = await this._platform.sendMessage(this._session, { id: peerId }, content, {
      onProgress: (progress) => this._onTransferProgress?.(this._session, progress),
    })
    const source: IMMessage = { ...sent, conversationId: peerId, outgoing: true }
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    const conversation = await this._store.getConversation(this._session.platformSessionId, peerId)
      ?? { id: peerId, kind: 'direct' as const, title: peerId }
    const persisted = await this._store.ingest(this._session, conversation, source)
    await Promise.all(uploads.map((upload) => this._uploads!.complete(upload)))

    const updates: tl.TypeUpdate[] = []
    let pts = await this._reservePts(persisted.projection.length, source.timestamp)
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

  private async _reservePts(count: number, date: number): Promise<number> {
    if (this._store) {
      return (await this._store.advancePts(this._session.platformSessionId, count, date)).pts
    }
    this._pts += count
    return this._pts
  }

  private async _materializeDialog(source: IMDialog) {
    const platformPeerId = source.conversation.id
    this._conversations.set(platformPeerId, source.conversation)
    const peer = this._conversationPeer(source.conversation)
    const users = source.conversation.kind === 'direct'
      ? [await this._getPeerUser(platformPeerId, source.conversation.title)]
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
    }
    return { source, dialog, message, users, chat }
  }

  private async _loadHistory(peerId: string, request: HistoryWindow = { limit: 1 }): Promise<MaterializedMessage[]> {
    if (this._data && this._store) {
      const anchorId = request.offsetId || request.maxId || undefined
      const anchor = anchorId
        ? await this._store.findProjectedByTlId(this._session.platformSessionId, anchorId, peerId)
        : undefined
      const fetchLimit = Math.max(1, Math.min(
        (request.limit ?? 1) + Math.max(0, request.addOffset ?? 0) + 1,
        200,
      ))
      await this._data.getHistory(peerId, {
        limit: fetchLimit,
        before: anchor ? { id: anchor.source.id, timestamp: anchor.source.timestamp } : undefined,
      })
      const projected = await this._store.readProjectedHistory(this._session.platformSessionId, peerId, {
        limit: fetchLimit,
        beforeTimestamp: request.offsetDate && request.offsetDate > 0 ? request.offsetDate : undefined,
        maxTimestamp: anchor?.source.timestamp,
      })
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
      this._historyCache.set(peerId, history)
      return history
    }

    const history = (await this._requireHistory(this._platform.getHistory).call(
      this._platform, this._session, { id: peerId }, { limit: request.limit },
    )).messages
    const materialized = history.slice().sort((a, b) => a.timestamp - b.timestamp).map((source) => {
      const item: MaterializedMessage = { source, tlId: this._messageId(peerId, source.id), ordinal: 0 }
      this._rememberMessage(item)
      return item
    }).sort((a, b) => b.source.timestamp - a.source.timestamp || b.tlId - a.tlId)
    this._historyCache.set(peerId, materialized)
    return materialized
  }

  private async _hydrateAllMessages(): Promise<void> {
    const dialogs = await this._loadDialogs()
    await Promise.all(dialogs.map((dialog) => this._loadHistory(dialog.conversation.id)))
  }

  private async _hydratePeers(): Promise<void> {
    const dialogs = await this._loadDialogs()
    for (const dialog of dialogs) {
      this._conversations.set(dialog.conversation.id, dialog.conversation)
      this._peerId(dialog.conversation.id)
    }
  }

  private async _loadDialogs(query: { limit?: number, afterId?: string } = { limit: 100 }): Promise<IMDialog[]> {
    const dialogs = this._data
      ? await this._data.getDialogs(query)
      : (await this._requireHistory(this._platform.getDialogs).call(this._platform, this._session, query)).dialogs
    for (const dialog of dialogs) this._conversations.set(dialog.conversation.id, dialog.conversation)
    return dialogs.filter((dialog) => !this._isSubchannel(dialog.conversation))
  }

  private async _getInputUser(input: tl.TypeInputUser): Promise<tl.TypeUser> {
    if (input._ === 'inputUserSelf') return this._makeSelfUser()
    if (input._ !== 'inputUser' && input._ !== 'inputUserFromMessage') {
      throw new RpcError(400, 'USER_ID_INVALID')
    }
    const peerId = this._tlToPeer.get(input.userId)
    if (!peerId) throw new RpcError(400, 'USER_ID_INVALID')
    if (this._conversations.get(peerId)?.kind !== 'direct') throw new RpcError(400, 'USER_ID_INVALID')
    return this._getPeerUser(peerId)
  }

  private _makeMessage(item: MaterializedMessage): tl.RawMessage {
    const { source, tlId } = item
    const conversation = this._conversation(source.conversationId)
    return {
      _: 'message',
      out: source.outgoing || undefined,
      id: tlId,
      fromId: { _: 'peerUser', userId: source.outgoing ? this._selfId : this._peerId(source.senderId) },
      peerId: this._conversationPeer(conversation),
      replyTo: this._topicReplyHeader(conversation, tlId),
      date: source.timestamp,
      message: item.ordinal === 0 ? messageText(source) : '',
      media: item.media
        ? makeTlMessageMedia(item.media, source.timestamp, this._dcId)
        : source.content.parts.find((part) => part.type === 'sticker')
          ? this._stickers?.makeMessageMedia(
              source.content.parts.find((part) => part.type === 'sticker')!.sticker,
            )
          : undefined,
      groupedId: item.groupedId ? Long.fromString(item.groupedId) : undefined,
      reactions: source.reactionContext?.reactions.length
        ? this._reactions?.messageReactions(source.conversationId, source)
        : undefined,
    } as tl.RawMessage
  }

  private _rememberMessage(item: MaterializedMessage): void {
    const key = `${item.source.conversationId}\u0000${item.source.id}\u0000${item.ordinal}`
    this._messageToTl.set(key, item.tlId)
    this._tlToMessage.set(item.tlId, {
      peerId: item.source.conversationId,
      platformMessageId: item.source.id,
      ordinal: item.ordinal,
    })
  }

  private _emptyMessages(conversation: import('./platform.js').IMConversation): tl.messages.RawMessages {
    return {
      _: 'messages.messages', messages: [], topics: [],
      chats: conversation.kind === 'direct' ? [] : [this._makeChat(conversation)],
      users: [this._makeSelfUser()],
    }
  }

  private async _getPeerUser(peerId: string, fallbackName?: string): Promise<tl.RawUser> {
    const user = await this._platform.getUser?.(this._session, peerId)
    return this._makePeerUser(user ?? { id: peerId, firstName: fallbackName ?? peerId })
  }

  private async _getMessageSender(message: IMMessage<any>): Promise<tl.RawUser> {
    if (message.senderId === this._session.userId) return this._makeSelfUser(message.sender?.avatar)
    return message.sender
      ? this._makePeerUser(message.sender)
      : this._getPeerUser(message.senderId)
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
    do {
      const page = await this._platform.getConversationMembers(
        this._session, { id: conversationId }, { cursor, limit: 100 },
      )
      members.push(...page.members)
      cursor = page.nextCursor
    } while (cursor && members.length < 10_000)
    for (const member of members) {
      if (member.user.id !== this._session.userId) this._peerId(member.user.id)
    }
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
    const userId = self ? this._selfId : this._peerId(member.user.id)
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
    return makeUser({
      id: this._peerId(user.id), firstName: user.firstName,
      lastName: user.lastName, username: user.username,
      contact: true, mutualContact: true,
      photo: user.avatar ? this._makeAvatarPhoto(user.avatar, 'user') : undefined,
    })
  }

  private _makeSelfUser(avatar?: IMMedia<any>): tl.RawUser {
    return makeUser({
      id: this._selfId,
      self: true,
      premium: true,
      firstName: String(this._session.metadata.firstName ?? 'Bridge'),
      lastName: this._session.metadata.lastName as string | undefined,
      username: this._session.metadata.username as string | undefined,
      photo: avatar ? this._makeAvatarPhoto(avatar, 'user') : undefined,
    })
  }

  private _resolvePeer(peer: tl.TypeInputPeer): string {
    if (peer._ !== 'inputPeerUser' && peer._ !== 'inputPeerChat' && peer._ !== 'inputPeerChannel') {
      throw new RpcError(400, 'PEER_ID_INVALID')
    }
    const id = this._tlToPeer.get(inputPeerId(peer))
    if (!id) throw new RpcError(400, 'PEER_ID_INVALID')
    const conversation = this._conversation(id)
    if (peer._ === 'inputPeerUser' && conversation.kind !== 'direct') throw new RpcError(400, 'PEER_ID_INVALID')
    if (peer._ === 'inputPeerChat' && !this._isTelegramGroup(conversation)) throw new RpcError(400, 'PEER_ID_INVALID')
    if (peer._ === 'inputPeerChannel' && !this._isTelegramChannel(conversation)) throw new RpcError(400, 'PEER_ID_INVALID')
    return id
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

  private _conversation(peerId: string): import('./platform.js').IMConversation {
    return this._conversations.get(peerId) ?? { id: peerId, kind: 'direct', title: peerId }
  }

  private _conversationPeer(conversation: import('./platform.js').IMConversation): tl.TypePeer {
    const target = this._isSubchannel(conversation)
      ? this._conversation(conversation.parentId!)
      : conversation
    const id = this._peerId(target.id)
    if (this._isTelegramChannel(target)) return { _: 'peerChannel', channelId: id }
    if (target.kind === 'group') return { _: 'peerChat', chatId: id }
    return { _: 'peerUser', userId: id }
  }

  private _makeChat(conversation: import('./platform.js').IMConversation): tl.TypeChat {
    const id = this._peerId(conversation.id)
    if (this._isTelegramGroup(conversation)) {
      return {
        _: 'chat', creator: true, id, title: conversation.title,
        photo: conversation.avatar ? this._makeAvatarPhoto(conversation.avatar, 'chat') : { _: 'chatPhotoEmpty' },
        participantsCount: Number(conversation.metadata?.participantsCount ?? 0), date: 0, version: 1,
      }
    }
    const broadcast = conversation.metadata?.broadcast === true
    return {
      _: 'channel', creator: true, id, accessHash: Long.ZERO, title: conversation.title,
      broadcast: broadcast || undefined, megagroup: !broadcast || undefined,
      forum: !broadcast && this._subchannels(conversation.id).length > 0 || undefined,
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
    return conversation.kind === 'channel'
      || conversation.kind === 'group' && this._platform.capabilities.members?.paginated === true
  }

  private _isTelegramGroup(conversation: import('./platform.js').IMConversation): boolean {
    return conversation.kind === 'group' && !this._isTelegramChannel(conversation)
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
    const history = await this._loadHistory(child.id, { limit: 100 })
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
        fromId: { _: 'peerUser', userId: this._peerId(oldest.source.senderId) },
        notifySettings: { _: 'peerNotifySettings' },
      },
    }
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

/** Stable positive signed-int ID used for synthetic Telegram entities. */
export function stableId(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 0x7ffffffe + 1
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

export function makeTlMessageMedia(media: IMMediaRow, timestamp: number, dcId = 1): tl.TypeMessageMedia {
  const id = Long.fromNumber(media.id)
  // Real Telegram media always carries a non-zero access hash. The bridge
  // resolves downloads from its durable media row, so this synthetic hash is
  // only for clients (notably Desktop) that disable the download action when
  // access_hash is zero.
  const accessHash = Long.fromNumber(media.id)
  const fileReference = new TextEncoder().encode(`bridge-media:${media.id}`)
  if (media.kind === 'image') {
    return {
      _: 'messageMediaPhoto',
      photo: {
        _: 'photo', id, accessHash, fileReference, date: timestamp,
        sizes: [{
          _: 'photoSize', type: 'x', w: media.width ?? 1, h: media.height ?? 1,
          size: Math.min(media.size ?? 0, 0x7fffffff),
        }],
        dcId,
      },
    }
  }
  return {
    _: 'messageMediaDocument',
    document: {
      _: 'document', id, accessHash, fileReference, date: timestamp,
      mimeType: media.mimeType ?? 'application/octet-stream', size: media.size ?? 0, dcId,
      attributes: [{ _: 'documentAttributeFilename', fileName: media.name ?? 'file' }],
    },
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
      attributes: [{ _: 'documentAttributeFilename', fileName: staged.media.name ?? 'file' }],
    },
  }
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
