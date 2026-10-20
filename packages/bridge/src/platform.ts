import type { VoiceCallMediaProvider } from './voice/media.js'

export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export type IMConversationKind = 'direct' | 'group' | 'channel'

export interface PlatformCapabilities {
  history: boolean
  readState?: {
    markRead: boolean
    events: boolean
  }
  /**
   * 平台原生消息序号的连续性：`'group'` 表示群聊 msgSeq 连续，可按序号检测并回填历史空洞，
   * 且 `getHistory` 支持 `beforeSequence`。
   */
  sequenceHistory?: 'group'
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
    updateRoles?: boolean
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
  /** 原生戳一戳能力；缺省时客户端隐藏该入口。 */
  poke?: {
    maxCount: number
  }
}

export interface IMMessageDeleteRule {
  supported: boolean
  maxAgeSeconds?: number
}

export interface PlatformSession {
  platformSessionId: string
  platformId: string
  userId: string
  credentials: JsonValue
  metadata: JsonObject
  virtualPhone?: string
}

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
  parentId?: string
  spaceId?: string
  avatar?: IMMedia<TMediaLocator>
  selfRole?: IMConversationRole
  selfPermissions?: IMConversationPermissions
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
  manageAdministrators?: boolean
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

/** 好友申请或入群申请，独立于普通消息与系统通知。 */
export interface IMRequest<TMediaLocator = unknown> {
  id: string
  kind: 'friend' | 'group-join'
  state: 'pending' | 'accepted' | 'rejected'
  requester: IMUser<TMediaLocator>
  group?: IMConversation<TMediaLocator>
  message?: string
  createdAt?: string | number
  metadata?: JsonObject
}

export interface IMRequestQuery {
  kind?: IMRequest['kind']
  cursor?: string
  limit?: number
}

export interface IMRequestPage<TMediaLocator = unknown> {
  requests: IMRequest<TMediaLocator>[]
  nextCursor?: string
}

export type IMRequestAction = 'accept' | 'reject'

export type IMMediaKind = 'image' | 'file'

export interface IMMediaPreview<TLocator = unknown> {
  mimeType?: string
  size: number
  width: number
  height: number
  locator: TLocator
}

export interface IMMedia<TLocator = unknown> {
  /** 平台原始媒体 ID，bridge 层不解析也不截断。 */
  id: string
  kind: IMMediaKind
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  /** 仅标记语音消息，不含普通音频文件。 */
  voice?: boolean
  transcript?: string
  preview?: IMMediaPreview<TLocator>
  /** Telegram 兼容的内联 stripped JPEG 缩略图。 */
  strippedThumbnail?: Uint8Array
  locator?: TLocator
}

/** 供打补丁客户端直连下载的短期 URL。 */
export interface IMDirectDownload {
  url: string
  /** Unix 毫秒时间戳。 */
  expiresAt: number
  supportsRange: boolean
}

export interface IMMediaSource {
  size?: number
  stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>
  /** 按字节范围读取，避免每次 `upload.getFile` 都从头拉取并丢弃前缀数据。 */
  streamRange?(options: { offset: number, limit: number, signal?: AbortSignal }): AsyncIterable<Uint8Array>
}

export interface IMMediaUploadHashes {
  size: number
  md5: string
  sha1: string
  /** QQ 视频按每 1 MiB 边界累计的 SHA-1 中间状态及最终摘要。 */
  sha1Checkpoints?: string[]
  /** 前 10 MiB 的 MD5，用于 QQ 私聊文件秒传。 */
  file10MMd5: string
}

export interface IMMediaUploadThumbnail {
  bytes: Uint8Array
  width: number
  height: number
}

/** 客户端上传文件分片前发送的元数据探测。 */
export interface IMMediaUploadProbe extends Omit<IMMediaInput, 'source'> {
  hashes: IMMediaUploadHashes
  thumbnail?: IMMediaUploadThumbnail
}

export interface IMMediaUploadSink {
  write(bytes: Uint8Array): Promise<void>
  complete(): Promise<void>
  abort(reason?: unknown): void | Promise<void>
}

/**
 * 原生上传预检结果。无 `sink` 表示远端已命中秒传可直接发送；有 `sink` 时由 bridge 将
 * 客户端上传的分片重排校验后直接写入 `sink`，不落盘暂存。
 */
export interface IMMediaUploadPreparation {
  media: IMMediaInput
  sink?: IMMediaUploadSink
}

