import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateReaderCodeForTlEntries, parseTlToEntries } from '@mtcute/tl-utils'

const root = resolve(import.meta.dirname, '..')
const schemaRoot = resolve(root, 'packages/mtproto/schema/api')
const output = resolve(root, 'packages/mtproto/src/rpc/generated-historical-reader-map.ts')
const manifest = JSON.parse(readFileSync(resolve(schemaRoot, 'manifest.json'), 'utf8'))
const currentSchema = JSON.parse(readFileSync(
  resolve(root, 'node_modules/@mtcute/core/tl/api-schema.json'),
  'utf8',
))
const int53Fields = new Set(currentSchema.e.flatMap((entry) =>
  (entry.arguments ?? [])
    .filter((argument) => argument.type === 'int53')
    .map((argument) => `${entry.name}.${argument.name}`),
))
const records = Object.values(manifest.layers)
  .filter((record) => record.file && record.sha256)
  .sort((a, b) => a.requestedLayer - b.requestedLayer)

const entriesById = new Map()
for (const record of records) {
  const schema = readFileSync(resolve(schemaRoot, record.file), 'utf8')
  const digest = createHash('sha256').update(schema).digest('hex')
  if (digest !== record.sha256) throw new Error(`Telegram schema layer ${record.requestedLayer} failed SHA-256 validation`)
  for (const entry of parseTlToEntries(schema, { panicOnError: true })) {
    for (const argument of entry.arguments) {
      if (argument.type === 'long' && int53Fields.has(`${entry.name}.${argument.name}`)) {
        argument.type = 'int53'
      }
    }
    entriesById.set(entry.id, entry)
  }
}

const code = generateReaderCodeForTlEntries([...entriesById.values()], {
  variableName: 'historicalReaderMap',
  includeMethods: true,
  includeMethodResults: true,
})
writeFileSync(output, `${code.replace(/^var historicalReaderMap=/, 'const historicalReaderMap=')}\nexport default historicalReaderMap\n`)
console.log(`generated ${entriesById.size} constructors from ${records.length} schema layers -> ${output}`)
