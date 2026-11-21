import type { CapturedMtprotoEvent } from './types.js'

/**
 * 按分块索引存放捕获的事件。
 * Muon 增量同步不支持数组头部移除，扁平数组的 `splice(0, overflow)` 会退化为全量替换；
 * 向最新分块追加并 `delete` 最旧分块键可保持每次增量最小。
 */
export type EventChunks = Record<number, CapturedMtprotoEvent[]>

export const MAX_CHUNK_SIZE = 250

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

/** 原地向最新分块追加 `batch`，并从头部整块淘汰直到总数不超过 `maxEvents`，返回淘汰条数。 */
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
  return trimChunkedEvents(chunks, maxEvents)
}

export function replaceChunks(
  chunks: EventChunks,
  events: readonly CapturedMtprotoEvent[],
  chunkSize = MAX_CHUNK_SIZE,
): void {
  for (const key of chunkKeys(chunks)) delete chunks[key]
  if (events.length) appendChunkedEvents(chunks, events, Number.MAX_SAFE_INTEGER, chunkSize)
}

export function chunkEvents(
  events: readonly CapturedMtprotoEvent[],
  chunkSize = MAX_CHUNK_SIZE,
): EventChunks {
  const chunks: EventChunks = {}
  replaceChunks(chunks, events, chunkSize)
  return chunks
}

/** Drop whole chunks from the front until the buffer fits `maxEvents`. Always keeps the newest chunk. */
export function trimChunkedEvents(chunks: EventChunks, maxEvents: number): number {
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
