import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MAX_PACKED_DATA_UNPACKED_SIZE, unpackPackedData } from './packed-data.js'

describe('unpackPackedData', () => {
  const payload = new TextEncoder().encode('crossgram packed payload')

  it.each([
    ['gzip', gzipSync],
    ['zlib', deflateSync],
    ['raw DEFLATE', deflateRawSync],
  ])('accepts %s streams', (_format, compress) => {
    expect(unpackPackedData(compress(payload))).toEqual(payload)
  })

  it.each([
    ['gzip', gzipSync],
    ['zlib', deflateSync],
    ['raw DEFLATE', deflateRawSync],
  ])('enforces the unpacked size limit for %s streams', (_format, compress) => {
    const oversized = new Uint8Array(MAX_PACKED_DATA_UNPACKED_SIZE + 1)
    expect(() => unpackPackedData(compress(oversized))).toThrow()
  })

  it('rejects data that is not a supported compressed stream', () => {
    expect(() => unpackPackedData(new Uint8Array([1, 2, 3, 4]))).toThrow(
      'Unable to decompress gzip_packed payload as gzip, zlib, or raw DEFLATE',
    )
  })
})
