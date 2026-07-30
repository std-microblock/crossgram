/** Platform-neutral IM contract used by the bridge domain layer. */

export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export type IMConversationKind = 'direct' | 'group' | 'channel'

export interface PlatformCapabilities {
  history: boolean
  /** Synchronization of the current account's incoming-message read boundary. */
  readState?: {
    /** Telegram read-history requests can be forwarded to the platform. */
    markRead: boolean
    /** The platform may emit `read` events when another client advances the boundary. */
    events: boolean
  }
  /** Server-side message search. When absent, the bridge falls back to loaded history. */
  search?: boolean
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

/** The adapter-owned identity represented by one Cordis platform entry. */
export interface IMPlatformAccount<TMediaLocator = unknown> {
  user: IMUser<TMediaLocator>
  credentials?: JsonValue
}

export interface IMUser<TMediaLocator = unknown> {
  id: string
  firstName: string
  lastName?: string
  username?: string
  about?: string
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

export interface IMMediaPreview<TLocator = unknown> {
  mimeType?: string
  size: number
  width: number
  height: number
  /** Adapter-owned locator for the extracted preview asset. */
  locator: TLocator
}

export interface IMMedia<TLocator = unknown> {
  /** Opaque platform media ID. It is never parsed or truncated by the bridge. */
  id: string
  kind: IMMediaKind
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  /** Playback duration in seconds for streamable audio/video media. */
  duration?: number
  /** Optional adapter-generated preview, downloaded through the same media method. */
  preview?: IMMediaPreview<TLocator>
  /** Telegram-compatible inline stripped JPEG shown before any media download. */
  strippedThumbnail?: Uint8Array
  /** Adapter-owned, typed data needed by downloadMedia(). */
  locator?: TLocator
}

/** A short-lived, adapter-issued URL that a patched client may download directly. */
export interface IMDirectDownload {
  url: string
  /** Absolute Unix timestamp in milliseconds. */
  expiresAt: number
  /** Whether the origin is expected to honor HTTP byte-range requests. */
  supportsRange: boolean
}

export interface IMMediaSource {
  size?: number
  stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>
}

export interface IMMediaInput extends Omit<IMMedia, 'id' | 'locator'> {
  source: IMMediaSource
}

export type IMTextEntity =
  | {
      type: 'mention'
      /** UTF-16 code-unit offset, matching Telegram and JavaScript string indexing. */
      offset: number
      length: number
      /** Opaque platform user ID. */
      userId: string
      /** Optional platform display/account number (QQ UIN, etc.). */
      numericId?: string
    }
  | {
      type: 'custom-emoji'
      offset: number
      length: number
      /** Definition includes the platform-native key and downloadable visual resource. */
      definition: IMReactionDefinition
    }
  | {
      type: 'conversation-link'
      offset: number
      length: number
      /** A non-dialog conversation made addressable by this message. */
      conversation: IMConversation
    }

export type IMMessagePart<TMediaLocator = unknown> =
  | { type: 'text', text: string, entities?: IMTextEntity[] }
  | { type: 'media', media: IMMedia<TMediaLocator> }
  | { type: 'sticker', sticker: import('./sticker-provider.js').IMSticker }
  | { type: 'card', card: IMMessageCard }

/** Platform share metadata projected as Telegram's native WebPage preview. */
export interface IMMessageCard {
  kind: 'mini-app' | 'link' | 'music' | 'contact' | 'location' | 'application'
  title: string
  description?: string
  source?: string
  url?: string
  thumbnailUrl?: string
}

export type IMMessageInputPart =
  | { type: 'text', text: string, entities?: IMTextEntity[] }
  | { type: 'media', media: IMMediaInput }
  | { type: 'sticker', sticker: import('./sticker-provider.js').IMStickerSendPlan }

export interface IMMessageContent<TMediaLocator = unknown> {
  parts: IMMessagePart<TMediaLocator>[]
  /** Platform service/system message rendered by Telegram as a MessageService. */
  serviceAction?: { type: 'custom', text: string }
}

export interface IMMessageInput {
  parts: IMMessageInputPart[]
  replyToId?: string
  /** Stable platform-native sequence used when the reply target's opaque ID changes between account views. */
  replyToNativeSequence?: string
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
  /** Stable lexicographically sortable native ID used to preserve message order without relying on timestamps. */
  nativeOrderKey?: string
  outgoing?: boolean
  /** Opaque platform grouping key, retained for album reconciliation. */
  groupId?: string
  metadata?: JsonObject
  reactionContext?: IMReactionContext
  /** Opaque platform message ID referenced by this reply. */
  replyToId?: string
}

export function telegramMessageId(message: IMMessage): number | undefined {
  return telegramMessageIdFromMetadata(message.metadata)
}

export function telegramReplyToMessageId(message: IMMessage): number | undefined {
  return positiveInt32(message.metadata?.telegramReplyToMessageId)
}

export function telegramMessageIdFromMetadata(metadata?: JsonObject): number | undefined {
  return positiveInt32(metadata?.telegramMessageId)
}

function positiveInt32(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0x7fffffff
    ? value
    : undefined
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
  /** Stable platform-native sequence used when opaque message IDs change between account views. */
  nativeSequence?: string
}

/** The platform permanently cannot resolve the requested stored message target. */
export class IMMessageTargetUnavailableError extends Error {}

export interface IMReadTarget {
  conversationId: string
  /** Opaque logical platform message ID through which incoming messages were read. */
  messageId: string
}

export interface IMDeleteMessagesOptions {
  /** Request deletion for every participant instead of only the current user. */
  forEveryone: boolean
}

export interface IMForwardMessagesOptions {
  dropAuthor?: boolean
  replyToId?: string
  /** Authorized stored sources used when an adapter must copy instead of natively forward. */
  sourceMessages?: readonly IMMessage<any>[]
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
  /** Last platform message known to be read, when the upstream exposes an exact unread boundary. */
  readInboxMaxMessage?: IMMessage<TMediaLocator>
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
  /** Total dialogs available upstream, independent of this page's limit. */
  total?: number
}

export interface IMHistoryPage<TMediaLocator = unknown> {
  messages: IMMessage<TMediaLocator>[]
  nextCursor?: string
}

export interface IMMessageSearchQuery extends IMPageQuery {
  query: string
  fromUserId?: string
  minTimestamp?: number
  maxTimestamp?: number
  mediaKind?: IMMediaKind
}

export interface IMMessageSearchPage<TMediaLocator = unknown> {
  messages: IMMessage<TMediaLocator>[]
  nextCursor?: string
  total?: number
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

export type IMMessageSendRejectionReason = 'permission-denied'

/** A platform permanently rejected a send that must not be retried unchanged. */
export class IMMessageSendRejectedError extends Error {
  constructor(
    readonly reason: IMMessageSendRejectionReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'IMMessageSendRejectedError'
  }
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

