import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MAX_RETAINED_RECEIVE_BYTES } from './receive-buffer.js'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '../../../..')

describe('real encrypted multi-device receive memory', () => {
  it('keeps every device connected and retains only bounded buffers after uploads', async () => {
    const { stdout } = await run(process.execPath, [
      '--import', 'tsx', '--import', '@cordisjs/unyaml', 'scripts/profile-mtproto-memory.mts',
    ], {
      cwd: root,
      env: { ...process.env, PROFILE_FULL_APP: '0', PROFILE_DEVICES: '4', PROFILE_ROUNDS: '12', PROFILE_PART_BYTES: '262144' },
      timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    })
    const report = JSON.parse(stdout)
    expect(report.loaded.received).toBe(48)
    expect(report.loaded.bytes).toBe(48 * 262144)
    expect(report.loaded.connections).toBe(4)
    expect(report.idle.connections).toBe(4)
    expect(report.idle.obfuscationBuffers).toHaveLength(4)
    for (const buffer of report.idle.obfuscationBuffers) {
      expect(buffer.available).toBe(0)
      expect(buffer.written).toBe(0)
      expect(buffer.capacity).toBeLessThanOrEqual(MAX_RETAINED_RECEIVE_BYTES)
    }
    // RSS is measured by the harness, but deterministic CI gates the retained
    // allocations, not OS-specific residency/GC timing or the load generator's heap.
    expect(report.peakRss).toBeGreaterThan(0)
  })
})
