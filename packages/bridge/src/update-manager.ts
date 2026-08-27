import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import type { ServerConnection } from '@mtproto-relay/mtproto'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import {
  makeAdminRights, makeDefaultBannedRights, makeTlArticleMedia, makeTlCardPreview,
  makeTlMessageMedia, projectTlMessage, stableId,
} from './dialogs.js'
import { toUser, type MessageStore } from './message-store.js'
import {
  cardUrl, messageMentionsUser, messagePartText, telegramReplyToMessageId,
  type IMConversation, type IMMessage, type IMPlatform, type PlatformSession,
} from './platform.js'
import { qqReplySequenceFromMetadata } from './message-id.js'
import type { IMSticker } from './sticker-provider.js'
import type {
  CommittedPlatformEvent, PlatformEventDeliveryOptions, PlatformEventPublishResult, PlatformRegistry,
} from './platform-manager.js'
import { makeUser } from './synthetic.js'
import type { BlockedPeerStore } from './blocked-peers.js'
import { customReactionDocumentId } from './reaction-rpc.js'
import { updateFromJson, updateToJson } from './update-json.js'
import type { MessageProjectionPipeline } from './message-projection.js'

export interface MentionReadPublishResult {
  pts: number
  ptsCount: number
}

/** Converts committed platform events to account-scoped MTProto updates. */
export class UpdateManager {
  constructor(
    private readonly _database: Database,
    private readonly _registry: PlatformRegistry,
    private readonly _store: MessageStore,
    private readonly _sendUpdate: (
      authKeyId: Uint8Array,
      update: tl.TypeUpdates,
      excludeConnection?: ServerConnection,
    ) => number,
    private readonly _dcId = 1,
    private readonly _onTrace?: (format: string, ...args: unknown[]) => void,
    private readonly _projectSticker?: (
      session: PlatformSession,
      sticker: IMSticker,
    ) => tl.TypeMessageMedia | undefined,
    private readonly _blockedPeers?: BlockedPeerStore,
    private readonly _registerReactions?: (session: PlatformSession, message: IMMessage) => void,
    private readonly _messageProjection?: MessageProjectionPipeline,
  ) {}

  private async _hydrateReactionUsers(
    session: PlatformSession,
    message: IMMessage,
  ): Promise<{ ids: Map<string, number>, users: tl.RawUser[] }> {
    const actorIds = [...new Set((message.reactionContext?.reactions ?? []).flatMap((reaction) =>
      (reaction.recentActors ?? []).slice(0, 3).map((actor) => actor.userId)))]
    if (!actorIds.length) return { ids: new Map(), users: [] }
    const platform = this._registry.require(session.platformId)
    const profiles = await Promise.all(actorIds.map(async (actorId) => {
      try {
        const profile = await platform.getUser?.(session, actorId)
        if (profile) return profile
      } catch (error) {
        this._onTrace?.(
          'reaction actor profile lookup failed platform=%s session=%s user=%s error=%s',
          session.platformId, session.platformSessionId, actorId, String(error),
        )
      }
      const stored = await this._store.getUser(session.platformId, actorId)
      return stored ? toUser(stored) : { id: actorId, firstName: actorId }
    }))
    const rows = await this._store.upsertUsers(session, profiles)
    return {
      ids: new Map(rows.map((row) => [row.platformUserId, row.id])),
      users: rows.map((row) => {
        const user = toUser(row)
        return makeUser({
          id: row.id,
          self: row.platformUserId === session.userId || undefined,
          premium: row.platformUserId === session.userId || undefined,
          firstName: user.firstName,
          lastName: user.lastName,
          username: user.username,
          phone: row.platformUserId === session.userId ? session.virtualPhone : undefined,
          photo: user.avatar ? makeUpdateAvatar(user.avatar.id, this._dcId, 'user') : undefined,
        })
      }),
    }
  }

