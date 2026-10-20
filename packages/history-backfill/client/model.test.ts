import { describe, expect, it } from 'vitest'
import { conversationProgress, formatAge, sessionStatusLabel } from './model.js'
import type { BackfillConversationSnapshot } from '../src/types.js'

const base: BackfillConversationSnapshot = {
  conversationId: 'c', title: 'C', kind: 'group', mode: 'sequence', bootstrapped: true, spans: 1, covered: 10,
  gapCount: 0, missing: 0, floorReached: false, requests: 0, fetched: 0, inserted: 0, failures: 0,
}

describe('history backfill page model', () => {
  it('describes sequence and anchor progress', () => {
    expect(conversationProgress({ ...base, bootstrapped: false })).toBe('not scanned yet')
    expect(conversationProgress(base)).toBe('no stored sequence')
    expect(conversationProgress({ ...base, minSequence: 3, maxSequence: 12, upperSequence: 20 }))
      .toBe('seq 3–20 · 10 covered')
    expect(conversationProgress({ ...base, mode: 'anchor' })).toBe('walking back')
    expect(conversationProgress({ ...base, mode: 'anchor', floorReached: true })).toBe('complete')
  })

  it('formats relative times in both directions', () => {
    expect(formatAge(undefined)).toBe('never')
    expect(formatAge(10_000, 40_000)).toBe('30s ago')
    expect(formatAge(0, 7_200_000)).toBe('2h ago')
    expect(formatAge(400_000, 100_000)).toBe('in 5m')
    expect(sessionStatusLabel('capped')).toBe('Daily request limit reached')
  })
})
