import { describe, expect, it } from 'vitest'
import { RuntimeMonitor } from './runtime.js'

describe('RuntimeMonitor', () => {
  it('samples finite CrossGram process, event-loop, memory, and GC fields', () => {
    const monitor = new RuntimeMonitor()
    try {
      const snapshot = monitor.sample()
      expect(snapshot.rssBytes).toBeGreaterThan(0)
      expect(snapshot.heapTotalBytes).toBeGreaterThan(0)
      expect(snapshot.heapLimitBytes).toBeGreaterThan(snapshot.heapTotalBytes)
      expect(snapshot.heapAvailableBytes).toBeGreaterThan(0)
      expect(snapshot.nativeContexts).toBeGreaterThan(0)
      expect(snapshot.peakMallocedBytes).toBeGreaterThanOrEqual(snapshot.mallocedBytes)
      for (const value of Object.values(snapshot)) expect(Number.isFinite(value)).toBe(true)
    } finally {
      monitor.dispose()
    }
  })
})
