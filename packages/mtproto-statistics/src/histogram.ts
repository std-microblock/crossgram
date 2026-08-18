import type { DistributionSnapshot } from './types.js'

const BOUNDS = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 125, 250, 500,
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000, Number.POSITIVE_INFINITY,
] as const

export class LatencyHistogram {
  private readonly buckets = new Uint32Array(BOUNDS.length)
  count = 0
  sumMs = 0
  minMs = Number.POSITIVE_INFINITY
  maxMs = 0

  record(durationMs: number): void {
    const value = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    let low = 0
    let high = BOUNDS.length - 1
    while (low < high) {
      const middle = (low + high) >>> 1
      if (value <= BOUNDS[middle]!) high = middle
      else low = middle + 1
    }
    this.buckets[low]++
    this.count++
    this.sumMs += value
    this.minMs = Math.min(this.minMs, value)
    this.maxMs = Math.max(this.maxMs, value)
  }

  reset(): void {
    this.buckets.fill(0)
    this.count = 0
    this.sumMs = 0
    this.minMs = Number.POSITIVE_INFINITY
    this.maxMs = 0
  }

  snapshot(): DistributionSnapshot {
    return {
      count: this.count,
      averageMs: round(this.count ? this.sumMs / this.count : 0),
      minMs: round(this.count ? this.minMs : 0),
      maxMs: round(this.maxMs),
      p50Ms: this.quantile(0.5),
      p90Ms: this.quantile(0.9),
      p95Ms: this.quantile(0.95),
      p99Ms: this.quantile(0.99),
    }
  }

  quantile(ratio: number): number {
    if (!this.count) return 0
    const target = Math.max(1, Math.ceil(this.count * ratio))
    let seen = 0
    for (let index = 0; index < this.buckets.length; index++) {
      seen += this.buckets[index]!
      if (seen < target) continue
      const bound = BOUNDS[index]!
      return round(Number.isFinite(bound) ? Math.min(bound, this.maxMs) : this.maxMs)
    }
    return round(this.maxMs)
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