  async publishPeerBlocked(
    session: PlatformSession,
    userId: number,
    blocked: boolean,
    changedAt: Date,
  ): Promise<void> {
    await this._blockedPeers?.ensureLoaded(session.platformSessionId)
    const state = await this._store.getUpdateState(session.platformSessionId)
    await this._send(session.platformSessionId, {
      _: 'updates',
      updates: [{
        _: 'updatePeerBlocked', blocked: blocked || undefined,
        peerId: { _: 'peerUser', userId },
      }],
      users: [], chats: [], date: Math.floor(changedAt.getTime() / 1000), seq: state.seq,
    })
    if (!blocked || !this._blockedPeers || this._blockedPeers.mode === 'show') return

    const groups = new Map<string, {
      conversation: IMConversation
      deletedMessageIds: number[]
      reactionMessages: Array<{ message: IMMessage, messageIds: number[] }>
    }>()
    for (const projected of await this._store.listProjectedMessages(session.platformSessionId)) {
      const hidden = await this._blockedPeers.hidesMessage(
        session.platformSessionId, projected.source, this._store,
      )
      const visibleMessage = hidden
        ? projected.source
        : this._blockedPeers.filterMessageReactions(session.platformSessionId, projected.source)
      if (!hidden && visibleMessage === projected.source) continue
      let conversation = await this._store.getConversation(
        session.platformSessionId, projected.source.conversationId,
      ) ?? {
        id: projected.source.conversationId,
        kind: 'direct' as const,
        title: projected.source.conversationId,
      }
      if (conversation.kind === 'channel' && conversation.parentId) {
        conversation = await this._store.getConversation(session.platformSessionId, conversation.parentId)
          ?? { id: conversation.parentId, kind: 'channel', title: conversation.parentId }
      }
      const key = conversation.kind === 'direct' ? `direct:${conversation.id}` : `channel:${conversation.id}`
      const group = groups.get(key) ?? { conversation, deletedMessageIds: [], reactionMessages: [] }
      const messageIds = projected.parts.map((part) => part.tlMessageId)
      if (hidden) group.deletedMessageIds.push(...messageIds)
      else group.reactionMessages.push({ message: visibleMessage, messageIds })
      groups.set(key, group)
    }

    for (const [scope, group] of groups) {
      const messageIds = [...new Set(group.deletedMessageIds)].sort((left, right) => left - right)
      const channelId = group.conversation.kind === 'direct'
        ? undefined
        : stableId(`peer:${group.conversation.id}`)
      const eventKey = [
        session.platformSessionId, 'block-delete', userId, changedAt.getTime(), scope,
      ].join(':')
      const delivery = await this._store.prepareUpdateDelivery(
        eventKey, session.platformSessionId, messageIds.length,
        Math.floor(changedAt.getTime() / 1000), channelId,
      )
      const directPeerId = group.conversation.kind === 'direct'
        ? (await this._store.getUser(session.platformId, group.conversation.id)
          ?? await this._store.upsertUser(
            session,
            await this._registry.require(session.platformId).getUser?.(session, group.conversation.id)
              ?? { id: group.conversation.id, firstName: group.conversation.title },
          )).id
        : undefined
      const peer = conversationPeer(group.conversation, directPeerId)
      const updates: tl.TypeUpdate[] = []
      if (messageIds.length) {
        updates.push(channelId === undefined
          ? {
              _: 'updateDeleteMessages', messages: messageIds,
              pts: delivery.pts, ptsCount: delivery.ptsCount,
            }
          : {
              _: 'updateDeleteChannelMessages', channelId, messages: messageIds,
              pts: delivery.pts, ptsCount: delivery.ptsCount,
            })
      }
      for (const item of group.reactionMessages) {
        this._registerReactions?.(session, item.message)
        const reactions = makeMessageReactions(item.message, session.platformSessionId)
        updates.push(...item.messageIds.map((msgId): tl.RawUpdateMessageReactions => ({
          _: 'updateMessageReactions', peer, msgId, reactions,
        })))
      }
      const payload: tl.RawUpdates = {
        _: 'updates', updates, users: [],
        chats: channelId === undefined ? [] : [this._makeChat(group.conversation)],
        date: delivery.date, seq: delivery.seq,
      }
      await this._store.setUpdatePayload(eventKey, updateToJson(payload))
      if (await this._send(session.platformSessionId, payload)) {
        await this._store.markUpdatePublished(eventKey)
      }
    }
  }

  async publishDraft(
    session: PlatformSession,
    update: tl.RawUpdateDraftMessage,
    excludeAuthKeyId?: string,
  ): Promise<void> {
    const state = await this._store.getUpdateState(session.platformSessionId)
    await this._send(session.platformSessionId, {
      _: 'updates', updates: [update], users: [], chats: [],
      date: Math.floor(Date.now() / 1000), seq: state.seq,
    }, excludeAuthKeyId)
  }

  async publishNotification(
    session: PlatformSession,
    notificationUpdates: tl.RawUpdateNotifySettings[],
    excludeAuthKeyId?: string,
  ): Promise<void> {
    const state = await this._store.getUpdateState(session.platformSessionId)
    await this._send(session.platformSessionId, {
      _: 'updates', updates: notificationUpdates, users: [], chats: [],
      date: Math.floor(Date.now() / 1000), seq: state.seq,
    }, excludeAuthKeyId)
  }

  async publishAccountUpdates(
    session: PlatformSession,
    accountUpdates: tl.TypeUpdate[],
    excludeAuthKeyId?: string,
  ): Promise<void> {
    const state = await this._store.getUpdateState(session.platformSessionId)
    await this._send(session.platformSessionId, {
      _: 'updates', updates: accountUpdates, users: [], chats: [],
      date: Math.floor(Date.now() / 1000), seq: state.seq,
    }, excludeAuthKeyId)
  }

  /** Publishes mention-content acknowledgements to every other authorized device. */
  async publishMentionRead(
    session: PlatformSession,
    conversation: IMConversation,
    tlMessageIds: readonly number[],
    topMsgId: number | undefined,
    excludeConnection?: ServerConnection,
  ): Promise<MentionReadPublishResult> {
    const messageIds = [...new Set(tlMessageIds)]
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((left, right) => left - right)
    if (!messageIds.length) {
      const state = await this._store.getUpdateState(session.platformSessionId)
      return { pts: state.pts, ptsCount: 0 }
    }

    const date = Math.floor(Date.now() / 1000)
    const channelId = conversation.kind === 'direct'
      ? undefined
      : stableId(`peer:${conversation.id}`)
    const eventKey = [
      session.platformSessionId,
      'mention-read',
      channelId === undefined ? 'account' : `channel:${channelId}`,
      topMsgId ?? 0,
      ...messageIds,
    ].join(':')
    const delivery = await this._store.prepareUpdateDelivery(
      eventKey,
      session.platformSessionId,
      messageIds.length,
      date,
      channelId,
    )
    const update: tl.TypeUpdate = channelId === undefined
      ? {
          _: 'updateReadMessagesContents',
          messages: messageIds,
          pts: delivery.pts,
          ptsCount: delivery.ptsCount,
        }
      : {
          _: 'updateChannelReadMessagesContents',
          channelId,
          topMsgId,
          messages: messageIds,
        }
    const payload: tl.RawUpdates = {
      _: 'updates',
      updates: [update],
      users: [],
      chats: channelId === undefined ? [] : [makeUpdateChat(conversation, Boolean(topMsgId), this._dcId)],
      date: delivery.date,
      seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, updateToJson(payload))
    await this._send(session.platformSessionId, payload, undefined, excludeConnection)
    // The initiating connection acknowledged the same mutation through its RPC
    // result, while offline devices can still recover the retained payload via
    // updates.getDifference / updates.getChannelDifference.
    await this._store.markUpdatePublished(eventKey)

    if (channelId === undefined) return { pts: delivery.pts, ptsCount: delivery.ptsCount }
    const state = await this._store.getUpdateState(session.platformSessionId)
    return { pts: state.pts, ptsCount: 0 }
  }

