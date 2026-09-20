import { describe, expect, it } from 'vitest'
import { compareMemoryProfiles } from '../scripts/compare-mtproto-memory.mjs'

function run(rss: number, elapsedMs = 100) {
  return { node: '24', platform: 'linux', fullApp: true, devices: 8, rounds: 64, partBytes: 512,
    loaded: { received: 512, bytes: 262144, connections: 8 },
    idle: { connections: 8, memory: { rss } }, peakRss: rss, elapsedMs }
}
const repeat = (value: ReturnType<typeof run>) => Array.from({ length: 3 }, () => structuredClone(value))

describe('whole-process memory comparison gate', () => {
  it('requires thirty percent improvement in both peak and post-workload RSS', () => {
    expect(compareMemoryProfiles(repeat(run(1000)), repeat(run(600))).passed).toBe(true)
    expect(compareMemoryProfiles(repeat(run(1000)), repeat(run(800))).passed).toBe(false)
    const after = repeat(run(600)); after.forEach(value => { value.peakRss = 800 })
    expect(compareMemoryProfiles(repeat(run(1000)), after).passed).toBe(false)
  })
  it('uses medians rather than selecting the best run and rejects excessive slowdown', () => {
    const comparison = compareMemoryProfiles([run(1000), run(1100), run(900)], [run(600), run(620), run(800)])
    expect(comparison.optimized.medianIdleRss).toBe(620)
    expect(compareMemoryProfiles(repeat(run(1000)), repeat(run(600, 200))).passed).toBe(false)
  })
  it('rejects incomparable or incomplete runs', () => {
    expect(() => compareMemoryProfiles([run(1000)], repeat(run(600)))).toThrow('three runs')
    const missing = repeat(run(600)); missing[0].idle.connections = 7
    expect(() => compareMemoryProfiles(repeat(run(1000)), missing)).toThrow('lost devices')
    const changed = repeat(run(600)); changed[0].rounds = 32
    expect(() => compareMemoryProfiles(repeat(run(1000)), changed)).toThrow('Workloads differ')
    const invalid = repeat(run(600)); invalid[0].peakRss = NaN
    expect(() => compareMemoryProfiles(repeat(run(1000)), invalid)).toThrow('Invalid measurement')
  })
})
