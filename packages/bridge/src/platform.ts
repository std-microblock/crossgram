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
  | { type: 'message-edit', eventId: string, message: IMMessage, conversation: IMConversation }
  | {
      type: 'message-delete'
      eventId: string
      conversation: IMConversation
      messageIds: string[]
      timestamp: number
    }
  | { type: 'conversation', conversation: IMConversation }
  | { type: 'read', conversationId: string, upToMessageId: string }

export type Unsubscribe = () => void | Promise<void>

export interface IMPlatform {
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

export function messageText(message: IMMessage): string {
  return message.content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

export function messageMedia(message: IMMessage): IMMedia[] {
  return message.content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
}
