import { describe, expect, it } from 'vitest'
import { imageDimensions, probeImageDimensions } from './image-dimensions.js'

describe('image dimensions', () => {
  it('detects PNG, GIF, JPEG, and WebP from a bounded upload prefix', async () => {
    expect(imageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 })
    expect(imageDimensions(jpeg(1096, 892))).toEqual({ width: 1096, height: 892 })
    expect(imageDimensions(webpExtended(366, 194))).toEqual({ width: 366, height: 194 })

    const detected = await probeImageDimensions({
      async *stream() {
        yield jpeg(1440, 900)
        yield new Uint8Array(300_000)
      },
    })
    expect(detected).toEqual({ width: 1440, height: 900 })
  })
})

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10)
  bytes.set(new TextEncoder().encode('GIF89a'))
  new DataView(bytes.buffer).setUint16(6, width, true)
  new DataView(bytes.buffer).setUint16(8, height, true)
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(23)
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8])
  new DataView(bytes.buffer).setUint16(13, height)
  new DataView(bytes.buffer).setUint16(15, width)
  bytes.set([3, 1, 0x11, 0, 0xff, 0xd9], 17)
  return bytes
}

function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
  writeU24LE(bytes, 24, width - 1)
  writeU24LE(bytes, 27, height - 1)
  return bytes
}

function writeU24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = value >>> 8 & 0xff
  bytes[offset + 2] = value >>> 16 & 0xff
}
