import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const mergedForwardPlugin = `- id: merged-forward
  name: '@mtproto-relay/merged-forward'
`

export function migrateRuntimeConfig(source) {
  if (/^\s*name:\s*['"]?@mtproto-relay\/merged-forward['"]?\s*$/m.test(source)) return source
  return `${source}${source.endsWith('\n') ? '' : '\n'}${mergedForwardPlugin}`
}

export function migrateRuntimeConfigFile(path) {
  const source = readFileSync(path, 'utf8')
  const migrated = migrateRuntimeConfig(source)
  if (migrated === source) return false

  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, migrated, { encoding: 'utf8', mode: 0o600 })
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
    console.log(`Added required merged-forward plugin to ${path}`)
  }
}