export interface IMMediaInput extends Omit<IMMedia, 'id' | 'locator'> {
  source: IMMediaSource
  /** 可直接复用的源平台媒体，无需重新上传字节流。 */
  origin?: IMMedia
}

export interface IMFlashTransferResult {
  fileSetId: string
  shareLink: string
  expiresAt?: number
}

/** 嵌入在单条消息内的合并转发消息包（非独立会话，仅由 `IMMessageBundleProvider` 解析）。 */
export interface IMMessageBundle {
  id: string
  title: string
  preview?: string
  locator: JsonValue
}

export interface IMFlashTransferProvider {
  prepareUpload?(
    session: PlatformSession,
    media: IMMediaUploadProbe,
  ): Promise<IMMediaUploadPreparation | undefined>
  create(
    session: PlatformSession,
    media: readonly IMMediaInput[],
    options?: { name?: string, signal?: AbortSignal },
  ): Promise<IMFlashTransferResult>
}

export type IMTextEntity =
  | {
      type: 'mention'
      /** UTF-16 码元偏移，与 Telegram 及 JS 字符串索引一致。 */
      offset: number
      length: number
      userId: string
      /** 平台展示号（如 QQ 号）。 */
      numericId?: string
    }
  | {
      type: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'blockquote'
      offset: number
      length: number
      language?: string
    }
  | {
      type: 'text-link'
      offset: number
      length: number
      url: string
    }
  | {
      type: 'custom-emoji'
      offset: number
      length: number
      definition: IMReactionDefinition
    }
  | {
      type: 'conversation-link'
      offset: number
      length: number
      conversation: IMConversation
    }

export type IMMessagePart<TMediaLocator = unknown> =
  | { type: 'text', text: string, entities?: IMTextEntity[] }
  | { type: 'media', media: IMMedia<TMediaLocator> }
  | { type: 'sticker', sticker: import('./sticker-provider.js').IMSticker }
  | { type: 'card', card: IMMessageCard }
  | { type: 'message-bundle', bundle: IMMessageBundle }

export interface IMMessageCard {
  kind: 'mini-app' | 'link' | 'music' | 'contact' | 'location' | 'application'
  title: string
  description?: string
  source?: string
  url?: string
  thumbnailUrl?: string
  /** Official group-invite cards: the adapter turns this into an accept button. */
  groupInvite?: IMMessageGroupInvite
}

/** Parameters of an official group-invite card, resolved by the protocol side. */
export interface IMMessageGroupInvite {
  groupCode: string
  msgSeq: string
}

export type IMMessageInputPart =
  | { type: 'text', text: string, entities?: IMTextEntity[] }
  | { type: 'media', media: IMMediaInput }
  | { type: 'sticker', sticker: import('./sticker-provider.js').IMStickerSendPlan }

export interface IMServiceMember {
  id: string
  name?: string
}

/** 投影为 Telegram `MessageService` 的系统提示；`members-joined` 同时保留成员列表与原始文案以便无法完整解析成员时回退。 */
export type IMMessageServiceAction =
  | { type: 'custom', text: string }
  | { type: 'phone-call', duration?: number }
  | {
      type: 'members-joined'
      text: string
      members: IMServiceMember[]
      actor?: IMServiceMember
      viaInviteLink?: boolean
    }

export interface IMMessageContent<TMediaLocator = unknown> {
  parts: IMMessagePart<TMediaLocator>[]
  inlineKeyboard?: IMInlineKeyboard
  serviceAction?: IMMessageServiceAction
  /**
   * Markdown the body was written in, when the platform knows it (QQ official
   * bots send their whole body as markdown).
   *
   * Telegram draws tables, headings and real lists only in a rich message, so
   * the relay renders this into page blocks and sends the message as one. The
   * text parts stay the message text.
   */
  richMarkdown?: string
}

export interface IMInlineKeyboard {
  rows: Array<{ buttons: IMInlineKeyboardButton[] }>
}

export type IMInlineKeyboardButton =
  | { type: 'url', text: string, url: string, style?: 'primary' | 'danger' | 'success' }
  | {
      type: 'callback'
      text: string
      data: string
      style?: 'primary' | 'danger' | 'success'
      metadata?: JsonObject
    }

export interface IMMessageInput {
  parts: IMMessageInputPart[]
  replyToId?: string
  /** 跨账号视角下消息 ID 变化时用于定位被回复消息的平台原生序号。 */
  replyToNativeSequence?: string
}

