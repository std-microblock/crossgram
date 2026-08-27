import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  stableId,
  type ConversationViewContext,
  type ConversationViewMessageTarget,
  type IMConversation,
  type MessageProjectionInput,
  type MessageProjectionResult,
} from '@mtproto-relay/bridge'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['conversationView', 'mtproto', 'mtprotoBridge']

export const MERGED_FORWARD_VIEW = 'merged-forward'

interface MergedForwardRecord extends ConversationViewContext {
  target?: ConversationViewMessageTarget
}

export function isMergedForwardConversation(conversation: IMConversation): boolean {
  return conversation.metadata?.conversationView === MERGED_FORWARD_VIEW
}

/** Feature-owned address book, renderer, target cache, and RPC admission policy. */
export class MergedForwardProjection {
  private readonly _records = new Map<string, Map<number, MergedForwardRecord>>()
  private readonly _targetJobs = new Map<string, Promise<ConversationViewMessageTarget | undefined>>()

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
    for (const record of this._records.get(platformSessionId)?.values() ?? []) {
      if (record.target?.tlMessageId === tlMessageId) return true
    }
    return false
  }

  target(platformSessionId: string, chatId: number): ConversationViewMessageTarget | undefined {
    return this._record(platformSessionId, chatId)?.target
  }

  setTarget(platformSessionId: string, chatId: number, target: ConversationViewMessageTarget): boolean {
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
        type: 'telegram_message',
        title: record.conversation.title,
        description: detailedPreview ?? '点击查看合并转发消息',
      },
    }
  }

  makeChat(platformSessionId: string, chatId: number, _dcId: number): tl.TypeChat | undefined {
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
    const chat = this.makeChat(platformSessionId, chatId, 1)
    if (!chat) return
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
        notifySettings, botInfo: [],
      },
      chats: [chat], users: [],
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
      const target = await this._ensureTarget(input, conversation, chatId)
      if (target) input.bindConversation?.(conversation, chatId, { ...target, timestamp: 0 })
      const url = this.makeLink(input.session.platformSessionId, chatId)
      if (!url) continue
      urls.set(conversation.id, url)
      const chat = this.makeChat(input.session.platformSessionId, chatId, 1)
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
  }

  private async _ensureTarget(
    input: MessageProjectionInput,
    conversation: IMConversation,
    chatId: number,
  ): Promise<ConversationViewMessageTarget | undefined> {
    const existing = this.target(input.session.platformSessionId, chatId)
    if (existing || !input.loadConversation) return existing
    const key = `${input.session.platformSessionId}\u0000${chatId}\u0000${conversation.id}`
    let pending = this._targetJobs.get(key)
    if (!pending) {
      pending = input.loadConversation(conversation).then((candidates) => {
        const latest = candidates.slice().sort((left, right) =>
          right.timestamp - left.timestamp || right.tlMessageId - left.tlMessageId)[0]
        if (!latest) return
        const target: ConversationViewMessageTarget = latest
        this.setTarget(input.session.platformSessionId, chatId, target)
        return target
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
  ctx.on('bridge/conversation-view/supports', (conversation) =>
    projection.supports(conversation) || undefined)
  ctx.on('bridge/conversation-view/remember', (platformSessionId, chatId, conversation) =>
    projection.remember(platformSessionId, chatId, conversation))
  ctx.on('bridge/conversation-view/resolve', (platformSessionId, chatId) =>
    projection.resolve(platformSessionId, chatId))
  ctx.on('bridge/conversation-view/resolve-username', (platformSessionId, username) =>
    projection.resolveUsername(platformSessionId, username))
  ctx.on('bridge/conversation-view/owns-message', (platformSessionId, tlMessageId) =>
    projection.ownsMessage(platformSessionId, tlMessageId) || undefined)
  ctx.on('bridge/conversation-view/target', (platformSessionId, chatId) =>
    projection.target(platformSessionId, chatId))
  ctx.on('bridge/conversation-view/set-target', (platformSessionId, chatId, target) =>
    projection.setTarget(platformSessionId, chatId, target) || undefined)
  ctx.on('bridge/conversation-view/make-link', (platformSessionId, chatId) =>
    projection.makeLink(platformSessionId, chatId))
  ctx.on('bridge/conversation-view/make-preview', (platformSessionId, chatId) =>
    projection.makePreview(platformSessionId, chatId))
  ctx.on('bridge/conversation-view/make-chat', (platformSessionId, chatId, dcId) =>
    projection.makeChat(platformSessionId, chatId, dcId))
  ctx.on('bridge/conversation-view/make-full-chat', (platformSessionId, chatId, notifySettings) =>
    projection.makeFullChat(platformSessionId, chatId, notifySettings))
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
  if (request._ === 'contacts.resolveUsername') {
    const req = request as tl.contacts.RawResolveUsernameRequest
    if (!/^bridgechat_\d+$/.test(req.username)) return
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!projection.resolveUsername(state.session.platformSessionId, req.username)) return
    return state.dialogs.resolveUsername(req)
  }
  if (request._ === 'messages.getFullChat') {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!projection.resolve(state.session.platformSessionId, req.chatId)) return
    return state.dialogs.getFullChat(req)
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
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!projection.resolve(state.session.platformSessionId, req.peer.chatId)) return
    if (request._ === 'messages.getHistory') return state.dialogs.getHistory(request)
    if (request._ === 'messages.readHistory') return state.dialogs.readHistory(request, rpc.connection)
    if (request._ === 'messages.getScheduledHistory') return state.dialogs.getScheduledHistory(request)
    return state.dialogs.getPeerSettings(request)
  }
  if (request._ === 'messages.getPeerDialogs') {
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const owned = req.peers.some((item) => item._ === 'inputDialogPeer'
      && item.peer._ === 'inputPeerChat'
      && projection.resolve(state.session.platformSessionId, item.peer.chatId))
    return owned ? state.dialogs.getPeerDialogs(req) : undefined
  }
  if (request._ === 'messages.getMessages') {
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    const req = request as tl.messages.RawGetMessagesRequest
    const owned = req.id.some((item) => item._ === 'inputMessageID'
      && projection.ownsMessage(state.session.platformSessionId, item.id))
    return owned ? state.dialogs.getMessages(req) : undefined
  }
}

function isDetailedConversationPreview(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  return !(/^(?:点击)?查看(?:[xX×\d]+条)?(?:消息的)?(?:合并)?转发(?:消息)?$/.test(compact)
    || /^(?:共)?[xX×\d]+条消息的合并转发$/.test(compact)
    || /^(?:合并转发|聊天记录)$/.test(compact))
}

export type { ConversationViewContext, ConversationViewMessageTarget }
