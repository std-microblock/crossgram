import type { IMConversation, IMMessage, IMRequest, IMRequestAction, IMUser, PlatformSession } from './platform.js'
import type { MessageStore } from './message-store.js'
import {
  type SystemPeer, type SystemPeerCallbackInput, type SystemPeerCallbackResult, SystemPeerCallbackError, type SystemPeerProvider,
  type SystemPeerService,
} from './system-peer.js'

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
    metadata: {
      bridgeOwned: true, localOnly: true, readOnly: true, requestInbox: true,
      systemPeer: 'request-inbox', bot: true,
    },
  }
}

export function requestInboxSender(): IMUser {
  return {
    id: REQUEST_INBOX_SENDER_ID,
    firstName: '请求收件箱',
    metadata: { bridgeOwned: true, localOnly: true, requestInbox: true, bot: true },
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

/** Legacy request-inbox rows remain local-only after an upgrade. */
export function isLocalOnlyConversation(conversation: IMConversation | undefined): boolean {
  return conversation?.metadata?.localOnly === true
    || (conversation?.metadata?.bridgeOwned === true && conversation.metadata?.requestInbox === true)
}

export function isRequestInboxConversation(conversation: IMConversation | undefined): boolean {
  return conversation?.id === REQUEST_INBOX_CONVERSATION_ID
    && conversation.metadata?.bridgeOwned === true
    && conversation.metadata?.requestInbox === true
}

/**
 * Read-only system peer for durable friend and group request projections.
 * Request persistence and event delivery remain in MessageStore and
 * PlatformSubscriptionManager respectively, avoiding re-entrant queue waits.
 */
export class RequestInboxSystemPeerProvider implements SystemPeerProvider {
  private readonly _locks = new Map<string, Promise<void>>()

  constructor(
    private readonly _store: MessageStore,
    private readonly _resolveRequest: (
      session: PlatformSession,
      requestId: string,
      action: IMRequestAction,
    ) => Promise<IMRequest>,
    private readonly _deliverRecovery: (session: PlatformSession, request: IMRequest) => Promise<void>,
  ) {}

  async bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void> {
    if (await this._store.getConversation(session.platformSessionId, REQUEST_INBOX_CONVERSATION_ID)) {
      await peers.emit(session, { type: 'conversation', conversation: requestInboxConversation() })
    }
  }

  async resolve(_session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined> {
    return conversationId === REQUEST_INBOX_CONVERSATION_ID
      ? { id: REQUEST_INBOX_CONVERSATION_ID, conversation: requestInboxConversation() }
      : undefined
  }

  async callback(
    session: PlatformSession,
    _peer: SystemPeer,
    input: SystemPeerCallbackInput,
  ): Promise<SystemPeerCallbackResult> {
    const requestId = input.message.metadata?.bridgeRequestId
    if (typeof requestId !== 'string') throw new SystemPeerCallbackError('DATA_INVALID')
    const action: IMRequestAction | undefined = input.data === REQUEST_ACCEPT_CALLBACK_DATA
      ? 'accept'
      : input.data === REQUEST_REJECT_CALLBACK_DATA ? 'reject' : undefined
    if (!action) throw new SystemPeerCallbackError('DATA_INVALID')
    return this._withLock(`${session.platformSessionId}\0${requestId}`, async () => {
      const request = await this._store.getRequest(session.platformSessionId, requestId)
      if (!request) throw new SystemPeerCallbackError('REQUEST_ID_INVALID')
      if (request.state !== 'pending') {
        if ((request.state === 'accepted' && action === 'accept')
          || (request.state === 'rejected' && action === 'reject')) {
          await this._recover(session, request)
          return { message: '请求已处理', cacheTime: 0 }
        }
        throw new SystemPeerCallbackError('REQUEST_STATE_CONFLICT')
      }
      let resolved: IMRequest
      try {
        resolved = await this._resolveRequest(session, request.id, action)
      } catch (error) {
        if (error instanceof SystemPeerCallbackError) throw error
        throw new SystemPeerCallbackError('REQUEST_RESOLVE_FAILED')
      }
      if (resolved.id !== request.id
        || resolved.kind !== request.kind
        || resolved.state === 'pending'
        || (action === 'accept' && resolved.state !== 'accepted')
        || (action === 'reject' && resolved.state !== 'rejected')) {
        throw new SystemPeerCallbackError('REQUEST_RESOLVE_FAILED')
      }
      const stored = await this._store.ingestRequest(session, resolved)
      await this._recover(session, stored.request)
      return { message: '请求已处理', cacheTime: 0 }
    })
  }

  private async _recover(session: PlatformSession, request: IMRequest): Promise<void> {
    try {
      await this._deliverRecovery(session, request)
    } catch {
      throw new SystemPeerCallbackError('REQUEST_RESOLVE_FAILED')
    }
  }

  private async _withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this._locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this._locks.set(key, current)
    await previous.catch(() => {})
    try {
      return await callback()
    } finally {
      release()
      if (this._locks.get(key) === current) this._locks.delete(key)
    }
  }
}

function requestInboxText(request: IMRequest): string {
  const requester = request.requester.firstName || request.requester.id
  const lines = [
    request.kind === 'friend' ? '好友申请' : '入群申请',
    `申请人：${requester}`,
  ]
  if (request.kind === 'group-join') lines.push(`目标群：${request.group?.title ?? request.group?.id ?? '未知群'}`)
  if (request.metadata?.qqRequestSource === 'doubt') {
    lines.push('QQ 已过滤')
    if (typeof request.metadata.qqRequestReason === 'string' && request.metadata.qqRequestReason.trim()) {
      lines.push(`风险提示：${request.metadata.qqRequestReason}`)
    }
  }
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
