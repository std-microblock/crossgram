import { describe, expect, it } from 'vitest'
import { SequenceCoverage } from './coverage.js'

describe('SequenceCoverage', () => {
  it('builds contiguous spans from stored sequences in any order', () => {
    const coverage = SequenceCoverage.fromSequences([10, 3, 4, 5, 9, 9, 1, 0, -2, 20])
    expect(coverage.spans).toEqual([
      { start: 1, end: 1 }, { start: 3, end: 5 }, { start: 9, end: 10 }, { start: 20, end: 20 },
    ])
    expect(coverage.min).toBe(1)
    expect(coverage.max).toBe(20)
    expect(coverage.covered).toBe(7)
  })

  it('merges overlapping and adjacent ranges and ignores invalid input', () => {
    const coverage = new SequenceCoverage()
    coverage.add(10, 12)
    coverage.add(20)
    coverage.add(13, 14)
    expect(coverage.spans).toEqual([{ start: 10, end: 14 }, { start: 20, end: 20 }])
    coverage.add(19, 15)
    expect(coverage.spans).toEqual([{ start: 10, end: 20 }])
    coverage.add(1, 3)
    coverage.add(5, 30)
    expect(coverage.spans).toEqual([{ start: 1, end: 3 }, { start: 5, end: 30 }])
    coverage.add(-5, 0)
    coverage.add(Number.NaN, 4)
    coverage.add(-4, 4)
    expect(coverage.spans).toEqual([{ start: 1, end: 30 }])
    expect(coverage.has(17)).toBe(true)
    expect(coverage.has(31)).toBe(false)
  })

  it('finds the top gap first, then the highest gap between spans', () => {
    const coverage = SequenceCoverage.fromSequences([1, 2, 3, 7, 8, 12])
    expect(coverage.highestGap(20)).toEqual({ low: 13, high: 20 })
    expect(coverage.highestGap(12)).toEqual({ low: 9, high: 11 })
    expect(coverage.highestGap()).toEqual({ low: 9, high: 11 })
    coverage.add(9, 11)
    expect(coverage.highestGap()).toEqual({ low: 4, high: 6 })
    coverage.add(4, 6)
    expect(coverage.highestGap()).toBeUndefined()
    expect(coverage.gapStats(15)).toEqual({ count: 1, missing: 3 })
  })

  it('treats an empty coverage with a known upper bound as one gap from the start', () => {
    expect(new SequenceCoverage().highestGap(42)).toEqual({ low: 1, high: 42 })
    expect(new SequenceCoverage().highestGap()).toBeUndefined()
    expect(SequenceCoverage.fromSequences([5, 6]).gapStats()).toEqual({ count: 0, missing: 0 })
    expect(SequenceCoverage.fromSequences([1, 5, 9]).gapStats()).toEqual({ count: 2, missing: 6 })
  })
})