export interface IMMessage<TMediaLocator = unknown> {
  id: string
  /** 逻辑消息对应的底层物理消息 ID 列表（如相册分片）。 */
  sourceIds?: string[]
  conversationId: string
  senderId: string
  sender?: IMUser<TMediaLocator>
  /** 会话内成员头衔。 */
  senderTitle?: string
  content: IMMessageContent<TMediaLocator>
  timestamp: number
  /** 按字典序排列的平台原生排序键。 */
  nativeOrderKey?: string
  outgoing?: boolean
  /** 标记上游已撤回但保留为墓碑的消息。 */
  recalled?: boolean
  groupId?: string
  metadata?: JsonObject
  reactionContext?: IMReactionContext
  replyToId?: string
}

/** 合并转发包内的单条消息快照，不含 `conversationId`。 */
export interface IMMessageSnapshot<TMediaLocator = unknown>
  extends Omit<IMMessage<TMediaLocator>, 'conversationId'> {}

export interface IMMessageBundleProvider<TMediaLocator = unknown> {
  load(
    session: PlatformSession,
    locator: JsonValue,
  ): Promise<IMMessageSnapshot<TMediaLocator>[]>
  avatar?(
    session: PlatformSession,
    locator: JsonValue,
  ): Promise<IMMedia<TMediaLocator> | undefined>
}

export function messageMentionsUser(message: IMMessage, userId: string): boolean {
  return message.content.parts.some((part) =>
    part.type === 'text'
    && part.entities?.some((entity) => entity.type === 'mention' && entity.userId === userId),
  )
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
  /** Telegram `chosen_order`，值越大表示越晚选中。 */
  selectedOrder?: number
  recentActors?: IMReactionActor[]
}

export interface IMReactionResource {
  version: number
  format: 'static' | 'animated' | 'video'
  mimeType: 'image/webp' | 'image/png' | 'image/gif' | 'image/apng' | 'video/webm'
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

export interface IMReactionActorPage {
  context: IMReactionContext
  actors: Array<{ reactionKey: string, actor: IMReactionActor }>
  nextOffset?: string
}

export interface IMReactionActorPageRequest {
  reactionKey?: string
  offset?: string
  limit: number
}

export interface IMMessageTarget {
  conversationId: string
  messageId: string
  targetId: string
  nativeSequence?: string
}

export class IMMessageTargetUnavailableError extends Error {}

export class IMMediaUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IMMediaUnavailableError'
  }
}

export interface IMReadTarget {
  conversationId: string
  messageId: string
}

export interface IMDeleteMessagesOptions {
  forEveryone: boolean
}

export type IMConversationMemberModeration =
  | { type: 'mute', untilDate: number }
  | { type: 'unmute' }
  | { type: 'kick', rejectAddRequest?: boolean }

export interface IMForwardMessagesOptions {
  dropAuthor?: boolean
  replyToId?: string
  /** 平台不支持原生转发时，供适配器按内容复制重发的源消息。 */
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
  readInboxMaxMessage?: IMMessage<TMediaLocator>
}

export interface IMPageQuery {
  cursor?: string
  limit?: number
  afterId?: string
}

export interface IMHistoryAnchor {
  id: string
  timestamp: number
}

export interface IMHistoryQuery extends IMPageQuery {
  before?: IMHistoryAnchor
  after?: IMHistoryAnchor
  /** 未指定锚点时固定从最新消息拉取，而非平台默认的未读边界窗口。 */
  latest?: boolean
  /** 按平台原生序号向更早方向读取（含该序号），需要 `capabilities.sequenceHistory`。 */
  beforeSequence?: string
}

export interface IMDialogPage<TMediaLocator = unknown> {
  dialogs: IMDialog<TMediaLocator>[]
  nextCursor?: string
  total?: number
}

export interface IMHistoryPage<TMediaLocator = unknown> {
  messages: IMMessage<TMediaLocator>[]
  nextCursor?: string
  /**
   * 本页原始记录（平台侧过滤撤回、灰条之前）覆盖的原生序号区间，只在按 `beforeSequence` 读取时给出。
   * 区间内缺失的序号已确认不存在或不可见，无需再次回填。
   */
  coverage?: { minSequence: string, maxSequence: string }
}

