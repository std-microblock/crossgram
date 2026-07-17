#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TELEGRAM_SCHEMA_URL = 'https://core.telegram.org/schema'
const DEFAULT_OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/mtproto/schema/api')

export function decodeHtml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, body) => {
    const lower = body.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    if (lower === 'nbsp') return ' '
    const radix = lower.startsWith('#x') ? 16 : 10
    const digits = lower.slice(radix === 16 ? 2 : 1)
    return String.fromCodePoint(Number.parseInt(digits, radix))
  })
}

export function parseSchemaPage(html) {
  const selected = html.match(/dropdown-toggle[^>]*>[\s\S]*?Layer\s+(\d+)/i)
    ?? html.match(/<title>\s*Schema(?:\s*Layer)?\s*(\d+)?\s*<\/title>/i)
  const reportedLayer = selected?.[1] ? Number.parseInt(selected[1], 10) : null

  const block = html.match(/<pre\b[^>]*class=(?:"[^"]*\bpage_scheme\b[^"]*"|'[^']*\bpage_scheme\b[^']*')[^>]*>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/i)
  if (!block) throw new Error('page does not contain pre.page_scheme > code')

  const schema = decodeHtml(block[1].replace(/<[^>]+>/g, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .concat('\n')
  if (!schema.includes('---functions---')) throw new Error('schema is missing ---functions--- marker')
  if (!/^[a-zA-Z][\w.]*#[0-9a-f]{1,8}\b/m.test(schema)) throw new Error('schema has no TL constructors')

  const advertisedLayers = [...new Set(
    [...html.matchAll(/[?&]layer=(\d+)/g)].map(match => Number.parseInt(match[1], 10)),
  )].sort((a, b) => a - b)
  return { reportedLayer, advertisedLayers, schema }
}

export function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUTPUT,
    from: 1,
    to: null,
    concurrency: 4,
    retries: 3,
    advertisedOnly: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    else if (arg === '--advertised-only') options.advertisedOnly = true
    else if (arg === '--dense') options.advertisedOnly = false
    else if (arg === '--out') options.out = resolve(argv[++i])
    else if (arg === '--from') options.from = positiveInt(argv[++i], '--from')
    else if (arg === '--to') options.to = positiveInt(argv[++i], '--to')
    else if (arg === '--concurrency') options.concurrency = positiveInt(argv[++i], '--concurrency')
    else if (arg === '--retries') options.retries = positiveInt(argv[++i], '--retries')
    else if (arg === '--help') return { ...options, help: true }
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function positiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

async function fetchText(url, retries, init = {}) {
  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        ...init,
        headers: {
          'user-agent': 'mtproto-relay-cordis schema sync/1.0',
          ...init.headers,
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 500 * attempt))
    }
  }
  throw lastError
}

export function cookieFromSetCookie(value) {
  if (!value) return null
  return value.split(';', 1)[0] || null
}

async function fetchLayerText(layer, retries) {
  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${TELEGRAM_SCHEMA_URL}?layer=${layer}`, {
        headers: { 'user-agent': 'mtproto-relay-cordis schema sync/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status < 300 || response.status >= 400) {
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        return await response.text()
      }
      const location = response.headers.get('location')
      const cookie = cookieFromSetCookie(response.headers.get('set-cookie'))
      if (!location || !cookie) throw new Error('layer redirect did not provide location and stel_dev_layer cookie')
      return await fetchText(new URL(location, TELEGRAM_SCHEMA_URL), retries, { headers: { cookie } })
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 500 * attempt))
    }
  }
  throw lastError
}

async function atomicWrite(path, data) {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }))
  return results
}

export async function syncSchemas(options) {
  await mkdir(options.out, { recursive: true })
  const landingHtml = await fetchText(TELEGRAM_SCHEMA_URL, options.retries)
  const landing = parseSchemaPage(landingHtml)
  if (landing.reportedLayer === null) throw new Error('could not determine current Telegram API layer')

  const upper = options.to ?? landing.reportedLayer
  const layers = options.advertisedOnly
    ? landing.advertisedLayers.filter(layer => layer >= options.from && layer <= upper)
    : Array.from({ length: upper - options.from + 1 }, (_, index) => options.from + index)
  if (!layers.includes(landing.reportedLayer) && landing.reportedLayer >= options.from && landing.reportedLayer <= upper) {
    layers.push(landing.reportedLayer)
    layers.sort((a, b) => a - b)
  }

  const records = await mapConcurrent(layers, options.concurrency, async (requestedLayer, index) => {
    try {
      const page = parseSchemaPage(await fetchLayerText(requestedLayer, options.retries))
      if (page.reportedLayer !== requestedLayer) {
        const reason = `Telegram returned layer ${page.reportedLayer ?? '?'} for requested layer ${requestedLayer}`
        process.stderr.write(`[${index + 1}/${layers.length}] layer ${requestedLayer} unavailable: ${reason}\n`)
        return { requestedLayer, reportedLayer: page.reportedLayer, unavailable: reason }
      }
      const sha256 = createHash('sha256').update(page.schema).digest('hex')
      const file = `layer-${requestedLayer}.tl.gz`
      await atomicWrite(resolve(options.out, file), gzipSync(page.schema, { level: 9 }))
      process.stdout.write(`[${index + 1}/${layers.length}] layer ${requestedLayer} -> ${page.reportedLayer ?? '?'} (${page.schema.length} bytes)\n`)
      return {
        requestedLayer,
        reportedLayer: page.reportedLayer,
        file,
        sha256,
        bytes: Buffer.byteLength(page.schema),
      }
    } catch (error) {
      process.stderr.write(`[${index + 1}/${layers.length}] layer ${requestedLayer} failed: ${error instanceof Error ? error.message : error}\n`)
      return { requestedLayer, error: error instanceof Error ? error.message : String(error) }
    }
  })

  const manifest = {
    source: TELEGRAM_SCHEMA_URL,
    syncedAt: new Date().toISOString(),
    latestLayer: landing.reportedLayer,
    dense: !options.advertisedOnly,
    layers: Object.fromEntries(records.map(record => [record.requestedLayer, record])),
  }
  await atomicWrite(resolve(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const failures = records.filter(record => 'error' in record)
  if (failures.length) throw new Error(`${failures.length} schema layer(s) failed; see manifest.json`)

  const expectedFiles = new Set(records.flatMap(record => record.file ? [record.file] : []))
  for (const file of await readdir(options.out)) {
    if (/^layer-\d+\.tl\.gz$/.test(file) && !expectedFiles.has(file)) await unlink(resolve(options.out, file))
  }
  return manifest
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/sync-telegram-schemas.mjs [options]\n\n`)
  process.stdout.write(`  --from N            first requested layer (default: 1)\n`)
  process.stdout.write(`  --to N              last requested layer (default: current layer)\n`)
  process.stdout.write(`  --advertised-only   fetch layers listed by Telegram's selector (default)\n`)
  process.stdout.write(`  --dense             request every integer layer; fails on unavailable snapshots\n`)
  process.stdout.write(`  --concurrency N     parallel requests (default: 4)\n`)
  process.stdout.write(`  --retries N         attempts per request (default: 3)\n`)
  process.stdout.write(`  --out PATH          output directory\n`)
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
