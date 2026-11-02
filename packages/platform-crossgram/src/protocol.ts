import type { JsonValue } from '@mtproto-relay/bridge'
import type { QQPreparedMedia } from './highway.js'

export interface QQMediaLocator {
  messageId: string
  elementId: string
  chatType: 1 | 2 | 8 | 134
  peerUid: string
  kind: 'image' | 'file' | 'voice'
  fileName: string
  fileSize?: string
  filePath?: string
  fileUuid?: string
  fileSubId?: string
  fileBizId?: number
  md5?: string
  sha?: string
  sha3?: string
  /** 前 10 MiB 的 MD5，解析私聊文件 CDN 直链时必填。 */
  file10MMd5?: string
  /** QQ 原始 CDN URL；bridge 协议 v15 可直接替换其中过期的 RKey。 */
  originImageUrl?: string
  /** QQ 图片 CDN 规格：0 为原图，198 与 720 为原生缩略图。 */
  imageSpec?: 0 | 198 | 720
  /** 仅原生 QQ 视频元素存在：0 为 H.264，1 为 H.265。 */
  videoCodecFormat?: number
  avatarUin?: string
  avatarUrl?: string
  previewKey?: string
  /** 本地转码后的缓存路径，未转码的原文件不使用。 */
  cachedPath?: string
  /** 历史消息占位标记：字节尚未就绪，待后续 `message-edit` 事件补齐。 */
  deferred?: true
}

export interface WireMedia {
  id: string
  kind: 'image' | 'file'
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  voice?: boolean
  transcript?: string
  preview?: {
    mimeType?: string
    size: number
    width: number
    height: number
    locator: QQMediaLocator
  }
  locator: QQMediaLocator
}

export interface WireFlashTransferUploadFile {
  source: 'upload'
  name: string
  size: number
}

/** 已通过预上传流程写入 QQ 文件 CDN 的条目。 */
export interface WireFlashTransferUploadedFile {
  source: 'uploaded'
  name: string
  size: number
  md5: string
  sha1: string
}

export interface WireFlashTransferQQMediaFile {
  source: 'qq-media'
  name: string
  size: number
  locator: QQMediaLocator
}

export interface WireFlashTransferManifest {
  name?: string
  files: Array<WireFlashTransferUploadFile | WireFlashTransferUploadedFile | WireFlashTransferQQMediaFile>
  framing: 'length-prefixed-v1'
}

export interface WireFlashTransferResult {
  fileSetId: string
  shareLink: string
  expiresAt?: number
}

export interface WireGroupFile {
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
  busId: number
  media: WireMedia
}

