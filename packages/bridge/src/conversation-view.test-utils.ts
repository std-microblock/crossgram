import { Context } from 'cordis'
import Long from 'long'
import { ConversationViewService } from './conversation-view.js'

export function createTestConversationViews(): ConversationViewService {
  const service = new ConversationViewService(new Context())
  service.register({
    id: 'merged-forward-test',
    supports: (conversation) => conversation.metadata?.conversationView === 'merged-forward',
    makeLink: (context, target) =>
      `https://t.me/bridgechat_${context.chatId}${target ? `/${target.tlMessageId}` : ''}`,
    makePreview: (context, url) => ({
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage', id: Long.ONE, url, displayUrl: context.conversation.title, hash: 0,
        type: 'telegram_message', title: context.conversation.title,
        description: String(context.conversation.metadata?.qqMultiForwardPreview ?? '点击查看合并转发消息'),
      },
    }),
    makeChat: (context) => ({
      _: 'chat', left: true, id: context.chatId, title: context.conversation.title,
      photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
    }),
    makeFullChat: (context, notifySettings) => ({
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: context.chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId: context.chatId },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO }, notifySettings, botInfo: [],
      },
      chats: [{
        _: 'chat', left: true, id: context.chatId, title: context.conversation.title,
        photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
      }],
      users: [],
    }),
    resolveUsername: (username) => {
      const match = /^bridgechat_(\d+)$/.exec(username)
      return match ? Number(match[1]) : undefined
    },
  })
  return service
}
