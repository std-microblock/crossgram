import type { tl } from '@mtcute/core'
import Long from 'long'
import type { UpdateJson, UpdateJsonValue } from '@mtproto-relay/update-store'

const TYPE_KEY = '$mtprotoRelayType'
const VALUE_KEY = 'value'
const UNSIGNED_KEY = 'unsigned'

/** Convert an mtcute TL update into a portable JSON value before storage. */
export function updateToJson(update: tl.RawUpdates): UpdateJson {
  return toJsonValue(update) as UpdateJson
}

/** Restore the mtcute runtime values required by the TL writer. */
export function updateFromJson(payload: UpdateJson): tl.RawUpdates {
  return fromJsonValue(payload) as tl.RawUpdates
}

function toJsonValue(value: unknown): UpdateJsonValue | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Telegram update JSON cannot contain a non-finite number')
    return value
  }
  if (typeof value === 'bigint') {
    return { [TYPE_KEY]: 'bigint', [VALUE_KEY]: value.toString() }
  }
  if (Long.isLong(value)) {
    return {
      [TYPE_KEY]: 'long',
      [VALUE_KEY]: value.toString(),
      [UNSIGNED_KEY]: value.unsigned,
    }
  }
  if (value instanceof Uint8Array) {
    return { [TYPE_KEY]: 'bytes', [VALUE_KEY]: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item) ?? null)
  }
  if (typeof value === 'object') {
    const output: Record<string, UpdateJsonValue> = {}
    for (const [key, child] of Object.entries(value)) {
      const encoded = toJsonValue(child)
      if (encoded !== undefined) output[key] = encoded
    }
    return output
  }
  throw new TypeError(`Telegram update JSON cannot contain ${typeof value}`)
}

function fromJsonValue(value: UpdateJsonValue): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(fromJsonValue)

  const tag = value[TYPE_KEY]
  const encoded = value[VALUE_KEY]
  if (tag === 'long' && typeof encoded === 'string') {
    return Long.fromString(encoded, value[UNSIGNED_KEY] === true)
  }
  if (tag === 'bytes' && typeof encoded === 'string') return Uint8Array.from(Buffer.from(encoded, 'base64'))
  if (tag === 'bigint' && typeof encoded === 'string') return BigInt(encoded)

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fromJsonValue(child)]))
}
