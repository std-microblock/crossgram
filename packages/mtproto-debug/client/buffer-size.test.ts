import { describe, expect, it } from 'vitest'
import {
  BUFFER_SIZE_STORAGE_KEY,
  MAX_BUFFER_SIZE,
  MIN_BUFFER_SIZE,
  parseBufferSize,
  readStoredBufferSize,
  storeBufferSize,
  type BufferSizeStorage,
} from './buffer-size.js'

function memoryStorage(initial: Record<string, string> = {}): BufferSizeStorage & {
  values: Record<string, string>
} {
  const values = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
  }
}

describe('capture buffer size setting', () => {
  it('accepts whole numbers inside the configured bounds', () => {
    expect(parseBufferSize('2000')).toBe(2_000)
    expect(parseBufferSize(' 200 ')).toBe(200)
    expect(parseBufferSize(20_000)).toBe(MAX_BUFFER_SIZE)
    expect(parseBufferSize(MIN_BUFFER_SIZE)).toBe(MIN_BUFFER_SIZE)
  })

  it('rejects fractions, junk and out-of-range values', () => {
    expect(() => parseBufferSize('12.5')).toThrow(/whole number/)
    expect(() => parseBufferSize('')).toThrow(/whole number/)
    expect(() => parseBufferSize('lots')).toThrow(/whole number/)
    expect(() => parseBufferSize('0')).toThrow(/between 100 and 20000/)
    expect(() => parseBufferSize('1e9')).toThrow(/between 100 and 20000/)
  })

  it('round-trips the value through storage', () => {
    const storage = memoryStorage()
    expect(readStoredBufferSize(storage)).toBeUndefined()
    storeBufferSize(5_000, storage)
    expect(storage.values[BUFFER_SIZE_STORAGE_KEY]).toBe('5000')
    expect(readStoredBufferSize(storage)).toBe(5_000)
  })

  it('treats a corrupted or unavailable storage as unset', () => {
    expect(readStoredBufferSize(memoryStorage({ [BUFFER_SIZE_STORAGE_KEY]: 'oops' })))
      .toBeUndefined()
    expect(readStoredBufferSize(memoryStorage({ [BUFFER_SIZE_STORAGE_KEY]: '10' })))
      .toBeUndefined()
    expect(readStoredBufferSize(undefined)).toBeUndefined()
    expect(() => storeBufferSize(2_000, undefined)).not.toThrow()
    expect(() => storeBufferSize(2_000, {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    })).not.toThrow()
  })
})
