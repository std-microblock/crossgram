import type { CapturedMtprotoEvent } from './types.js'

/**
 * Captured events are stored as a map of chunk index to event array rather than
 * a flat array, because the chunk is the unit of eviction.
 *
 * Muon (which encodes the mutations sent to the client) can express appending
 * to an array, truncating it from the end, deleting an object key, or replacing
 * a value wholesale — but not removing from the front. A flat ring buffer
 * trimmed with `events.splice(0, overflow)` therefore degrades to a full
 * `replace` of the entire buffer on every flush once it reaches capacity, which
 * forces the client to rebuild every event object (and its reactive proxy) each
 * time. Appending to the newest chunk and `delete`-ing the oldest key keeps
 * every steady-state delta small.
 */
export type EventChunks = Record<number, CapturedMtprotoEvent[]>

/** Upper bound on a single chunk, so one eviction never discards too much history. */
export const MAX_CHUNK_SIZE = 250

/**
 * Eviction is whole-chunk, so the retained window sits within one chunk of
 * `maxEvents`. Sixteen chunks keeps that slack at ~6% while leaving evictions
 * infrequent.
 */
export function resolveChunkSize(maxEvents: number): number {
  return Math.max(1, Math.min(MAX_CHUNK_SIZE, Math.ceil(maxEvents / 16)))
}

export function chunkKeys(chunks: EventChunks): number[] {
  return Object.keys(chunks).map(Number).sort((left, right) => left - right)
}

export function flattenChunks(chunks: EventChunks): CapturedMtprotoEvent[] {
  const events: CapturedMtprotoEvent[] = []
  for (const key of chunkKeys(chunks)) events.push(...chunks[key])
  return events
}

export function countChunkedEvents(chunks: EventChunks): number {
  let total = 0
  for (const chunk of Object.values(chunks)) total += chunk.length
  return total
}

/**
 * Append `batch` to the newest chunk (opening new chunks as needed) and evict
 * whole chunks from the front until the buffer fits `maxEvents`. Mutates
 * `chunks` in place so the caller's muon proxy observes the change. Returns how
 * many events were dropped.
 */
export function appendChunkedEvents(
  chunks: EventChunks,
  batch: readonly CapturedMtprotoEvent[],
  maxEvents: number,
  chunkSize = resolveChunkSize(maxEvents),
): number {
  if (!batch.length) return 0
  const keys = chunkKeys(chunks)
  let head: number | undefined = keys[keys.length - 1]
  let offset = 0
  while (offset < batch.length) {
    if (head === undefined || chunks[head].length >= chunkSize) {
      head = (head ?? -1) + 1
      chunks[head] = []
    }
    const room = chunkSize - chunks[head].length
    const slice = batch.slice(offset, offset + room)
    chunks[head].push(...slice)
    offset += slice.length
  }
  return evictChunks(chunks, maxEvents)
}

/** Reset `chunks` in place to hold exactly `events`, preserving the object identity. */
export function replaceChunks(
  chunks: EventChunks,
  events: readonly CapturedMtprotoEvent[],
  chunkSize = MAX_CHUNK_SIZE,
): void {
  for (const key of chunkKeys(chunks)) delete chunks[key]
  if (events.length) appendChunkedEvents(chunks, events, Number.MAX_SAFE_INTEGER, chunkSize)
}

/** Build a fresh chunk map from a flat event list. */
export function chunkEvents(
  events: readonly CapturedMtprotoEvent[],
  chunkSize = MAX_CHUNK_SIZE,
): EventChunks {
  const chunks: EventChunks = {}
  replaceChunks(chunks, events, chunkSize)
  return chunks
}

/** Drop whole chunks from the front until the buffer fits. Always keeps the newest chunk. */
function evictChunks(chunks: EventChunks, maxEvents: number): number {
  const keys = chunkKeys(chunks)
  let total = countChunkedEvents(chunks)
  let dropped = 0
  for (let index = 0; index < keys.length - 1 && total > maxEvents; index++) {
    const size = chunks[keys[index]].length
    total -= size
    dropped += size
    delete chunks[keys[index]]
  }
  return dropped
}
