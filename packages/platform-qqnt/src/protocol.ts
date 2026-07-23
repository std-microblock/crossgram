export interface QQMediaLocator {
  messageId: string
  elementId: string
  chatType: 1 | 2
  peerUid: string
  kind: 'image' | 'file'
  fileName: string
  fileSize?: string
  filePath?: string
  fileUuid?: string
  fileSubId?: string
  fileBizId?: number
  md5?: string
  sha?: string
  sha3?: string
  avatarUin?: string
}

export interface WireMedia {
  id: string
  kind: 'image' | 'file'
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  locator: QQMediaLocator
}

export type QQStickerReference =
  | {
      kind: 'market'
      packageId: string
      stickerId: string
      name: string
      key: string
      width: number
      height: number
      animated: boolean
      staticPath?: string
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
      locator?: QQMediaLocator
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

export interface WireMessage {
  id: string
  sourceIds?: string[]
  conversationId: string
  senderId: string
  timestamp: number
  outgoing: boolean
  sender?: {
    id: string
    numericId?: string
    name: string
    alias?: string
    avatar?: WireMedia
  }
  msgSeq?: string
  /** Correlates a local HTTP send with its QQ listener echo. */
  originRequestId?: string
  replyToId?: string
  parts: Array<
    | WireTextPart
    | { type: 'media', media: WireMedia }
    | { type: 'sticker', sticker: WireSticker }
  >
  reactionContext?: WireReactionState
}

export interface WireTextPart {
  type: 'text'
  text: string
  entities?: Array<{
    type: 'mention'
    offset: number
    length: number
    userId: string
    numericId?: string
  }>
}

export interface WireConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  peerUid: string
  peerUin: string
  chatType: 1 | 2
  avatarUrl?: string
  avatar?: WireMedia
  participantCount?: number
  selfRole?: 'owner' | 'administrator' | 'member'
  unreadCount?: number
  lastMessage?: WireMessage
  firstUnread?: { msgSeq: string, msgTime: string }
  readInboxMaxMessage?: WireMessage
}

export type WireEvent =
  | { type: 'message', conversation: WireConversation, message: WireMessage }
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
          locator: { filePath: string, assetKey?: string }
        }
      }
}

export interface WireReactionContext extends WireReactionState {
  available: WireReactionDefinition[]
}

export interface WireReactionState {
  reactions: Array<{ key: string, count: number, selected?: boolean }>
  maxSelected: number
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
    }
    role: 'owner' | 'administrator' | 'member'
  }>
  total?: number
  nextCursor?: string
}
