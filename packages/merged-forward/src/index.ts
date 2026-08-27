import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  stableId,
  type BridgeSessionState,
  type IMConversation,
  type LinkedConversationProjectionCandidate,
  type MessageProjectionInput,
  type MessageProjectionResult,
  type ProjectedDialogPeer,
} from '@mtproto-relay/bridge'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['mtproto', 'mtprotoBridge']

export const MERGED_FORWARD_VIEW = 'merged-forward'

interface MergedForwardRecord {
  platformSessionId: string
  chatId: number
  conversation: IMConversation
  target?: LinkedConversationProjectionCandidate
}

export function isMergedForwardConversation(conversation: IMConversation): boolean {
  return conversation.metadata?.conversationView === MERGED_FORWARD_VIEW
}

/** Feature-owned address book, renderer, target cache, durable recovery, and RPC admission policy. */
export class MergedForwardProjection {
  private readonly _records = new Map<string, Map<number, MergedForwardRecord>>()
  private readonly _targetJobs = new Map<string, Promise<LinkedConversationProjectionCandidate | undefined>>()
  private readonly _hydrateJobs = new Map<string, Promise<void>>()
  private readonly _hydratedSessions = new Set<string>()

  supports(conversation: IMConversation): boolean {
    return isMergedForwardConversation(conversation)
  }

  remember(platformSessionId: string, chatId: number, conversation: IMConversation): string | undefined {
    if (!this.supports(conversation)) return
    const records = this._records.get(platformSessionId) ?? new Map<number, MergedForwardRecord>()
    const previous = records.get(chatId)
    const record: MergedForwardRecord = {
      platformSessionId,
      chatId,
      conversation,
      ...(previous?.conversation.id === conversation.id && previous.target
        ? { target: previous.target }
        : {}),
    }
    records.set(chatId, record)
    this._records.set(platformSessionId, records)
    return this.makeLink(platformSessionId, chatId)
  }

  resolve(platformSessionId: string, chatId: number): IMConversation | undefined {
    return this._record(platformSessionId, chatId)?.conversation
  }

  resolveUsername(
    platformSessionId: string,
    username: string,
  ): { chatId: number, conversation: IMConversation } | undefined {
    const match = /^bridgechat_(\d+)$/.exec(username)
    if (!match) return
    const chatId = Number(match[1])
    const conversation = this.resolve(platformSessionId, chatId)
    return conversation ? { chatId, conversation } : undefined
  }

  ownsMessage(platformSessionId: string, tlMessageId: number): boolean {
    return this.recordOwningMessage(platformSessionId, tlMessageId) !== undefined
  }

  recordOwningMessage(platformSessionId: string, tlMessageId: number): MergedForwardRecord | undefined {
    for (const record of this._records.get(platformSessionId)?.values() ?? []) {
      if (record.target?.tlMessageId === tlMessageId) return record
    }
  }

  target(platformSessionId: string, chatId: number): LinkedConversationProjectionCandidate | undefined {
    return this._record(platformSessionId, chatId)?.target
  }

  setTarget(
    platformSessionId: string,
    chatId: number,
    target: LinkedConversationProjectionCandidate,
  ): boolean {
    const record = this._record(platformSessionId, chatId)
    if (!record) return false
    record.target = target
    return true
  }

  makeLink(platformSessionId: string, chatId: number): string | undefined {
    const record = this._record(platformSessionId, chatId)
    if (!record) return
    return `https://t.me/bridgechat_${chatId}${record.target ? `/${record.target.tlMessageId}` : ''}`
  }

