import type { CapturedMtprotoEvent } from './types.js'

export interface EventGroup {
  event: CapturedMtprotoEvent
  result?: CapturedMtprotoEvent
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

export function filterEventGroups(groups: EventGroup[], filter: string): EventGroup[] {
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return groups
  return groups.filter(group => terms.every(term =>
    group.event.searchText.includes(term) || !!group.result?.searchText.includes(term)))
}

export function countGroupedEvents(groups: EventGroup[]): number {
  return groups.reduce((count, group) => count + 1 + (group.result ? 1 : 0), 0)
}

function eventKey(connectionId: string, messageId: string): string {
  return `${connectionId}:${messageId}`
}
