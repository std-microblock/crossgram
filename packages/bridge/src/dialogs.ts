import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { messageText, type IMDialog, type IMMessage, type IMPlatform, type IMUser, type PlatformSession } from './platform.js'
import { makeUser } from './synthetic.js'
import type { MessageStore } from './message-store.js'
import { PlatformDataService } from './platform-manager.js'
import type { IMMediaRow } from './models.js'

type GetDialogsRequest = tl.messages.RawGetDialogsRequest
type GetHistoryRequest = tl.messages.RawGetHistoryRequest
type GetMessagesRequest = tl.messages.RawGetMessagesRequest
type SendMessageRequest = tl.messages.RawSendMessageRequest

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
  private readonly _selfId: number
  private readonly _data?: PlatformDataService
  private readonly _store?: MessageStore
  private readonly _historyCache = new Map<string, MaterializedMessage[]>()

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    store?: MessageStore,
  ) {
    this._selfId = this._allocate(`self:${_session.platformSessionId}`, new Map())
    if (store) {
      this._store = store
      this._data = new PlatformDataService(_platform, _session, store)
    }
  }

  async getDialogs(req: GetDialogsRequest): Promise<tl.messages.TypeDialogs> {
    const all = (await this._loadDialogs())
      .slice()
      .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0))

    // Allocate each peer's message IDs oldest-first before exposing topMessage.
    // This preserves Telegram's monotonic ID semantics for offset/max/min filters.
    await Promise.all(all.map((dialog) => this._loadHistory(dialog.conversation.id)))
    const materialized = await Promise.all(all.map((dialog) => this._materializeDialog(dialog)))
    let start = 0
    if (req.offsetPeer._ === 'inputPeerUser') {
      const offsetPeer = this._tlToPeer.get(req.offsetPeer.userId)
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
      chats: [],
      users: uniqueUsers(page.map((item) => item.user)),
    }
    return result as unknown as tl.messages.TypeDialogs
  }

  async getHistory(req: GetHistoryRequest): Promise<tl.messages.TypeMessages> {
    await this._hydratePeers()
    const peerId = this._resolvePeer(req.peer)
    const all = await this._loadHistory(peerId)
    const filtered = all.filter((item) => {
      if (req.offsetId > 0 && item.tlId >= req.offsetId) return false
      if (req.offsetDate > 0 && item.source.timestamp >= req.offsetDate) return false
      if (req.maxId > 0 && item.tlId >= req.maxId) return false
      if (req.minId > 0 && item.tlId <= req.minId) return false
      return true
    })
    const start = Math.max(0, req.addOffset)
    const page = filtered.slice(start, start + clampLimit(req.limit))
    const peer = await this._getPeerUser(peerId)
    return {
      _: page.length < filtered.length || start > 0 ? 'messages.messagesSlice' : 'messages.messages',
      ...(page.length < filtered.length || start > 0 ? { count: filtered.length } : {}),
      messages: page.map((item) => this._makeMessage(item)),
      topics: [],
      chats: [],
      users: uniqueUsers([peer, this._makeSelfUser()]),
    } as unknown as tl.messages.TypeMessages
  }

  async getMessages(req: GetMessagesRequest): Promise<tl.messages.TypeMessages> {
    await this._hydrateAllMessages()
    const users = new Map<number, tl.RawUser>()
    const messages: tl.TypeMessage[] = []

    for (const input of req.id) {
      const requestedId = input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
      const ref = this._tlToMessage.get(requestedId)
      if (!ref) {
        messages.push({ _: 'messageEmpty', id: requestedId } as tl.RawMessageEmpty)
        continue
      }
      const history = await this._loadHistory(ref.peerId)
      const found = history.find((item) => item.tlId === requestedId)
      if (!found) {
        messages.push({ _: 'messageEmpty', id: requestedId } as tl.RawMessageEmpty)
        continue
      }
      messages.push(this._makeMessage(found))
      const user = await this._getPeerUser(ref.peerId)
      users.set(user.id, user)
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
    const dialogs = (await this._loadDialogs()).sort((left, right) =>
      left.conversation.title.localeCompare(right.conversation.title))
    const users = await Promise.all(dialogs.map((dialog) => this._getPeerUser(dialog.conversation.id, dialog.conversation.title)))
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
    const peerId = this._resolvePeer(req.peer)
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
    const pts = ++this._pts
    return {
      _: 'updateShortSentMessage', out: true, id, pts, ptsCount: 1, date: source.timestamp,
    }
  }

  private async _materializeDialog(source: IMDialog) {
    const platformPeerId = source.conversation.id
    const peerId = this._peerId(platformPeerId)
    const user = await this._getPeerUser(platformPeerId, source.conversation.title)
    const projected = source.lastMessage
      ? this._historyCache.get(platformPeerId)?.filter((item) =>
          item.source.id === source.lastMessage!.id || item.source.sourceIds?.includes(source.lastMessage!.id))
      : undefined
    const top = projected?.[0]
    const topMessage = top?.tlId ?? (source.lastMessage ? this._messageId(platformPeerId, source.lastMessage.id) : 0)
    const message = source.lastMessage
      ? this._makeMessage(top ?? { source: source.lastMessage, tlId: topMessage, ordinal: 0 })
      : undefined
    const dialog: tl.RawDialog = {
      _: 'dialog',
      peer: { _: 'peerUser', userId: peerId },
      topMessage,
      readInboxMaxId: source.unreadCount > 0 ? 0 : topMessage,
      readOutboxMaxId: topMessage,
      unreadCount: source.unreadCount,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      unreadPollVotesCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
    }
    return { source, dialog, message, user }
  }

  private async _loadHistory(peerId: string): Promise<MaterializedMessage[]> {
    if (this._data && this._store) {
      await this._data.getHistory(peerId)
      const projected = await this._store.readProjectedHistory(this._session.platformSessionId, peerId)
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
      this._platform, this._session, { id: peerId },
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
    for (const dialog of dialogs) this._peerId(dialog.conversation.id)
  }

  private async _loadDialogs(): Promise<IMDialog[]> {
    if (this._data) return this._data.getDialogs()
    const getDialogs = this._requireHistory(this._platform.getDialogs)
    return (await getDialogs.call(this._platform, this._session)).dialogs
  }

  private async _getInputUser(input: tl.TypeInputUser): Promise<tl.TypeUser> {
    if (input._ === 'inputUserSelf') return this._makeSelfUser()
    if (input._ !== 'inputUser') throw new RpcError(400, 'USER_ID_INVALID')
    const peerId = this._tlToPeer.get(input.userId)
    if (!peerId) throw new RpcError(400, 'USER_ID_INVALID')
    return this._getPeerUser(peerId)
  }

  private _makeMessage(item: MaterializedMessage): tl.RawMessage {
    const { source, tlId } = item
    const peerId = this._peerId(source.conversationId)
    return {
      _: 'message',
      out: source.outgoing || undefined,
      id: tlId,
      fromId: { _: 'peerUser', userId: source.outgoing ? this._selfId : this._peerId(source.senderId) },
      peerId: { _: 'peerUser', userId: peerId },
      date: source.timestamp,
      message: item.ordinal === 0 ? messageText(source) : '',
      media: item.media ? makeTlMessageMedia(item.media, source.timestamp) : undefined,
      groupedId: item.groupedId ? Long.fromString(item.groupedId) : undefined,
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

  private async _getPeerUser(peerId: string, fallbackName?: string): Promise<tl.RawUser> {
    const user = await this._platform.getUser?.(this._session, peerId)
    return this._makePeerUser(user ?? { id: peerId, firstName: fallbackName ?? peerId })
  }

  private _makePeerUser(user: IMUser): tl.RawUser {
    return makeUser({
      id: this._peerId(user.id), firstName: user.firstName,
      lastName: user.lastName, username: user.username,
      contact: true, mutualContact: true,
    })
  }

  private _makeSelfUser(): tl.RawUser {
    return makeUser({
      id: this._selfId,
      self: true,
      firstName: String(this._session.metadata.firstName ?? 'Bridge'),
      lastName: this._session.metadata.lastName as string | undefined,
      username: this._session.metadata.username as string | undefined,
    })
  }

  private _resolvePeer(peer: tl.TypeInputPeer): string {
    if (peer._ !== 'inputPeerUser') throw new RpcError(400, 'PEER_ID_INVALID')
    const id = this._tlToPeer.get(peer.userId)
    if (!id) throw new RpcError(400, 'PEER_ID_INVALID')
    return id
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

function clampLimit(limit: number): number {
  return Math.max(0, Math.min(Math.trunc(limit), 100))
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

export function makeTlMessageMedia(media: IMMediaRow, timestamp: number): tl.TypeMessageMedia {
  const id = Long.fromNumber(media.id)
  const fileReference = new TextEncoder().encode(`bridge-media:${media.id}`)
  if (media.kind === 'image') {
    return {
      _: 'messageMediaPhoto',
      photo: {
        _: 'photo', id, accessHash: Long.ZERO, fileReference, date: timestamp,
        sizes: [{
          _: 'photoSize', type: 'x', w: media.width ?? 1, h: media.height ?? 1,
          size: Math.min(media.size ?? 0, 0x7fffffff),
        }],
        dcId: 1,
      },
    }
  }
  return {
    _: 'messageMediaDocument',
    document: {
      _: 'document', id, accessHash: Long.ZERO, fileReference, date: timestamp,
      mimeType: media.mimeType ?? 'application/octet-stream', size: media.size ?? 0, dcId: 1,
      attributes: [{ _: 'documentAttributeFilename', fileName: media.name ?? 'file' }],
    },
  }
}
