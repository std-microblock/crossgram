import type { IMConversation, IMMessage, IMRequest, IMUser } from './platform.js'

export const REQUEST_INBOX_CONVERSATION_ID = 'bridge:request-inbox'
// The inbox is a direct peer, so its synthetic sender must be that same peer.
export const REQUEST_INBOX_SENDER_ID = REQUEST_INBOX_CONVERSATION_ID
export const REQUEST_ACCEPT_CALLBACK_DATA = 'bridge-request:accept'
export const REQUEST_REJECT_CALLBACK_DATA = 'bridge-request:reject'

export function requestInboxConversation(): IMConversation {
  return {
    id: REQUEST_INBOX_CONVERSATION_ID,
    kind: 'direct',
    title: '好友与群请求',
    metadata: { bridgeOwned: true, readOnly: true, requestInbox: true },
  }
}

export function requestInboxSender(): IMUser {
  return {
    id: REQUEST_INBOX_SENDER_ID,
    firstName: '请求收件箱',
    metadata: { bridgeOwned: true, requestInbox: true },
  }
}

export function requestInboxMessage(request: IMRequest): IMMessage {
  return {
    id: `bridge:request:${encodeURIComponent(request.id)}`,
    conversationId: REQUEST_INBOX_CONVERSATION_ID,
    senderId: REQUEST_INBOX_SENDER_ID,
    sender: requestInboxSender(),
    content: {
      parts: [{ type: 'text', text: requestInboxText(request) }],
      ...(request.state === 'pending' ? {
        inlineKeyboard: {
          rows: [{ buttons: [
            { type: 'callback' as const, text: '接受', data: REQUEST_ACCEPT_CALLBACK_DATA, style: 'success' as const },
            { type: 'callback' as const, text: '拒绝', data: REQUEST_REJECT_CALLBACK_DATA, style: 'danger' as const },
          ] }],
        },
      } : {}),
    },
    timestamp: requestTimestamp(request.createdAt),
    outgoing: false,
    metadata: { bridgeRequestId: request.id },
  }
}

export function isRequestInboxConversation(conversation: IMConversation | undefined): boolean {
  return conversation?.id === REQUEST_INBOX_CONVERSATION_ID
    && conversation.metadata?.bridgeOwned === true
    && conversation.metadata?.requestInbox === true
}

function requestInboxText(request: IMRequest): string {
  const requester = request.requester.firstName || request.requester.id
  const lines = [
    request.kind === 'friend' ? '好友申请' : '入群申请',
    `申请人：${requester}`,
  ]
  if (request.kind === 'group-join') lines.push(`目标群：${request.group?.title ?? request.group?.id ?? '未知群'}`)
  lines.push(`验证信息：${request.message || '无'}`)
  lines.push(`状态：${request.state === 'pending' ? '待处理' : request.state === 'accepted' ? '已接受' : '已拒绝'}`)
  return lines.join('\n')
}

function requestTimestamp(value: IMRequest['createdAt']): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value > 10_000_000_000 ? value / 1000 : value)
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (value.trim() && Number.isFinite(numeric)) {
      return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return 0
}
