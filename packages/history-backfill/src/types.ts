export type BackfillMode = 'sequence' | 'anchor'
export type BackfillFloorReason = 'start' | 'age' | 'empty'
export type BackfillSessionStatus = 'disabled' | 'waiting-idle' | 'capped' | 'working' | 'done' | 'unsupported'

export interface BackfillConversationSnapshot {
  conversationId: string
  title: string
  kind: string
  mode: BackfillMode
  bootstrapped: boolean
  spans: number
  covered: number
  minSequence?: number
  maxSequence?: number
  /** 会话最新一条消息的序号，顶部空洞的上界。 */
  upperSequence?: number
  gapCount: number
  missing: number
  floorReached: boolean
  floorReason?: BackfillFloorReason
  /** 已回填到的最早消息时间（Unix 秒）。 */
  oldestTimestamp?: number
  requests: number
  fetched: number
  inserted: number
  failures: number
  nextAttemptAt?: number
  lastRunAt?: number
  lastError?: string
}

export interface BackfillSessionSnapshot {
  platformSessionId: string
  platformId: string
  status: BackfillSessionStatus
  lastActivityAt?: number
  requestsToday: number
  dailyRequestCap: number
  totals: {
    conversations: number
    complete: number
    gaps: number
    missing: number
    fetched: number
    inserted: number
  }
  conversations: BackfillConversationSnapshot[]
}

export interface BackfillEvent {
  at: number
  platformSessionId: string
  conversationId: string
  title: string
  mode: BackfillMode
  kind: 'gap' | 'floor'
  /** 请求的序号区间或锚点描述。 */
  range: string
  fetched: number
  inserted: number
  error?: string
}

export interface BackfillSettings {
  idleAfterMs: number
  intervalMs: number
  pageSize: number
  dailyRequestCap: number
  maxAgeDays: number
}

export interface BackfillSnapshot {
  enabled: boolean
  busy: boolean
  settings: BackfillSettings
  sessions: BackfillSessionSnapshot[]
  recent: BackfillEvent[]
}

export interface HistoryBackfillData {
  snapshot: BackfillSnapshot
  setEnabled(enabled: boolean): Promise<void>
  /** 清除某个会话的失败退避与「已到底」标记，下次空闲时重新检查。 */
  resetConversation(platformSessionId: string, conversationId: string): Promise<void>
}
