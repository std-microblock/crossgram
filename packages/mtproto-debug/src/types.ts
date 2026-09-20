export interface CapturedMtprotoEvent {
  id: number
  timestamp: number
  direction: 'client->server' | 'server->client'
  phase: 'handshake' | 'message' | 'connection'
  connectionId: string
  name: string
  messageId?: string
  requestMessageId?: string
  seqNo?: number
  authKeyId?: string | null
  sessionId?: string
  payload?: unknown
  error?: string
  searchText: string
  /** Lightweight list rows omit payload and searchText until expanded. */
  payloadOmitted?: boolean
  rpcError?: boolean
}

export interface MtprotoDebugData {
  capturing: boolean
  /** Same-origin paginated capture endpoint; history is never broadcast. */
  apiPath: string
  dropped: number
  maxEvents: number
  start(): Promise<void>
  pause(): Promise<void>
  clear(): Promise<void>
}