  makePreview(platformSessionId: string, chatId: number): tl.RawMessageMediaWebPage | undefined {
    const record = this._record(platformSessionId, chatId)
    const url = this.makeLink(platformSessionId, chatId)
    if (!record || !url) return
    const preview = record.conversation.metadata?.conversationViewPreview
    const detailedPreview = typeof preview === 'string' && isDetailedConversationPreview(preview)
      ? preview.trim()
      : undefined
    return {
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage',
        id: Long.fromNumber(stableId(`conversation-preview:${record.conversation.id}`)),
        url, displayUrl: record.conversation.title, hash: 0,
        type: 'telegram_message', title: record.conversation.title,
        description: detailedPreview ?? '点击查看合并转发消息',
      },
    }
  }

  makeChat(platformSessionId: string, chatId: number): tl.TypeChat | undefined {
    const record = this._record(platformSessionId, chatId)
    if (!record) return
    return {
      _: 'chat', left: true, id: chatId, title: record.conversation.title,
      photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
    }
  }

  makeFullChat(
    platformSessionId: string,
    chatId: number,
    notifySettings: tl.TypePeerNotifySettings,
  ): tl.messages.RawChatFull | undefined {
    const chat = this.makeChat(platformSessionId, chatId)
    if (!chat) return
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO }, notifySettings, botInfo: [],
      },
      chats: [chat], users: [],
    }
  }

  projectedPeer(platformSessionId: string, chatId: number): ProjectedDialogPeer | undefined {
    const record = this._record(platformSessionId, chatId)
    const chat = this.makeChat(platformSessionId, chatId)
    if (!record || !chat) return
    return {
      conversation: record.conversation,
      peer: { _: 'peerChat', chatId },
      chat,
    }
  }

  async ensureHydrated(state: BridgeSessionState): Promise<void> {
    const sessionId = state.session.platformSessionId
    if (this._hydratedSessions.has(sessionId)) return
    const existing = this._hydrateJobs.get(sessionId)
    if (existing) return existing
    const pending = (async () => {
      const conversations = await state.store.listConversations(sessionId)
      for (const conversation of conversations) {
        if (!this.supports(conversation)) continue
        const chatId = stableId(`peer:${conversation.id}`)
        this.remember(sessionId, chatId, conversation)
        if (this.target(sessionId, chatId)) continue
        const [latest] = await state.store.readProjectedHistory(sessionId, conversation.id, { limit: 1 })
        const part = latest?.parts.find((candidate) => candidate.ordinal === 0)
        if (!latest || !part) continue
        this.setTarget(sessionId, chatId, {
          conversationId: conversation.id,
          platformMessageId: latest.source.id,
          tlMessageId: part.tlMessageId,
          timestamp: latest.source.timestamp,
        })
      }
      this._hydratedSessions.add(sessionId)
    })()
    this._hydrateJobs.set(sessionId, pending)
    try {
      await pending
    } finally {
      if (this._hydrateJobs.get(sessionId) === pending) this._hydrateJobs.delete(sessionId)
    }
  }

  async project(
    input: MessageProjectionInput,
    next: () => MessageProjectionResult | Promise<MessageProjectionResult>,
  ): Promise<MessageProjectionResult> {
    if (input.ordinal !== 0) return next()
    const linked = input.draft.source.content.parts
      .filter((part) => part.type === 'text')
      .flatMap((part) => part.entities ?? [])
      .filter((entity) => entity.type === 'conversation-link' && this.supports(entity.conversation))
    if (!linked.length) return next()

    const urls = new Map<string, string>()
    for (const entity of linked) {
      if (entity.type !== 'conversation-link' || urls.has(entity.conversation.id)) continue
      const conversation = entity.conversation
      const chatId = stableId(`peer:${conversation.id}`)
      this.remember(input.session.platformSessionId, chatId, conversation)
      await this._ensureTarget(input, conversation, chatId)
      const url = this.makeLink(input.session.platformSessionId, chatId)
      if (!url) continue
      urls.set(conversation.id, url)
      const chat = this.makeChat(input.session.platformSessionId, chatId)
      if (chat) input.draft.chats.push(chat)
    }
    if (!urls.size) return next()

    const source = input.draft.source
    input.draft.source = {
      ...source,
      content: {
        ...source.content,
        parts: source.content.parts.map((part) => part.type !== 'text' ? part : {
          ...part,
          entities: part.entities?.map((entity) => {
            if (entity.type !== 'conversation-link') return entity
            const url = urls.get(entity.conversation.id)
            return url ? {
              type: 'text-link' as const, offset: entity.offset, length: entity.length, url,
            } : entity
          }),
        }),
      },
    }
    if (!source.content.parts.some((part) =>
      part.type === 'media' || part.type === 'sticker' || part.type === 'card')) {
      const first = linked[0]
      if (first?.type === 'conversation-link') {
        input.draft.media = this.makePreview(
          input.session.platformSessionId, stableId(`peer:${first.conversation.id}`),
        )
      }
    }
    return next()
  }

  clear(): void {
    this._records.clear()
    this._targetJobs.clear()
    this._hydrateJobs.clear()
    this._hydratedSessions.clear()
  }

  private async _ensureTarget(
    input: MessageProjectionInput,
    conversation: IMConversation,
    chatId: number,
  ): Promise<LinkedConversationProjectionCandidate | undefined> {
    const existing = this.target(input.session.platformSessionId, chatId)
    if (existing || !input.loadConversation) return existing
    const key = `${input.session.platformSessionId}\u0000${chatId}\u0000${conversation.id}`
    let pending = this._targetJobs.get(key)
    if (!pending) {
      pending = input.loadConversation(conversation).then((candidates) => {
        const latest = candidates.slice().sort((left, right) =>
          right.timestamp - left.timestamp || right.tlMessageId - left.tlMessageId)[0]
        if (!latest) return
        this.setTarget(input.session.platformSessionId, chatId, latest)
        return latest
      })
      this._targetJobs.set(key, pending)
      pending.finally(() => {
        if (this._targetJobs.get(key) === pending) this._targetJobs.delete(key)
      }).catch(() => {})
    }
    return pending
  }

  private _record(platformSessionId: string, chatId: number): MergedForwardRecord | undefined {
    return this._records.get(platformSessionId)?.get(chatId)
  }
}