export interface IMGroupFile<TMediaLocator = unknown> {
  type: 'file'
  id: string
  parentId: string
  name: string
  size: number
  uploadTime: number
  modifyTime: number
  expiresAt?: number
  downloadCount: number
  uploaderId: string
  uploaderName: string
  media: IMMedia<TMediaLocator>
}

export interface IMGroupFileFolder {
  type: 'folder'
  id: string
  parentId: string
  name: string
  createTime: number
  modifyTime: number
  creatorId: string
  creatorName: string
  fileCount: number
}

export interface IMGroupFilePage<TMediaLocator = unknown> {
  items: Array<IMGroupFile<TMediaLocator> | IMGroupFileFolder>
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

export type IMMessageSendRejectionReason = 'permission-denied' | 'platform-rejected'

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
  | {
      type: 'message'
      message: IMMessage<TMediaLocator>
      conversation: IMConversation<TMediaLocator>
      /** 标记读取历史时补齐的实时订阅漏接消息。 */
      delivery?: 'recovery'
    }
  | { type: 'message-edit', eventId: string, message: IMMessage<TMediaLocator>, conversation: IMConversation<TMediaLocator> }
  | {
      type: 'message-delete'
      eventId: string
      conversation: IMConversation<TMediaLocator>
      messageIds: string[]
      timestamp: number
    }
  | { type: 'conversation', conversation: IMConversation<TMediaLocator> }
  | {
      type: 'request'
      request: IMRequest<TMediaLocator>
      delivery?: 'recovery'
    }
  | { type: 'read', conversationId: string, upToMessageId: string }
  | {
      type: 'message-reactions'
      eventId: string
      conversation: IMConversation<TMediaLocator>
      target: IMMessageTarget
      context: IMReactionContext
      timestamp: number
    }
  | {
      type: 'voice-transcript'
      eventId: string
      conversation: IMConversation<TMediaLocator>
      messageId: string
      transcript: string
      timestamp: number
    }
  | {
      /** 瞬态一对一语音通话状态，不持久化为消息。 */
      type: 'voice-call'
      callRef: string
      signal: 'incoming' | 'accept-requested' | 'refuse-requested' | 'logout-requested' | 'ended'
      media: 'voice' | 'unknown'
      conversation: IMConversation<TMediaLocator>
      timestamp: number
    }

export type IMVoiceCallOperation = 'accept' | 'reject' | 'hangup'

export interface IMVoiceCallController {
  control(session: PlatformSession, callRef: string, operation: IMVoiceCallOperation): Promise<void>
}

export type Unsubscribe = () => void | Promise<void>

export interface IMPlatform<TMediaLocator = unknown> {
  readonly platformKind?: string
  readonly capabilities: PlatformCapabilities
  readonly voiceMedia?: VoiceCallMediaProvider
  readonly voiceCalls?: IMVoiceCallController
  readonly flashTransfer?: IMFlashTransferProvider
  readonly messageBundles?: IMMessageBundleProvider<TMediaLocator>

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

  /**
   * 在客户端上传分片前基于元数据准备原生上传。返回 `undefined` 则回退到磁盘暂存分片；
   * 含 `sink` 则继续接收 `upload.saveFilePart`；无 `sink` 则表示秒传命中。
   */
  prepareMediaUpload?(
    session: PlatformSession,
    conversation: IMConversationRef,
    media: IMMediaUploadProbe,
  ): Promise<IMMediaUploadPreparation | undefined>

