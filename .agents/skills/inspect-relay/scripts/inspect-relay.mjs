#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const MESSAGE_TABLES = [
  ['aliases', 'mtproto_im_message_alias', 'messageId'],
  ['media', 'mtproto_im_media', 'messageId'],
  ['telegramParts', 'mtproto_tl_message_part', 'messageId'],
  ['reactions', 'mtproto_im_message_reaction', 'messageId'],
]

export function parseArgs(argv) {
  const [command = 'doctor', ...tokens] = argv
  const options = { _: [] }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2)
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const next = tokens[index + 1]
    const value = inlineValue ?? (next !== undefined && !next.startsWith('--') ? tokens[++index] : true)
    if (key === 'where') (options.where ??= []).push(value)
    else options[key] = value
  }
  return { command, options }
}

export function parseDuration(value, now = Date.now()) {
  if (value === undefined) return undefined
  if (/^\d+$/.test(String(value))) return Number(value)
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(String(value))
  if (!match) {
    const timestamp = Date.parse(String(value))
    if (Number.isNaN(timestamp)) throw new Error(`Invalid time value: ${value}`)
    return timestamp
  }
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return now - Number(match[1]) * units[match[2].toLowerCase()]
}

export function parseScalar(value) {
  if (value === 'null') return null
  if (value === 'true') return 1
  if (value === 'false') return 0
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

export function findRuntime(start = process.cwd(), overrides = {}) {
  const root = resolve(overrides.root || start)
  let current = root
  let projectRoot = root
  while (true) {
    if (existsSync(join(current, 'app.yml')) || existsSync(join(current, 'package.json'))) {
      projectRoot = current
      if (existsSync(join(current, 'app.yml'))) break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const locate = (value, fallback) => value
    ? (isAbsolute(value) ? value : resolve(projectRoot, value))
    : join(projectRoot, fallback)
  return {
    root: projectRoot,
    db: locate(overrides.db, 'data/cordis.db'),
    logsDb: locate(overrides.logsDb, 'data/logs.db'),
    webui: String(overrides.webui || 'http://127.0.0.1:3140'),
  }
}

export function openReadOnly(filename) {
  if (!existsSync(filename)) throw new Error(`Database does not exist: ${filename}`)
  return new DatabaseSync(filename, { readOnly: true })
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
}

function assertIdentifier(value, label = 'identifier') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return `"${value}"`
}

function normalizeValue(value) {
  if (value instanceof Uint8Array) return { $type: 'bytes', base64: Buffer.from(value).toString('base64'), length: value.length }
  if (typeof value !== 'string') return value
  if (!/^(?:\{|\[)/.test(value.trim())) return value
  try { return JSON.parse(value) } catch { return value }
}

export function normalizeRows(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])))
}

