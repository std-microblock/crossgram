import Long from 'long'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import type { CapturedMtprotoEvent } from './types.js'

const MAX_DEPTH = 20
const MAX_BYTE_PREVIEW = 512

export function serializeDebugEvent(event: MtprotoDebugEvent, id: number): CapturedMtprotoEvent {
  const payload = toDebugJson(event.payload)
  const result: CapturedMtprotoEvent = {
    id,
    timestamp: event.timestamp,
    direction: event.direction,
    phase: event.phase,
    connectionId: event.connectionId,
    name: getEventName(payload),
    messageId: toLongString(event.messageId),
    seqNo: event.seqNo,
    authKeyId: event.authKeyId instanceof Uint8Array ? toHex(event.authKeyId) : event.authKeyId,
    sessionId: toLongString(event.sessionId),
    payload,
    error: event.error,
    searchText: '',
  }
  result.searchText = JSON.stringify({ ...result, searchText: undefined }).toLowerCase()
  return result
}

export function toDebugJson(value: unknown): unknown {
  return normalize(value, 0, new WeakSet<object>())
}

function normalize(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === 'string'
    || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return { $type: 'bigint', decimal: value.toString() }
  if (typeof value === 'symbol' || typeof value === 'function') return String(value)
  if (Long.isLong(value)) {
    return {
      $type: 'Long',
      decimal: value.toString(),
      hex: value.isNegative() ? `-0x${value.negate().toString(16)}` : `0x${value.toString(16)}`,
    }
  }
  if (value instanceof Uint8Array) {
    const preview = value.subarray(0, MAX_BYTE_PREVIEW)
    return {
      $type: 'bytes',
      length: value.length,
      hex: toHex(preview),
      truncated: value.length > preview.length,
    }
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { $type: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value !== 'object') return String(value)
  if (depth >= MAX_DEPTH) return '[Max depth reached]'
  if (ancestors.has(value)) return '[Circular]'

  ancestors.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map(item => normalize(item, depth + 1, ancestors))
  } else {
    result = Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalize(item, depth + 1, ancestors),
    ]))
  }
  ancestors.delete(value)
  return result
}

function getEventName(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'unknown'
  const object = payload as Record<string, unknown>
  const name = typeof object._ === 'string' ? object._ : 'unknown'
  if (name !== 'rpc_result' || !object.result || typeof object.result !== 'object') return name
  const resultName = (object.result as Record<string, unknown>)._ 
  return typeof resultName === 'string' ? `${name} -> ${resultName}` : name
}

function toLongString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (Long.isLong(value)) return value.isNegative() ? `-0x${value.negate().toString(16)}` : `0x${value.toString(16)}`
  return String(value)
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex')
}
