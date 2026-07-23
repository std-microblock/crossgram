import type { IMMediaSource } from './platform.js'

const MAX_IMAGE_HEADER_BYTES = 256 * 1024

/** Read a bounded prefix from a replayable upload source and detect common image dimensions. */
export async function probeImageDimensions(
  source: IMMediaSource,
  limit = MAX_IMAGE_HEADER_BYTES,
): Promise<{ width: number, height: number } | undefined> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of source.stream()) {
    const accepted = chunk.subarray(0, Math.max(0, limit - size))
    if (accepted.length) {
      chunks.push(accepted)
      size += accepted.length
    }
    if (size >= limit) break
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return imageDimensions(bytes)
}

export function imageDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  return pngDimensions(bytes)
    ?? gifDimensions(bytes)
    ?? jpegDimensions(bytes)
    ?? webpDimensions(bytes)
}

function pngDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 24
    || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
    || bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a) return
  return dimensions(readU32BE(bytes, 16), readU32BE(bytes, 20))
}

function gifDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 10) return
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return
  return dimensions(readU16LE(bytes, 6), readU16LE(bytes, 8))
}

function jpegDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return
  let offset = 2
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return
    const marker = bytes[offset++]!
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return
    const length = readU16BE(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return dimensions(readU16BE(bytes, offset + 5), readU16BE(bytes, offset + 3))
    }
    offset += length
  }
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function webpDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    return dimensions(readU24LE(bytes, 24) + 1, readU24LE(bytes, 27) + 1)
  }
  if (chunk === 'VP8 ' && bytes.length >= 30
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return dimensions(readU16LE(bytes, 26) & 0x3fff, readU16LE(bytes, 28) & 0x3fff)
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21]! | bytes[22]! << 8 | bytes[23]! << 16 | bytes[24]! << 24) >>> 0
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
}

function dimensions(width: number, height: number): { width: number, height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100 + bytes[offset + 3]!
}
