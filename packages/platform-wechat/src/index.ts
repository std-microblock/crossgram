import type { Context } from 'cordis'
import z from 'schemastery'
import type {
  IMConversation, IMConversationMemberPage, IMConversationRef, IMDialogPage, IMEvent,
  IMMessage, IMMessageInput, IMPageQuery, IMPlatform, IMPlatformAccount, IMTransferOptions,
  IMUser, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { IMMessageSendRejectedError, resolvePlatformPluginId } from '@mtproto-relay/bridge'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { startCallbackServer, type CallbackServer } from './callback.js'
import { ComWeChatClient, normalizeEndpoint } from './client.js'
import type { ComWeChatCallback, ComWeChatContact } from './types.js'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:18888/api/'
const DEFAULT_CALLBACK_HOST = '127.0.0.1'
const DEFAULT_CALLBACK_PORT = 23_456
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_CALLBACK_BYTES = 1_048_576
const DEFAULT_MAX_CALLBACK_CONNECTIONS = 32

export interface Config {
  endpoint?: string
  callbackPort?: number
  requestTimeoutMs?: number
  maxCallbackBytes?: number
  maxCallbackConnections?: number
  /** Test-only HTTP transport injection. */
  fetch?: typeof globalThis.fetch
}

export const Config = z.object({
  endpoint: z.transform(z.string(), normalizeEndpoint).default(DEFAULT_ENDPOINT),
  callbackPort: z.natural().min(1).max(65_535).default(DEFAULT_CALLBACK_PORT),
  requestTimeoutMs: z.natural().min(1).max(300_000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  maxCallbackBytes: z.natural().min(1).max(16 * 1024 * 1024).default(DEFAULT_MAX_CALLBACK_BYTES),
  maxCallbackConnections: z.natural().min(1).max(1_024).default(DEFAULT_MAX_CALLBACK_CONNECTIONS),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export const name = 'im-platform-wechat'
export const inject = ['imPlatform']

export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'wechat')
  const platform = new ComWeChatPlatform(config, ctx.logger('platform-wechat'))
  ctx.imPlatform.register(platform, id)
  ctx.effect(() => () => platform.stop())
}

export class ComWeChatPlatform implements IMPlatform {
  readonly platformKind = 'wechat'
  readonly capabilities: PlatformCapabilities = {
    history: false,
    readState: { markRead: false, events: false },
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
    members: { list: true, administrators: false, permissions: false },
    messageActions: {
      delete: { own: { supported: false }, others: { supported: false } },
      edit: { mode: 'unsupported' },
      forward: { mode: 'unsupported', preservesAuthor: false },
    },
  }

  readonly client: ComWeChatClient
  private readonly callbackPort: number
  private readonly maxCallbackBytes: number
  private readonly maxCallbackConnections: number
  private readonly logger?: ComWeChatLogger
  private callback?: CallbackServer
  private callbackGeneration?: number
  private callbackSubscribed = false
  private lifecycle: Promise<void> = Promise.resolve()
  private generation = 0
  private requestedGeneration?: number
  private selfId?: string
  private readonly users = new Map<string, IMUser>()
  private readonly conversations = new Map<string, IMConversation>()

  constructor(config: Config = {}, logger?: ComWeChatLogger) {
    this.logger = logger
    this.callbackPort = config.callbackPort ?? DEFAULT_CALLBACK_PORT
    this.maxCallbackBytes = config.maxCallbackBytes ?? DEFAULT_MAX_CALLBACK_BYTES
    this.maxCallbackConnections = config.maxCallbackConnections ?? DEFAULT_MAX_CALLBACK_CONNECTIONS
    this.client = new ComWeChatClient({
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetch: config.fetch,
      onWarning: (message) => this.logger?.warn('%s', message),
    })
  }

  async stop(): Promise<void> {
    this.requestedGeneration = undefined
    await this.queueLifecycle(async () => {
      if (this.requestedGeneration !== undefined) return
      await this.disposeCallback()
    })
  }

  private async disposeCallback(): Promise<void> {
    const callback = this.callback
    const shouldStopCallback = Boolean(callback) || this.callbackSubscribed
    this.callback = undefined
    this.callbackGeneration = undefined
    this.callbackSubscribed = false
    let closeError: unknown
    try {
      await callback?.close()
    } catch (error) {
      closeError = error
    }
    if (shouldStopCallback) await this.stopCallback()
    if (closeError) throw closeError
  }

  async getAccount(): Promise<IMPlatformAccount> {
    if (!await this.client.isLoggedIn()) throw new Error('ComWeChat is not logged in')
    const response = await this.client.getSelfInfo()
    const data = asObject(response.data)
    const id = stringId(data?.wxId)
    if (!id) throw new Error('ComWeChat self info did not contain data.wxId')
    this.selfId = id
    const user = this.mapUser({
      wxid: id,
      wxNickName: data?.wxNickName,
      nickname: data?.nickname ?? data?.nickName,
    })
    if (!user) throw new Error('ComWeChat self info did not contain a supported user ID')
    return { credentials: {}, user }
  }

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const generation = ++this.generation
    this.requestedGeneration = generation
    return this.queueLifecycle(async () => {
      if (this.requestedGeneration !== generation) {
        throw new Error('ComWeChat callback subscription was replaced before it started')
      }
      await this.disposeCallback()
      if (this.requestedGeneration !== generation) {
        throw new Error('ComWeChat callback subscription was replaced before it started')
      }
      const callback = await startCallbackServer({
        host: DEFAULT_CALLBACK_HOST,
        port: this.callbackPort,
        maxBytes: this.maxCallbackBytes,
        maxConnections: this.maxCallbackConnections,
        onMessage: async (message) => {
          const event = this.mapCallback(message)
          if (event) await handler(event)
        },
        onWarning: (message, error) => this.logger?.warn('%s: %s', message, formatError(error)),
      })
      this.callback = callback
      this.callbackGeneration = generation
      try {
        if (this.requestedGeneration !== generation) {
          await this.disposeCallback()
          throw new Error('ComWeChat callback subscription was stopped before it started')
        }
        await this.client.startCallback(this.callbackPort)
        if (this.requestedGeneration !== generation || this.callback !== callback || this.callbackGeneration !== generation) {
          await this.disposeCallback()
          throw new Error('ComWeChat callback subscription was stopped before it started')
        }
        this.callbackSubscribed = true
      } catch (error) {
        if (this.callback === callback) await this.disposeCallback()
        throw error
      }
      return async () => {
        await this.queueLifecycle(async () => {
          if (this.callback !== callback || this.callbackGeneration !== generation) return
          if (this.requestedGeneration === generation) this.requestedGeneration = undefined
          await this.disposeCallback()
        })
      }
    })
  }

  async sendMessage(
    _session: PlatformSession,
    _conversation: IMConversationRef,
    _content: IMMessageInput,
    _options?: IMTransferOptions,
  ): Promise<IMMessage> {
    throw new IMMessageSendRejectedError(
      'platform-rejected',
      'ComWeChat reference API does not provide a correlatable final message ID; this adapter is receive-only.',
    )
  }

  private async stopCallback(): Promise<void> {
    try {
      await this.client.stopCallback()
    } catch (error) {
      this.logger?.warn('ComWeChat callback unhook failed: %s', formatError(error))
    }
  }

  private queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const transition = this.lifecycle.then(operation, operation)
    this.lifecycle = transition.then(() => undefined, () => undefined)
    return transition
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage> {
    const contacts = await this.client.getContacts()
    const dialogs = contacts.flatMap((contact) => {
      const conversation = this.mapConversation(contact)
      return conversation ? [{ conversation, unreadCount: 0 }] : []
    })
    const start = pageStart(dialogs, query)
    const limit = clampLimit(query.limit)
    const page = dialogs.slice(start, start + limit)
    return {
      dialogs: page,
      total: dialogs.length,
      nextCursor: start + page.length < dialogs.length ? String(start + page.length) : undefined,
    }
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser | null> {
    const cached = this.users.get(userId)
    if (cached) return cached
    const contact = (await this.client.getContacts()).find((item) => contactId(item) === userId)
    return contact ? this.mapUser(contact) : null
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage> {
    if (!isGroupId(conversation.id)) return { members: [], total: 0 }
    const contacts = (await this.client.getGroupMembers(conversation.id)).filter(contactId)
    const start = pageStart(contacts.map((contact) => ({ conversation: { id: contactId(contact)! } })), query)
    const limit = clampLimit(query.limit)
    const pageContacts = contacts.slice(start, start + limit)
    const members = (await mapWithConcurrency(
      pageContacts,
      8,
      contact => this.withGroupMemberNickname(conversation.id, contact),
    )).flatMap((contact) => {
      const user = this.mapUser(contact)
      return user ? [{
        user,
        role: 'member' as const,
        permissions: {
          manageConversation: false,
          manageMembers: false,
          deleteAnyMessage: false,
          editAnyMessage: false,
          pinMessages: false,
          inviteMembers: false,
        },
      }] : []
    })
    return {
      members,
      total: contacts.length,
      nextCursor: start + pageContacts.length < contacts.length ? String(start + pageContacts.length) : undefined,
    }
  }

  private async withGroupMemberNickname(chatroomId: string, contact: ComWeChatContact): Promise<ComWeChatContact> {
    const wxid = contactId(contact)
    if (!wxid) return contact
    try {
      const response = await this.client.getGroupMemberNickname(chatroomId, wxid)
      const data = asObject(response.data) ?? response
      const nickname = stringId(data.wxNickName) ?? stringId(data.nickname) ?? stringId(data.nickName)
      return nickname ? { ...contact, wxNickName: nickname } : contact
    } catch (error) {
      this.logger?.warn('ComWeChat group member nickname lookup failed: %s', formatError(error))
      return contact
    }
  }

  private mapCallback(raw: ComWeChatCallback): IMEvent | undefined {
    const type = numberValue(raw.type)
    const sender = stringId(raw.sender)
    if (!sender) {
      this.logger?.warn('ComWeChat callback has no sender')
      return
    }
    const group = isGroupId(sender)
    const outgoing = isTrue(raw.isSendMsg)
    const senderId = outgoing ? stringId(raw.self) ?? this.selfId : group ? stringId(raw.wxid) ?? sender : sender
    if (!senderId) {
      this.logger?.warn('ComWeChat outgoing callback has no self ID')
      return
    }
    const conversation = this.getCallbackConversation(sender, group)
    const timestamp = callbackTimestamp(raw.timestamp ?? raw.time)
    if (type === 2005) {
      const messageId = stringId(raw.msgid)
      if (!messageId) {
        this.logger?.warn('ComWeChat revoke callback has no message ID')
        return
      }
      return { type: 'message-delete', eventId: `wechat-revoke:${messageId}`, conversation, messageIds: [messageId], timestamp }
    }
    const messageId = stringId(raw.msgid)
    if (!messageId) {
      this.logger?.warn('ComWeChat callback has no message ID')
      return
    }
    const text = callbackText(type, raw.message)
    if (!text) return
    return {
      type: 'message',
      conversation,
      message: {
        id: messageId,
        conversationId: conversation.id,
        senderId,
        sender: this.users.get(senderId),
        timestamp,
        outgoing,
        content: { parts: [{ type: 'text', text }] },
        metadata: { comWeChatType: type ?? -1 },
      },
    }
  }

  private mapConversation(contact: ComWeChatContact): IMConversation | undefined {
    const id = contactId(contact)
    if (!id) {
      this.logger?.warn('ComWeChat contact has no supported ID')
      return
    }
    const conversation: IMConversation = {
      id,
      kind: isGroupId(id) ? 'group' : 'direct',
      title: contactTitle(contact, id),
    }
    this.conversations.set(id, conversation)
    if (!isGroupId(id)) this.mapUser(contact)
    return conversation
  }

  private getCallbackConversation(id: string, group: boolean): IMConversation {
    const cached = this.conversations.get(id)
    if (cached) return cached
    const conversation: IMConversation = { id, kind: group ? 'group' : 'direct', title: this.users.get(id)?.firstName ?? id }
    this.conversations.set(id, conversation)
    return conversation
  }

  private mapUser(contact: ComWeChatContact): IMUser | undefined {
    const id = contactId(contact)
    if (!id) return
    const user: IMUser = { id, firstName: contactTitle(contact, id), metadata: { wechatId: id } }
    this.users.set(id, user)
    return user
  }
}

function callbackText(type: number | undefined, value: unknown): string | undefined {
  const message = typeof value === 'string' ? value : ''
  if (type === 1) return message || '[WeChat text message]'
  if (type === 3) return '[WeChat image attachment unavailable: local media import is disabled]'
  if (type === 34) return '[WeChat voice message unavailable: local media import is disabled]'
  if (type === 43) return '[WeChat video attachment unavailable: local media import is disabled]'
  if (type === 47) return '[WeChat animated sticker unavailable]'
  if (type === 48) return message ? `[WeChat location] ${message}` : '[WeChat location]'
  if (type === 49) return message || '[WeChat shared content]'
  if (type === 2004) return '[WeChat file attachment unavailable: local media import is disabled]'
  return type === undefined ? '[WeChat unsupported message]' : `[WeChat unsupported message type ${type}]`
}

function contactId(contact: ComWeChatContact): string | undefined {
  return stringId(contact.wxid) ?? stringId(contact.id) ?? stringId(contact.userName)
}

function contactTitle(contact: ComWeChatContact, fallback: string): string {
  return stringId(contact.wxRemark) ?? stringId(contact.remark) ?? stringId(contact.remarkName) ?? stringId(contact.wxNickName)
    ?? stringId(contact.nickname) ?? stringId(contact.nickName) ?? fallback
}

function isGroupId(id: string): boolean {
  return id.includes('@chatroom')
}

function callbackTimestamp(value: unknown): number {
  const timestamp = numberValue(value)
  if (timestamp === undefined || timestamp < 0) return Math.floor(Date.now() / 1_000)
  return Math.floor(timestamp > 100_000_000_000 ? timestamp / 1_000 : timestamp)
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : undefined
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function pageStart(items: Array<{ conversation: { id: string } }>, query: IMPageQuery): number {
  if (query.afterId) {
    const index = items.findIndex((item) => item.conversation.id === query.afterId)
    return index < 0 ? 0 : index + 1
  }
  if (!query.cursor) return 0
  const value = Number(query.cursor)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ComWeChat cursor: ${query.cursor}`)
  return value
}

function clampLimit(limit = 100): number {
  return Math.max(0, Math.min(Math.trunc(limit), 1_000))
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await mapper(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ComWeChatLogger {
  warn(format: string, ...args: unknown[]): void
}

export { ComWeChatClient, normalizeEndpoint } from './client.js'
export { startCallbackServer } from './callback.js'
export type { ComWeChatCallback, ComWeChatContact } from './types.js'