  /** Sends an ephemeral phone update without adding call data to the update journal. */
  async publishPhoneCall(
    session: PlatformSession,
    update: tl.RawUpdatePhoneCall,
    excludeAuthKeyId?: string,
  ): Promise<number> {
    const payload: tl.TypeUpdates = {
      _: 'updateShort', update, date: Math.floor(Date.now() / 1_000),
    }
    const bindings = await this._database.get('mtproto_auth_binding', {
      platformSessionId: session.platformSessionId,
    })
    let delivered = 0
    for (const binding of bindings) {
      if (binding.authKeyId !== excludeAuthKeyId) delivered += this._sendUpdate(hexBytes(binding.authKeyId), payload)
    }
    return delivered
  }

  /** Sends one ephemeral call-scoped signaling update without journaling it. */
  async publishPhoneSignaling(
    session: PlatformSession,
    update: tl.RawUpdatePhoneCallSignalingData,
    excludeAuthKeyId?: string,
  ): Promise<number> {
    const payload: tl.TypeUpdates = {
      _: 'updateShort', update, date: Math.floor(Date.now() / 1_000),
    }
    const bindings = await this._database.get('mtproto_auth_binding', {
      platformSessionId: session.platformSessionId,
    })
    let delivered = 0
    for (const binding of bindings) {
      if (binding.authKeyId !== excludeAuthKeyId) delivered += this._sendUpdate(hexBytes(binding.authKeyId), payload)
    }
    return delivered
  }

  /** Replays only a current in-memory call snapshot to its already-authorized binding. */
  async replayPhoneCall(
    session: PlatformSession,
    update: tl.RawUpdatePhoneCall,
    authKeyId: string,
  ): Promise<number> {
    const [binding] = await this._database.get('mtproto_auth_binding', {
      authKeyId, platformSessionId: session.platformSessionId,
    })
    if (!binding) return 0
    return this._sendUpdate(hexBytes(authKeyId), { _: 'updateShort', update, date: Math.floor(Date.now() / 1_000) })
  }

  async publish(
    session: PlatformSession,
    committed: CommittedPlatformEvent,
    options: PlatformEventDeliveryOptions = {},
  ): Promise<PlatformEventPublishResult> {
    this._onTrace?.(
      'update publish start platform=%s session=%s %s',
      session.platformId, session.platformSessionId, committedEventSummary(committed),
    )
    if (committed.event.type === 'voice-call') return
    if (committed.event.type === 'message-delete') {
      return this._publishDelete(
        session,
        committed as Extract<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
        options,
      )
    }
    if (committed.event.type === 'message-reactions') {
      await this._publishReactions(
        session,
        committed as Extract<CommittedPlatformEvent, { event: { type: 'message-reactions' } }>,
      )
      return
    }
    if (committed.event.type === 'read') {
      await this._publishRead(
        session,
        committed as Extract<CommittedPlatformEvent, { event: { type: 'read' } }>,
        options,
      )
      return
    }
    return this._publishMessage(
      session,
      committed as Exclude<CommittedPlatformEvent, {
        event: { type: 'message-delete' | 'message-reactions' | 'read' | 'voice-call' }
      }>,
      options,
    )
  }

