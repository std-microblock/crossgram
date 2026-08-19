import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('e2e: historical server reader memory', () => {
  it('does not retain the parsed AST for every mirrored API layer', async () => {
    const script = `
      const before = process.memoryUsage().heapUsed
      const { getServerReaderMap } = await import('./packages/mtproto/src/rpc/server-reader-map.ts')
      getServerReaderMap()
      for (let index = 0; index < 4; index++) globalThis.gc()
      const after = process.memoryUsage().heapUsed
      process.stdout.write(JSON.stringify({ before, after, growth: after - before }))
    `
    const { stdout } = await execFileAsync(process.execPath, [
      '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script,
    ], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    })
    const result = JSON.parse(stdout) as { before: number, after: number, growth: number }

    // The generated historical reader itself is intentionally retained. What
    // must not survive is every intermediate TlEntry[] parsed from the ~150
    // complete snapshots. Before this regression guard the retained growth was
    // about 140 MiB on Node 24; the reader alone stays well below this ceiling.
    expect(result.growth).toBeLessThan(96 * 1024 * 1024)
  }, 30_000)
})
