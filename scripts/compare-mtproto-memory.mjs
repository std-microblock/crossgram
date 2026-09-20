import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function compareMemoryProfiles(before, after, threshold = 0.3) {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error('Invalid reduction threshold')
  if (before.length < 3 || after.length < 3) throw new Error('At least three runs per variant are required')
  const reference = before[0]
  for (const run of [...before, ...after]) {
    for (const field of ['node', 'platform', 'fullApp', 'devices', 'rounds', 'partBytes']) {
      if (run[field] !== reference[field]) throw new Error('Workloads differ: ' + field)
    }
    if (run.fullApp !== true) throw new Error('Whole-application mode is required')
    if (run.loaded.received !== run.devices * run.rounds
      || run.loaded.bytes !== run.devices * run.rounds * run.partBytes
      || run.loaded.connections !== run.devices || run.idle.connections !== run.devices) {
      throw new Error('Incomplete workload or lost devices')
    }
    for (const value of [run.peakRss, run.idle.memory.rss, run.elapsedMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid measurement')
    }
  }
  const summarize = runs => ({
    runs: runs.length,
    medianIdleRss: median(runs.map(run => run.idle.memory.rss)),
    medianPeakRss: median(runs.map(run => run.peakRss)),
    medianElapsedMs: median(runs.map(run => run.elapsedMs)),
  })
  const baseline = summarize(before), optimized = summarize(after)
  const idleReduction = 1 - optimized.medianIdleRss / baseline.medianIdleRss
  const peakReduction = 1 - optimized.medianPeakRss / baseline.medianPeakRss
  const elapsedRatio = optimized.medianElapsedMs / baseline.medianElapsedMs
  return {
    workload: Object.fromEntries(['node', 'platform', 'fullApp', 'devices', 'rounds', 'partBytes'].map(k => [k, reference[k]])),
    baseline, optimized, idleReduction, peakReduction, elapsedRatio, threshold,
    passed: idleReduction >= threshold && peakReduction >= threshold && elapsedRatio <= 1.25,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? 'work/memory-profile')
  const load = prefix => readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .sort().map(name => JSON.parse(readFileSync(resolve(directory, name), 'utf8')))
  const result = compareMemoryProfiles(load('baseline-'), load('optimized-'))
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
}
