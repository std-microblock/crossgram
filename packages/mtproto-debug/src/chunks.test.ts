import { describe, expect, it } from 'vitest'
import {
  appendChunkedEvents, chunkEvents, chunkKeys, countChunkedEvents,
  flattenChunks, MAX_CHUNK_SIZE, replaceChunks, resolveChunkSize,
} from './chunks.js'
import type { EventChunks } from './chunks.js'
import type { CapturedMtprotoEvent } from './types.js'

function event(id: number): CapturedMtprotoEvent {
  return {
    id,
    timestamp: id,
    direction: 'client->server',
    phase: 'message',
    connectionId: 'conn-1',
    name: `call.${id}`,
    searchText: `call.${id}`,
  }
}

const ids = (chunks: EventChunks) => flattenChunks(chunks).map(item => item.id)

describe('chunked capture buffer', () => {
  it('keeps the chunk size within one chunk of the configured cap', () => {
    expect(resolveChunkSize(2_000)).toBe(125)
    expect(resolveChunkSize(20_000)).toBe(MAX_CHUNK_SIZE)
    expect(resolveChunkSize(2)).toBe(1)
    expect(resolveChunkSize(1)).toBe(1)
  })

  it('appends into the newest chunk and opens a new one when it fills', () => {
    const chunks: EventChunks = {}
    expect(appendChunkedEvents(chunks, [event(1), event(2)], 100, 2)).toBe(0)
    expect(chunkKeys(chunks)).toEqual([0])
    appendChunkedEvents(chunks, [event(3)], 100, 2)
    expect(chunkKeys(chunks)).toEqual([0, 1])
    expect(ids(chunks)).toEqual([1, 2, 3])
  })

  it('splits a batch larger than one chunk across several chunks', () => {
    const chunks: EventChunks = {}
    appendChunkedEvents(chunks, [1, 2, 3, 4, 5].map(event), 100, 2)
    expect(chunkKeys(chunks)).toEqual([0, 1, 2])
    expect(ids(chunks)).toEqual([1, 2, 3, 4, 5])
    expect(countChunkedEvents(chunks)).toBe(5)
  })

  it('evicts whole chunks from the front once the cap is exceeded', () => {
    const chunks: EventChunks = {}
    const dropped = appendChunkedEvents(chunks, [1, 2, 3, 4, 5, 6].map(event), 4, 2)
    expect(dropped).toBe(2)
    expect(ids(chunks)).toEqual([3, 4, 5, 6])
    expect(appendChunkedEvents(chunks, [event(7), event(8)], 4, 2)).toBe(2)
    expect(ids(chunks)).toEqual([5, 6, 7, 8])
  })

  it('never evicts the newest chunk even when a single batch exceeds the cap', () => {
    const chunks: EventChunks = {}
    appendChunkedEvents(chunks, [1, 2, 3].map(event), 2, 10)
    expect(ids(chunks)).toEqual([1, 2, 3])
    expect(chunkKeys(chunks)).toEqual([0])
  })

  it('holds the retained window within one chunk of the cap under a steady stream', () => {
    const chunks: EventChunks = {}
    const maxEvents = 2_000
    const chunkSize = resolveChunkSize(maxEvents)
    let dropped = 0
    let next = 0
    for (let round = 0; round < 200; round++) {
      const batch = Array.from({ length: 50 }, () => event(++next))
      dropped += appendChunkedEvents(chunks, batch, maxEvents, chunkSize)
      expect(countChunkedEvents(chunks)).toBeLessThanOrEqual(maxEvents)
    }
    expect(countChunkedEvents(chunks)).toBeGreaterThan(maxEvents - chunkSize)
    expect(dropped + countChunkedEvents(chunks)).toBe(next)
    // oldest retained event is contiguous with the newest
    const retained = ids(chunks)
    expect(retained[retained.length - 1]).toBe(next)
    expect(retained).toEqual(retained.map((_, index) => retained[0] + index))
  })

  it('round-trips a flat list and resets in place', () => {
    const chunks = chunkEvents([1, 2, 3, 4, 5].map(event), 2)
    expect(ids(chunks)).toEqual([1, 2, 3, 4, 5])
    replaceChunks(chunks, [event(9)])
    expect(ids(chunks)).toEqual([9])
    replaceChunks(chunks, [])
    expect(chunkKeys(chunks)).toEqual([])
    expect(flattenChunks(chunks)).toEqual([])
    expect(countChunkedEvents(chunks)).toBe(0)
  })
})