  /** Resolve the platform's current user; bridge never invents profile fields. */
  getAccount?(): Promise<IMPlatformAccount<TMediaLocator>>

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
  /** Resolve one opaque platform conversation, used for targeted metadata backfill. */
  getConversation?(
    session: PlatformSession,
    conversationId: string,
  ): Promise<IMConversation<TMediaLocator> | null>
  /** Child conversations exposed lazily beneath one parent dialog, such as Discord guild channels. */
  getSubdialogs?(
    session: PlatformSession,
    parent: IMConversationRef,
    query?: IMPageQuery,
  ): Promise<IMDialogPage<TMediaLocator>>
  /** Address-book contacts. This is intentionally separate from recent dialogs. */
  getContacts?(session: PlatformSession, query?: IMPageQuery): Promise<IMUserPage<TMediaLocator>>
  getHistory?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query?: IMHistoryQuery,
  ): Promise<IMHistoryPage<TMediaLocator>>
  searchMessages?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMMessageSearchQuery,
  ): Promise<IMMessageSearchPage<TMediaLocator>>
  /** Resolve one opaque platform message, used for reply-target backfill. */
  getMessage?(
    session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<TMediaLocator> | null>
  markRead?(
    session: PlatformSession,
    target: IMReadTarget,
  ): Promise<void>
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
  /**
   * Resolve a short-lived direct download URL for the exact stored media.
   * The bridge only calls this after authorizing the media against the current
   * MTProto session; implementations must not return local/cache-only assets.
   */
  resolveMediaUrl?(
    session: PlatformSession,
    media: IMMedia<TMediaLocator>,
  ): Promise<IMDirectDownload | undefined>
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
  return message.content.parts.map(messagePartText).filter(Boolean).join('\n')
}

export function messagePartText(part: IMMessagePart<unknown>): string {
  if (part.type === 'text') return part.text
  if (part.type !== 'card') return ''
  const label = cardKindLabel(part.card.kind)
  const source = part.card.source?.trim()
  return source ? `${label} · ${source}` : label
}

export function cardUrl(card: IMMessageCard): string | undefined {
  if (!card.url) return
  try {
    const url = new URL(card.url)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !/\s/u.test(card.url)
      ? card.url
      : undefined
  } catch {
    return
  }
}

function cardKindLabel(kind: IMMessageCard['kind']): string {
  if (kind === 'mini-app') return '小程序'
  if (kind === 'music') return '音乐'
  if (kind === 'contact') return '联系人'
  if (kind === 'location') return '位置'
  if (kind === 'application') return '应用'
  return '分享'
}

export function messageMedia<TMediaLocator>(message: IMMessage<TMediaLocator>): IMMedia<TMediaLocator>[] {
  return message.content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
}

export function messageStickers(message: IMMessage<unknown>): import('./sticker-provider.js').IMSticker[] {
  return message.content.parts.flatMap((part) => part.type === 'sticker' ? [part.sticker] : [])
}
