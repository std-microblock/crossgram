const TELEGRAM_JPEG_HEADER = hexBytes([
  'ffd8ffe000104a46494600010100000100010000ffdb004300281c1e231e19282321232d2b28303c64413c37373c7b585d49',
  '64918099968f808c8aa0b4e6c3a0aadaad8a8cc8ffcbdaeef5ffffff9bc1fffffffaffe6fdfff8ffdb0043012b2d2d3c353c',
  '76414176f8a58ca5f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8',
  'f8f8f8f8f8f8f8f8ffc00011080000000003012200021101031101ffc4001f00000105010101010101000000000000000001',
  '02030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114',
  '328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a53545556',
  '5758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5',
  'b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f010003',
  '0101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102',
  '031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35',
  '363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495',
  '969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9ea',
  'f2f3f4f5f6f7f8f9faffda000c03010002110311003f00',
].join(''))

const JPEG_END = new Uint8Array([0xff, 0xd9])

/**
 * Removes the fixed Telegram JPEG envelope from a small baseline JPEG.
 *
 * The input must use the standard quality-20 quantization and Huffman tables,
 * 4:2:0 chroma subsampling, and dimensions no larger than 255 pixels. Sharp's
 * `jpeg({ quality: 20, chromaSubsampling: '4:2:0', progressive: false,
 * optimizeCoding: false })` produces this representation.
 */
export function stripTelegramJpegThumbnail(jpeg: Uint8Array): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('Telegram stripped thumbnail source is not a JPEG')
  }
  let width = 0
  let height = 0
  let scanOffset = -1
  for (let offset = 2; offset < jpeg.length;) {
    if (jpeg[offset++] !== 0xff) throw new Error('Telegram stripped thumbnail has an invalid JPEG marker')
    while (jpeg[offset] === 0xff) offset++
    const marker = jpeg[offset++]
    if (marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > jpeg.length) throw new Error('Telegram stripped thumbnail has a truncated JPEG segment')
    const length = (jpeg[offset] << 8) | jpeg[offset + 1]
    if (length < 2 || offset + length > jpeg.length) {
      throw new Error('Telegram stripped thumbnail has an invalid JPEG segment')
    }
    if (marker === 0xc0) {
      if (length < 8) throw new Error('Telegram stripped thumbnail has an invalid JPEG frame')
      height = (jpeg[offset + 3] << 8) | jpeg[offset + 4]
      width = (jpeg[offset + 5] << 8) | jpeg[offset + 6]
    } else if (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error('Telegram stripped thumbnail source must be a baseline JPEG')
    }
    if (marker === 0xda) {
      scanOffset = offset + length
      break
    }
    offset += length
  }
  if (!width || !height || width > 255 || height > 255 || scanOffset < 0) {
    throw new Error('Telegram stripped thumbnail source has unsupported dimensions or no scan data')
  }
  if (jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9 || scanOffset > jpeg.length - 2) {
    throw new Error('Telegram stripped thumbnail source has no JPEG end marker')
  }
  const output = new Uint8Array(3 + jpeg.length - 2 - scanOffset)
  // Telegram stores the one-byte JPEG frame dimensions in SOF order:
  // height first, then width.
  output.set([1, height, width])
  output.set(jpeg.subarray(scanOffset, jpeg.length - 2), 3)
  return output
}

/** Reconstructs a displayable JPEG from Telegram's inline stripped bytes. */
export function expandTelegramStrippedThumbnail(stripped: Uint8Array): Uint8Array {
  if (stripped.length < 3 || stripped[0] !== 1) return stripped.slice()
  const output = new Uint8Array(TELEGRAM_JPEG_HEADER.length + stripped.length - 3 + JPEG_END.length)
  output.set(TELEGRAM_JPEG_HEADER)
  output[164] = stripped[1]
  output[166] = stripped[2]
  output.set(stripped.subarray(3), TELEGRAM_JPEG_HEADER.length)
  output.set(JPEG_END, output.length - JPEG_END.length)
  return output
}

function hexBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2)
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return output
}
