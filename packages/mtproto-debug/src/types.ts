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
}

export interface MtprotoDebugData {
  capturing: boolean
  /** Chunked ring buffer; see `chunks.ts` for why this is not a flat array. */
  chunks: Record<number, CapturedMtprotoEvent[]>
  dropped: number
  maxEvents: number
  start(): Promise<void>
  pause(): Promise<void>
  clear(): Promise<void>
}
