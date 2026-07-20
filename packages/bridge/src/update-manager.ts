import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { makeTlMessageMedia, stableId } from './dialogs.js'
import type { MessageStore } from './message-store.js'
import type { IMConversation, IMMessage, PlatformSession } from './platform.js'
import { messageText } from './platform.js'
import type { CommittedPlatformEvent, PlatformRegistry } from './platform-manager.js'
import { makeUser } from './synthetic.js'

/** Converts committed platform events to account-scoped MTProto updates. */
export class UpdateManager {
  constructor(
    private readonly _database: Database,
    private readonly _registry: PlatformRegistry,
    private readonly _store: MessageStore,
    private readonly _sendUpdate: (authKeyId: Uint8Array, update: tl.TypeUpdates) => number,
    private readonly _dcId = 1,
  ) {}

  async publish(
    session: PlatformSession,
    committed: CommittedPlatformEvent,
  ): Promise<void> {
    if (committed.event.type === 'message-delete') {
      await this._publishDelete(
        session,
        committed as Extract<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
      )
      return
    }
    await this._publishMessage(
      session,
      committed as Exclude<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
    )
  }

  private async _publishMessage(
    session: PlatformSession,
    committed: Exclude<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
  ): Promise<void> {
    const { event, result } = committed
    const isEdit = event.type === 'message-edit'
    const eventKey = isEdit
      ? `${session.platformSessionId}:edit:${event.eventId}`
      : `${session.platformSessionId}:message:${result.message.id}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    if (!delivery && isEdit && !result.changed) return
    delivery ??= await this._store.prepareUpdateDelivery(
      eventKey, session.platformSessionId, result.projection.length, event.message.timestamp,
    )
    if (delivery.published) return
    const displayConversation = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getConversation(session.platformSessionId, event.conversation.parentId)
        ?? { id: event.conversation.parentId, kind: 'channel' as const, title: event.conversation.parentId }
      : event.conversation
    const topicId = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getOldestTlMessageId(session.platformSessionId, event.conversation.id)
      : undefined
    let pts = delivery.pts - delivery.ptsCount
    const updates: tl.TypeUpdate[] = []
    for (const part of result.projection) {
      const projected = await this._store.findProjectedByTlId(
        session.platformSessionId, part.tlMessageId, event.conversation.id,
      )
      if (!projected) continue
      const media = projected.media.find((item) => item.id === part.mediaId)
      const message = makeUpdateMessage(
        session.platformSessionId, displayConversation, projected.source, part.tlMessageId, part.ordinal,
        part.groupedId ?? undefined, media, this._dcId, topicId,
      )
      updates.push({
        _: isEdit
          ? event.conversation.kind === 'channel' ? 'updateEditChannelMessage' : 'updateEditMessage'
          : event.conversation.kind === 'channel' ? 'updateNewChannelMessage' : 'updateNewMessage',
        message,
        pts: ++pts,
        ptsCount: 1,
      } as tl.TypeUpdate)
    }
    if (!updates.length) return

    const platform = this._registry.require(session.platformId)
    const sender = await platform.getUser?.(session, event.message.senderId)
    const users = [
      makeUser({ id: stableId(`self:${session.platformSessionId}`), self: true, firstName: String(session.metadata.firstName ?? 'Bridge') }),
      makeUser({
        id: stableId(`peer:${event.message.senderId}`),
        firstName: sender?.firstName ?? event.message.senderId,
        lastName: sender?.lastName,
        username: sender?.username,
      }),
    ]
    const chats = displayConversation.kind === 'direct'
      ? []
      : [makeUpdateChat(displayConversation, topicId !== undefined)]
    const payload: tl.RawUpdates = {
      _: 'updates', updates, users, chats, date: delivery.date, seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, encodeUpdate(payload))
    if (await this._send(session.platformSessionId, payload)) {
      await this._store.markUpdatePublished(eventKey)
    }
  }

  private async _publishDelete(
    session: PlatformSession,
    committed: Extract<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
  ): Promise<void> {
    const { event, result } = committed
    const eventKey = `${session.platformSessionId}:delete:${event.eventId}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    if (!delivery && !result.changed) return
    if (!result.tlMessageIds.length) return
    delivery ??= await this._store.prepareUpdateDelivery(
      eventKey, session.platformSessionId, result.tlMessageIds.length, event.timestamp,
    )
    if (delivery.published) return
    const displayConversation = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getConversation(session.platformSessionId, event.conversation.parentId)
        ?? { id: event.conversation.parentId, kind: 'channel' as const, title: event.conversation.parentId }
      : event.conversation
    const update = event.conversation.kind === 'channel'
      ? {
          _: 'updateDeleteChannelMessages',
          channelId: stableId(`peer:${displayConversation.id}`),
          messages: result.tlMessageIds,
          pts: delivery.pts,
          ptsCount: delivery.ptsCount,
        }
      : {
          _: 'updateDeleteMessages',
          messages: result.tlMessageIds,
          pts: delivery.pts,
          ptsCount: delivery.ptsCount,
        }
    const payload: tl.RawUpdates = {
      _: 'updates', updates: [update as tl.TypeUpdate],
      users: [],
      chats: displayConversation.kind === 'direct' ? [] : [makeUpdateChat(displayConversation, !!event.conversation.parentId)],
      date: delivery.date,
      seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, encodeUpdate(payload))
    if (await this._send(session.platformSessionId, payload)) {
      await this._store.markUpdatePublished(eventKey)
    }
  }

  private async _send(platformSessionId: string, payload: tl.RawUpdates): Promise<boolean> {
    const bindings = await this._database.get('mtproto_auth_binding', { platformSessionId })
    let delivered = 0
    for (const binding of bindings) delivered += this._sendUpdate(hexBytes(binding.authKeyId), payload)
    return delivered > 0
  }

