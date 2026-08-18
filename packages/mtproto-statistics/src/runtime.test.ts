import { describe, expect, it } from 'vitest'
import { RuntimeMonitor } from './runtime.js'

describe('RuntimeMonitor', () => {
  it('samples finite CrossGram process, event-loop, memory, and GC fields', () => {
    const monitor = new RuntimeMonitor()
    try {
      const snapshot = monitor.sample()
      expect(snapshot.rssBytes).toBeGreaterThan(0)
      expect(snapshot.heapTotalBytes).toBeGreaterThan(0)
      for (const value of Object.values(snapshot)) expect(Number.isFinite(value)).toBe(true)
    } finally {
      monitor.dispose()
    }
  })
})
