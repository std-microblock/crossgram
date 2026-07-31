import type { CapturedMtprotoEvent } from './types.js'

export interface MtprotoCaptureFilters {
  limit?: number
  since?: number
  until?: number
  afterId?: number
  beforeId?: number
  id?: number
  name?: string
  direction?: CapturedMtprotoEvent['direction']
  phase?: CapturedMtprotoEvent['phase']
  connectionId?: string
  messageId?: string
  requestMessageId?: string
  authKeyId?: string
  sessionId?: string
  grep?: string
  fields?: Array<{ path: string, value: string }>
}

/** Flat view of the capture buffer; the live data stores events chunked (see `chunks.ts`). */
export interface CaptureSource {
  capturing: boolean
  dropped: number
  maxEvents: number
  events: CapturedMtprotoEvent[]
}

export interface MtprotoCaptureSnapshot {
  capturing: boolean
  dropped: number
  maxEvents: number
  total: number
  matched: number
  events: CapturedMtprotoEvent[]
}

export class CaptureQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureQueryError'
  }
}

export function parseCaptureQuery(query: URLSearchParams, now = Date.now()): MtprotoCaptureFilters {
  return {
    limit: parseInteger(query.get('limit'), 'limit', 1, 10_000) ?? 100,
    since: parseTime(query.get('since'), 'since', now),
    until: parseTime(query.get('until'), 'until', now),
    afterId: parseInteger(query.get('afterId'), 'afterId', 0),
    beforeId: parseInteger(query.get('beforeId'), 'beforeId', 1),
    id: parseInteger(query.get('id'), 'id', 1),
    name: optional(query.get('name')),
    direction: parseEnum(query.get('direction'), 'direction', ['client->server', 'server->client']),
    phase: parseEnum(query.get('phase'), 'phase', ['handshake', 'message', 'connection']),
    connectionId: optional(query.get('connectionId')),
    messageId: optional(query.get('messageId')),
    requestMessageId: optional(query.get('requestMessageId')),
    authKeyId: optional(query.get('authKeyId')),
    sessionId: optional(query.get('sessionId')),
    grep: optional(query.get('grep')),
    fields: query.getAll('field').map(parseField),
  }
}

export function queryCapture(data: CaptureSource, filters: MtprotoCaptureFilters = {}): MtprotoCaptureSnapshot {
  let events = data.events
  if (filters.since !== undefined) events = events.filter(event => event.timestamp >= filters.since!)
  if (filters.until !== undefined) events = events.filter(event => event.timestamp <= filters.until!)
  if (filters.afterId !== undefined) events = events.filter(event => event.id > filters.afterId!)
  if (filters.beforeId !== undefined) events = events.filter(event => event.id < filters.beforeId!)
  if (filters.id !== undefined) events = events.filter(event => event.id === filters.id)
  if (filters.name) events = events.filter(event => includes(event.name, filters.name!))
  if (filters.direction) events = events.filter(event => event.direction === filters.direction)
  if (filters.phase) events = events.filter(event => event.phase === filters.phase)
  if (filters.connectionId) events = events.filter(event => event.connectionId === filters.connectionId)
  if (filters.messageId) events = events.filter(event => event.messageId === filters.messageId)
  if (filters.requestMessageId) events = events.filter(event => event.requestMessageId === filters.requestMessageId)
  if (filters.authKeyId) events = events.filter(event => event.authKeyId === filters.authKeyId)
  if (filters.sessionId) events = events.filter(event => event.sessionId === filters.sessionId)
  if (filters.grep) events = events.filter(event => includes(event.searchText || JSON.stringify(event), filters.grep!))
  for (const field of filters.fields ?? []) {
    events = events.filter(event => scalarText(readPath(event, field.path)) === field.value)
  }
  const matched = events.length
  const limit = filters.limit ?? 100
  events = events.slice(-limit)
  return {
    capturing: data.capturing,
    dropped: data.dropped,
    maxEvents: data.maxEvents,
    total: data.events.length,
    matched,
    events,
  }
}

function optional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value
}

function parseInteger(value: string | null, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new CaptureQueryError(`Invalid ${name}: ${value}`)
  }
  return number
}

function parseTime(value: string | null, name: string, now: number): number | undefined {
  if (value === null || value === '') return undefined
  if (/^\d+$/.test(value)) {
    const timestamp = Number(value)
    if (!Number.isSafeInteger(timestamp)) throw new CaptureQueryError(`Invalid ${name}: ${value}`)
    return timestamp
  }
  const relative = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(value)
  if (relative) {
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
    return now - Number(relative[1]) * units[relative[2].toLowerCase() as keyof typeof units]
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) throw new CaptureQueryError(`Invalid ${name}: ${value}`)
  return timestamp
}

function parseEnum<T extends string>(value: string | null, name: string, values: readonly T[]): T | undefined {
  if (value === null || value === '') return undefined
  if (!values.includes(value as T)) throw new CaptureQueryError(`Invalid ${name}: ${value}`)
  return value as T
}

function parseField(expression: string): { path: string, value: string } {
  const separator = expression.indexOf('=')
  const path = expression.slice(0, separator)
  if (separator < 1 || !path.split('.').every(part => /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)$/.test(part))) {
    throw new CaptureQueryError(`Invalid field filter: ${expression}`)
  }
  return { path, value: expression.slice(separator + 1) }
}

function readPath(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function scalarText(value: unknown): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function includes(value: string, search: string): boolean {
  return value.toLowerCase().includes(search.toLowerCase())
}
