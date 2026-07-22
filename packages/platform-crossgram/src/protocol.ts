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

export interface WireMessage {
  id: string
  sourceIds?: string[]
  conversationId: string
  senderId: string
  timestamp: number
  outgoing: boolean
  msgSeq?: string
  parts: Array<{ type: 'text', text: string } | { type: 'media', media: WireMedia }>
  reactionContext?: WireReactionContext
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
  unreadCount?: number
  lastMessage?: WireMessage
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
      context: WireReactionContext
      timestamp: number
    }

export interface WireReactionContext {
  available: Array<{
    key: string
    title?: string
    presentation:
      | { type: 'emoji', emoticon: string }
      | {
          type: 'custom'
          alt: string
          resource: {
            version: number
            format: 'static'
            mimeType: 'image/png'
            width: number
            height: number
            size?: number
            locator: { filePath: string }
          }
        }
  }>
  reactions: Array<{ key: string, count: number, selected?: boolean }>
  maxSelected: number
}

export interface WireMemberPage {
  members: Array<{
    user: { id: string, numericId?: string, name: string, avatarUrl?: string }
    role: 'owner' | 'administrator' | 'member'
  }>
  total?: number
  nextCursor?: string
}