export interface WireGroupFileFolder {
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

export interface WireGroupFilePage {
  items: Array<WireGroupFile | WireGroupFileFolder>
  nextCursor?: string
  total?: number
}

export type QQStickerReference = (
  | {
      kind: 'sysface'
      faceId: string
      faceType: number
      name: string
      packId?: string
      stickerId?: string
      sourceType?: number
      stickerType?: number
      resultId?: string
      imageType?: number
      width?: number
      height?: number
      animated: true
      url?: string
    }
  | {
      kind: 'market'
      packageId: string
      stickerId: string
      name: string
      key: string
      width: number
      height: number
      animated: boolean
      mimeType?: 'image/gif' | 'image/apng' | 'image/png'
      staticPath?: string
      staticSize?: number
      dynamicPath?: string
      favoriteResId?: string
    }
  | {
      kind: 'favorite'
      resId: string
      path: string
      name: string
      md5?: string
      size?: number
      width?: number
      height?: number
      animated: boolean
      mimeType?: 'image/gif' | 'image/apng' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp'
      url?: string
      locator?: QQMediaLocator
    }
) & {
  /** 历史消息占位标记：待后续 `message-edit` 事件补齐后才可读取。 */
  deferred?: true
}

export interface WireSticker {
  stickerId: string
  packId?: string
  title?: string
  format: 'static' | 'animated'
  mimeType: string
  width?: number
  height?: number
  size?: number
  version?: number
  reference: QQStickerReference
}

export interface WireStickerPackSummary {
  packId: string
  title: string
  count?: number
  version?: number
}

export interface WireStickerPack extends WireStickerPackSummary {
  stickers: WireSticker[]
}

export interface WireServiceMember {
  /** 成员的 QQ UID。 */
  id: string
  /** 通知中携带的昵称，资料未解析前作为回退。 */
  name?: string
}

/** 同时保留 QQ 原始文案与结构化入群信息；当所有成员均可解析时渲染为 Telegram 原生入群事件，否则回退为文本。 */
export type WireServiceAction =
  | { type: 'custom', text: string }
  | { type: 'phone-call' }
  | {
      type: 'members-joined'
      text: string
      members: WireServiceMember[]
      actor?: WireServiceMember
      viaInviteLink?: true
    }

export interface WireMessage {
  id: string
  sourceIds?: string[]
  conversationId: string
  senderId: string
  timestamp: number
  outgoing: boolean
  recalled?: boolean
  sender?: {
    id: string
    numericId?: string
    name: string
    alias?: string
    avatar?: WireMedia
    bot?: true
  }
  msgSeq?: string
  telegramMessageId?: number
  telegramReplyToMessageId?: number
  /** 用于将本地 HTTP 发送请求与 QQ 监听回显关联起来。 */
  originRequestId?: string
  replyToId?: string
  serviceAction?: WireServiceAction
  parts: Array<
    | WireTextPart
    | { type: 'markdown', content: string }
    | { type: 'inline-keyboard', keyboard: WireInlineKeyboard }
    | { type: 'media', media: WireMedia }
    | { type: 'sticker', sticker: WireSticker }
    | { type: 'multi-forward', title: string, preview?: string, locator: WireMultiForwardLocator }
    | { type: 'card', card: WireCard }
  >
  reactionContext?: WireReactionState
}

export interface WireInlineKeyboard {
  botAppid: string
  rows: Array<{ buttons: WireInlineKeyboardButton[] }>
}

export interface WireInlineKeyboardButton {
  id: string
  label: string
  visitedLabel: string
  style: number
  type: number
  clickLimit: number
  unsupportTips: string
  data: string
  atBotShowChannelList: boolean
  permissionType: number
  specifyRoleIds: string[]
  specifyTinyids: string[]
}

export interface WireCard {
  kind: 'mini-app' | 'link' | 'music' | 'contact' | 'location' | 'application'
  title: string
  description?: string
  source?: string
  url?: string
  thumbnailUrl?: string
  /** Official group-invite cards (bizsrc=qun.invite): accepts the invite server-side. */
  groupInvite?: WireGroupInvite
  /** Location cards (com.tencent.map LocationShare) carry coordinates. */
  location?: WireLocation
}

export interface WireLocation {
  lat: number
  lng: number
}

/** Parameters of an official "邀请你加入群聊" card's mqqapi jump link. */
export interface WireGroupInvite {
  groupCode: string
  /** Notify seq; the bridge resolves the invitation by it. */
  msgSeq: string
}

export interface WireMultiForwardLocator {
  conversationId: string
  rootMessageId: string
  parentMessageId?: string
}

export interface WireTextPart {
  type: 'text'
  text: string
  entities?: Array<
    | {
        type: 'mention'
        offset: number
        length: number
        userId: string
        numericId?: string
      }
    | {
        type: 'qq-face'
        offset: number
        length: number
        faceId: string
        faceType: number
      }
  >
}

export type WireSendPart =
  | WireTextPart
  | {
      type: 'media'
      media: WireSendMedia
      prepared?: QQPreparedMedia
    }

export interface WireSendMedia {
  kind: 'image' | 'video' | 'file' | 'voice'
  name: string
  mimeType?: string
  size?: number
  md5?: string
  sha1?: string
  sha1Checkpoints?: string[]
  file10MMd5?: string
  width?: number
  height?: number
  duration?: number
  thumbnail?: {
    size: number
    md5: string
    sha1: string
    width: number
    height: number
  }
}

export type WireUploadMedia = Omit<WireSendMedia, 'kind'> & { kind: 'image' | 'video' | 'file' }

export interface WireSendOptions {
  originRequestId?: string
  sticker?: QQStickerReference
  replyToId?: string
  replyToSequence?: string
}

export interface WireConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  peerUid: string
  peerUin: string
  chatType: 1 | 2 | 8 | 134
  /** QQ 群消息提醒策略：0 未指定；1 接收并提醒；2 收进群助手；3 屏蔽；4 接收不提醒。 */
  groupMsgMask?: 0 | 1 | 2 | 3 | 4
  avatarUrl?: string
  avatar?: WireMedia
  participantCount?: number
  selfRole?: 'owner' | 'administrator' | 'member'
  unreadCount?: number
  lastMessage?: WireMessage
  firstUnread?: { msgSeq: string, msgTime: string }
  readInboxMaxMessage?: WireMessage
}

