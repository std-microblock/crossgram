import { describe, expect, it } from 'vitest'
import { telegramStickerPlaceholder, traceTelegramStickerOutline } from './sticker-outline.js'

describe('Telegram sticker outlines', () => {
  it('encodes a rounded dimension-aware placeholder understood by Telegram Desktop', () => {
    const outline = telegramStickerPlaceholder(200, 100)

    expect(expandPath(outline)).toBe(
      'M12,0H188Q200,0,200,12V88Q200,100,188,100H12Q0,100,0,88V12Q0,0,12,0z',
    )
  })

  it('traces transparent first-frame edges and scales them to document dimensions', () => {
    const alpha = new Uint8Array([
      0, 0, 0, 0, 0, 0,
      0, 0, 255, 255, 0, 0,
      0, 255, 255, 255, 255, 0,
      255, 255, 255, 255, 255, 255,
      0, 255, 255, 255, 255, 0,
      0, 0, 255, 255, 0, 0,
    ])

    const outline = traceTelegramStickerOutline(alpha, 6, 6, 60, 120)

    expect(outline).toBeInstanceOf(Uint8Array)
    expect(expandPath(outline!)).toBe(
      'M20,20L10,40L0,60L10,80L20,100L20,120L40,120L40,100L50,80L60,60L50,40L40,20z',
    )
  })

  it('returns no traced outline for a fully transparent frame', () => {
    expect(traceTelegramStickerOutline(new Uint8Array(16), 4, 4)).toBeUndefined()
  })
})

function expandPath(bytes: Uint8Array): string {
  const characters = 'AACAAAAHAAALMAAAQASTAVAAAZaacaaaahaaalmaaaqastava.az0123456789-,'
  let result = 'M'
  for (const byte of bytes) {
    if (byte >= 192) result += characters[byte - 192]
    else {
      if (byte >= 128) result += ','
      else if (byte >= 64) result += '-'
      result += byte & 63
    }
  }
  return `${result}z`
}
