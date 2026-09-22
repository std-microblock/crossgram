import { describe, expect, it } from 'vitest'
import {
  decodeTelegramStickerPath, encodeTelegramStickerPath, telegramStickerPlaceholder,
  traceTelegramStickerOutline,
} from './sticker-outline.js'

describe('Telegram sticker outlines', () => {
  it('encodes a rounded dimension-aware placeholder clients can decode', () => {
    const outline = telegramStickerPlaceholder(200, 100)

    // Clients prepend the implicit move-to and append the closing command.
    expect(expand(outline)).toBe(
      'M12,0H188C195,0,200,5,200,12V88C200,95,195,100,188,100H12C5,100,0,95,0,88V12C0,5,5,0,12,0z',
    )
    expect(pathBounds(outline)).toEqual({ left: 0, top: 0, right: 200, bottom: 100 })
  })

  it('stays inside the command subset every client parser implements', () => {
    for (const [width, height] of [[512, 512], [320, 180], [1080, 1080], [1, 1], [1, 400]]) {
      const expanded = expand(telegramStickerPlaceholder(width, height))

      expect(expanded).toMatch(/^M[0-9HVCLz,-]+z$/)
      expect(expanded).not.toMatch(/[QqTtAa]/)
      expect(pathBounds(telegramStickerPlaceholder(width, height)))
        .toEqual({ left: 0, top: 0, right: width, bottom: height })
    }
  })

  it('rejects quadratic placeholder paths that shipped before the frame fix', () => {
    const quadratic = encodeTelegramStickerPath(
      '61,0H451Q512,0,512,61V451Q512,512,451,512H61Q0,512,0,451V61Q0,0,61,0',
    )

    // Telegram Desktop drops the entire path on an unknown command, so the
    // decoder must flag it instead of forwarding a sticker without a frame.
    expect(decodeTelegramStickerPath(quadratic)).toBeUndefined()
  })

  it('rejects paths without a drawing segment or with malformed numbers', () => {
    expect(decodeTelegramStickerPath(encodeTelegramStickerPath('12,0'))).toBeUndefined()
    expect(decodeTelegramStickerPath(encodeTelegramStickerPath('0,0H'))).toBeUndefined()
    expect(decodeTelegramStickerPath(new Uint8Array())).toBeUndefined()
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
    expect(expand(outline!)).toBe(
      'M20,20L0,60L20,100L20,120L40,120L40,100L60,60L40,20z',
    )
    expect(pathBounds(outline!)).toEqual({ left: 0, top: 20, right: 60, bottom: 120 })
  })

  it('returns no traced outline for a fully transparent frame', () => {
    expect(traceTelegramStickerOutline(new Uint8Array(16), 4, 4)).toBeUndefined()
  })
})

/** Mirrors `Images::ExpandPathInlineBytes` from every Telegram client. */
function expand(bytes: Uint8Array): string {
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

function pathBounds(bytes: Uint8Array): { left: number, top: number, right: number, bottom: number } {
  const commands = decodeTelegramStickerPath(bytes)
  if (!commands) throw new Error('sticker path is not drawable by Telegram clients')
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  const include = (x: number, y: number) => {
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  for (const command of commands) {
    if (command._ === 'cubic') {
      include(command.x1, command.y1)
      include(command.x2, command.y2)
    }
    include(command.x, command.y)
  }
  return { left, top, right, bottom }
}
