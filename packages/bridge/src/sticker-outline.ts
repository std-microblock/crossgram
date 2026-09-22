const COMPACT_PATH_CHARACTERS
  = 'AACAAAAHAAALMAAAQASTAVAAAZaacaaaahaaalmaaaqastava.az0123456789-,'

// Clients do not run a general SVG engine over a `photoPathSize` thumbnail.
// Telegram Desktop's `Images::PathFromInlineBytes` implements M/L/H/V/C/S/Z
// only and throws the whole path away as soon as it meets any other command,
// which silently removes the loading frame. Everything we encode therefore has
// to stay inside that subset.
const CUBIC_CORNER_RATIO = 0.5522847498307936

interface Point {
  x: number
  y: number
}

export type TelegramStickerPathCommand =
  | { _: 'move', x: number, y: number }
  | { _: 'line', x: number, y: number }
  | { _: 'cubic', x1: number, y1: number, x2: number, y2: number, x: number, y: number }
  | { _: 'close', x: number, y: number }

/**
 * Builds Telegram's compact SVG-path placeholder for an uncached sticker.
 *
 * The frame spans the whole document box. Clients scale it with
 * `documentAttributeImageSize` — Telegram Desktop through
 * `DocumentData::dimensions`, Android through the attribute lookup in
 * `DocumentObject.getSvgThumb` — and Desktop additionally clips it to the
 * rounded sticker rect, so a rounded rectangle here matches what a real
 * silhouette looks like before either thumbnail or asset arrives.
 */
export function telegramStickerPlaceholder(width: number, height: number): Uint8Array {
  const w = positiveDimension(width)
  const h = positiveDimension(height)
  const radius = Math.max(1, Math.round(Math.min(w, h) * 0.12))
  const control = Math.round(radius * CUBIC_CORNER_RATIO)
  return compactPath([
    `${radius},0`,
    `H${w - radius}`,
    `C${w - radius + control},0,${w},${radius - control},${w},${radius}`,
    `V${h - radius}`,
    `C${w},${h - radius + control},${w - radius + control},${h},${w - radius},${h}`,
    `H${radius}`,
    `C${radius - control},${h},0,${h - radius + control},0,${h - radius}`,
    `V${radius}`,
    `C0,${radius - control},${radius - control},0,${radius},0`,
  ].join(''))
}

/**
 * Encodes an SVG path into Telegram's compact sticker-path bytes.
 *
 * Clients prepend the implicit leading move-to and append the closing command
 * themselves, so the text must start with the first coordinate pair and must
 * not carry a trailing `z`.
 */
export function encodeTelegramStickerPath(path: string): Uint8Array {
  return compactPath(path)
}

/**
 * Decodes compact sticker-path bytes exactly the way clients do: they prepend
 * the implicit move-to, append the closing command, and then run a reduced SVG
 * parser that only knows the commands Telegram's own sticker encoder emits.
 *
 * Returns `undefined` when a client would drop the whole path, which happens
 * for unknown commands, malformed numbers, unclosed subpaths, and paths that
 * carry no drawing segment at all. Callers fall back to a drawable placeholder
 * so a sticker never stays blank instead of showing a loading frame.
 */
