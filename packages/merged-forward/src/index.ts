import type { Context } from 'cordis'
import Long from 'long'
import {
  stableId,
  type ConversationViewContext,
  type ConversationViewMessageTarget,
  type ConversationViewProvider,
  type IMConversation,
} from '@mtproto-relay/bridge'

export const name = 'merged-forward-viewer'
export const inject = ['conversationView']

export const MERGED_FORWARD_VIEW = 'merged-forward'

export function isMergedForwardConversation(conversation: IMConversation): boolean {
  return conversation.metadata?.conversationView === MERGED_FORWARD_VIEW
}

export function makeMergedForwardProvider(): ConversationViewProvider {
  return {
    id: MERGED_FORWARD_VIEW,
    supports: isMergedForwardConversation,
    makeLink(context, target) {
      return `https://t.me/bridgechat_${context.chatId}${target ? `/${target.tlMessageId}` : ''}`
    },
    makePreview(context, url) {
      const preview = context.conversation.metadata?.qqMultiForwardPreview
      const detailedPreview = typeof preview === 'string' && isDetailedConversationPreview(preview)
        ? preview.trim()
        : undefined
      return {
        _: 'messageMediaWebPage', manual: true, safe: true,
        webpage: {
          _: 'webPage',
          id: Long.fromNumber(stableId(`conversation-preview:${context.conversation.id}`)),
          url, displayUrl: context.conversation.title, hash: 0,
          type: 'telegram_message',
          title: context.conversation.title,
          description: detailedPreview ?? '点击查看合并转发消息',
        },
      }
    },
    makeChat(context) {
      return {
        _: 'chat', left: true, id: context.chatId, title: context.conversation.title,
        photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
      }
    },
    makeFullChat(context, notifySettings) {
      return {
        _: 'messages.chatFull',
        fullChat: {
          _: 'chatFull', id: context.chatId, about: '',
          participants: { _: 'chatParticipantsForbidden', chatId: context.chatId },
          chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
          notifySettings, botInfo: [],
        },
        chats: [this.makeChat(context, 1)], users: [],
      }
    },
    resolveUsername(username) {
      const match = /^bridgechat_(\d+)$/.exec(username)
      return match ? Number(match[1]) : undefined
    },
  }
}

export function apply(ctx: Context): void {
  ctx.conversationView.register(makeMergedForwardProvider())
}

function isDetailedConversationPreview(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  return !(/^(?:点击)?查看(?:[xX×\d]+条)?(?:消息的)?(?:合并)?转发(?:消息)?$/.test(compact)
    || /^(?:共)?[xX×\d]+条消息的合并转发$/.test(compact)
    || /^(?:合并转发|聊天记录)$/.test(compact))
}

export type { ConversationViewContext, ConversationViewMessageTarget }
