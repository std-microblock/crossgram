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

/**
 * True when every field of the expected payload matches the stored payload.
 *
 * Durable rows also carry state that the ingestion path does not own, such as
 * reaction selections or relay-only display fields. Those extra fields must not
 * make an otherwise unchanged payload look modified.
 */
export function jsonContains(container: unknown, expected: unknown): boolean {
  if (jsonEquals(container, expected)) return true
  if (Array.isArray(container) && Array.isArray(expected)) {
    return container.length === expected.length
      && expected.every((item, index) => jsonContains(container[index], item))
  }
  if (!container || !expected || typeof container !== 'object' || typeof expected !== 'object') {
    return false
  }
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (value === undefined) continue
    if (!jsonContains((container as Record<string, unknown>)[key], value)) return false
  }
  return true
}