export interface WireNativeAvsdkEvent {
  type: 'native-avsdk'
  version: 1
  callback: string
  args: unknown[]
}

export interface WireCallSignalEvent {
  type: 'call-signal'
  version: 1
  signal: 'incoming' | 'accept-requested' | 'refuse-requested' | 'logout-requested' | 'ended'
  media: 'voice' | 'unknown'
  callId: string
  conversation: WireConversation
  timestamp: number
}

export type WireRequestKind = 'friend' | 'group-join'

export type WireRequestStatus = 'pending' | 'accepted' | 'rejected'

export interface WireRequest {
  id: string
  kind: WireRequestKind
  status: WireRequestStatus
  requester: { id: string, name?: string }
  group?: { id: string, name?: string }
  message?: string
  timestamp?: string | number
  source?: 'doubt'
  reason?: string
}

/** `POST /v1/conversations/:id/pokes` 请求体（bridge 协议 v33）。 */
export interface WirePokeRequest {
  /** 被戳用户的 QQ UID。 */
  userId: string
  /** 连续戳一戳次数，1..10。 */
  count: number
}

export interface WirePokeResult {
  message?: WireMessage
}

export interface WireRequestPage {
  requests: WireRequest[]
  nextCursor?: string
}

export type WireEvent =
  | { type: 'message', conversation: WireConversation, message: WireMessage }
  | { type: 'message-edit', eventId: string, conversation: WireConversation, message: WireMessage }
  | { type: 'request', request: WireRequest }
  | WireCallSignalEvent
  | {
      type: 'voice-transcript'
      eventId: string
      conversation: WireConversation
      messageId: string
      transcript: string
      timestamp: number
    }
  | WireNativeAvsdkEvent
  | {
      type: 'message-delete'
      eventId: string
      conversation: WireConversation
      messageIds: string[]
      timestamp: number
    }
  | {
      type: 'message-reactions'
      eventId: string
      conversation: WireConversation
      target: { conversationId: string, messageId: string, targetId: string }
      context: WireReactionState
      timestamp: number
    }

export interface WireReactionDefinition {
  key: string
  title?: string
  presentation:
    | { type: 'emoji', emoticon: string }
    | {
        type: 'custom'
        alt: string
        resource: {
          version: number
          format: 'static' | 'video'
          mimeType: 'image/png' | 'video/webm'
          width: number
          height: number
          size?: number
          locator: JsonValue
        }
      }
}

export interface WireReactionAssetMeta {
  reactionKey?: string
  size: number
  version: number
  mimeType?: string
  width?: number
  height?: number
  /** QQ 表情压缩包内的条目名，用于诊断。 */
  entry?: string
  source?: 'path' | 'bundle' | 'payload'
}

export interface WireStickerAssetMeta {
  size: number
  version: number
  mimeType?: string
  width?: number
  height?: number
  source?: 'path' | 'bundle'
}

export interface WireReactionContext extends WireReactionState {
  available: WireReactionDefinition[]
}

export interface WireReactionState {
  reactions: Array<{
    key: string
    count: number
    selected?: boolean
    recentActors?: Array<{ userId: string, timestamp?: number }>
  }>
  maxSelected: number
}

export interface WireReactionActorPage {
  state: WireReactionState
  actors: Array<{ reactionKey: string, actor: { userId: string, timestamp?: number } }>
  nextOffset?: string
}

export interface WireMemberPage {
  members: Array<{
    user: {
      id: string
      numericId?: string
      name: string
      alias?: string
      avatarUrl?: string
      avatar?: WireMedia
      bot?: true
    }
    role: 'owner' | 'administrator' | 'member'
  }>
  total?: number
  nextCursor?: string
}
