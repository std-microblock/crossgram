import { dirname, join, resolve } from 'node:path'

export interface HistoryProfileOptions {
  host: string
  port: number
  database: string
  rsaKey: string
  authKeyStore: string
  serverAuthKeyId?: string
  authId?: string
  conversation?: string
  peer?: string
  offsetId: number
  offsetDate: number
  addOffset: number
  limit: number
  maxId: number
  minId: number
  warmup: number
  repeat: number
  timeoutMs: number
  logLevel: number
}

export function parseHistoryProfileOptions(argv: readonly string[]): HistoryProfileOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const equals = arg.indexOf('=')
    if (equals >= 0) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    values.set(arg.slice(2), value)
  }
  const integer = (name: string, fallback: number, minimum = 0) => {
    const raw = values.get(name)
    const value = raw === undefined ? fallback : Number(raw)
    if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`)
    return value
  }
  const database = resolve(values.get('database') ?? 'data/cordis.db')
  const options: HistoryProfileOptions = {
    host: values.get('host') ?? '127.0.0.1',
    port: integer('port', 4430, 1),
    database,
    rsaKey: resolve(values.get('rsa-key') ?? join(dirname(database), 'rsa-key.json')),
    authKeyStore: resolve(values.get('auth-key-store') ?? join(dirname(database), 'auth-keys.json')),
    serverAuthKeyId: values.get('server-auth-key-id'),
    authId: values.get('auth-id'),
    conversation: values.get('conversation'),
    peer: values.get('peer'),
    offsetId: integer('offset-id', 1),
    offsetDate: integer('offset-date', 0),
    addOffset: integer('add-offset', -25, Number.MIN_SAFE_INTEGER),
    limit: integer('limit', 50, 1),
    maxId: integer('max-id', 0),
    minId: integer('min-id', 0),
    warmup: integer('warmup', 1),
    repeat: integer('repeat', 5, 1),
    timeoutMs: integer('timeout-ms', 30_000, 1),
    logLevel: integer('log-level', 0),
  }
  if (!options.conversation && !options.peer) {
    throw new Error('pass --conversation <platform conversation id> or --peer <channel|chat|user>:<id>')
  }
  return options
}

export function stableSyntheticId(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 0x7ffffffe + 1
}

export function percentile(samples: readonly number[], fraction: number): number {
  if (!samples.length) return 0
  const sorted = samples.slice().sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!
}
