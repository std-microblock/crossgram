import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { openE2eClient } from './client.js'
import type {
  MtprotoE2eProbe,
  MtprotoE2eProbeContext,
  RunE2eProbeOptions,
} from './types.js'

export async function runE2eProbe(filename: string, options: RunE2eProbeOptions = {}): Promise<unknown> {
  const probe = await loadProbe(filename)
  const opened = await openE2eClient(options)
  const controller = new AbortController()
  const timeoutMs = options.probeTimeoutMs ?? 60_000
  const timer = setTimeout(() => controller.abort(new Error(`MTProto E2E probe timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref()
  try {
    const context: MtprotoE2eProbeContext = {
      client: opened.client,
      profile: opened.profile,
      user: opened.user,
      signal: controller.signal,
      call: (request, callTimeoutMs = options.callTimeoutMs ?? 30_000) => opened.client.call(request, {
        abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(callTimeoutMs)]),
      }),
      publish: (value) => options.onResult?.(serializeProbeResult(value, options.maxResultBytes)),
    }
    const result = await probe(context)
    if (result !== undefined) options.onResult?.(serializeProbeResult(result, options.maxResultBytes))
    return result
  } finally {
    clearTimeout(timer)
    await opened.close()
  }
}

export async function loadProbe(filename: string): Promise<MtprotoE2eProbe> {
  const source = resolve(filename)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Probe is not a regular file: ${source}`)
  if (info.size > 256 * 1024) throw new Error('MTProto E2E probes must not exceed 256 KiB')
  const temporary = resolve(dirname(source), `.${basename(source)}.${process.pid}.${Math.random().toString(16).slice(2)}.mts`)
  try {
    await writeFile(temporary, await readFile(source), { mode: 0o600 })
    const exports = await tsImport(pathToFileURL(temporary).href, import.meta.url) as Record<string, unknown>
    const probe = typeof exports.run === 'function'
      ? exports.run
      : typeof exports.default === 'function'
        ? exports.default
        : undefined
    if (!probe) throw new Error(`${source} must export function run(context) or a default function`)
    return probe as MtprotoE2eProbe
  } finally {
    await rm(temporary, { force: true })
  }
}

export function serializeProbeResult(value: unknown, maxBytes = 1024 * 1024): unknown {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return `${current}n`
    if (current instanceof Error) return { name: current.name, message: current.message, stack: current.stack }
    if (current instanceof Uint8Array) {
      return { type: 'bytes', length: current.length, base64: Buffer.from(current).toString('base64') }
    }
    if (current && typeof current === 'object') {
      if (seen.has(current)) return '[Circular]'
      seen.add(current)
    }
    return current
  })
  if (json === undefined) return null
  if (Buffer.byteLength(json) > maxBytes) throw new Error(`Probe result exceeds ${maxBytes} bytes`)
  return JSON.parse(json)
}
