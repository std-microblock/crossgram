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
  parts: Array<{ type: 'text', text: string } | { type: 'media', media: WireMedia }>
}

export interface WireConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  peerUid: string
  peerUin: string
  chatType: 1 | 2
  avatarUrl?: string
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

export interface WireMemberPage {
  members: Array<{
    user: { id: string, numericId?: string, name: string, avatarUrl?: string }
    role: 'owner' | 'administrator' | 'member'
  }>
  total?: number
  nextCursor?: string
}
