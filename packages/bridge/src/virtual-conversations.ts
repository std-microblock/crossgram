import type { IMConversation } from './platform.js'

/** Linked non-dialog peers must be resolvable from every MTProto connection. */
const conversations = new Map<string, Map<number, IMConversation>>()

export function registerVirtualConversation(
  platformSessionId: string,
  chatId: number,
  conversation: IMConversation,
): string {
  const session = conversations.get(platformSessionId) ?? new Map<number, IMConversation>()
  session.set(chatId, conversation)
  conversations.set(platformSessionId, session)
  return `tg://resolve?domain=bridgechat_${chatId}`
}

export function virtualConversation(
  platformSessionId: string,
  chatId: number,
): IMConversation | undefined {
  return conversations.get(platformSessionId)?.get(chatId)
}