export function decodeTelegramStickerPath(bytes: Uint8Array): TelegramStickerPathCommand[] | undefined {
  const source = `${expandCompactPath(bytes)}z\0`
  const commands: TelegramStickerPathCommand[] = []
  let position = 0
  let x = 0
  let y = 0
  let draws = false

  const current = () => source[position] ?? '\0'
  const skipCommas = () => { while (current() === ',') position++ }
  const number = (): number | undefined => {
    skipCommas()
    let sign = 1
    if (current() === '-') {
      sign = -1
      position++
    }
    let digits = 0
    let value = 0
    while (isDigit(current())) {
      value = value * 10 + Number(current())
      position++
      digits++
    }
    if (current() === '.') {
      position++
      let scale = 0.1
      while (isDigit(current())) {
        value += Number(current()) * scale
        scale *= 0.1
        position++
        digits++
      }
    }
    return digits ? sign * value : undefined
  }

  while (current() !== '\0') {
    skipCommas()
    if (current() === '\0') break

    // The encoder drops the leading move-to and clients add it back, so every
    // path starts with one. Consecutive move-tos keep the last coordinate pair,
    // matching how the client parser consumes them.
    while (current() === 'm' || current() === 'M') {
      const relative = current() === 'm'
      position++
      let next: Point | undefined
      do {
        const nextX = number()
        const nextY = number()
        if (nextX === undefined || nextY === undefined) return undefined
        next = relative ? { x: x + nextX, y: y + nextY } : { x: nextX, y: nextY }
        skipCommas()
      } while (current() !== '\0' && !isAlpha(current()))
      x = next!.x
      y = next!.y
      commands.push({ _: 'move', x, y })
    }
    const start: Point = { x, y }

    let closed = false
    let command = '-'
    let lastControl: Point | undefined
    while (!closed) {
      skipCommas()
      // The client logs "Receive unclosed path" and drops the path.
      if (current() === '\0') return undefined
      if (isAlpha(current())) {
        command = current()
        position++
      }
      switch (command) {
        case 'l':
        case 'L': {
          const nextX = number()
          const nextY = number()
          if (nextX === undefined || nextY === undefined) return undefined
          x = command === 'l' ? x + nextX : nextX
          y = command === 'l' ? y + nextY : nextY
          commands.push({ _: 'line', x, y })
          draws = true
          lastControl = undefined
          break
        }
        case 'h':
        case 'H': {
          const nextX = number()
          if (nextX === undefined) return undefined
          x = command === 'h' ? x + nextX : nextX
          commands.push({ _: 'line', x, y })
          draws = true
          lastControl = undefined
          break
        }
        case 'v':
        case 'V': {
          const nextY = number()
          if (nextY === undefined) return undefined
          y = command === 'v' ? y + nextY : nextY
          commands.push({ _: 'line', x, y })
          draws = true
          lastControl = undefined
          break
        }
        case 'c':
        case 'C':
        case 's':
        case 'S': {
          const relative = command === 'c' || command === 's'
          const smooth = command === 's' || command === 'S'
          const values = smooth
            ? [number(), number(), number(), number()]
            : [number(), number(), number(), number(), number(), number()]
          if (values.some((value) => value === undefined)) return undefined
          const x1 = smooth ? (lastControl ? 2 * x - lastControl.x : x) : (relative ? x : 0) + values[0]!
          const y1 = smooth ? (lastControl ? 2 * y - lastControl.y : y) : (relative ? y : 0) + values[1]!
          const x2 = (relative ? x : 0) + values[smooth ? 0 : 2]!
          const y2 = (relative ? y : 0) + values[smooth ? 1 : 3]!
          const endX = (relative ? x : 0) + values[smooth ? 2 : 4]!
          const endY = (relative ? y : 0) + values[smooth ? 3 : 5]!
          commands.push({ _: 'cubic', x1, y1, x2, y2, x: endX, y: endY })
          x = endX
          y = endY
          draws = true
          lastControl = { x: x2, y: y2 }
          break
        }
        case 'm':
        case 'M':
        case 'z':
        case 'Z': {
          // The client parser rewinds over a move-to so its outer loop reads it
          // as a new subpath; only `z`/`Z` close the current one.
          if (command === 'z' || command === 'Z') {
            commands.push({ _: 'close', x: start.x, y: start.y })
            x = start.x
            y = start.y
          } else {
            position--
          }
          closed = true
          break
        }
        default:
          // Clients discard the entire path on an unsupported command.
          return undefined
      }
    }
  }

  return draws ? commands : undefined
}

/**
 * Approximates the visible outside edge of an RGBA alpha channel as a compact
 * Telegram sticker path. Empty masks return undefined so callers can use the
 * deterministic rounded placeholder instead.
 */
