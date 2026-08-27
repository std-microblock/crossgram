import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProbe, serializeProbeResult } from './probe.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MTProto E2E probes', () => {
  it('loads a TypeScript run export without leaving the cache-busting copy behind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-e2e-probe-'))
    directories.push(directory)
    const filename = join(directory, 'probe.ts')
    await writeFile(filename, 'export async function run() { return { ok: true as const } }\n')
    const probe = await loadProbe(filename)
    await expect(probe({} as never)).resolves.toEqual({ ok: true })
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(directory)).toEqual(['probe.ts'])
  })

  it('serializes protocol values and rejects oversized output', () => {
    expect(serializeProbeResult({ id: 42n, bytes: Uint8Array.of(1, 2, 3) })).toEqual({
      id: '42n', bytes: { type: 'bytes', length: 3, base64: 'AQID' },
    })
    expect(() => serializeProbeResult('x'.repeat(100), 10)).toThrow(/exceeds/)
  })
})
