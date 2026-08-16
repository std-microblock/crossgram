import type { IMConversation } from './platform.js'

export interface VirtualMessageTarget {
  conversationId: string
  platformMessageId: string
  tlMessageId: number
}

/** Linked non-dialog peers must be resolvable from every MTProto connection. */
const conversations = new Map<string, Map<number, IMConversation>>()
const firstMessages = new Map<string, Map<number, VirtualMessageTarget>>()

export function registerVirtualConversation(
  platformSessionId: string,
  chatId: number,
  conversation: IMConversation,
): string {
  const session = conversations.get(platformSessionId) ?? new Map<number, IMConversation>()
  session.set(chatId, conversation)
  conversations.set(platformSessionId, session)
  // HTTPS t.me links are handled natively by both Telegram Desktop and
  // Android clients. The synthetic username still resolves to a basic
  // peerChat, so opening the link does not require a channel/megagroup.
  const first = virtualConversationMessageTarget(platformSessionId, chatId)
  return `https://t.me/bridgechat_${chatId}${first ? `/${first.tlMessageId}` : ''}`
}

export function registerVirtualConversationMessageTarget(
  platformSessionId: string,
  chatId: number,
  target: VirtualMessageTarget,
): void {
  const session = firstMessages.get(platformSessionId) ?? new Map<number, VirtualMessageTarget>()
  session.set(chatId, target)
  firstMessages.set(platformSessionId, session)
}

export function virtualConversationMessageTarget(
  platformSessionId: string,
  chatId: number,
): VirtualMessageTarget | undefined {
  return firstMessages.get(platformSessionId)?.get(chatId)
}

export function virtualConversation(
  platformSessionId: string,
  chatId: number,
): IMConversation | undefined {
  return conversations.get(platformSessionId)?.get(chatId)
}