export function queryLogs(db, options = {}) {
  const conditions = []
  const values = []
  if (options.since !== undefined) { conditions.push('ts >= ?'); values.push(parseDuration(options.since)) }
  if (options.level !== undefined) {
    const levels = { debug: 0, info: 1, success: 1, warn: 2, error: 3, fatal: 4 }
    const level = levels[String(options.level).toLowerCase()] ?? Number(options.level)
    if (!Number.isFinite(level)) throw new Error(`Invalid log level: ${options.level}`)
    conditions.push('level >= ?'); values.push(level)
  }
  if (options.name) { conditions.push('name LIKE ?'); values.push(`%${options.name}%`) }
  if (options.grep) { conditions.push('body LIKE ?'); values.push(`%${options.grep}%`) }
  const limit = boundedLimit(options.limit, 200)
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT id, sn, ts, type, level, name, body, entry_id AS entryId FROM logs${where} ORDER BY id DESC LIMIT ?`).all(...values, limit)
  return normalizeRows(rows.reverse())
}

function boundedLimit(value, fallback) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < 1 || number > 10_000) throw new Error(`Invalid limit: ${value}`)
  return number
}

export function queryTable(db, table, options = {}) {
  const available = new Set(tableNames(db))
  if (!available.has(table)) throw new Error(`Unknown table: ${table}`)
  const conditions = []
  const values = []
  for (const expression of options.where ?? []) {
    const separator = String(expression).indexOf('=')
    if (separator < 1) throw new Error(`Invalid --where expression: ${expression}`)
    const key = String(expression).slice(0, separator)
    const value = String(expression).slice(separator + 1)
    conditions.push(`${assertIdentifier(key, 'column')} IS ?`)
    values.push(parseScalar(value))
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  return normalizeRows(db.prepare(`SELECT * FROM ${assertIdentifier(table, 'table')}${where} LIMIT ?`).all(...values, boundedLimit(options.limit, 100)))
}

export function queryReadOnlySql(db, sql) {
  const source = String(sql || '').trim()
  if (!/^(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(source)) throw new Error('Only SELECT, WITH, PRAGMA, and EXPLAIN statements are allowed')
  const statement = db.prepare(source)
  return normalizeRows(statement.all())
}

function selectIfPresent(db, table, column, value) {
  if (!tableNames(db).includes(table)) return []
  return normalizeRows(db.prepare(`SELECT * FROM ${assertIdentifier(table)} WHERE ${assertIdentifier(column)} = ?`).all(value))
}

export function queryMessage(db, identifier, options = {}) {
  const platformId = options.platformId === true || options.platformId === 'true'
  let message
  if (platformId) {
    const clauses = ['a.platformMessageId = ?']
    const values = [String(identifier)]
    if (options.conversation !== undefined) { clauses.push('a.conversationId = ?'); values.push(Number(options.conversation)) }
    message = db.prepare(`SELECT m.* FROM mtproto_im_message m JOIN mtproto_im_message_alias a ON a.messageId = m.id WHERE ${clauses.join(' AND ')} ORDER BY m.id DESC LIMIT 1`).get(...values)
  } else {
    message = db.prepare('SELECT * FROM mtproto_im_message WHERE id = ?').get(Number(identifier))
  }
  if (!message) throw new Error(`Message not found: ${identifier}`)
  const bundle = { message: normalizeRows([message])[0] }
  for (const [key, table, column] of MESSAGE_TABLES) bundle[key] = selectIfPresent(db, table, column, message.id)
  bundle.conversation = selectIfPresent(db, 'mtproto_im_conversation', 'id', message.conversationId)[0] ?? null
  bundle.sender = selectIfPresent(db, 'mtproto_im_user', 'id', message.senderUserId)[0] ?? null
  bundle.deliveries = selectIfPresent(db, 'mtproto_update_delivery', 'platformSessionId', message.platformSessionId)
    .filter(row => String(row.eventKey ?? '').includes(String(message.primaryPlatformMessageId)) || Number(row.messageId) === Number(message.id))
  return bundle
}

export async function fetchMtprotoSnapshot(webui, options = {}, WebSocketImpl = globalThis.WebSocket) {
  if (!WebSocketImpl) throw new Error('This Node.js runtime does not provide WebSocket support')
  const endpoint = new URL(options.apiPath || '/api', webui)
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  const timeoutMs = Number(options.timeout ?? 5_000)
  const init = await new Promise((resolveInit, reject) => {
    const socket = new WebSocketImpl(endpoint)
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Timed out connecting to ${endpoint}`)) }, timeoutMs)
    const fail = event => { clearTimeout(timer); reject(new Error(`WebUI WebSocket failed: ${event?.message || endpoint}`)) }
    const receive = event => {
      try {
        const payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
        if (payload.type !== 'entry:init') return
        clearTimeout(timer)
        socket.close()
        resolveInit(payload.body)
      } catch (error) { clearTimeout(timer); socket.close(); reject(error) }
    }
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('error', fail)
      socket.addEventListener('message', receive)
    } else {
      socket.once('error', fail)
      socket.on('message', data => receive({ data }))
    }
  })
  const entries = Object.values(init.entries || {})
  const debug = entries.map(entry => entry?.data).find(data => data && Array.isArray(data.events) && 'maxEvents' in data)
  if (!debug) throw new Error('MTProto debug entry is not available in WebUI')
  let events = debug.events
  if (options.since !== undefined) events = events.filter(event => event.timestamp >= parseDuration(options.since))
  if (options.name) events = events.filter(event => String(event.name).toLowerCase().includes(String(options.name).toLowerCase()))
  if (options.direction) events = events.filter(event => event.direction === options.direction)
  if (options.phase) events = events.filter(event => event.phase === options.phase)
  if (options.grep) events = events.filter(event => (event.searchText || JSON.stringify(event)).toLowerCase().includes(String(options.grep).toLowerCase()))
  events = events.slice(-boundedLimit(options.limit, 100))
  return { capturing: debug.capturing, dropped: debug.dropped, maxEvents: debug.maxEvents, events }
}

export async function run(argv, io = {}) {
  const { command, options } = parseArgs(argv)
  const runtime = findRuntime(process.cwd(), options)
  let result
  if (command === 'doctor') {
    result = { ...runtime, dbExists: existsSync(runtime.db), logsDbExists: existsSync(runtime.logsDb), node: process.version }
  } else if (command === 'logs') {
    const db = openReadOnly(runtime.logsDb)
    try { result = queryLogs(db, options) } finally { db.close() }
  } else if (command === 'mtproto') {
    result = await fetchMtprotoSnapshot(runtime.webui, options, io.WebSocket)
  } else if (command === 'tables') {
    const db = openReadOnly(runtime.db)
    try { result = tableNames(db) } finally { db.close() }
  } else if (command === 'table') {
    const db = openReadOnly(runtime.db)
    try { result = queryTable(db, options._[0], options) } finally { db.close() }
  } else if (command === 'sql') {
    const db = openReadOnly(runtime.db)
    try { result = queryReadOnlySql(db, options._.join(' ')) } finally { db.close() }
  } else if (command === 'message') {
    const db = openReadOnly(runtime.db)
    try { result = queryMessage(db, options._[0], options) } finally { db.close() }
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
  const json = JSON.stringify(result, null, options.compact ? 0 : 2) + '\n'
  if (options.output) {
    const filename = isAbsolute(options.output) ? options.output : resolve(process.cwd(), options.output)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, json, 'utf8')
  } else {
    (io.stdout || process.stdout).write(json)
  }
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
