import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { makeTlMessageMedia, stableId } from './dialogs.js'
import type { IngestResult, MessageStore } from './message-store.js'
import type { IMConversation, IMEvent, IMMessage, PlatformSession } from './platform.js'
import { messageText } from './platform.js'
import type { PlatformRegistry } from './platform-manager.js'
import { makeUser } from './synthetic.js'

/** Converts committed platform events to account-scoped MTProto updates. */
export class UpdateManager {
  constructor(
    private readonly _database: Database,
    private readonly _registry: PlatformRegistry,
    private readonly _store: MessageStore,
    private readonly _sendUpdate: (authKeyId: Uint8Array, update: tl.TypeUpdates) => void,
  ) {}

  async publish(
    session: PlatformSession,
    event: Extract<IMEvent, { type: 'message' }>,
    result: IngestResult,
  ): Promise<void> {
    const delivery = await this._store.prepareUpdateDelivery(
      result.message.id, session.platformSessionId, result.projection.length, event.message.timestamp,
    )
    if (delivery.published) return
    let pts = delivery.pts - delivery.ptsCount
    const updates: tl.TypeUpdate[] = []
    for (const part of result.projection) {
      const projected = await this._store.findProjectedByTlId(
        session.platformSessionId, part.tlMessageId, event.conversation.id,
      )
      if (!projected) continue
      const media = projected.media.find((item) => item.id === part.mediaId)
      const message = makeUpdateMessage(
        session.platformSessionId, event.conversation, projected.source, part.tlMessageId, part.ordinal,
        part.groupedId ?? undefined, media,
      )
      updates.push({
        _: event.conversation.kind === 'channel' ? 'updateNewChannelMessage' : 'updateNewMessage',
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
    const chats = event.conversation.kind === 'direct' ? [] : [makeUpdateChat(event.conversation)]
    const payload: tl.RawUpdates = {
      _: 'updates', updates, users, chats, date: delivery.date, seq: delivery.seq,
    }
    const bindings = await this._database.get('mtproto_auth_binding', {
      platformSessionId: session.platformSessionId,
    })
    for (const binding of bindings) {
      this._sendUpdate(hexBytes(binding.authKeyId), payload)
    }
    await this._store.markUpdatePublished(result.message.id)
  }

  async getState(platformSessionId: string): Promise<tl.updates.RawState> {
    const state = await this._store.getUpdateState(platformSessionId)
    return {
      _: 'updates.state', pts: state.pts, qts: state.qts,
      date: state.date, seq: state.seq, unreadCount: 0,
    }
  }
}

function makeUpdateMessage(
  platformSessionId: string,
  conversation: IMConversation,
  source: IMMessage,
  id: number,
  ordinal: number,
  groupedId?: string,
  media?: import('./models.js').IMMediaRow,
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
    date: source.timestamp,
    message: ordinal === 0 ? messageText(source) : '',
    media: media ? makeTlMessageMedia(media, source.timestamp) : undefined,
    groupedId: groupedId ? Long.fromString(groupedId) : undefined,
  } as tl.RawMessage
}

function makeUpdateChat(conversation: IMConversation): tl.TypeChat {
  const id = stableId(`peer:${conversation.id}`)
  if (conversation.kind === 'group') {
    return {
      _: 'chat', id, title: conversation.title, photo: { _: 'chatPhotoEmpty' },
      participantsCount: Number(conversation.metadata?.participantsCount ?? 0), date: 0, version: 1,
    }
  }
  const broadcast = conversation.metadata?.broadcast === true
  return {
    _: 'channel', id, accessHash: Long.ZERO, title: conversation.title,
    broadcast: broadcast || undefined, megagroup: !broadcast || undefined,
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
