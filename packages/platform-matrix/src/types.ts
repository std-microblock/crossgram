export interface MatrixWhoAmI {
  user_id: string
  device_id?: string
}

export interface MatrixProfile {
  displayname?: string
  avatar_url?: string
}

export interface MatrixEvent<T = Record<string, unknown>> {
  type: string
  event_id?: string
  sender?: string
  origin_server_ts?: number
  state_key?: string
  redacts?: string
  content: T
  unsigned?: {
    age?: number
    redacted_because?: MatrixEvent
    'm.relations'?: {
      'm.annotation'?: { chunk?: MatrixAnnotation[] }
    }
  }
}

export interface MatrixAnnotation {
  type: 'm.reaction'
  key: string
  count: number
  senders?: string[]
}

export interface MatrixRoomMemberContent {
  membership?: 'invite' | 'join' | 'knock' | 'leave' | 'ban'
  displayname?: string
  avatar_url?: string
}

export interface MatrixRoomMessageContent {
  msgtype?: string
  body?: string
  formatted_body?: string
  format?: string
  url?: string
  file?: { url?: string }
  filename?: string
  info?: {
    mimetype?: string
    size?: number
    w?: number
    h?: number
    duration?: number
    thumbnail_url?: string
    thumbnail_info?: {
      mimetype?: string
      size?: number
      w?: number
      h?: number
    }
  }
  'm.relates_to'?: {
    rel_type?: string
    event_id?: string
    'm.in_reply_to'?: { event_id?: string }
  }
  'm.new_content'?: MatrixRoomMessageContent
}

export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, MatrixJoinedRoom>
    leave?: Record<string, MatrixLeftRoom>
  }
  account_data?: { events?: MatrixEvent[] }
}

export interface MatrixJoinedRoom {
  state?: { events?: MatrixEvent[] }
  timeline?: { events?: MatrixEvent[], limited?: boolean, prev_batch?: string }
  ephemeral?: { events?: MatrixEvent[] }
  account_data?: { events?: MatrixEvent[] }
  unread_notifications?: { notification_count?: number, highlight_count?: number }
  summary?: {
    'm.heroes'?: string[]
    'm.joined_member_count'?: number
    'm.invited_member_count'?: number
  }
}

export interface MatrixLeftRoom {
  state?: { events?: MatrixEvent[] }
  timeline?: { events?: MatrixEvent[] }
}

export interface MatrixMessagesResponse {
  start?: string
  end?: string
  chunk: MatrixEvent[]
  state?: MatrixEvent[]
}

export interface MatrixEventContextResponse {
  start?: string
  end?: string
  event?: MatrixEvent
  events_before?: MatrixEvent[]
  events_after?: MatrixEvent[]
  state?: MatrixEvent[]
}

export interface MatrixMembersResponse {
  chunk: MatrixEvent<MatrixRoomMemberContent>[]
}

export interface MatrixJoinedRoomsResponse {
  joined_rooms: string[]
}

export interface MatrixDirectAccountData {
  [userId: string]: string[]
}

export interface MatrixMediaLocator {
  mxc: string
  thumbnailMxc?: string
}
