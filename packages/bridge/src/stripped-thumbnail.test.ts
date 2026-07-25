import { describe, expect, it } from 'vitest'
import { expandTelegramStrippedThumbnail, stripTelegramJpegThumbnail } from './stripped-thumbnail.js'

const stripped = new Uint8Array(Buffer.from(
  'ASgcyhzwBzRjFTxoNoOKXaGHSrsK5BgYo2/WpjFx7VF0pAWo5YhGAykN7VKgUj5dv4tn+VV9o+UZAyad5WD94ZpXHYfMDs5Kgf7tU+hOCaslSwx5gP15qs3DEUXAdJIXfJ7cUpnYhQTwtFFKwXATssm9eCOmKjYksSe9FFAXPw==',
  'base64',
))

describe('Telegram stripped thumbnails', () => {
  it('round-trips the canonical JPEG envelope without changing scan bytes', () => {
    const jpeg = expandTelegramStrippedThumbnail(stripped)

    expect(jpeg.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]))
    expect(jpeg.subarray(-2)).toEqual(new Uint8Array([0xff, 0xd9]))
    expect([jpeg[163], jpeg[164], jpeg[165], jpeg[166]]).toEqual([0, 40, 0, 28])
    expect(stripTelegramJpegThumbnail(jpeg)).toEqual(stripped)
  })

  it('leaves unknown stripped representations untouched and rejects invalid JPEG input', () => {
    const unknown = new Uint8Array([2, 3, 4, 5])
    expect(expandTelegramStrippedThumbnail(unknown)).toEqual(unknown)
    expect(() => stripTelegramJpegThumbnail(new Uint8Array([1, 2, 3]))).toThrow(/not a JPEG/)
  })
})