export function makeMergedForwardProvider(): MergedForwardProjection {
  return new MergedForwardProjection()
}

export function apply(ctx: Context): void {
  const projection = new MergedForwardProjection()
  ctx.on('bridge/message/project', (input, next) => projection.project(input, next))
  ctx.on('mtproto/rpc', async function (
    this: ServerRpcContext,
    request: tl.RpcMethod,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const result = await routeMergedForwardRpc(ctx, projection, this, request)
    if (result === undefined) return next()
    return result
  } as never, { prepend: true })
  ctx.effect(() => () => projection.clear(), 'mergedForward.clear')
}

async function routeMergedForwardRpc(
  ctx: Context,
  projection: MergedForwardProjection,
  rpc: ServerRpcContext,
  request: tl.RpcMethod,
): Promise<unknown | undefined> {
  const resolveState = async () => {
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    await projection.ensureHydrated(state)
    return state
  }
  if (request._ === 'contacts.resolveUsername') {
    const req = request as tl.contacts.RawResolveUsernameRequest
    if (!/^bridgechat_\d+$/.test(req.username)) return
    const state = await resolveState()
    const resolved = projection.resolveUsername(state.session.platformSessionId, req.username)
    if (!resolved) return
    const chat = projection.makeChat(state.session.platformSessionId, resolved.chatId)
    if (!chat) return
    return {
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: resolved.chatId },
      chats: [chat], users: [],
    }
  }
  if (request._ === 'messages.getFullChat') {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await resolveState()
    const conversation = projection.resolve(state.session.platformSessionId, req.chatId)
    if (!conversation) return
    return projection.makeFullChat(
      state.session.platformSessionId,
      req.chatId,
      await state.dialogs.getConversationNotifySettings(conversation),
    )
  }
  if (
    request._ === 'messages.getHistory'
    || request._ === 'messages.readHistory'
    || request._ === 'messages.getScheduledHistory'
    || request._ === 'messages.getPeerSettings'
  ) {
    const req = request as tl.messages.RawGetHistoryRequest
      | tl.messages.RawReadHistoryRequest
      | tl.messages.RawGetScheduledHistoryRequest
      | tl.messages.RawGetPeerSettingsRequest
    if (req.peer._ !== 'inputPeerChat') return
    const state = await resolveState()
    const projectedPeer = projection.projectedPeer(state.session.platformSessionId, req.peer.chatId)
    if (!projectedPeer) return
    if (request._ === 'messages.getHistory') return state.dialogs.getProjectedHistory(request, projectedPeer)
    if (request._ === 'messages.readHistory') {
      return state.dialogs.readProjectedHistory(request, projectedPeer, rpc.connection)
    }
    if (request._ === 'messages.getScheduledHistory') {
      return state.dialogs.getProjectedScheduledHistory(projectedPeer)
    }
    return state.dialogs.getProjectedPeerSettings(projectedPeer)
  }
  if (request._ === 'messages.getPeerDialogs') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const projectedEntries = req.peers.flatMap((item, index) => {
      if (item._ !== 'inputDialogPeer' || item.peer._ !== 'inputPeerChat') return []
      const projected = projection.projectedPeer(state.session.platformSessionId, item.peer.chatId)
      return projected ? [{ index, projected }] : []
    })
    if (!projectedEntries.length) return
    const projectedIndexes = new Set(projectedEntries.map((entry) => entry.index))
    const ordinaryPeers = req.peers.filter((_item, index) => !projectedIndexes.has(index))
    const projectedResult = await state.dialogs.getProjectedPeerDialogs(
      projectedEntries.map((entry) => entry.projected),
    )
    const ordinaryResult = ordinaryPeers.length
      ? await state.dialogs.getPeerDialogs({ ...req, peers: ordinaryPeers })
      : undefined
    return mergePeerDialogs(projectedResult, ordinaryResult)
  }
  if (request._ === 'messages.getMessages') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetMessagesRequest
    const ownedIds = req.id.filter((item) => item._ === 'inputMessageID'
      && projection.ownsMessage(state.session.platformSessionId, item.id))
    if (!ownedIds.length) return
    const ordinaryIds = req.id.filter((item) => !ownedIds.includes(item))
    const peers = [...new Set(ownedIds.flatMap((item) => {
      if (item._ !== 'inputMessageID') return []
      const record = projection.recordOwningMessage(state.session.platformSessionId, item.id)
      const projected = record
        ? projection.projectedPeer(state.session.platformSessionId, record.chatId)
        : undefined
      return projected ? [projected] : []
    }))]
    const projectedResult = await state.dialogs.getProjectedMessages({ ...req, id: ownedIds }, peers)
    const ordinaryResult = ordinaryIds.length
      ? await state.dialogs.getMessages({ ...req, id: ordinaryIds })
      : undefined
    return mergeMessages(req.id, projectedResult, ordinaryResult)
  }
}