  async retryPending(platformSessionId: string): Promise<number> {
    let published = 0
    for (const delivery of await this._store.getPendingUpdateDeliveries(platformSessionId)) {
      if (!delivery.payload) continue
      if (!await this._send(platformSessionId, decodeUpdate(delivery.payload))) break
      await this._store.markUpdatePublished(delivery.eventKey)
      published++
    }
    return published
  }

  async getState(platformSessionId: string): Promise<tl.updates.RawState> {
    const state = await this._store.getUpdateState(platformSessionId)
    return {
      _: 'updates.state', pts: state.pts, qts: state.qts,
      date: state.date, seq: state.seq, unreadCount: 0,
    }
  }

  async getDifference(
    platformSessionId: string,
    request: tl.updates.RawGetDifferenceRequest,
  ): Promise<tl.updates.TypeDifference> {
    const state = await this.getState(platformSessionId)
    const deliveries = await this._store.getUpdateDeliveriesAfter(platformSessionId, request.pts)
    if (!deliveries.length) {
      return request.pts < state.pts
        ? { _: 'updates.differenceTooLong', pts: state.pts }
        : { _: 'updates.differenceEmpty', date: state.date, seq: state.seq }
    }
    if (deliveries.some((delivery) => !delivery.payload)) {
      return { _: 'updates.differenceTooLong', pts: state.pts }
    }
    const requestedLimit = request.ptsLimit ?? request.ptsTotalLimit ?? 100
    const page = deliveries.slice(0, Math.max(1, Math.min(requestedLimit, 100)))
    const newMessages: tl.TypeMessage[] = []
    const otherUpdates: tl.TypeUpdate[] = []
    const chats = new Map<string, tl.TypeChat>()
    const users = new Map<string, tl.TypeUser>()
    for (const delivery of page) {
      const payload = decodeUpdate(delivery.payload)
      for (const update of payload.updates) {
        if (update._ === 'updateNewMessage' || update._ === 'updateNewChannelMessage') {
          newMessages.push(update.message)
        } else {
          otherUpdates.push(update)
        }
      }
      for (const chat of payload.chats) chats.set(`${chat._}:${chat.id}`, chat)
      for (const user of payload.users) users.set(`${user._}:${user.id}`, user)
    }
    for (const delivery of page) await this._store.markUpdatePublished(delivery.eventKey)
    const last = page.at(-1)!
    const difference = {
      newMessages, newEncryptedMessages: [], otherUpdates,
      chats: [...chats.values()], users: [...users.values()],
    }
    if (page.length < deliveries.length) {
      return {
        _: 'updates.differenceSlice', ...difference,
        intermediateState: {
          _: 'updates.state', pts: last.pts, qts: state.qts,
          date: last.date, seq: last.seq, unreadCount: 0,
        },
      }
    }
    return { _: 'updates.difference', ...difference, state }
  }
}

function encodeUpdate(update: tl.RawUpdates): string {
  return Buffer.from(TlBinaryWriter.serializeObject(__tlWriterMap, update)).toString('base64')
}

function decodeUpdate(payload: string): tl.RawUpdates {
  return new TlBinaryReader(__tlReaderMap, Buffer.from(payload, 'base64')).object() as tl.RawUpdates
}

function makeUpdateMessage(
  platformSessionId: string,
  conversation: IMConversation,
  source: IMMessage,
  id: number,
  ordinal: number,
  groupedId?: string,
  media?: import('./models.js').IMMediaRow,
  dcId = 1,
  topicId?: number,
): tl.RawMessage {
  const peerId = stableId(`peer:${conversation.id}`)
  const peer: tl.TypePeer = conversation.kind === 'group'
    ? { _: 'peerChat', chatId: peerId }
    : conversation.kind === 'channel'
      ? { _: 'peerChannel', channelId: peerId }
      : { _: 'peerUser', userId: peerId }
  return {
    _: 'message', out: source.outgoing || undefined, id,
    fromId: {
      _: 'peerUser',
      userId: source.outgoing ? stableId(`self:${platformSessionId}`) : stableId(`peer:${source.senderId}`),
    },
    peerId: peer,
    replyTo: topicId && topicId !== id ? {
      _: 'messageReplyHeader', forumTopic: true, replyToMsgId: topicId, replyToTopId: topicId,
    } : undefined,
    date: source.timestamp,
    message: ordinal === 0 ? messageText(source) : '',
    media: media ? makeTlMessageMedia(media, source.timestamp, dcId) : undefined,
    groupedId: groupedId ? Long.fromString(groupedId) : undefined,
  } as tl.RawMessage
}

function makeUpdateChat(conversation: IMConversation, forum = false): tl.TypeChat {
  const id = stableId(`peer:${conversation.id}`)
  if (conversation.kind === 'group') {
    return {
      _: 'chat', creator: true, id, title: conversation.title, photo: { _: 'chatPhotoEmpty' },
      participantsCount: Number(conversation.metadata?.participantsCount ?? 0), date: 0, version: 1,
    }
  }
  const broadcast = conversation.metadata?.broadcast === true
  return {
    _: 'channel', creator: true, id, accessHash: Long.ZERO, title: conversation.title,
    broadcast: broadcast || undefined, megagroup: !broadcast || undefined,
    forum: forum || undefined,
    photo: { _: 'chatPhotoEmpty' }, date: 0,
    participantsCount: Number(conversation.metadata?.participantsCount ?? 0),
  }
}

function hexBytes(value: string): Uint8Array {
  if (value.length % 2) throw new Error('invalid auth key ID')
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
