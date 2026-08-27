import { chmodSync, chownSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const requiredPlugins = [
  `- id: merged-forward
  name: '@mtproto-relay/merged-forward'
`,
  `- id: platform-admin-bot
  name: '@mtproto-relay/platform-admin-bot'
  config:
    allowedPlatformSessionIds: []
    crossAccountAccess: false
    showLoginCodes: true
    webuiUrl: ''
`,
  `- id: telegram-bot-api
  name: '@mtproto-relay/telegram-bot-api'
  config:
    verifierSecret: \${TELEGRAM_BOT_TOKEN_VERIFIER_SECRET}
`,
  `- id: qq-flash-transfer-bot
  name: '@mtproto-relay/qq-flash-transfer-bot'
`,
  `- id: debug-scripts
  name: '@mtproto-relay/debug-scripts'
  config:
    root: /var/lib/crossgram/debug-scripts
    results: /var/lib/crossgram/debug-results
    ttl: 1800000
`,
]

export function migrateRuntimeConfig(source) {
  source = migrateDatabaseDriver(source)
  const missing = requiredPlugins.filter((plugin) => {
    const name = /^\s*name:\s*(.+)$/m.exec(plugin)?.[1]
    return name && !new RegExp(`^\\s*name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(source)
  })
  return missing.length ? `${source}${source.endsWith('\n') ? '' : '\n'}${missing.join('')}` : source
}

const postgresPlugin = `- id: database-postgres
  name: '@cordisjs/plugin-database-postgres'
  config:
    host: 127.0.0.1
    port: 5432
    user: crossgram
    password:
      __jsExpr: process.env.CROSSGRAM_POSTGRES_PASSWORD
    database: crossgram
    max: 10
`

/** Replace an active SQLite driver item without rewriting the surrounding runtime config. */
export function migrateDatabaseDriver(source) {
  const lines = source.split('\n')
  const sqliteName = "name: '@cordisjs/plugin-database-sqlite'"
  const postgresName = "name: '@cordisjs/plugin-database-postgres'"
  const sqliteNameIndex = lines.findIndex((line) => line.trim() === sqliteName)
  if (sqliteNameIndex < 0) return source

  const itemStart = findPluginItemStart(lines, sqliteNameIndex)
  if (itemStart < 0) return source
  const indent = /^\s*/.exec(lines[itemStart])?.[0] ?? ''
  const itemEnd = findPluginItemEnd(lines, itemStart, indent)
  const replacement = postgresPlugin.trimEnd().split('\n').map((line) => `${indent}${line}`)

  const postgresNameIndex = lines.findIndex((line) => line.trim() === postgresName)
  if (postgresNameIndex >= 0) {
    const postgresStart = findPluginItemStart(lines, postgresNameIndex)
    const postgresIndent = postgresStart >= 0 ? /^\s*/.exec(lines[postgresStart])?.[0] ?? '' : ''
    if (postgresStart >= 0 && postgresIndent === indent) {
      const postgresEnd = findPluginItemEnd(lines, postgresStart, postgresIndent)
      const firstStart = Math.min(itemStart, postgresStart)
      const firstEnd = firstStart === itemStart ? itemEnd : postgresEnd
      const secondStart = Math.max(itemStart, postgresStart)
      const secondEnd = secondStart === itemStart ? itemEnd : postgresEnd
      lines.splice(secondStart, secondEnd - secondStart)
      lines.splice(firstStart, firstEnd - firstStart, ...replacement)
      return lines.join('\n')
    }
  }

  lines.splice(itemStart, itemEnd - itemStart, ...replacement)
  return lines.join('\n')
}

function findPluginItemStart(lines, nameIndex) {
  const nameIndent = /^\s*/.exec(lines[nameIndex])?.[0].length ?? 0
  for (let index = nameIndex - 1; index >= 0; index--) {
    const indent = /^\s*/.exec(lines[index])?.[0].length ?? 0
    if (indent === nameIndent - 2 && lines[index].trimStart().startsWith('- id:')) return index
    if (lines[index].trim() && indent < nameIndent - 2) return -1
  }
  return -1
}

function findPluginItemEnd(lines, start, indent) {
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    const currentIndent = /^\s*/.exec(line)?.[0] ?? ''
    if (currentIndent.length < indent.length) return index
    if (currentIndent === indent && line.trimStart().startsWith('- id:')) return index
  }
  return lines.length
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function migrateRuntimeConfigFile(path) {
  const previous = statSync(path)
  const source = readFileSync(path, 'utf8')
  const migrated = migrateRuntimeConfig(source)
  if (migrated === source) return false

  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, migrated, { encoding: 'utf8', mode: 0o600 })
    // Updates run as root, but the Cordis process runs as `crossgram` and must
    // retain read access to its root-managed runtime config after an atomic rename.
    chownSync(temporary, previous.uid, previous.gid)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: node migrate-runtime-config.mjs <app.yml>')
    process.exitCode = 2
  } else if (migrateRuntimeConfigFile(path)) {
    console.log(`Added required Crossgram bot plugins to ${path}`)
  }
}