function mergePeerDialogs(
  projected: tl.messages.RawPeerDialogs,
  ordinary?: tl.messages.RawPeerDialogs,
): tl.messages.RawPeerDialogs {
  if (!ordinary) return projected
  return {
    _: 'messages.peerDialogs',
    dialogs: [...ordinary.dialogs, ...projected.dialogs],
    messages: [...ordinary.messages, ...projected.messages],
    chats: uniqueById([...ordinary.chats, ...projected.chats]),
    users: uniqueById([...ordinary.users, ...projected.users]),
    state: ordinary.state,
  }
}

function mergeMessages(
  requested: readonly tl.TypeInputMessage[],
  projected: tl.messages.TypeMessages,
  ordinary?: tl.messages.TypeMessages,
): tl.messages.RawMessages {
  const projectedMessages = projected as Exclude<tl.messages.TypeMessages, tl.messages.RawMessagesNotModified>
  const ordinaryMessages = ordinary as Exclude<tl.messages.TypeMessages, tl.messages.RawMessagesNotModified> | undefined
  const candidates = [...(ordinaryMessages?.messages ?? []), ...projectedMessages.messages]
  const byId = new Map(candidates.map((message) => [message.id, message]))
  return {
    _: 'messages.messages',
    messages: requested.map((input) => {
      const id = input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
      return byId.get(id) ?? { _: 'messageEmpty', id }
    }),
    topics: [],
    chats: uniqueById([...(ordinaryMessages?.chats ?? []), ...projectedMessages.chats]),
    users: uniqueById([...(ordinaryMessages?.users ?? []), ...projectedMessages.users]),
  }
}

function uniqueById<T extends { _: string, id: number }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [`${item._}:${item.id}`, item])).values()]
}

function isDetailedConversationPreview(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  return !(/^(?:点击)?查看(?:[xX×\d]+条)?(?:消息的)?(?:合并)?转发(?:消息)?$/.test(compact)
    || /^(?:共)?[xX×\d]+条消息的合并转发$/.test(compact)
    || /^(?:合并转发|聊天记录)$/.test(compact))
}
