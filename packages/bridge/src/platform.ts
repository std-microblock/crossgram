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
  members?: {
    list: boolean
    administrators: boolean
    permissions: boolean
  }
  avatars?: {
    users: boolean
    conversations: boolean
  }
  messageActions?: {
    delete: {
      own: IMMessageDeleteRule
      others: IMMessageDeleteRule
    }
    edit: {
      mode: 'native' | 'delete-and-resend' | 'unsupported'
      /** Omitted means the platform does not impose a fixed age limit. */
      maxAgeSeconds?: number
    }
    forward: {
      mode: 'native' | 'copy' | 'unsupported'
      preservesAuthor: boolean
    }
  }
  stickers?: {
    native: boolean
    upload: boolean
    formats: Array<'static' | 'animated' | 'video'>
  }
  reactions?: {
    read: boolean
    write: boolean
    events: boolean
    actorList: boolean
    maxSelected: number
  }
}

export interface IMMessageDeleteRule {
  supported: boolean
  /** Omitted means messages of any age may be deleted. */
  maxAgeSeconds?: number
}

/** An authenticated platform session (created by the HTTP auth flow). */
export interface PlatformSession {
  platformSessionId: string
  platformId: string
  userId: string
  credentials: JsonValue
  metadata: JsonObject
}

export interface IMUser<TMediaLocator = unknown> {
  id: string
  firstName: string
  lastName?: string
  username?: string
  avatar?: IMMedia<TMediaLocator>
  metadata?: JsonObject
}

export interface IMConversationRef {
  id: string
}

export interface IMConversation<TMediaLocator = unknown> extends IMConversationRef {
  kind: IMConversationKind
  title: string
  /** Parent channel/category/thread owner on hierarchical platforms such as Discord. */
  parentId?: string
  /** Guild, workspace, or other top-level platform container. */
  spaceId?: string
  avatar?: IMMedia<TMediaLocator>
  metadata?: JsonObject
}

export type IMConversationRole = 'owner' | 'administrator' | 'member' | 'guest'

export interface IMConversationPermissions {
  manageConversation: boolean
  manageMembers: boolean
  deleteAnyMessage: boolean
  editAnyMessage: boolean
  pinMessages: boolean
  inviteMembers: boolean
}

export interface IMConversationMember<TMediaLocator = unknown> {
  user: IMUser<TMediaLocator>
  role: IMConversationRole
  permissions: IMConversationPermissions
  joinedAt?: number
  title?: string
  metadata?: JsonObject
}

export interface IMConversationMemberPage<TMediaLocator = unknown> {
  members: IMConversationMember<TMediaLocator>[]
  total?: number
  nextCursor?: string
}

export interface IMUserPage<TMediaLocator = unknown> {
  users: IMUser<TMediaLocator>[]
  nextCursor?: string
}

export type IMMediaKind = 'image' | 'file'

export interface IMMedia<TLocator = unknown> {
  /** Opaque platform media ID. It is never parsed or truncated by the bridge. */
  id: string
  kind: IMMediaKind
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  /** Adapter-owned, typed data needed by downloadMedia(). */
  locator?: TLocator
}

export interface IMMediaSource {
  size?: number
  stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>
}

export interface IMMediaInput extends Omit<IMMedia, 'id' | 'locator'> {
  source: IMMediaSource
}

export type IMMessagePart<TMediaLocator = unknown> =
  | { type: 'text', text: string }
  | { type: 'media', media: IMMedia<TMediaLocator> }
  | { type: 'sticker', sticker: import('./sticker-provider.js').IMSticker }

export type IMMessageInputPart =
  | { type: 'text', text: string }
  | { type: 'media', media: IMMediaInput }
  | { type: 'sticker', sticker: import('./sticker-provider.js').IMStickerSendPlan }

export interface IMMessageContent<TMediaLocator = unknown> {
  parts: IMMessagePart<TMediaLocator>[]
}

export interface IMMessageInput {
  parts: IMMessageInputPart[]
  replyToId?: string
}

export interface IMMessage<TMediaLocator = unknown> {
  /** Logical platform message ID. Strings may be arbitrarily long. */
  id: string
  /** Physical platform IDs represented by this logical message, for example a Telegram album. */
  sourceIds?: string[]
  conversationId: string
  senderId: string
  /** Sender profile as observed in this conversation, including any conversation-scoped display name. */
  sender?: IMUser<TMediaLocator>
  content: IMMessageContent<TMediaLocator>
  timestamp: number
  outgoing?: boolean
  /** Opaque platform grouping key, retained for album reconciliation. */
  groupId?: string
  metadata?: JsonObject
  reactionContext?: IMReactionContext
}

export interface IMReactionActor {
  userId: string
  timestamp?: number
}

export interface IMReactionSummary {
  key: string
  count: number
  selected?: boolean
  recentActors?: IMReactionActor[]
}