  private async _publishReactions(
    session: PlatformSession,
    committed: Extract<CommittedPlatformEvent, { event: { type: 'message-reactions' } }>,
  ): Promise<void> {
    const { event, result } = committed
    await this._blockedPeers?.ensureLoaded(session.platformSessionId)
    if (await this._blockedPeers?.hidesMessage(session.platformSessionId, result.message, this._store)) return
    const eventKey = `${session.platformSessionId}:reaction:${event.eventId}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    if (!delivery && !result.changed) return
    const platform = this._registry.require(session.platformId)
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
    const visibleMessage = this._blockedPeers?.filterMessageReactions(
      session.platformSessionId, result.message,
    ) ?? result.message
    this._registerReactions?.(session, visibleMessage)
    const reactionUsers = await this._hydrateReactionUsers(session, visibleMessage)
    const reactions = makeMessageReactions(
      visibleMessage,
      session.platformSessionId,
      (userId) => reactionUsers.ids.get(userId),
      platform.capabilities.reactions?.actorList === true,
      session.userId,
    )
    const directPeerId = displayConversation.kind === 'direct'
      ? (await this._store.getUser(session.platformId, displayConversation.id)
        ?? await this._store.upsertUser(session,
          await platform.getUser?.(session, displayConversation.id)
            ?? { id: displayConversation.id, firstName: displayConversation.title })).id
      : undefined
    let pts = delivery.pts - delivery.ptsCount
    const updates = result.tlMessageIds.map((msgId): tl.RawUpdateMessageReactions => ({
      _: 'updateMessageReactions',
      peer: conversationPeer(displayConversation, directPeerId),
      msgId,
      reactions,
    }))
    // updateMessageReactions itself does not carry pts; account pts is retained
    // in the durable delivery state for difference/retry ordering.
    pts += updates.length
    void pts
    const payload: tl.RawUpdates = {
      _: 'updates', updates, users: reactionUsers.users,
      chats: displayConversation.kind === 'direct' ? [] : [this._makeChat(displayConversation)],
      date: delivery.date, seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, updateToJson(payload))
    if (await this._send(session.platformSessionId, payload)) await this._store.markUpdatePublished(eventKey)
  }

  private async _publishRead(
    session: PlatformSession,
    committed: Extract<CommittedPlatformEvent, { event: { type: 'read' } }>,
    options: PlatformEventDeliveryOptions,
  ): Promise<void> {
    const { event, result } = committed
    const displayConversation = result.conversation.kind === 'channel' && result.conversation.parentId
      ? await this._store.getConversation(session.platformSessionId, result.conversation.parentId)
        ?? { id: result.conversation.parentId, kind: 'channel' as const, title: result.conversation.parentId }
      : result.conversation
    const channelId = displayConversation.kind === 'direct'
      ? undefined
      : stableId(`peer:${displayConversation.id}`)
    const eventKey = `${session.platformSessionId}:read:${event.conversationId}:${event.upToMessageId}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    delivery ??= await this._store.prepareUpdateDelivery(
      eventKey, session.platformSessionId, 1, result.message.timestamp, channelId,
    )
    if (delivery.published) return

    let update: tl.TypeUpdate
    if (channelId !== undefined) {
      update = {
        _: 'updateReadChannelInbox', channelId,
        maxId: result.tlMessageId, stillUnreadCount: result.unreadCount,
        pts: delivery.pts,
      }
    } else {
      const platform = this._registry.require(session.platformId)
      const user = await this._store.getUser(session.platformId, displayConversation.id)
        ?? await this._store.upsertUser(session, displayConversation.metadata?.bridgeOwned === true
          ? { id: displayConversation.id, firstName: displayConversation.title }
          : await platform.getUser?.(session, displayConversation.id)
            ?? { id: displayConversation.id, firstName: displayConversation.title })
      update = {
        _: 'updateReadHistoryInbox', peer: { _: 'peerUser', userId: user.id },
        maxId: result.tlMessageId, stillUnreadCount: result.unreadCount,
        pts: delivery.pts, ptsCount: delivery.ptsCount,
      }
    }
    const payload: tl.RawUpdates = {
      _: 'updates', updates: [update], users: [],
      chats: channelId === undefined ? [] : [this._makeChat(displayConversation)],
      date: delivery.date, seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, updateToJson(payload))
    if (await this._send(
      session.platformSessionId, payload, options.excludeAuthKeyId, options.excludeConnection,
    ) || options.deliveredViaRpc) {
      await this._store.markUpdatePublished(eventKey)
    }
  }

