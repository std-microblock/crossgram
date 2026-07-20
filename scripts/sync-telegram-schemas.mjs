#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const DEFAULT_TD_REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../td')
const DEFAULT_OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/mtproto/schema/api')
const DEFAULT_SCHEMA_PATH = 'td/generate/scheme/telegram_api.tl'
const DEFAULT_VERSION_PATH = 'td/telegram/Version.h'

export function parseLayerFromVersion(value) {
  const match = value.match(/\bMTPROTO_LAYER\s*=\s*(\d+)\s*;/)
  return match ? Number.parseInt(match[1], 10) : null
}

export function normalizeSchema(value) {
  const schema = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .concat('\n')
  if (!schema.includes('---functions---')) throw new Error('schema is missing ---functions--- marker')
  if (!/^[a-zA-Z][\w.]*#[0-9a-f]{1,8}\b/m.test(schema)) throw new Error('schema has no TL constructors')
  return schema
}

export function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUTPUT,
    tdRepo: DEFAULT_TD_REPOSITORY,
    ref: 'HEAD',
    from: 1,
    to: null,
    schemaPath: DEFAULT_SCHEMA_PATH,
    versionPath: DEFAULT_VERSION_PATH,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    else if (arg === '--out') options.out = resolve(argv[++i])
    else if (arg === '--td-repo') options.tdRepo = resolve(argv[++i])
    else if (arg === '--ref') options.ref = argv[++i]
    else if (arg === '--from') options.from = positiveInt(argv[++i], '--from')
    else if (arg === '--to') options.to = positiveInt(argv[++i], '--to')
    else if (arg === '--schema-path') options.schemaPath = argv[++i]
    else if (arg === '--version-path') options.versionPath = argv[++i]
    else if (arg === '--help') return { ...options, help: true }
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.to !== null && options.to < options.from) throw new Error('--to must not be lower than --from')
  return options
}

function positiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
  return stdout
}

async function show(repo, commit, path) {
  try {
    return await git(repo, ['show', `${commit}:${path}`])
  } catch {
    return null
  }
}

export async function extractSnapshots(options) {
  await git(options.tdRepo, ['rev-parse', '--is-inside-work-tree'])
  const commits = (await git(options.tdRepo, [
    'log', '--format=%H', options.ref, '--', options.schemaPath,
  ])).trim().split('\n').filter(Boolean)
  const snapshots = new Map()
  for (const commit of commits) {
    const version = await show(options.tdRepo, commit, options.versionPath)
    const layer = version === null ? null : parseLayerFromVersion(version)
    if (layer === null || layer < options.from || (options.to !== null && layer > options.to) || snapshots.has(layer)) continue
    const schemaValue = await show(options.tdRepo, commit, options.schemaPath)
    if (schemaValue === null) continue
    snapshots.set(layer, { layer, commit, schema: normalizeSchema(schemaValue) })
  }
  return [...snapshots.values()].sort((a, b) => a.layer - b.layer)
}

async function atomicWrite(path, data) {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

export async function syncSchemas(options) {
  await mkdir(options.out, { recursive: true })
  const snapshots = await extractSnapshots(options)
  if (!snapshots.length) throw new Error('TDLib history contains no versioned API schema snapshots in the requested range')

  const records = []
  for (const snapshot of snapshots) {
    const file = `layer-${snapshot.layer}.tl`
    const sha256 = createHash('sha256').update(snapshot.schema).digest('hex')
    await atomicWrite(resolve(options.out, file), snapshot.schema)
    records.push({
      requestedLayer: snapshot.layer,
      reportedLayer: snapshot.layer,
      sourceCommit: snapshot.commit,
      file,
      sha256,
      bytes: Buffer.byteLength(snapshot.schema),
    })
    process.stdout.write(`layer ${snapshot.layer} <- ${snapshot.commit.slice(0, 12)} (${snapshot.schema.length} bytes)\n`)
  }

  const sourceRevision = (await git(options.tdRepo, ['rev-parse', options.ref])).trim()
  const sourceDate = (await git(options.tdRepo, ['show', '-s', '--format=%cI', sourceRevision])).trim()
  const latestLayer = Math.max(...records.map(record => record.requestedLayer))
  const manifest = {
    source: 'https://github.com/tdlib/td',
    sourceRevision,
    sourceDate,
    schemaPath: options.schemaPath,
    versionPath: options.versionPath,
    latestLayer,
    layers: Object.fromEntries(records.map(record => [record.requestedLayer, record])),
  }
  await atomicWrite(resolve(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const expectedFiles = new Set(records.map(record => record.file))
  for (const file of await readdir(options.out)) {
    if (/^layer-\d+\.tl(?:\.gz)?$/.test(file) && !expectedFiles.has(file)) await unlink(resolve(options.out, file))
  }
  return manifest
}

function printHelp() {
  process.stdout.write('Usage: node scripts/sync-telegram-schemas.mjs [options]\n\n')
  process.stdout.write('  --td-repo PATH       local full-history TDLib checkout (default: ../td)\n')
  process.stdout.write('  --ref REF            history ref (default: HEAD)\n')
  process.stdout.write('  --schema-path PATH   telegram_api.tl path inside TDLib\n')
  process.stdout.write('  --version-path PATH  Version.h path containing MTPROTO_LAYER\n')
  process.stdout.write('  --from N             first layer to retain (default: 1)\n')
  process.stdout.write('  --to N               last layer to retain (default: latest)\n')
  process.stdout.write('  --out PATH           schema output directory\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) printHelp()
    else await syncSchemas(options)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
    process.exitCode = 1
  }
}
