/**
 * Key-order-insensitive JSON helpers for values that round-trip through a
 * durable JSON column.
 *
 * PostgreSQL jsonb does not preserve the key order of the payload it stores:
 * it returns keys ordered by length and then bytewise. Comparing
 * JSON.stringify() output against a freshly built payload therefore reports a
 * difference for every persisted row, which makes ingestion rewrite unchanged
 * messages and conversations on every read. Canonicalize both sides instead.
 */

/** Serialize a JSON value with a stable, sorted key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return JSON.stringify(value) ?? 'null'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return '{' + entries
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
    .join(',') + '}'
}

/** Structural equality that ignores JSON key order. */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  return canonicalJson(left) === canonicalJson(right)
}
