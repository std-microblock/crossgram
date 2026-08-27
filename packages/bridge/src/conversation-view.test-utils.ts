import { Context } from 'cordis'
import Long from 'long'
import {
  ConversationViewService,
  type ConversationViewContext,
  type ConversationViewMessageTarget,
} from './conversation-view.js'
import { MessageProjectionPipeline } from './message-projection.js'
import { stableId } from './dialogs.js'

interface Record extends ConversationViewContext {
  target?: ConversationViewMessageTarget
}

export type TestConversationViews = ConversationViewService & {
  messageProjection: MessageProjectionPipeline
}

export function createTestConversationViews(): TestConversationViews {
  const ctx = new Context()
  const records = new Map<string, Map<number, Record>>()
  const record = (sessionId: string, chatId: number) => records.get(sessionId)?.get(chatId)
  const link = (item: Record) =>
    `https://t.me/bridgechat_${item.chatId}${item.target ? `/${item.target.tlMessageId}` : ''}`
  ctx.on('bridge/conversation-view/supports', (conversation) =>
    conversation.metadata?.conversationView === 'merged-forward' || undefined)
  ctx.on('bridge/conversation-view/remember', (sessionId, chatId, conversation) => {
    if (conversation.metadata?.conversationView !== 'merged-forward') return
    const scoped = records.get(sessionId) ?? new Map<number, Record>()
    const previous = scoped.get(chatId)
    const item: Record = {
      platformSessionId: sessionId, chatId, conversation,
      ...(previous?.target ? { target: previous.target } : {}),
    }
    scoped.set(chatId, item)
    records.set(sessionId, scoped)
    return link(item)
  })
  ctx.on('bridge/conversation-view/resolve', (sessionId, chatId) => record(sessionId, chatId)?.conversation)
  ctx.on('bridge/conversation-view/resolve-username', (sessionId, username) => {
    const match = /^bridgechat_(\d+)$/.exec(username)
    if (!match) return
    const chatId = Number(match[1])
    const conversation = record(sessionId, chatId)?.conversation
    return conversation ? { chatId, conversation } : undefined
  })
  ctx.on('bridge/conversation-view/owns-message', (sessionId, tlMessageId) =>
    [...records.get(sessionId)?.values() ?? []].some((item) => item.target?.tlMessageId === tlMessageId)
      || undefined)
  ctx.on('bridge/conversation-view/target', (sessionId, chatId) => record(sessionId, chatId)?.target)
  ctx.on('bridge/conversation-view/set-target', (sessionId, chatId, target) => {
    const item = record(sessionId, chatId)
    if (!item) return
    item.target = target
    return true
  })
  ctx.on('bridge/conversation-view/make-link', (sessionId, chatId) => {
    const item = record(sessionId, chatId)
    return item ? link(item) : undefined
  })
  ctx.on('bridge/conversation-view/make-preview', (sessionId, chatId) => {
    const item = record(sessionId, chatId)
    if (!item) return
    const url = link(item)
    return {
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage', id: Long.ONE, url, displayUrl: item.conversation.title, hash: 0,
        type: 'telegram_message', title: item.conversation.title,
        description: String(item.conversation.metadata?.conversationViewPreview ?? '点击查看合并转发消息'),
      },
    }
  })
  ctx.on('bridge/conversation-view/make-chat', (sessionId, chatId) => {
    const item = record(sessionId, chatId)
    return item ? {
      _: 'chat', left: true, id: chatId, title: item.conversation.title,
      photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
    } : undefined
  })
  ctx.on('bridge/conversation-view/make-full-chat', (sessionId, chatId, notifySettings) => {
    const item = record(sessionId, chatId)
    if (!item) return
    const chat = {
      _: 'chat' as const, left: true, id: chatId, title: item.conversation.title,
      photo: { _: 'chatPhotoEmpty' as const }, participantsCount: 1, date: 0, version: 1,
    }
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO }, notifySettings, botInfo: [],
      },
      chats: [chat], users: [],
    }
  })
  const service = new ConversationViewService(ctx)
  ctx.on('bridge/message/project', async (input, next) => {
    if (input.ordinal !== 0) return next()
    const linked = input.draft.source.content.parts
      .filter((part) => part.type === 'text')
      .flatMap((part) => part.entities ?? [])
      .filter((entity) => entity.type === 'conversation-link'
        && entity.conversation.metadata?.conversationView === 'merged-forward')
    if (!linked.length) return next()
    const urls = new Map<string, string>()
    for (const entity of linked) {
      if (entity.type !== 'conversation-link') continue
      const chatId = stableId(`peer:${entity.conversation.id}`)
      service.remember(input.session.platformSessionId, chatId, entity.conversation)
      let target = service.target(input.session.platformSessionId, chatId)
      if (!target && input.loadConversation) {
        const candidates = await input.loadConversation(entity.conversation)
        const latest = candidates.slice().sort((left, right) =>
          right.timestamp - left.timestamp || right.tlMessageId - left.tlMessageId)[0]
        if (latest) {
          target = latest
          service.setTarget(input.session.platformSessionId, chatId, latest)
        }
      }
      if (target) input.bindConversation?.(entity.conversation, chatId, { ...target, timestamp: 0 })
      const url = service.makeLink(input.session.platformSessionId, chatId)
      if (url) urls.set(entity.conversation.id, url)
      const chat = service.makeChat(input.session.platformSessionId, chatId, 1)
      if (chat) input.draft.chats.push(chat)
    }
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
            return url ? { type: 'text-link' as const, offset: entity.offset, length: entity.length, url } : entity
          }),
        }),
      },
    }
    const first = linked[0]
    if (first?.type === 'conversation-link') {
      input.draft.media = service.makePreview(
        input.session.platformSessionId, stableId(`peer:${first.conversation.id}`),
      )
    }
    return next()
  })
  return Object.assign(service, { messageProjection: new MessageProjectionPipeline(ctx) })
}
