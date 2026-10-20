export function stripAnsi(value = '') {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}
export function parseCell(
  text: string,
  type: string,
  nullable: boolean,
  isNull: boolean,
): unknown {
  if (isNull) {
    if (!nullable) throw new Error('This field cannot be null')
    return null
  }
  if (/^(u?int|unsigned|integer|float|double|decimal|number)/i.test(type)) {
    if (!text.trim() || !Number.isFinite(Number(text)))
      throw new Error('Enter a finite number')
    const value = Number(text)
    if (/^(u?int|unsigned|integer)/i.test(type) && !Number.isSafeInteger(value))
      throw new Error('Enter a safe integer')
    return value
  }
  if (/^bool/i.test(type)) {
    if (text !== 'true' && text !== 'false')
      throw new Error('Use true or false')
    return text === 'true'
  }
  if (/^(json|object|list|array)/i.test(type)) return JSON.parse(text)
  return text
}
export function primaryKey(
  row: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  if (
    !keys.length ||
    keys.some((key) => row[key] === undefined || row[key] === null)
  )
    throw new Error('This row has no complete primary key')
  return Object.fromEntries(keys.map((key) => [key, row[key]]))
}
export function parseHeaders(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    const index = line.indexOf(':')
    if (index <= 0)
      throw new Error('Headers must use Name: value, one per line')
    const key = line.slice(0, index).trim(),
      value = line.slice(index + 1).trim()
    if (!/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(key))
      throw new Error('Invalid header name')
    if (/^(cookie|host|content-length|connection)$/i.test(key))
      throw new Error('This browser-controlled header cannot be set: ' + key)
    result[key] = value
  }
  return result
}
export function safeHttpURL(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials')
  return url.href
}
/** Bounded decoding prevents giant responses from freezing the interface. */

export { pageSlice, displayValue, readResponse } from '../utils.js'
