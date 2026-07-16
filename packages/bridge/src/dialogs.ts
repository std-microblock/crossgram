import type { tl } from '@mtcute/core'
import { RpcError } from '@mtproto-relay/mtproto'
import type { IMDialog, IMMessage, IMPlatform, IMUser, PlatformSession } from './platform.js'
import { makeUser } from './synthetic.js'

type GetDialogsRequest = tl.messages.RawGetDialogsRequest
type GetHistoryRequest = tl.messages.RawGetHistoryRequest
type GetMessagesRequest = tl.messages.RawGetMessagesRequest

interface MessageRef {
  peerId: string
  platformMessageId: string
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
  private readonly _selfId: number

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
  ) {
    this._selfId = this._allocate(`self:${_session.platformSessionId}`, new Map())
  }

  async getDialogs(req: GetDialogsRequest): Promise<tl.messages.TypeDialogs> {
    const getDialogs = this._requireHistory(this._platform.getDialogs)
    const all = (await getDialogs.call(this._platform, this._session))
      .slice()
      .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0))

    // Allocate each peer's message IDs oldest-first before exposing topMessage.
    // This preserves Telegram's monotonic ID semantics for offset/max/min filters.
    await Promise.all(all.map((dialog) => this._loadHistory(dialog.peerId)))
    const materialized = await Promise.all(all.map((dialog) => this._materializeDialog(dialog)))
    let start = 0
    if (req.offsetPeer._ === 'inputPeerUser') {
      const offsetPeer = this._tlToPeer.get(req.offsetPeer.userId)
      const index = offsetPeer === undefined ? -1 : materialized.findIndex((item) => item.source.peerId === offsetPeer)
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
      messages: page.map((item) => this._makeMessage(item.source, item.tlId)),
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
      const found = history.find((item) => item.source.id === ref.platformMessageId)
      if (!found) {
        messages.push({ _: 'messageEmpty', id: requestedId } as tl.RawMessageEmpty)
        continue
      }
      messages.push(this._makeMessage(found.source, found.tlId))
      const user = await this._getPeerUser(ref.peerId)
      users.set(user.id, user)
    }

    const self = this._makeSelfUser()
    users.set(self.id, self)
    return {
      _: 'messages.messages', messages, topics: [], chats: [], users: [...users.values()],
    } as unknown as tl.messages.TypeMessages
  }

  peerTlId(peerId: string): number {
    return this._peerId(peerId)
  }

  private async _materializeDialog(source: IMDialog) {
    const peerId = this._peerId(source.peerId)
    const user = await this._getPeerUser(source.peerId, source.title)
    const topMessage = source.lastMessage ? this._messageId(source.peerId, source.lastMessage.id) : 0
    const message = source.lastMessage ? this._makeMessage(source.lastMessage, topMessage) : undefined
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

  private async _loadHistory(peerId: string) {
    const getHistory = this._requireHistory(this._platform.getHistory)
    const history = await getHistory.call(this._platform, this._session, peerId)
    for (const source of history.slice().sort((a, b) => a.timestamp - b.timestamp)) {
      this._messageId(peerId, source.id)
    }
    return history
      .map((source) => ({ source, tlId: this._messageId(peerId, source.id) }))
      .sort((a, b) => b.source.timestamp - a.source.timestamp || b.tlId - a.tlId)
  }

  private async _hydrateAllMessages(): Promise<void> {
    const getDialogs = this._requireHistory(this._platform.getDialogs)
    const dialogs = await getDialogs.call(this._platform, this._session)
    await Promise.all(dialogs.map((dialog) => this._loadHistory(dialog.peerId)))
  }

  private _makeMessage(source: IMMessage, tlId: number): tl.RawMessage {
    const peerId = this._peerId(source.peerId)
    return {
      _: 'message',
      out: source.outgoing || undefined,
      id: tlId,
      fromId: { _: 'peerUser', userId: source.outgoing ? this._selfId : this._peerId(source.senderId) },
      peerId: { _: 'peerUser', userId: peerId },
      date: source.timestamp,
      message: source.text ?? '',
    } as tl.RawMessage
  }

  private async _getPeerUser(peerId: string, fallbackName?: string): Promise<tl.RawUser> {
    const user = await this._platform.getUser?.(this._session, peerId)
    return this._makePeerUser(user ?? { id: peerId, firstName: fallbackName ?? peerId })
  }

  private _makePeerUser(user: IMUser): tl.RawUser {
    return makeUser({
      id: this._peerId(user.id), firstName: user.firstName,
      lastName: user.lastName, username: user.username,
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
    this._tlToMessage.set(id, { peerId, platformMessageId: messageId })
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
