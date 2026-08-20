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
]

export function migrateRuntimeConfig(source) {
  const missing = requiredPlugins.filter((plugin) => {
    const name = /^\s*name:\s*(.+)$/m.exec(plugin)?.[1]
    return name && !new RegExp(`^\\s*name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(source)
  })
  return missing.length ? `${source}${source.endsWith('\n') ? '' : '\n'}${missing.join('')}` : source
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
