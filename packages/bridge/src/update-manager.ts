import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { makeTlMessageMedia, projectTlMessage, stableId } from './dialogs.js'
import type { MessageStore } from './message-store.js'
import type { IMConversation, IMMessage, PlatformSession } from './platform.js'
import type { IMSticker } from './sticker-provider.js'
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
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    private readonly _projectSticker?: (
      session: PlatformSession,
      sticker: IMSticker,
    ) => tl.TypeMessageMedia | undefined,
  ) {}

  async publish(
    session: PlatformSession,
    committed: CommittedPlatformEvent,
  ): Promise<void> {
    this._onTrace?.(
      'update publish start platform=%s session=%s %s',
      session.platformId, session.platformSessionId, committedEventSummary(committed),
    )
    if (committed.event.type === 'message-delete') {
      await this._publishDelete(
        session,
        committed as Extract<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
      )
      return
    }
    if (committed.event.type === 'message-reactions') {
      await this._publishReactions(
        session,
        committed as Extract<CommittedPlatformEvent, { event: { type: 'message-reactions' } }>,
      )
      return
    }
    await this._publishMessage(
      session,
      committed as Exclude<CommittedPlatformEvent, {
        event: { type: 'message-delete' | 'message-reactions' }
      }>,
    )
  }

  private async _publishReactions(
    session: PlatformSession,
    committed: Extract<CommittedPlatformEvent, { event: { type: 'message-reactions' } }>,
  ): Promise<void> {
    const { event, result } = committed
    const eventKey = `${session.platformSessionId}:reaction:${event.eventId}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    if (!delivery && !result.changed) return
    const displayConversation = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getConversation(session.platformSessionId, event.conversation.parentId)
        ?? { id: event.conversation.parentId, kind: 'channel' as const, title: event.conversation.parentId }
      : event.conversation
    const channelId = displayConversation.kind === 'direct'
      ? undefined
      : stableId(`peer:${displayConversation.id}`)
    delivery ??= await this._store.prepareUpdateDelivery(
      eventKey, session.platformSessionId, 0, event.timestamp, channelId,
    )
    if (delivery.published) return
    const reactions = makeMessageReactions(result.message, session.platformSessionId)
    let pts = delivery.pts - delivery.ptsCount
    const updates = result.tlMessageIds.map((msgId): tl.RawUpdateMessageReactions => ({
      _: 'updateMessageReactions',
      peer: conversationPeer(displayConversation),
      msgId,
      reactions,
    }))
    // updateMessageReactions itself does not carry pts; account pts is retained
    // in the durable delivery state for difference/retry ordering.
    pts += updates.length
    void pts
    const payload: tl.RawUpdates = {
      _: 'updates', updates, users: [],
      chats: displayConversation.kind === 'direct' ? [] : [makeUpdateChat(displayConversation, false, this._dcId)],
      date: delivery.date, seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, encodeUpdate(payload))
    if (await this._send(session.platformSessionId, payload)) await this._store.markUpdatePublished(eventKey)
  }

  private async _publishMessage(
    session: PlatformSession,
    committed: Exclude<CommittedPlatformEvent, {
      event: { type: 'message-delete' | 'message-reactions' }
    }>,
  ): Promise<void> {
    const { event, result } = committed
    const isEdit = event.type === 'message-edit'
    const eventKey = isEdit
      ? `${session.platformSessionId}:edit:${event.eventId}`
      : `${session.platformSessionId}:message:${result.message.id}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    if (!delivery && isEdit && !result.changed) {
      this._onTrace?.('update publish skipped eventKey=%s reason=unchanged-edit', eventKey)
      return
    }
    const displayConversation = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getConversation(session.platformSessionId, event.conversation.parentId)
        ?? { id: event.conversation.parentId, kind: 'channel' as const, title: event.conversation.parentId }
      : event.conversation
    const channelId = displayConversation.kind === 'direct'
      ? undefined
      : stableId(`peer:${displayConversation.id}`)
    delivery ??= await this._store.prepareUpdateDelivery(
      eventKey, session.platformSessionId, result.projection.length, event.message.timestamp, channelId,
    )
    if (delivery.published) {
      this._onTrace?.('update publish skipped eventKey=%s reason=already-published', eventKey)
      return
    }
    this._onTrace?.(
      'update delivery prepared eventKey=%s pts=%d ptsCount=%d seq=%d projection=%d created=%s changed=%s',
      eventKey, delivery.pts, delivery.ptsCount, delivery.seq, result.projection.length,
      result.created, result.changed,
    )
    const topicId = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getOldestTlMessageId(session.platformSessionId, event.conversation.id)
      : undefined
    const platform = this._registry.require(session.platformId)
    let pts = delivery.pts - delivery.ptsCount
    const updates: tl.TypeUpdate[] = []
    for (const part of result.projection) {
      const projected = await this._store.findProjectedByTlId(
        session.platformSessionId, part.tlMessageId, event.conversation.id,
      )
      if (!projected) {
        this._onTrace?.(
          'update projection missing eventKey=%s conversation=%s tlMessageId=%d ordinal=%d',
          eventKey, event.conversation.id, part.tlMessageId, part.ordinal,
        )
        continue
      }
      const media = projected.media.find((item) => item.id === part.mediaId)
      let replied = projected.source.replyToId
        ? await this._store.findProjectedByPlatformId(
            session.platformSessionId, event.conversation.id, projected.source.replyToId,
          )
        : undefined
      if (!replied && projected.source.replyToId && platform.getMessage) {
        try {
          const target = await platform.getMessage(
            session, { id: event.conversation.id }, projected.source.replyToId,
          )
          if (target) {
            await this._store.ingest(session, event.conversation, target, { allocation: 'history' })
            replied = await this._store.findProjectedByPlatformId(
              session.platformSessionId, event.conversation.id, projected.source.replyToId,
            )
          }
        } catch (error) {
          this._onTrace?.(
            'reply target backfill failed conversation=%s message=%s target=%s error=%s',
            event.conversation.id, projected.source.id, projected.source.replyToId, String(error),
          )
        }
      }
      const sticker = projected.source.content.parts.find((item) => item.type === 'sticker')
      const message = projectTlMessage({
        platformSessionId: session.platformSessionId,
        conversation: displayConversation,
        source: projected.source,
        tlId: part.tlMessageId,
        ordinal: part.ordinal,
        groupedId: part.groupedId ?? undefined,
        media: media
          ? makeTlMessageMedia(media, projected.source.timestamp, this._dcId)
          : sticker?.type === 'sticker'
            ? this._projectSticker?.(session, sticker.sticker)
            : undefined,
        entities: makeMessageEntities(projected.source, session.platformSessionId),
        reactions: projected.source.reactionContext?.reactions.length
          ? makeMessageReactions(projected.source, session.platformSessionId)
          : undefined,
        topicId,
        replyToTlId: replied?.parts[0]?.tlMessageId,
      })
      updates.push({
        _: isEdit
          ? event.conversation.kind !== 'direct' ? 'updateEditChannelMessage' : 'updateEditMessage'
          : event.conversation.kind !== 'direct' ? 'updateNewChannelMessage' : 'updateNewMessage',
        message,
        pts: ++pts,
        ptsCount: 1,
      } as tl.TypeUpdate)
    }
    if (!updates.length) {
      this._onTrace?.('update publish skipped eventKey=%s reason=no-projected-updates', eventKey)
      return
    }

    const sender = event.message.sender
      ?? await platform.getUser?.(session, event.message.senderId)
    const users = [
      makeUser({
        id: stableId(`self:${session.platformSessionId}`), self: true, premium: true,
        firstName: String(session.metadata.firstName ?? 'Bridge'),
      }),
      makeUser({
        id: stableId(`peer:${event.message.senderId}`),
        firstName: sender?.firstName ?? event.message.senderId,
        lastName: sender?.lastName,
        username: sender?.username,
        photo: sender?.avatar ? makeUpdateAvatar(sender.avatar.id, this._dcId, 'user') : undefined,
      }),
    ]
    const chats = [
      ...(displayConversation.kind === 'direct'
        ? []
        : [makeUpdateChat(displayConversation, topicId !== undefined, this._dcId)]),
      ...linkedConversations(event.message).map((conversation) =>
        makeUpdateChat(conversation, false, this._dcId)),
    ]
    const payload: tl.RawUpdates = {
      _: 'updates', updates, users, chats, date: delivery.date, seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, encodeUpdate(payload))
    this._onTrace?.(
      'update payload stored eventKey=%s updates=%d types=%s pts=%d seq=%d',
      eventKey, updates.length, updates.map((update) => update._).join(','), delivery.pts, delivery.seq,
    )
    if (await this._send(session.platformSessionId, payload)) {
      await this._store.markUpdatePublished(eventKey)
      this._onTrace?.('update published eventKey=%s session=%s', eventKey, session.platformSessionId)
    } else {
      this._onTrace?.(
        'update pending eventKey=%s session=%s reason=no-live-auth-connection',
        eventKey, session.platformSessionId,
      )
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
    const displayConversation = event.conversation.kind === 'channel' && event.conversation.parentId
      ? await this._store.getConversation(session.platformSessionId, event.conversation.parentId)
        ?? { id: event.conversation.parentId, kind: 'channel' as const, title: event.conversation.parentId }
      : event.conversation
    const channelId = displayConversation.kind === 'direct'
      ? undefined
      : stableId(`peer:${displayConversation.id}`)
    delivery ??= await this._store.prepareUpdateDelivery(
      eventKey, session.platformSessionId, result.tlMessageIds.length, event.timestamp, channelId,
    )
    if (delivery.published) return
    const update = event.conversation.kind !== 'direct'
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
      chats: displayConversation.kind === 'direct'
        ? []
        : [makeUpdateChat(displayConversation, !!event.conversation.parentId, this._dcId)],
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
    this._onTrace?.(
      'update send start session=%s bindings=%d updates=%d types=%s',
      platformSessionId, bindings.length, payload.updates.length,
      payload.updates.map((update) => update._).join(','),
    )
    for (const binding of bindings) {
      const connections = this._sendUpdate(hexBytes(binding.authKeyId), payload)
      delivered += connections
      this._onTrace?.(
        'update send binding session=%s authKey=%s connections=%d',
        platformSessionId, binding.authKeyId, connections,
      )
    }
    this._onTrace?.(
      'update send complete session=%s bindings=%d connections=%d',
      platformSessionId, bindings.length, delivered,
    )
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
    if (!deliveries.length && request.pts === state.pts) {
      return { _: 'updates.differenceEmpty', date: state.date, seq: state.seq }
    }
    const requestedLimit = request.ptsLimit ?? request.ptsTotalLimit ?? 100
    const page = deliveries.slice(0, Math.max(1, Math.min(requestedLimit, 100)))
    const newMessages: tl.TypeMessage[] = []
    const otherUpdates: tl.TypeUpdate[] = []
    const chats = new Map<string, tl.TypeChat>()
    const users = new Map<string, tl.TypeUser>()
    for (const delivery of page.filter((delivery) => delivery.payload)) {
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

  async getChannelDifference(
    platformSessionId: string,
    request: tl.updates.RawGetChannelDifferenceRequest,
  ): Promise<tl.updates.TypeChannelDifference> {
    if (request.channel._ !== 'inputChannel') throw new RpcError(400, 'CHANNEL_INVALID')
    const channelId = request.channel.channelId
    const state = await this._store.getChannelUpdateState(platformSessionId, channelId)
    const deliveries = await this._store.getUpdateDeliveriesAfter(platformSessionId, request.pts, 101, channelId)
    if (!deliveries.length) {
      return { _: 'updates.channelDifferenceEmpty', final: true, pts: state.pts }
    }
    const page = deliveries.slice(0, Math.max(1, Math.min(request.limit, 100)))
    const newMessages: tl.TypeMessage[] = []
    const otherUpdates: tl.TypeUpdate[] = []
    const chats = new Map<string, tl.TypeChat>()
    const users = new Map<string, tl.TypeUser>()
    for (const delivery of page.filter((delivery) => delivery.payload)) {
      const payload = decodeUpdate(delivery.payload)
      for (const update of payload.updates) {
        if (update._ === 'updateNewChannelMessage') newMessages.push(update.message)
        else otherUpdates.push(update)
      }
      for (const chat of payload.chats) chats.set(`${chat._}:${chat.id}`, chat)
      for (const user of payload.users) users.set(`${user._}:${user.id}`, user)
    }
    for (const delivery of page) await this._store.markUpdatePublished(delivery.eventKey)
    return {
      _: 'updates.channelDifference', final: page.length === deliveries.length,
      pts: page.at(-1)?.pts ?? state.pts,
      newMessages, otherUpdates, chats: [...chats.values()], users: [...users.values()],
    }
  }
}

function committedEventSummary(committed: CommittedPlatformEvent): string {
  const { event, result } = committed
  if (event.type === 'message' || event.type === 'message-edit') {
    const ingest = result as import('./message-store.js').IngestResult
    return `type=${event.type} conversation=${event.conversation.id} message=${event.message.id} created=${ingest.created} changed=${ingest.changed} projection=${ingest.projection.length}`
  }
  if (event.type === 'message-delete') {
    const deletion = result as import('./message-store.js').DeleteResult
    return `type=message-delete conversation=${event.conversation.id} eventId=${event.eventId} changed=${deletion.changed} tlMessages=${deletion.tlMessageIds.length}`
  }
  const reactions = result as import('./message-store.js').ReactionResult
  return `type=message-reactions conversation=${event.conversation.id} eventId=${event.eventId} changed=${reactions.changed} tlMessages=${reactions.tlMessageIds.length}`
}

function encodeUpdate(update: tl.RawUpdates): string {
  return Buffer.from(TlBinaryWriter.serializeObject(__tlWriterMap, update)).toString('base64')
}

function decodeUpdate(payload: string): tl.RawUpdates {
  return new TlBinaryReader(__tlReaderMap, Buffer.from(payload, 'base64')).object() as tl.RawUpdates
}

function makeMessageEntities(message: IMMessage, platformSessionId: string): tl.TypeMessageEntity[] | undefined {
  const entities: tl.TypeMessageEntity[] = []
  const textParts = message.content.parts.filter((part) => part.type === 'text')
  let base = 0
  for (const [index, part] of textParts.entries()) {
    for (const entity of part.entities ?? []) {
      if (entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > part.text.length) continue
      if (entity.type === 'mention') {
        entities.push({
          _: 'messageEntityMentionName', offset: base + entity.offset, length: entity.length,
          userId: stableId(`peer:${entity.userId}`),
        })
      } else if (entity.type === 'conversation-link') {
        entities.push({
          _: 'messageEntityTextUrl', offset: base + entity.offset, length: entity.length,
          url: `tg://privatepost?channel=${stableId(`peer:${entity.conversation.id}`)}&post=1`,
        })
      } else if (entity.definition.presentation.type === 'custom') {
        entities.push({
          _: 'messageEntityCustomEmoji', offset: base + entity.offset, length: entity.length,
          documentId: Long.fromNumber(stableId([
            'reaction-resource', 1, platformSessionId, message.conversationId,
            entity.definition.key, entity.definition.presentation.resource.version,
          ].join(':'))),
        })
      }
    }
    base += part.text.length + (index + 1 < textParts.length ? 1 : 0)
  }
  return entities.length ? entities : undefined
}

function linkedConversations(message: IMMessage): import('./platform.js').IMConversation[] {
  const conversations = new Map<string, import('./platform.js').IMConversation>()
  for (const part of message.content.parts) {
    if (part.type !== 'text') continue
    for (const entity of part.entities ?? []) {
      if (entity.type === 'conversation-link') conversations.set(entity.conversation.id, entity.conversation)
    }
  }
  return [...conversations.values()]
}

function makeUpdateChat(conversation: IMConversation, forum = false, dcId = 1): tl.TypeChat {
  const id = stableId(`peer:${conversation.id}`)
  const broadcast = conversation.metadata?.broadcast === true
  return {
    _: 'channel', creator: true, id, accessHash: Long.ZERO, title: conversation.title,
    broadcast: broadcast || undefined, megagroup: !broadcast || undefined,
    forum: forum || undefined,
    photo: conversation.avatar
      ? makeUpdateAvatar(conversation.avatar.id, dcId, 'chat')
      : { _: 'chatPhotoEmpty' }, date: 0,
    participantsCount: Number(conversation.metadata?.participantsCount ?? 0),
  }
}

function makeUpdateAvatar(mediaId: string, dcId: number, kind: 'user'): tl.RawUserProfilePhoto
function makeUpdateAvatar(mediaId: string, dcId: number, kind: 'chat'): tl.RawChatPhoto
function makeUpdateAvatar(
  mediaId: string,
  dcId: number,
  kind: 'user' | 'chat',
): tl.RawUserProfilePhoto | tl.RawChatPhoto {
  const photoId = Long.fromNumber(stableId(`avatar:${mediaId}`))
  return kind === 'user'
    ? { _: 'userProfilePhoto', photoId, dcId }
    : { _: 'chatPhoto', photoId, dcId }
}

function hexBytes(value: string): Uint8Array {
  if (value.length % 2) throw new Error('invalid auth key ID')
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function conversationPeer(conversation: IMConversation): tl.TypePeer {
  const id = stableId(`peer:${conversation.id}`)
  return conversation.kind === 'direct'
    ? { _: 'peerUser', userId: id }
    : { _: 'peerChannel', channelId: id }
}

function makeMessageReactions(
  message: IMMessage,
  platformSessionId: string,
): tl.RawMessageReactions {
  const definitions = new Map((message.reactionContext?.available ?? []).map((item) => [item.key, item]))
  return {
    _: 'messageReactions',
    results: (message.reactionContext?.reactions ?? []).flatMap((summary) => {
      const definition = definitions.get(summary.key)
      if (!definition) return []
      const reaction: tl.TypeReaction = definition.presentation.type === 'emoji'
        ? { _: 'reactionEmoji', emoticon: definition.presentation.emoticon }
        : { _: 'reactionCustomEmoji', documentId: Long.fromNumber(stableId([
            'reaction-resource', 1, platformSessionId, message.conversationId,
            definition.key, definition.presentation.resource.version,
          ].join(':'))) }
      return [{
        _: 'reactionCount', reaction, count: summary.count,
        chosenOrder: summary.selected ? 0 : undefined,
      } as tl.RawReactionCount]
    }),
  }
}
