import { inflateRawSync, unzipSync } from 'node:zlib'

export const MAX_PACKED_DATA_UNPACKED_SIZE = 16 * 1024 * 1024

/**
 * Decompresses the payload carried by gzip_packed.
 *
 * Telegram documents this envelope as gzip, but TDLib builds in the wild can
 * send a zlib wrapper or a raw DEFLATE stream. unzipSync handles gzip and zlib;
 * the raw inflater is deliberately only a fallback. Both paths enforce the
 * same output cap so a small transport envelope cannot expand without bound.
 */
export function unpackPackedData(packedData: Uint8Array): Uint8Array {
  const options = { maxOutputLength: MAX_PACKED_DATA_UNPACKED_SIZE }

  try {
    const unpacked = unzipSync(packedData, options)
    return new Uint8Array(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength)
  } catch (wrappedError) {
    try {
      const unpacked = inflateRawSync(packedData, options)
      return new Uint8Array(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength)
    } catch (rawError) {
      throw new AggregateError(
        [wrappedError, rawError],
        'Unable to decompress gzip_packed payload as gzip, zlib, or raw DEFLATE',
      )
    }
  }
}