  private async _publishMessage(
    session: PlatformSession,
    committed: Exclude<CommittedPlatformEvent, {
      event: { type: 'message-delete' | 'message-reactions' | 'read' | 'voice-call' }
    }>,
    options: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
    const { event, result } = committed
    await this._blockedPeers?.ensureLoaded(session.platformSessionId)
    if (await this._blockedPeers?.hidesMessage(session.platformSessionId, event.message, this._store)) {
      this._onTrace?.(
        'update publish skipped session=%s message=%s reason=blocked-content',
        session.platformSessionId, event.message.id,
      )
      return
    }
    const visibleMessage = this._blockedPeers?.filterMessageReactions(
      session.platformSessionId, event.message,
    ) ?? event.message
    this._registerReactions?.(session, visibleMessage)
    const isEdit = event.type === 'message-edit'
    const eventKey = isEdit
      ? `${session.platformSessionId}:edit:${event.eventId}`
      : `${session.platformSessionId}:message:${result.message.id}`
    let delivery = await this._store.getUpdateDelivery(eventKey)
    if (!delivery && !result.created && !result.changed && !options.forceDelivery) {
      this._onTrace?.('update publish skipped eventKey=%s reason=unchanged-message', eventKey)
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
      eventKey, session.platformSessionId,
      result.projection.length + result.removedTlMessageIds.length,
      event.message.timestamp, channelId,
    )
    if (delivery.published) {
      this._onTrace?.('update publish skipped eventKey=%s reason=already-published', eventKey)
      const payload = delivery.payload ? updateFromJson(delivery.payload) : undefined
      return payload && (options.messageRandomIds?.length || options.messageReplyToTopId)
        ? withSendReconciliation(payload, options.messageRandomIds, options.messageReplyToTopId)
        : payload
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
    const selfProfile = await platform.getUser?.(session, session.userId)
      ?? {
        id: session.userId,
        firstName: String(session.metadata.firstName ?? 'Bridge'),
        lastName: session.metadata.lastName as string | undefined,
        username: session.metadata.username as string | undefined,
        metadata: session.metadata,
      }
    const senderProfile = event.message.sender
      ?? await platform.getUser?.(session, event.message.senderId)
      ?? { id: event.message.senderId, firstName: event.message.senderId }
    const selfRow = await this._store.upsertUser(session, selfProfile)
    const senderRow = event.message.senderId === session.userId
      ? selfRow
      : await this._store.upsertUser(session, senderProfile)
    const directPeerRow = displayConversation.kind === 'direct'
      ? await this._store.getUser(session.platformId, displayConversation.id)
        ?? await this._store.upsertUser(session, displayConversation.metadata?.bridgeOwned === true
          ? { id: displayConversation.id, firstName: displayConversation.title }
          : await platform.getUser?.(session, displayConversation.id)
            ?? { id: displayConversation.id, firstName: displayConversation.title })
      : undefined
    const reactionUsers = await this._hydrateReactionUsers(session, visibleMessage)
    const userIds = new Map((await this._store.listUsers(session.platformId))
      .map((row) => [row.platformUserId, row.id]))
    let pts = delivery.pts - delivery.ptsCount
    const addedTlMessageIds = new Set(result.addedTlMessageIds)
    const updates: tl.TypeUpdate[] = []
    const projectionChats: tl.TypeChat[] = []
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
      const qqReplySequence = qqReplySequenceFromMetadata(projected.source.metadata)
      const nativeReplyTo = qqReplySequence === undefined
        ? telegramReplyToMessageId(projected.source)
        : undefined
      let replied = projected.source.replyToId
        ? await this._store.findProjectedByPlatformId(
            session.platformSessionId, event.conversation.id, projected.source.replyToId,
          )
        : undefined
      if (!replied && qqReplySequence !== undefined) {
        replied = await this._store.findProjectedByNativeSequence(
            session.platformSessionId, event.conversation.id, qqReplySequence,
        )
      }
      if (!replied && nativeReplyTo) {
        replied = await this._store.findProjectedByTlId(
          session.platformSessionId, nativeReplyTo, event.conversation.id,
        )
      }
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
      const mentioned = event.conversation.kind !== 'direct'
        && part.ordinal === 0 && projected.source.outgoing !== true && (
        messageMentionsUser(projected.source, session.userId)
        || replied?.source.outgoing === true
      )
      if (part.ordinal === 0) {
        await this._store.setMessageMentioned(
          session.platformSessionId,
          event.conversation.id,
          part.tlMessageId,
          mentioned,
          true,
        )
      }
      const draft: import('./message-projection.js').MessageProjectionDraft = {
        source: projected.source,
        chats: [] as tl.TypeChat[],
      }
      const fallback = () => {
        const projectedSource = draft.source
        const projectedSticker = projectedSource.content.parts.find((item) => item.type === 'sticker')
        const projectedCard = projectedSource.content.parts.find((item) => item.type === 'card')
        const richMessage = draft.richMessage ?? makeTlArticleMedia(
          projectedSource, projected.media, this._dcId, {
            userId: (platformUserId) => requiredUserId(userIds, platformUserId),
            customEmojiId: (definition) => customReactionDocumentId(session.platformSessionId, definition),
          },
        )
        return {
          message: projectTlMessage({
            conversation: displayConversation,
            source: projectedSource,
            tlId: part.tlMessageId,
            ordinal: part.ordinal,
            groupedId: part.groupedId ?? undefined,
            fromId: { _: 'peerUser', userId: projectedSource.outgoing ? selfRow.id : senderRow.id },
            peerId: directPeerRow ? { _: 'peerUser', userId: directPeerRow.id } : undefined,
            richMessage,
            media: richMessage ? undefined : (draft.media ?? (media
              ? makeTlMessageMedia(media, projectedSource.timestamp, this._dcId)
              : projectedSticker?.type === 'sticker'
                ? this._projectSticker?.(session, projectedSticker.sticker)
                : projectedCard?.type === 'card'
                  ? makeTlCardPreview(projectedCard.card, this._dcId)
                  : undefined)),
            entities: draft.entities ?? makeMessageEntities(
              projectedSource, session.platformSessionId, userIds,
            ),
            reactions: projectedSource.reactionContext?.reactions.length
              ? makeMessageReactions(
                  this._blockedPeers?.filterMessageReactions(session.platformSessionId, projectedSource)
                    ?? projectedSource,
                  session.platformSessionId,
                  (userId) => userIds.get(userId),
                  platform.capabilities.reactions?.actorList === true,
                  session.userId,
                )
              : undefined,
            topicId,
            replyToTlId: replied?.parts[0]?.tlMessageId ?? nativeReplyTo,
            mentioned,
            unreadMention: mentioned,
          }),
          chats: draft.chats,
        }
      }
      const rendered = this._messageProjection
        ? await this._messageProjection.project({
            mode: 'update',
            session,
            conversation: displayConversation,
            tlMessageId: part.tlMessageId,
            ordinal: part.ordinal,
            draft,
            loadConversation: (linked) => this._loadProjectionCandidates(session, platform, linked),
          }, fallback)
        : fallback()
      const message = rendered.message
      projectionChats.push(...rendered.chats)
      updates.push({
        _: isEdit && !addedTlMessageIds.has(part.tlMessageId)
          ? event.conversation.kind !== 'direct' ? 'updateEditChannelMessage' : 'updateEditMessage'
          : event.conversation.kind !== 'direct' ? 'updateNewChannelMessage' : 'updateNewMessage',
        message,
        pts: ++pts,
        ptsCount: 1,
      } as tl.TypeUpdate)
    }
    if (isEdit && result.removedTlMessageIds.length) {
      updates.push(channelId === undefined
        ? {
            _: 'updateDeleteMessages', messages: result.removedTlMessageIds,
            pts: delivery.pts, ptsCount: result.removedTlMessageIds.length,
          }
        : {
            _: 'updateDeleteChannelMessages', channelId, messages: result.removedTlMessageIds,
            pts: delivery.pts, ptsCount: result.removedTlMessageIds.length,
          })
    }
    if (!updates.length) {
      this._onTrace?.('update publish skipped eventKey=%s reason=no-projected-updates', eventKey)
      return
    }

    const sender = toUser(senderRow)
    const self = toUser(selfRow)
    const selfUser = makeUser({
      id: selfRow.id, self: true, premium: true,
      firstName: self.firstName, lastName: self.lastName, username: self.username,
      phone: session.virtualPhone,
      photo: self.avatar ? makeUpdateAvatar(self.avatar.id, this._dcId, 'user') : undefined,
    })
    const users = uniqueUpdateUsers(senderRow.id === selfRow.id
      ? [selfUser, ...reactionUsers.users]
      : [selfUser, makeUser({
          id: senderRow.id,
          bot: sender.metadata?.bot === true || undefined,
          firstName: sender.firstName,
          lastName: sender.lastName,
          username: sender.username,
          photo: sender.avatar ? makeUpdateAvatar(sender.avatar.id, this._dcId, 'user') : undefined,
        }), ...reactionUsers.users])
    const chats = [
      ...(displayConversation.kind === 'direct'
        ? []
        : [this._makeChat(displayConversation, topicId !== undefined)]),
      ...projectionChats,
    ]
    const payload: tl.RawUpdates = {
      _: 'updates', updates, users, chats, date: delivery.date, seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, updateToJson(payload))
    const deliveredPayload = options.messageRandomIds?.length || options.messageReplyToTopId
      ? withSendReconciliation(payload, options.messageRandomIds, options.messageReplyToTopId)
      : payload
    this._onTrace?.(
      'update payload stored eventKey=%s updates=%d types=%s pts=%d seq=%d',
      eventKey, updates.length, updates.map((update) => update._).join(','), delivery.pts, delivery.seq,
    )
    if (await this._send(
      session.platformSessionId, deliveredPayload, options.excludeAuthKeyId, options.excludeConnection,
    ) || options.deliveredViaRpc) {
      await this._store.markUpdatePublished(eventKey)
      this._onTrace?.('update published eventKey=%s session=%s', eventKey, session.platformSessionId)
    } else {
      this._onTrace?.(
        'update pending eventKey=%s session=%s reason=no-live-auth-connection',
        eventKey, session.platformSessionId,
      )
    }
    return deliveredPayload
  }

