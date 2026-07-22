import type Long from 'long'

export type MtprotoDebugDirection = 'client->server' | 'server->client'
export type MtprotoDebugPhase = 'handshake' | 'message' | 'connection'

/** A decoded protocol interaction emitted by an MTProto server session. */
export interface MtprotoDebugEvent {
  direction: MtprotoDebugDirection
  phase: MtprotoDebugPhase
  connectionId: string
  timestamp: number
  messageId?: Long | string
  seqNo?: number
  authKeyId?: Uint8Array | string | null
  sessionId?: Long | string
  payload?: unknown
  error?: string
}

export type MtprotoDebugListener = (event: MtprotoDebugEvent) => void
