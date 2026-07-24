import type { CapturedMtprotoEvent } from './types.js'

export const SLOW_RPC_THRESHOLD_MS = 1_000

export type RpcResultState = 'ok' | 'slow' | 'error'

export interface EventGroup {
  event: CapturedMtprotoEvent
  result?: CapturedMtprotoEvent
}

export interface RpcResultMetrics {
  durationMs: number
  state: RpcResultState
}

export function getRpcResultMetrics(
  call: CapturedMtprotoEvent,
  result?: CapturedMtprotoEvent,
): RpcResultMetrics | undefined {
  if (!result) return undefined
  const durationMs = Math.max(0, result.timestamp - call.timestamp)
  return {
    durationMs,
    state: isRpcError(result)
      ? 'error'
      : durationMs >= SLOW_RPC_THRESHOLD_MS ? 'slow' : 'ok',
  }
}

export function isRpcError(event: CapturedMtprotoEvent): boolean {
  if (!event.payload || typeof event.payload !== 'object') return false
  const payload = event.payload as Record<string, unknown>
  if (payload._ !== 'rpc_result' || !payload.result || typeof payload.result !== 'object') return false
  return (payload.result as Record<string, unknown>)._ === 'mt_rpc_error'
}

export function groupRpcEvents(events: CapturedMtprotoEvent[]): EventGroup[] {
  const calls = new Map<string, CapturedMtprotoEvent>()
  for (const event of events) {
    if (event.messageId && !event.requestMessageId) {
      calls.set(eventKey(event.connectionId, event.messageId), event)
    }
  }

  const groupedResults = new Set<number>()
  const resultByCall = new Map<number, CapturedMtprotoEvent>()
  for (const event of events) {
    if (!event.requestMessageId) continue
    const call = calls.get(eventKey(event.connectionId, event.requestMessageId))
    if (call && !resultByCall.has(call.id)) {
      resultByCall.set(call.id, event)
      groupedResults.add(event.id)
    }
  }

  const groups: EventGroup[] = []
  for (const event of events) {
    if (event.requestMessageId && groupedResults.has(event.id)) continue

    const result = resultByCall.get(event.id)
    const group: EventGroup = result ? { event, result } : { event }
    groups.push(group)
  }
  return groups
}

export function filterEventGroups(
  groups: EventGroup[],
  filter: string,
  typeFilter?: { mode: 'include' | 'exclude', value: string },
): EventGroup[] {
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length && !typeFilter) return groups
  return groups.filter(group => {
    if (terms.length && !terms.every(term =>
      group.event.searchText.includes(term) || !!group.result?.searchText.includes(term))) return false
    if (!typeFilter) return true
    const matches = group.event.name === typeFilter.value || group.result?.name === typeFilter.value
    return typeFilter.mode === 'include' ? matches : !matches
  })
}

export function countGroupedEvents(groups: EventGroup[]): number {
  return groups.reduce((count, group) => count + 1 + (group.result ? 1 : 0), 0)
}

function eventKey(connectionId: string, messageId: string): string {
  return `${connectionId}:${messageId}`
}