export function traceTelegramStickerOutline(
  alpha: Uint8Array,
  width: number,
  height: number,
  targetWidth = width,
  targetHeight = height,
  threshold = 16,
): Uint8Array | undefined {
  const sourceWidth = Math.trunc(width)
  const sourceHeight = Math.trunc(height)
  if (sourceWidth <= 0 || sourceHeight <= 0 || alpha.byteLength < sourceWidth * sourceHeight) return

  const rows: Array<{ left: number, right: number } | undefined> = []
  for (let y = 0; y < sourceHeight; y++) {
    let left = sourceWidth
    let right = -1
    for (let x = 0; x < sourceWidth; x++) {
      if (alpha[y * sourceWidth + x]! < threshold) continue
      left = Math.min(left, x)
      right = x + 1
    }
    rows.push(right > left ? { left, right } : undefined)
  }

  const paths: string[] = []
  for (let start = 0; start < sourceHeight;) {
    while (start < sourceHeight && !rows[start]) start++
    if (start >= sourceHeight) break
    let end = start
    while (end + 1 < sourceHeight && rows[end + 1]) end++

    const sampled = sampledRows(start, end)
    const points = [
      ...sampled.map((y) => scalePoint(rows[y]!.left, y, sourceWidth, sourceHeight, targetWidth, targetHeight)),
      scalePoint(rows[end]!.left, end + 1, sourceWidth, sourceHeight, targetWidth, targetHeight),
      scalePoint(rows[end]!.right, end + 1, sourceWidth, sourceHeight, targetWidth, targetHeight),
      ...sampled.slice().reverse()
        .map((y) => scalePoint(rows[y]!.right, y, sourceWidth, sourceHeight, targetWidth, targetHeight)),
    ]
    const simplified = simplifyPolygon(points)
    if (simplified.length >= 3) paths.push(pointPath(simplified))
    start = end + 1
  }

  return paths.length ? compactPath(paths.join('zM')) : undefined
}

function sampledRows(start: number, end: number): number[] {
  const step = Math.max(1, Math.ceil((end - start + 1) / 24))
  const result: number[] = []
  for (let y = start; y <= end; y += step) result.push(y)
  if (result.at(-1) !== end) result.push(end)
  return result
}

function scalePoint(
  x: number,
  y: number,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Point {
  return {
    x: Math.round(x * positiveDimension(targetWidth) / sourceWidth),
    y: Math.round(y * positiveDimension(targetHeight) / sourceHeight),
  }
}

function simplifyPolygon(points: Point[]): Point[] {
  const unique = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length]!
    return point.x !== previous.x || point.y !== previous.y
  })
  if (unique.length < 3) return unique
  return unique.filter((point, index) => {
    const previous = unique[(index + unique.length - 1) % unique.length]!
    const next = unique[(index + 1) % unique.length]!
    return (point.x - previous.x) * (next.y - point.y)
      !== (point.y - previous.y) * (next.x - point.x)
  })
}

function pointPath(points: Point[]): string {
  const [first, ...rest] = points
  return `${first!.x},${first!.y}${rest.map((point) => `L${point.x},${point.y}`).join('')}`
}

function expandCompactPath(bytes: Uint8Array): string {
  let path = 'M'
  for (const byte of bytes) {
    if (byte >= 128 + 64) {
      path += COMPACT_PATH_CHARACTERS.charAt(byte - 128 - 64)
    } else {
      if (byte >= 128) path += ','
      else if (byte >= 64) path += '-'
      path += String(byte & 63)
    }
  }
  return path
}

function compactPath(path: string): Uint8Array {
  const output = new Uint8Array(path.length)
  for (let index = 0; index < path.length; index++) {
    const compact = COMPACT_PATH_CHARACTERS.lastIndexOf(path[index]!)
    if (compact < 0) throw new Error(`Telegram sticker path contains an unsupported character: ${path[index]}`)
    output[index] = 192 + compact
  }
  return output
}

function isAlpha(char: string): boolean {
  const lower = char.toLowerCase()
  return lower >= 'a' && lower <= 'z'
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

function positiveDimension(value: number): number {
  return Math.max(1, Math.min(0x7fffffff, Math.round(Number.isFinite(value) ? value : 1)))
}
