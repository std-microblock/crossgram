import { Service, type Context } from 'cordis'
import type { tl } from '@mtcute/core'
import type { IMConversation } from './platform.js'

export interface ConversationViewMessageTarget {
  conversationId: string
  platformMessageId: string
  tlMessageId: number
}

export interface ConversationViewContext {
  platformSessionId: string
  chatId: number
  conversation: IMConversation
}

/**
 * Stateless Cordis facade for feature-owned synthetic conversation views.
 * Bridge dispatches projection/lookup events; feature plugins own all records.
 */
export class ConversationViewService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'conversationView')
  }

  supports(conversation: IMConversation): boolean {
    return this.ctx.bail('bridge/conversation-view/supports', conversation) === true
  }

  remember(
    platformSessionId: string,
    chatId: number,
    conversation: IMConversation,
  ): string | undefined {
    return this.ctx.bail(
      'bridge/conversation-view/remember', platformSessionId, chatId, conversation,
    )
  }

  resolve(platformSessionId: string, chatId: number): IMConversation | undefined {
    return this.ctx.bail('bridge/conversation-view/resolve', platformSessionId, chatId)
  }

  resolveUsername(
    platformSessionId: string,
    username: string,
  ): { chatId: number, conversation: IMConversation } | undefined {
    return this.ctx.bail(
      'bridge/conversation-view/resolve-username', platformSessionId, username,
    )
  }

  ownsMessage(platformSessionId: string, tlMessageId: number): boolean {
    return this.ctx.bail(
      'bridge/conversation-view/owns-message', platformSessionId, tlMessageId,
    ) === true
  }

  target(platformSessionId: string, chatId: number): ConversationViewMessageTarget | undefined {
    return this.ctx.bail('bridge/conversation-view/target', platformSessionId, chatId)
  }

  setTarget(platformSessionId: string, chatId: number, target: ConversationViewMessageTarget): void {
    this.ctx.bail('bridge/conversation-view/set-target', platformSessionId, chatId, target)
  }

  makeLink(platformSessionId: string, chatId: number): string | undefined {
    return this.ctx.bail('bridge/conversation-view/make-link', platformSessionId, chatId)
  }

  makePreview(platformSessionId: string, chatId: number): tl.RawMessageMediaWebPage | undefined {
    return this.ctx.bail('bridge/conversation-view/make-preview', platformSessionId, chatId)
  }

  makeChat(platformSessionId: string, chatId: number, dcId: number): tl.TypeChat | undefined {
    return this.ctx.bail('bridge/conversation-view/make-chat', platformSessionId, chatId, dcId)
  }

  makeFullChat(
    platformSessionId: string,
    chatId: number,
    notifySettings: tl.TypePeerNotifySettings,
  ): tl.messages.RawChatFull | undefined {
    return this.ctx.bail(
      'bridge/conversation-view/make-full-chat', platformSessionId, chatId, notifySettings,
    )
  }
}
