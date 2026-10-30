/** Lark 媒体定位器：下载走 `im/v1/messages/{message_id}/resources/{file_key}`。 */
export interface LarkMediaLocator {
  messageId?: string
  fileKey?: string
  type?: 'image' | 'file'
  /** CDN 直链资源（群头像等签名 URL），下载时不走消息资源接口。 */
  url?: string
}

export interface LarkTokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
  refresh_token_expires_in: number
  token_type?: string
}

export interface LarkUserInfo {
  open_id: string
  union_id?: string
  name?: string
  en_name?: string
  avatar_url?: string
}

export interface LarkChat {
  chat_id: string
  name?: string
  avatar?: string
  owner_id?: string
  chat_type?: 'p2p' | 'group'
  chat_mode?: string
  member_count?: number
  external?: boolean
}

/** 事件与 REST 共用的消息形状；`messageType` 统一两个接口的不同字段名（事件 message_type / REST msg_type）。 */
export interface LarkMessage {
  message_id: string
  chat_id: string
  chat_type?: 'p2p' | 'group'
  messageType: string
  /** JSON 字符串，结构随 msg_type 变化；REST 返回时嵌套在 body.content。 */
  content: string
  body?: { content?: string }
  /** REST 为毫秒字符串，事件为秒字符串。 */
  create_time: string
  root_id?: string
  parent_id?: string
  deleted?: boolean
  sender: LarkMessageSender
  mentions?: LarkMention[]
}

export interface LarkMessageSender {
  sender_id?: { open_id?: string, union_id?: string, user_id?: string }
  /** REST 列表接口的 sender 形状。 */
  id?: string
  id_type?: string
  sender_type?: string
}

export interface LarkMention {
  key: string
  id?: { open_id?: string, union_id?: string, user_id?: string }
  name?: string
}

export function larkSenderOpenId(sender: LarkMessageSender): string | undefined {
  return sender.sender_id?.open_id ?? sender.id
}

/** 统一 REST（毫秒）与事件（秒）的 create_time。 */
export function larkMessageTimestamp(message: Pick<LarkMessage, 'create_time'>): number {
  const raw = Number(message.create_time)
  if (!Number.isFinite(raw) || raw <= 0) return Math.floor(Date.now() / 1000)
  // REST create_time 是毫秒字符串
  return raw > 1e12 ? Math.floor(raw / 1000) : raw
}

export function larkMessageType(message: { messageType?: string }): string {
  return message.messageType ?? 'unknown'
}

/** WS 事件体；SDK 已把 header 平铺进同一对象（event_id 等来自 header）。 */
export interface LarkMessageReceiveEvent {
  event_id?: string
  sender: LarkMessageSender
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    thread_id?: string
    create_time?: string
    chat_id: string
    chat_type?: 'p2p' | 'group'
    message_type: string
    content: string
    mentions?: LarkMention[]
  }
}

export interface LarkMessageRecalledEvent {
  message_id: string
  chat_id: string
  operator_id?: { open_id?: string, union_id?: string, user_id?: string }
  recall_time?: string
}
