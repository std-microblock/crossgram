import { Context } from 'cordis'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as debugScripts from './index.js'
import type { DebugScriptStatus } from './index.js'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true })
})

async function waitFor<T>(
  read: () => T | undefined,
  predicate: (value: T) => boolean,
  timeout = 5000,
): Promise<T> {
  const started = Date.now()
  let last: T | undefined
  while (Date.now() - started < timeout) {
    const value = read()
    last = value
    if (value !== undefined && predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `Timed out waiting for debug script state: ${JSON.stringify(last)}`,
  )
}

function readStatus(
  results: string,
  name = 'probe.ts',
): DebugScriptStatus | undefined {
  const path = join(results, `${name}.json`)
  if (!existsSync(path)) return
  return JSON.parse(readFileSync(path, 'utf8'))
}

function resultVersion(status: DebugScriptStatus): number | undefined {
  return (status.results.at(-1)?.value as { version?: number } | undefined)
    ?.version
}

describe('debug scripts runtime', () => {
  it('loads, hot reloads, rolls back failed code, and unloads a TypeScript plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debug-scripts-e2e-'))
    temporary.push(root)
    const scripts = join(root, 'scripts')
    const results = join(root, 'results')
    const disposed = join(root, 'disposed.txt')
    const ctx = new Context()
    const runner = ctx.plugin(debugScripts, {
      root: scripts,
      results,
      debounce: 25,
      ttl: 10_000,
    })
    await runner

    const probe = join(scripts, 'probe.ts')
    const source = (version: number) => `
      import { appendFileSync } from 'node:fs'
      export async function apply(ctx) {
        await ctx.debugScript.publish({ version: ${version}, generation: ctx.debugScript.generation })
        ctx.effect(() => () => appendFileSync(${JSON.stringify(disposed)}, ${JSON.stringify(String(version))}))
      }
    `
    writeFileSync(probe, source(1))
    let status = await waitFor(
      () => readStatus(results),
      (value) => value.state === 'active' && resultVersion(value) === 1,
    )
    expect(status.activeGeneration).toBe(1)

    writeFileSync(probe, source(2))
    status = await waitFor(
      () => readStatus(results),
      (value) => value.activeGeneration === 2 && resultVersion(value) === 2,
    )
    expect(readFileSync(disposed, 'utf8')).toBe('1')

    writeFileSync(probe, 'export function apply( {')
    status = await waitFor(
      () => readStatus(results),
      (value) => value.generation === 3 && !!value.error,
    )
    expect(status.state).toBe('active')
    expect(status.activeGeneration).toBe(2)
    expect(readFileSync(disposed, 'utf8')).toBe('1')

    rmSync(probe)
    status = await waitFor(
      () => readStatus(results),
      (value) => value.state === 'unloaded',
    )
    expect(status.activeGeneration).toBe(2)
    expect(readFileSync(disposed, 'utf8')).toBe('12')

    await runner.dispose()
  })

  it('expires probes and disposes their Cordis effects at the configured TTL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debug-scripts-ttl-e2e-'))
    temporary.push(root)
    const scripts = join(root, 'scripts')
    const results = join(root, 'results')
    const disposed = join(root, 'expired.txt')
    mkdirSync(scripts, { recursive: true })
    writeFileSync(
      join(scripts, 'ttl.ts'),
      `
      import { writeFileSync } from 'node:fs'
      export function apply(ctx) {
        ctx.debugScript.publish('ready')
        ctx.effect(() => () => writeFileSync(${JSON.stringify(disposed)}, 'disposed'))
      }
    `,
    )
    const ctx = new Context()
    const runner = ctx.plugin(debugScripts, {
      root: scripts,
      results,
      debounce: 20,
      ttl: 80,
    })
    await runner
    const status = await waitFor(
      () => readStatus(results, 'ttl.ts'),
      (value) => value.state === 'expired',
    )
    expect(status.results.at(-1)?.value).toBe('ready')
    expect(readFileSync(disposed, 'utf8')).toBe('disposed')

    await runner.dispose()
  })
})
