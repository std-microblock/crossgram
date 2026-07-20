import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import {
  messageText, type IMDialog, type IMMediaInput, type IMMessage, type IMMessageInput,
  type IMPlatform, type IMTransferProgress, type IMUser, type PlatformSession,
} from './platform.js'
import { makeUser } from './synthetic.js'
import type { MessageStore } from './message-store.js'
import { PlatformDataService } from './platform-manager.js'
import type { IMMediaRow } from './models.js'
import type { UploadedFile, UploadManager } from './upload-manager.js'

type GetDialogsRequest = tl.messages.RawGetDialogsRequest
type GetHistoryRequest = tl.messages.RawGetHistoryRequest
type GetMessagesRequest = tl.messages.RawGetMessagesRequest
type SendMessageRequest = tl.messages.RawSendMessageRequest
type SendMediaRequest = tl.messages.RawSendMediaRequest
type SendMultiMediaRequest = tl.messages.RawSendMultiMediaRequest
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

  constructor(
    private readonly _platform: IMPlatform,
    private readonly _session: PlatformSession,
    store?: MessageStore,
    private readonly _uploads?: UploadManager,
    private readonly _onTransferProgress?: (session: PlatformSession, progress: IMTransferProgress) => void | Promise<void>,
  ) {
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
    const dialogs = (await this._loadDialogs({ limit: 500 })).sort((left, right) =>
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

  async sendMedia(req: SendMediaRequest): Promise<tl.TypeUpdates> {
    return this._sendMediaOnce(req.randomId.toString(), async () => {
      const resolved = await this._resolveUploadedMedia(req.media)
      try {
        const parts: IMMessageInput['parts'] = []
        if (req.message) parts.push({ type: 'text', text: req.message })
        parts.push({ type: 'media', media: resolved.media })
        return await this._sendRichContent(req.peer, { parts }, [resolved.upload])
      } catch (error) {
        throw error
      }
    })
  }

  async sendMultiMedia(req: SendMultiMediaRequest): Promise<tl.TypeUpdates> {
    const randomId = req.multiMedia.map((item) => item.randomId.toString()).join(':')
    return this._sendMediaOnce(randomId, async () => {
      if (!req.multiMedia.length) throw new RpcError(400, 'MEDIA_EMPTY')
      const resolved = await Promise.all(req.multiMedia.map((item) => this._resolveUploadedMedia(item.media)))
      const parts: IMMessageInput['parts'] = []
      const captions = req.multiMedia.map((item) => item.message).filter(Boolean)
      if (captions.length) parts.push({ type: 'text', text: captions.join('\n') })
      for (const item of resolved) parts.push({ type: 'media', media: item.media })
      return this._sendRichContent(req.peer, { parts }, resolved.map((item) => item.upload))
    })
  }

  async getFile(req: tl.upload.RawGetFileRequest): Promise<tl.upload.TypeFile> {
    if (!this._store || !this._platform.downloadMedia) throw new RpcError(400, 'FILE_DOWNLOAD_UNAVAILABLE')
    if (req.offset < 0 || req.limit <= 0) throw new RpcError(400, 'OFFSET_INVALID')
    if (req.location._ !== 'inputDocumentFileLocation' && req.location._ !== 'inputPhotoFileLocation') {
      throw new RpcError(400, 'LOCATION_INVALID')
    }
    const stored = await this._store.getMedia(this._session.platformSessionId, req.location.id.toNumber())
    if (!stored) throw new RpcError(400, 'FILE_ID_INVALID')
    const chunks: Uint8Array[] = []
    let size = 0
    const stream = this._platform.downloadMedia(this._session, stored.media, {
      offset: req.offset,
      limit: req.limit,
      onProgress: (progress) => this._onTransferProgress?.(this._session, progress),
    })
    for await (const chunk of stream) {
      const remaining = req.limit - size
      if (remaining <= 0) break
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(accepted)
      size += accepted.length
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return {
      _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: stored.timestamp, bytes,
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

  private async _resolveUploadedMedia(media: tl.TypeInputMedia): Promise<{
    media: IMMediaInput
    upload: UploadedFile
  }> {
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

  private async _sendRichContent(
    inputPeer: tl.TypeInputPeer,
    content: IMMessageInput,
    uploads: UploadedFile[],
  ): Promise<tl.TypeUpdates> {
    const media = content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
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
    if (Array.from(text).length > this._platform.capabilities.send.maxTextLength) {
      throw new RpcError(400, 'MESSAGE_TOO_LONG')
    }

    await this._hydratePeers()
    const peerId = this._resolvePeer(inputPeer)
    const sent = await this._platform.sendMessage(this._session, { id: peerId }, content, {
      onProgress: (progress) => this._onTransferProgress?.(this._session, progress),
    })
    const source: IMMessage = { ...sent, conversationId: peerId, outgoing: true }
    if (!this._store) throw new RpcError(500, 'MESSAGE_STORE_UNAVAILABLE')
    const conversation = await this._store.getConversation(this._session.platformSessionId, peerId)
      ?? { id: peerId, kind: 'direct' as const, title: peerId }
    const persisted = await this._store.ingest(this._session, conversation, source)
    await Promise.all(uploads.map((upload) => upload.cleanup()))

    const updates: tl.TypeUpdate[] = []
    for (const part of persisted.projection) {
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
      updates.push({
        _: 'updateNewMessage', message: this._makeMessage(item), pts: ++this._pts, ptsCount: 1,
      } as tl.RawUpdateNewMessage)
    }
    return {
      _: 'updates', updates, users: [this._makeSelfUser(), await this._getPeerUser(peerId)], chats: [],
      date: source.timestamp, seq: 0,
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
    for (const dialog of dialogs) this._peerId(dialog.conversation.id)
  }

  private async _loadDialogs(query: { limit?: number, afterId?: string } = { limit: 100 }): Promise<IMDialog[]> {
    if (this._data) return this._data.getDialogs(query)
    const getDialogs = this._requireHistory(this._platform.getDialogs)
    return (await getDialogs.call(this._platform, this._session, query)).dialogs
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

function inferImageMime(name: string): string {
  const extension = name.toLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'image/jpeg'
}
