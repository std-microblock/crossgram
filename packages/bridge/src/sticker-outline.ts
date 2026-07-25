const COMPACT_PATH_CHARACTERS
  = 'AACAAAAHAAALMAAAQASTAVAAAZaacaaaahaaalmaaaqastava.az0123456789-,'

interface Point {
  x: number
  y: number
}

/**
 * Builds Telegram's compact SVG-path placeholder for an uncached sticker.
 *
 * Telegram Desktop scales this path with the sticker dimensions and paints a
 * moving gradient through it until the sticker has loaded.
 */
export function telegramStickerPlaceholder(width: number, height: number): Uint8Array {
  const w = positiveDimension(width)
  const h = positiveDimension(height)
  const radius = Math.max(1, Math.round(Math.min(w, h) * 0.12))
  return compactPath([
    `${radius},0`,
    `H${w - radius}`,
    `Q${w},0,${w},${radius}`,
    `V${h - radius}`,
    `Q${w},${h},${w - radius},${h}`,
    `H${radius}`,
    `Q0,${h},0,${h - radius}`,
    `V${radius}`,
    `Q0,0,${radius},0`,
  ].join(''))
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

function compactPath(path: string): Uint8Array {
  const output = new Uint8Array(path.length)
  for (let index = 0; index < path.length; index++) {
    const compact = COMPACT_PATH_CHARACTERS.lastIndexOf(path[index]!)
    if (compact < 0) throw new Error(`Telegram sticker path contains an unsupported character: ${path[index]}`)
    output[index] = 192 + compact
  }
  return output
}

function positiveDimension(value: number): number {
  return Math.max(1, Math.min(0x7fffffff, Math.round(Number.isFinite(value) ? value : 1)))
}
