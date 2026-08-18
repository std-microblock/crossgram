import { describe, expect, it } from 'vitest'
import { LatencyHistogram } from './histogram.js'

describe('LatencyHistogram', () => {
  it('keeps constant-memory latency distributions and useful tail quantiles', () => {
    const histogram = new LatencyHistogram()
    for (let value = 1; value <= 100; value++) histogram.record(value)

    expect(histogram.snapshot()).toMatchObject({
      count: 100,
      averageMs: 50.5,
      minMs: 1,
      maxMs: 100,
      p50Ms: 64,
      p90Ms: 100,
      p95Ms: 100,
      p99Ms: 100,
    })
  })

  it('resets all accumulated state', () => {
    const histogram = new LatencyHistogram()
    histogram.record(42)
    histogram.reset()
    expect(histogram.snapshot()).toEqual({
      count: 0, averageMs: 0, minMs: 0, maxMs: 0,
      p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0,
    })
  })
})
