/** Platform-neutral IM contract used by the bridge domain layer. */

export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export type IMConversationKind = 'direct' | 'group' | 'channel'

export interface PlatformCapabilities {
  history: boolean
  send: {
    text: boolean
    images: boolean
    files: boolean
    mixed: boolean
    maxTextLength: number
    maxMedia: number
  }
  conversations: {
    groups: boolean
    channels: boolean
    subchannels: boolean
  }
}

/** An authenticated platform session (created by the HTTP auth flow). */
export interface PlatformSession {
  platformSessionId: string
  platformId: string
  userId: string
  credentials: JsonValue
  metadata: JsonObject
}

export interface IMUser {
  id: string
  firstName: string
  lastName?: string
  username?: string
  avatarUrl?: string
  metadata?: JsonObject
}

export interface IMConversationRef {
  id: string
}

export interface IMConversation extends IMConversationRef {
  kind: IMConversationKind
  title: string
  /** Parent channel/category/thread owner on hierarchical platforms such as Discord. */
  parentId?: string
  /** Guild, workspace, or other top-level platform container. */
  spaceId?: string
  metadata?: JsonObject
}

export type IMMediaKind = 'image' | 'file'

export interface IMMedia {
  /** Opaque platform media ID. It is never parsed or truncated by the bridge. */
  id: string
  kind: IMMediaKind
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  /** Opaque data needed by downloadMedia(). */
  locator?: JsonValue
}

export interface IMMediaSource {
  size?: number
  stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>
}

export interface IMMediaInput extends Omit<IMMedia, 'id' | 'locator'> {
  source: IMMediaSource
}

export type IMMessagePart =
  | { type: 'text', text: string }
  | { type: 'media', media: IMMedia }

export type IMMessageInputPart =
  | { type: 'text', text: string }
  | { type: 'media', media: IMMediaInput }

export interface IMMessageContent {
  parts: IMMessagePart[]
}

export interface IMMessageInput {
  parts: IMMessageInputPart[]
  replyToId?: string
}

export interface IMMessage {
  /** Logical platform message ID. Strings may be arbitrarily long. */
  id: string
  /** Physical platform IDs represented by this logical message, for example a Telegram album. */
  sourceIds?: string[]
  conversationId: string
  senderId: string
  content: IMMessageContent
  timestamp: number
  outgoing?: boolean
  /** Opaque platform grouping key, retained for album reconciliation. */
  groupId?: string
  metadata?: JsonObject
}

export interface IMDialog {
  conversation: IMConversation
  unreadCount: number
  lastMessage?: IMMessage
}

export interface IMPageQuery {
  cursor?: string
  limit?: number
  /** Stable platform entity ID after which the next page starts. */
  afterId?: string
}

export interface IMHistoryAnchor {
  id: string
  timestamp: number
}

export interface IMHistoryQuery extends IMPageQuery {
  /** Fetch messages strictly older than this platform message. */
  before?: IMHistoryAnchor
  /** Fetch messages strictly newer than this platform message. */
  after?: IMHistoryAnchor
}

export interface IMDialogPage {
  dialogs: IMDialog[]
  nextCursor?: string
}

export interface IMHistoryPage {
  messages: IMMessage[]
  nextCursor?: string
}

export interface IMTransferProgress {
  phase: 'upload' | 'download'
  mediaIndex: number
  transferredBytes: number
  totalBytes?: number
}

export interface IMTransferOptions {
  signal?: AbortSignal
  onProgress?: (progress: IMTransferProgress) => void | Promise<void>
}

export interface IMDownloadOptions extends IMTransferOptions {
  offset?: number
  limit?: number
}

export type IMEvent =
  | { type: 'message', message: IMMessage, conversation: IMConversation }
  | { type: 'conversation', conversation: IMConversation }
  | { type: 'read', conversationId: string, upToMessageId: string }

export type Unsubscribe = () => void | Promise<void>

export interface IMPlatform {
  readonly id: string
  readonly capabilities: PlatformCapabilities

  subscribe(session: PlatformSession, handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe>

  sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options?: IMTransferOptions,
  ): Promise<IMMessage>

  getDialogs?(session: PlatformSession, query?: IMPageQuery): Promise<IMDialogPage>
  getHistory?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query?: IMHistoryQuery,
  ): Promise<IMHistoryPage>
  getUser?(session: PlatformSession, userId: string): Promise<IMUser | null>
  downloadMedia?(
    session: PlatformSession,
    media: IMMedia,
    options?: IMDownloadOptions,
  ): AsyncIterable<Uint8Array>
}

/** In-memory adapter used by unit tests and the default development config. */
export class StaticDemoPlatform implements IMPlatform {
  readonly id = 'static-demo'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    send: {
      text: true,
      images: false,
      files: false,
      mixed: false,
      maxTextLength: 4096,
      maxMedia: 0,
    },
    conversations: { groups: false, channels: false, subchannels: false },
  }

  private _users: Record<string, IMUser> = {
    alice: { id: 'alice', firstName: 'Alice', username: 'alice' },
    bob: { id: 'bob', firstName: 'Bob', username: 'bob' },
  }

  private _messages: Record<string, IMMessage[]> = {
    alice: [
      makeDemoMessage('1', 'alice', 'Hey there!', 1_700_000_000),
      makeDemoMessage('2', 'alice', 'How are you?', 1_700_000_100),
    ],
    bob: [makeDemoMessage('1', 'bob', 'Meeting at 3?', 1_700_000_200)],
  }

  private _seq = 100

  async subscribe(_session: PlatformSession, _handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe> {
    return () => {}
  }

  async sendMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
  ): Promise<IMMessage> {
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
    const message: IMMessage = {
      id: String(++this._seq),
      conversationId: conversation.id,
      senderId: 'self',
      content: { parts: [{ type: 'text', text }] },
      timestamp: Math.floor(Date.now() / 1000),
      outgoing: true,
    }
    ;(this._messages[conversation.id] ??= []).push(message)
    return message
  }

  async getDialogs(_session: PlatformSession): Promise<IMDialogPage> {
    return {
      dialogs: Object.keys(this._users).map((conversationId) => {
        const messages = this._messages[conversationId] ?? []
        return {
          conversation: {
            id: conversationId,
            kind: 'direct',
            title: this._users[conversationId].firstName,
          },
          unreadCount: 0,
          lastMessage: messages[messages.length - 1],
        }
      }),
    }
  }

  async getHistory(_session: PlatformSession, conversation: IMConversationRef): Promise<IMHistoryPage> {
    return { messages: this._messages[conversation.id] ?? [] }
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser | null> {
    return this._users[userId] ?? null
  }
}

export function messageText(message: IMMessage): string {
  return message.content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

export function messageMedia(message: IMMessage): IMMedia[] {
  return message.content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
}

function makeDemoMessage(id: string, conversationId: string, text: string, timestamp: number): IMMessage {
  return {
    id,
    conversationId,
    senderId: conversationId,
    content: { parts: [{ type: 'text', text }] },
    timestamp,
  }
}