  private async _publishDelete(
    session: PlatformSession,
    committed: Extract<CommittedPlatformEvent, { event: { type: 'message-delete' } }>,
    options: PlatformEventDeliveryOptions,
  ): Promise<PlatformEventPublishResult> {
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
    if (delivery.published) return delivery.payload ? updateFromJson(delivery.payload) : undefined
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
        : [this._makeChat(displayConversation, !!event.conversation.parentId)],
      date: delivery.date,
      seq: delivery.seq,
    }
    await this._store.setUpdatePayload(eventKey, updateToJson(payload))
    if (await this._send(
      session.platformSessionId, payload, options.excludeAuthKeyId, options.excludeConnection,
    ) || options.deliveredViaRpc) {
      await this._store.markUpdatePublished(eventKey)
    }
    return payload
  }

  private async _loadProjectionCandidates(
    session: PlatformSession,
    platform: IMPlatform,
    conversation: IMConversation,
  ): Promise<import('./message-projection.js').LinkedConversationProjectionCandidate[]> {
    if (!platform.getHistory) return []
    const history = await platform.getHistory(session, { id: conversation.id }, { limit: 200 })
    if (!history.messages.length) return []
    const ordered = history.messages.slice().sort((left, right) =>
      left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    const ingested = await this._store.ingestMany(
      session, conversation, ordered, { allocation: 'history' },
    )
    return ingested.flatMap((result, index) => result.projection
      .filter((part) => part.ordinal === 0)
      .map((part) => ({
        conversationId: conversation.id,
        platformMessageId: ordered[index]!.id,
        tlMessageId: part.tlMessageId,
        timestamp: ordered[index]!.timestamp,
      })))
  }

  private _makeChat(conversation: IMConversation, forum = false): tl.TypeChat {
    return makeUpdateChat(conversation, forum, this._dcId)
  }

  private async _send(
    platformSessionId: string,
    payload: tl.RawUpdates,
    excludeAuthKeyId?: string,
    excludeConnection?: ServerConnection,
  ): Promise<boolean> {
    const bindings = await this._database.get('mtproto_auth_binding', { platformSessionId })
    let delivered = 0
    this._onTrace?.(
      'update send start session=%s bindings=%d updates=%d types=%s',
      platformSessionId, bindings.length, payload.updates.length,
      payload.updates.map((update) => update._).join(','),
    )
    for (const binding of bindings) {
      if (!excludeConnection && binding.authKeyId === excludeAuthKeyId) continue
      const connections = this._sendUpdate(hexBytes(binding.authKeyId), payload, excludeConnection)
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
      if (!await this._send(platformSessionId, updateFromJson(delivery.payload))) break
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
    const channelDeliveries = await this._store.getChannelUpdateDeliveriesSince(
      platformSessionId, request.date,
    )
    if (!deliveries.length && !channelDeliveries.length && request.pts === state.pts) {
      return { _: 'updates.differenceEmpty', date: state.date, seq: state.seq }
    }
    const requestedLimit = request.ptsLimit ?? request.ptsTotalLimit ?? 100
    // prepareUpdateDelivery reserves pts before the publisher finishes the payload.
    // A concurrent difference must stop there or the client permanently skips it.
    const firstIncomplete = deliveries.findIndex((delivery) => !delivery.payload)
    const readyDeliveries = firstIncomplete < 0 ? deliveries : deliveries.slice(0, firstIncomplete)
    const page = readyDeliveries.slice(0, Math.max(1, Math.min(requestedLimit, 100)))
    const newMessages: tl.TypeMessage[] = []
    const otherUpdates: tl.TypeUpdate[] = []
    const chats = new Map<string, tl.TypeChat>()
    const users = new Map<string, tl.TypeUser>()
    for (const delivery of page.filter((delivery) => delivery.payload)) {
      const payload = updateFromJson(delivery.payload)
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
    // Channel pts are intentionally independent from account pts, so a client
    // that was disconnected cannot identify missed dialogs from its account
    // cursor alone. Surface one channel-too-long marker per changed channel;
    // Telegram clients then compare their durable channel pts and fetch every
    // missing channel without opening the chat first. Repeated markers are safe
    // when multiple events share the same second because channel difference is
    // itself pts-deduplicated.
    const changedChannels = new Map<number, number>()
    for (const delivery of channelDeliveries.filter((delivery) => delivery.payload)) {
      const channelId = Number(delivery.scope.slice('channel:'.length))
      if (!Number.isSafeInteger(channelId)) continue
      changedChannels.set(channelId, Math.max(changedChannels.get(channelId) ?? 0, delivery.pts))
      const payload = updateFromJson(delivery.payload)
      for (const chat of payload.chats) chats.set(`${chat._}:${chat.id}`, chat)
      for (const user of payload.users) users.set(`${user._}:${user.id}`, user)
    }
    otherUpdates.push(...[...changedChannels].map(([channelId, pts]): tl.RawUpdateChannelTooLong => ({
      _: 'updateChannelTooLong', channelId, pts,
    })))
    for (const delivery of page) await this._store.markUpdatePublished(delivery.eventKey)
    const difference = {
      newMessages, newEncryptedMessages: [], otherUpdates,
      chats: [...chats.values()], users: [...users.values()],
    }
    if (!page.length && deliveries.length) {
      const pending = deliveries[0]
      return {
        _: 'updates.differenceSlice', ...difference,
        intermediateState: {
          _: 'updates.state', pts: request.pts, qts: request.qts,
          date: request.date, seq: Math.max(0, pending.seq - 1), unreadCount: 0,
        },
      }
    }
    if (page.length < deliveries.length) {
      const last = page.at(-1)!
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
    // Channel short-polls race live publication frequently, so never acknowledge
    // the reserved pts until the corresponding update payload is durable.
    const firstIncomplete = deliveries.findIndex((delivery) => !delivery.payload)
    const readyDeliveries = firstIncomplete < 0 ? deliveries : deliveries.slice(0, firstIncomplete)
    const page = readyDeliveries.slice(0, Math.max(1, Math.min(request.limit, 100)))
    if (!page.length) {
      return { _: 'updates.channelDifferenceEmpty', final: false, pts: request.pts }
    }
    const newMessages: tl.TypeMessage[] = []
    const otherUpdates: tl.TypeUpdate[] = []
    const chats = new Map<string, tl.TypeChat>()
    const users = new Map<string, tl.TypeUser>()
    for (const delivery of page.filter((delivery) => delivery.payload)) {
      const payload = updateFromJson(delivery.payload)
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
  const { event } = committed
  if (event.type === 'voice-call') {
    return `type=voice-call signal=${event.signal} media=${event.media} conversation=${event.conversation.id}`
  }
  const { result } = committed as Exclude<CommittedPlatformEvent, { event: { type: 'voice-call' } }>
  if (event.type === 'message' || event.type === 'message-edit') {
    const ingest = result as import('./message-store.js').IngestResult
    return `type=${event.type} conversation=${event.conversation.id} message=${event.message.id} created=${ingest.created} changed=${ingest.changed} projection=${ingest.projection.length}`
  }
  if (event.type === 'message-delete') {
    const deletion = result as import('./message-store.js').DeleteResult
    return `type=message-delete conversation=${event.conversation.id} eventId=${event.eventId} changed=${deletion.changed} tlMessages=${deletion.tlMessageIds.length}`
  }
  if (event.type === 'read') {
    const read = result as import('./message-store.js').ReadResult
    return `type=read conversation=${event.conversationId} message=${event.upToMessageId} unread=${read.unreadCount}`
  }
  const reactions = result as import('./message-store.js').ReactionResult
  return `type=message-reactions conversation=${event.conversation.id} eventId=${event.eventId} changed=${reactions.changed} tlMessages=${reactions.tlMessageIds.length}`
}

function makeMessageEntities(
  message: IMMessage,
  platformSessionId: string,
  userIds: ReadonlyMap<string, number>,
): tl.TypeMessageEntity[] | undefined {
  const entities: tl.TypeMessageEntity[] = []
  const rendered = message.content.parts.flatMap((part) => {
    const text = messagePartText(part)
    return text ? [{ part, text }] : []
  })
  let base = 0
  for (const [index, { part, text }] of rendered.entries()) {
    for (const entity of part.type === 'text' ? part.entities ?? [] : []) {
      if (entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > text.length) continue
      if (entity.type === 'mention') {
        entities.push({
          _: 'messageEntityMentionName', offset: base + entity.offset, length: entity.length,
          userId: requiredUserId(userIds, entity.userId),
        })
      } else if (entity.type === 'text-link') {
        entities.push({
          _: 'messageEntityTextUrl', offset: base + entity.offset, length: entity.length,
          url: entity.url,
        })
      } else if (entity.type === 'bold') {
        entities.push({ _: 'messageEntityBold', offset: base + entity.offset, length: entity.length })
      } else if (entity.type === 'italic') {
        entities.push({ _: 'messageEntityItalic', offset: base + entity.offset, length: entity.length })
      } else if (entity.type === 'underline') {
        entities.push({ _: 'messageEntityUnderline', offset: base + entity.offset, length: entity.length })
      } else if (entity.type === 'strikethrough') {
        entities.push({ _: 'messageEntityStrike', offset: base + entity.offset, length: entity.length })
      } else if (entity.type === 'code') {
        entities.push({ _: 'messageEntityCode', offset: base + entity.offset, length: entity.length })
      } else if (entity.type === 'pre') {
        entities.push({
          _: 'messageEntityPre', offset: base + entity.offset, length: entity.length,
          language: entity.language ?? '',
        })
      } else if (entity.type === 'blockquote') {
        entities.push({ _: 'messageEntityBlockquote', offset: base + entity.offset, length: entity.length })
      } else if (entity.type === 'custom-emoji' && entity.definition.presentation.type === 'custom') {
        entities.push({
          _: 'messageEntityCustomEmoji', offset: base + entity.offset, length: entity.length,
          documentId: Long.fromNumber(stableId([
            'reaction-resource', 1, platformSessionId, message.conversationId,
            entity.definition.key, entity.definition.presentation.resource.version,
          ].join(':'))),
        })
      }
    }
    if (part.type === 'card') {
      const url = cardUrl(part.card)
      if (url) entities.push({
        _: 'messageEntityTextUrl', offset: base, length: text.length, url,
      })
    }
    base += text.length + (index + 1 < rendered.length ? 1 : 0)
  }
  return entities.length ? entities : undefined
}

function requiredUserId(userIds: ReadonlyMap<string, number>, platformUserId: string): number {
  const id = userIds.get(platformUserId)
  if (id === undefined) throw new Error(`missing persisted platform user ${platformUserId}`)
  return id
}

function makeUpdateChat(conversation: IMConversation, forum = false, dcId = 1): tl.TypeChat {
  const id = stableId(`peer:${conversation.id}`)
  const broadcast = conversation.metadata?.broadcast === true
  const creator = conversation.selfRole === 'owner'
  const administrator = conversation.selfRole === 'administrator'
  return {
    _: 'channel', creator: creator || undefined,
    adminRights: creator || administrator
      ? makeAdminRights(conversation.selfPermissions, creator)
      : undefined,
    defaultBannedRights: makeDefaultBannedRights(conversation.metadata?.readOnly === true),
    id, accessHash: Long.ONE, title: conversation.title,
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

function withSendReconciliation(
  payload: tl.RawUpdates,
  randomIds: readonly Long[] | undefined,
  replyToTopId: number | undefined,
): tl.RawUpdates {
  let index = 0
  const updates: tl.TypeUpdate[] = []
  for (const update of payload.updates) {
    if (update._ === 'updateNewMessage' || update._ === 'updateNewChannelMessage') {
      const randomId = randomIds?.[index++]
      if (randomId) updates.push({ _: 'updateMessageID', id: update.message.id, randomId })
    }
    updates.push(withReplyToTopId(update, replyToTopId))
  }
  return { ...payload, updates }
}

function withReplyToTopId(update: tl.TypeUpdate, replyToTopId: number | undefined): tl.TypeUpdate {
  if (!replyToTopId
    || (update._ !== 'updateNewMessage' && update._ !== 'updateNewChannelMessage')
    || update.message._ !== 'message'
    || update.message.replyTo?._ !== 'messageReplyHeader') return update
  return {
    ...update,
    message: {
      ...update.message,
      replyTo: { ...update.message.replyTo, replyToTopId },
    },
  }
}

function conversationPeer(conversation: IMConversation, directUserId?: number): tl.TypePeer {
  const id = conversation.kind === 'direct'
    ? directUserId ?? (() => { throw new Error(`missing direct user ID for ${conversation.id}`) })()
    : stableId(`peer:${conversation.id}`)
  return conversation.kind === 'direct'
    ? { _: 'peerUser', userId: id }
    : { _: 'peerChannel', channelId: id }
}

function makeMessageReactions(
  message: IMMessage,
  platformSessionId: string,
  resolveUserId?: (platformUserId: string) => number | undefined,
  canSeeList = false,
  selfUserId?: string,
): tl.RawMessageReactions {
  const definitions = new Map((message.reactionContext?.available ?? []).map((item) => [item.key, item]))
  const toReaction = (key: string): tl.TypeReaction | undefined => {
    const definition = definitions.get(key)
    if (!definition) return
    return definition.presentation.type === 'emoji'
      ? { _: 'reactionEmoji', emoticon: definition.presentation.emoticon }
      : { _: 'reactionCustomEmoji', documentId: Long.fromNumber(
          customReactionDocumentId(platformSessionId, definition),
        ) }
  }
  const recentReactions = (message.reactionContext?.reactions ?? []).flatMap((summary) => {
    const reaction = toReaction(summary.key)
    if (!reaction || !resolveUserId) return []
    return (summary.recentActors ?? []).slice(0, 3).flatMap((actor): tl.RawMessagePeerReaction[] => {
      const userId = resolveUserId(actor.userId)
      return userId === undefined ? [] : [{
        _: 'messagePeerReaction',
        my: actor.userId === selfUserId || undefined,
        peerId: { _: 'peerUser', userId },
        date: actor.timestamp ?? message.timestamp,
        reaction,
      }]
    })
  })
  return {
    _: 'messageReactions',
    canSeeList: canSeeList || undefined,
    results: (message.reactionContext?.reactions ?? []).flatMap((summary) => {
      const reaction = toReaction(summary.key)
      return reaction ? [{
        _: 'reactionCount', reaction, count: summary.count,
        chosenOrder: summary.selected ? summary.selectedOrder ?? 0 : undefined,
      } as tl.RawReactionCount] : []
    }),
    recentReactions: recentReactions.length ? recentReactions : undefined,
  }
}

function uniqueUpdateUsers(users: tl.RawUser[]): tl.RawUser[] {
  const unique = new Map<number, tl.RawUser>()
  for (const user of users) if (!unique.has(user.id)) unique.set(user.id, user)
  return [...unique.values()]
}