export interface IMReactionResource {
  version: number
  format: 'static' | 'video'
  mimeType: 'image/webp' | 'image/png' | 'video/webm'
  width: number
  height: number
  size?: number
  locator?: JsonValue
}

export interface IMReactionDefinition {
  key: string
  title?: string
  presentation:
    | { type: 'emoji', emoticon: string }
    | { type: 'custom', alt: string, resource: IMReactionResource }
}

export interface IMReactionContext {
  available: IMReactionDefinition[]
  reactions: IMReactionSummary[]
  maxSelected: number
}

export interface IMMessageTarget {
  conversationId: string
  messageId: string
  targetId: string
}

export interface IMDeleteMessagesOptions {
  /** Request deletion for every participant instead of only the current user. */
  forEveryone: boolean
}

export interface IMForwardMessagesOptions {
  dropAuthor?: boolean
  replyToId?: string
}

export interface IMReactionTarget {
  conversationId: string
  messageId?: string
  targetId?: string
}

export interface IMDialog<TMediaLocator = unknown> {
  conversation: IMConversation<TMediaLocator>
  unreadCount: number
  lastMessage?: IMMessage<TMediaLocator>
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

export interface IMDialogPage<TMediaLocator = unknown> {
  dialogs: IMDialog<TMediaLocator>[]
  nextCursor?: string
}

export interface IMHistoryPage<TMediaLocator = unknown> {
  messages: IMMessage<TMediaLocator>[]
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

export type IMEvent<TMediaLocator = unknown> =
  | { type: 'message', message: IMMessage<TMediaLocator>, conversation: IMConversation<TMediaLocator> }
  | { type: 'message-edit', eventId: string, message: IMMessage<TMediaLocator>, conversation: IMConversation<TMediaLocator> }
  | {
      type: 'message-delete'
      eventId: string
      conversation: IMConversation<TMediaLocator>
      messageIds: string[]
      timestamp: number
    }
  | { type: 'conversation', conversation: IMConversation<TMediaLocator> }
  | { type: 'read', conversationId: string, upToMessageId: string }
  | {
      type: 'message-reactions'
      eventId: string
      conversation: IMConversation<TMediaLocator>
      target: IMMessageTarget
      context: IMReactionContext
      timestamp: number
    }

export type Unsubscribe = () => void | Promise<void>

export interface IMPlatform<TMediaLocator = unknown> {
  readonly platformKind?: string
  readonly capabilities: PlatformCapabilities

  subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<TMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe>

  sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options?: IMTransferOptions,
  ): Promise<IMMessage<TMediaLocator>>

  getDialogs?(session: PlatformSession, query?: IMPageQuery): Promise<IMDialogPage<TMediaLocator>>
  /** Address-book contacts. This is intentionally separate from recent dialogs. */
  getContacts?(session: PlatformSession, query?: IMPageQuery): Promise<IMUserPage<TMediaLocator>>
  getHistory?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query?: IMHistoryQuery,
  ): Promise<IMHistoryPage<TMediaLocator>>
  getUser?(session: PlatformSession, userId: string): Promise<IMUser<TMediaLocator> | null>
  getConversationMember?(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<TMediaLocator> | null>
  getConversationMembers?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query?: IMPageQuery,
  ): Promise<IMConversationMemberPage<TMediaLocator>>
  deleteMessages?(
    session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
    options: IMDeleteMessagesOptions,
  ): Promise<void>
  editMessage?(
    session: PlatformSession,
    target: IMMessageTarget,
    content: IMMessageInput,
    options?: IMTransferOptions,
  ): Promise<IMMessage<TMediaLocator>>
  forwardMessages?(
    session: PlatformSession,
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options?: IMForwardMessagesOptions,
  ): Promise<IMMessage<TMediaLocator>[]>
  downloadMedia?(
    session: PlatformSession,
    media: IMMedia<TMediaLocator>,
    options?: IMDownloadOptions,
  ): AsyncIterable<Uint8Array>
  setMessageReactions?(
    session: PlatformSession,
    target: IMMessageTarget,
    reactionKeys: readonly string[],
  ): Promise<IMReactionContext>
  getAvailableReactions?(
    session: PlatformSession,
    target: IMReactionTarget,
  ): Promise<IMReactionContext>
  getMessageReactions?(
    session: PlatformSession,
    target: IMMessageTarget,
  ): Promise<IMReactionContext>
  downloadReactionResource?(
    session: PlatformSession,
    resource: IMReactionResource,
    options?: IMDownloadOptions,
  ): AsyncIterable<Uint8Array>
}

export function messageText(message: IMMessage<unknown>): string {
  return message.content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

export function messageMedia<TMediaLocator>(message: IMMessage<TMediaLocator>): IMMedia<TMediaLocator>[] {
  return message.content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
}

export function messageStickers(message: IMMessage<unknown>): import('./sticker-provider.js').IMSticker[] {
  return message.content.parts.flatMap((part) => part.type === 'sticker' ? [part.sticker] : [])
}