  getDialogs?(session: PlatformSession, query?: IMPageQuery): Promise<IMDialogPage<TMediaLocator>>
  getConversation?(
    session: PlatformSession,
    conversationId: string,
  ): Promise<IMConversation<TMediaLocator> | null>
  /** 父会话下按需暴露的子频道（如 Discord 服务器频道）。 */
  getSubdialogs?(
    session: PlatformSession,
    parent: IMConversationRef,
    query?: IMPageQuery,
  ): Promise<IMDialogPage<TMediaLocator>>
  getContacts?(session: PlatformSession, query?: IMPageQuery): Promise<IMUserPage<TMediaLocator>>
  getRequests?(session: PlatformSession, query?: IMRequestQuery): Promise<IMRequestPage<TMediaLocator>>
  resolveRequest?(
    session: PlatformSession,
    id: string,
    action: IMRequestAction,
  ): Promise<IMRequest<TMediaLocator>>
  getHistory?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query?: IMHistoryQuery,
  ): Promise<IMHistoryPage<TMediaLocator>>
  listGroupFiles?(
    session: PlatformSession,
    conversation: IMConversationRef,
    query?: IMPageQuery & { folderId?: string },
  ): Promise<IMGroupFilePage<TMediaLocator>>
  getMessage?(
    session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<TMediaLocator> | null>
  clickInlineButton?(
    session: PlatformSession,
    target: { conversationId: string, messageId: string, nativeSequence?: string },
    button: Extract<IMInlineKeyboardButton, { type: 'callback' }>,
  ): Promise<{ message?: string, alert?: boolean, url?: string, refresh?: true }>
  markRead?(
    session: PlatformSession,
    target: IMReadTarget,
  ): Promise<void>
  sendPoke?(
    session: PlatformSession,
    conversation: IMConversationRef,
    target: { userId: string },
    count: number,
  ): Promise<IMMessage<TMediaLocator> | undefined>

  /** 反向同步会话通知屏蔽策略（如 QQ 群消息屏蔽设置）。 */
  setConversationNotificationMask?(
    session: PlatformSession,
    conversationId: string,
    mask: number,
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
  setConversationMemberRole?(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
    role: 'administrator' | 'member',
  ): Promise<void>
  moderateConversationMember?(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
    action: IMConversationMemberModeration,
  ): Promise<void>
  blockUser?(
    session: PlatformSession,
    userId: string,
    blocked: boolean,
  ): Promise<void>
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
  /** 解析供客户端直连的短期下载 URL，不得返回仅本地可达的资源。 */
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
  getMessageReactionActors?(
    session: PlatformSession,
    target: IMMessageTarget,
    request: IMReactionActorPageRequest,
  ): Promise<IMReactionActorPage>
  downloadReactionResource?(
    session: PlatformSession,
    resource: IMReactionResource,
    options?: IMDownloadOptions,
  ): AsyncIterable<Uint8Array>
  resolveReactionResourceUrl?(
    session: PlatformSession,
    resource: IMReactionResource,
  ): Promise<IMDirectDownload | undefined>
}

export type IMProjectableMessage<TMediaLocator = unknown> =
  | IMMessage<TMediaLocator>
  | IMMessageSnapshot<TMediaLocator>

export function messageText(message: IMProjectableMessage<unknown>): string {
  return message.content.parts.map(messagePartText).filter(Boolean).join('\n')
}

export function messagePartText(part: IMMessagePart<unknown>): string {
  if (part.type === 'text') return part.text
  if (part.type !== 'card') return ''
  const label = cardKindLabel(part.card.kind)
  const source = part.card.source?.trim()
  return source ? `${label} · ${source}` : label
}

/**
 * 判断是否为投影成 Telegram `MessageService` 的系统提示消息。
 * QQ 灰条挂在对应正文消息的 `msgSeq` 上，撤回灰条实际会撤回该正文消息，不能作为独立消息寻址。
 */
export function isServiceMessage(
  message: Pick<IMProjectableMessage<unknown>, 'content'>,
): boolean {
  return message.content.serviceAction !== undefined && message.content.serviceAction !== null
}

export function serviceActionMembers(
  action: IMMessageServiceAction | undefined | null,
): IMServiceMember[] {
  if (action?.type !== 'members-joined') return []
  return [...(action.actor ? [action.actor] : []), ...action.members]
}

export function serviceActionText(
  action: IMMessageServiceAction | undefined | null,
): string {
  return action && 'text' in action ? action.text : ''
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

export function messageMedia<TMediaLocator>(message: IMProjectableMessage<TMediaLocator>): IMMedia<TMediaLocator>[] {
  return message.content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
}

export function isArticleMessage(message: IMProjectableMessage<unknown>): boolean {
  const media = messageMedia(message)
  return media.length >= 2
    && message.content.parts.every((part) => part.type === 'text' || part.type === 'media')
    && media.every((item) => item.kind === 'image'
      && item.mimeType !== 'image/gif' && item.mimeType !== 'image/apng')
    && message.content.parts.some((part, index) => part.type === 'text' && part.text.trim()
      && message.content.parts.slice(0, index).some((before) => before.type === 'media')
      && message.content.parts.slice(index + 1).some((after) => after.type === 'media'))
}

export function messageStickers(message: IMMessage<unknown>): import('./sticker-provider.js').IMSticker[] {
  return message.content.parts.flatMap((part) => part.type === 'sticker' ? [part.sticker] : [])
}
