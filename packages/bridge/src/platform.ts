/**
 * IM platform abstraction. Auth is handled out-of-band via the HTTP API
 * (virtual phone + login code), so a platform only implements messaging + push
 * (required) and history (optional, per capabilities).
 */

export interface PlatformCapabilities {
  /** Can fetch dialog list / message history. */
  history: boolean
  /** Can send messages. */
  sendMessage: boolean
  /** Supports group chats. */
  groups: boolean
  maxMessageLength: number
}

export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
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
}

export interface IMMessage {
  id: string
  peerId: string
  senderId: string
  text?: string
  timestamp: number
  outgoing?: boolean
}

export interface IMDialog {
  peerId: string
  title: string
  unreadCount: number
  lastMessage?: IMMessage
}

export type IMEvent =
  | { type: 'message', message: IMMessage }
  | { type: 'read', peerId: string, upToMessageId: string }

export type Unsubscribe = () => void

export interface IMPlatform {
  readonly id: string
  readonly capabilities: PlatformCapabilities

  /** Subscribe to push events (required). */
  subscribe(session: PlatformSession, handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe>

  /** Send a message (required). */
  sendMessage(session: PlatformSession, peerId: string, text: string): Promise<IMMessage>

  /** Fetch dialogs (only if capabilities.history). */
  getDialogs?(session: PlatformSession): Promise<IMDialog[]>
  /** Fetch history for a peer (only if capabilities.history). */
  getHistory?(session: PlatformSession, peerId: string): Promise<IMMessage[]>
  /** Look up a user. */
  getUser?(session: PlatformSession, userId: string): Promise<IMUser | null>
}

/**
 * In-memory demo platform with two prefilled dialogs (Alice, Bob). Used to
 * exercise the full bridge flow (login → dialogs → send) without a real backend.
 */
export class StaticDemoPlatform implements IMPlatform {
  readonly id = 'static-demo'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    sendMessage: true,
    groups: false,
    maxMessageLength: 4096,
  }

  private _users: Record<string, IMUser> = {
    alice: { id: 'alice', firstName: 'Alice', username: 'alice' },
    bob: { id: 'bob', firstName: 'Bob', username: 'bob' },
  }

  private _messages: Record<string, IMMessage[]> = {
    alice: [
      { id: '1', peerId: 'alice', senderId: 'alice', text: 'Hey there!', timestamp: 1_700_000_000 },
      { id: '2', peerId: 'alice', senderId: 'alice', text: 'How are you?', timestamp: 1_700_000_100 },
    ],
    bob: [
      { id: '1', peerId: 'bob', senderId: 'bob', text: 'Meeting at 3?', timestamp: 1_700_000_200 },
    ],
  }

  private _seq = 100

  async subscribe(_session: PlatformSession, _handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe> {
    // Static platform pushes nothing; return a no-op unsubscribe.
    return () => {}
  }

  async sendMessage(_session: PlatformSession, peerId: string, text: string): Promise<IMMessage> {
    const msg: IMMessage = {
      id: String(++this._seq),
      peerId,
      senderId: 'self',
      text,
      timestamp: Math.floor(Date.now() / 1000),
      outgoing: true,
    }
    ;(this._messages[peerId] ??= []).push(msg)
    return msg
  }

  async getDialogs(_session: PlatformSession): Promise<IMDialog[]> {
    return Object.keys(this._users).map((peerId) => {
      const msgs = this._messages[peerId] ?? []
      return {
        peerId,
        title: this._users[peerId].firstName,
        unreadCount: 0,
        lastMessage: msgs[msgs.length - 1],
      }
    })
  }

  async getHistory(_session: PlatformSession, peerId: string): Promise<IMMessage[]> {
    return this._messages[peerId] ?? []
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser | null> {
    return this._users[userId] ?? null
  }
}
