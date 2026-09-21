/** Preserve both peaks and troughs while bounding SVG work independently of history size. */
export function downsample(
  values: readonly number[],
  maximum = 120,
): { index: number; value: number }[] {
  maximum = Number.isFinite(maximum) ? Math.max(4, Math.floor(maximum)) : 120
  const valueAt = (index: number) =>
    Number.isFinite(values[index]) ? Math.max(0, values[index]) : 0
  const clean = (index: number) => ({ index, value: valueAt(index) })
  if (values.length <= maximum) return values.map((_, index) => clean(index))
  const result = [clean(0)],
    buckets = Math.max(1, Math.floor((maximum - 2) / 2)),
    width = (values.length - 2) / buckets
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor(bucket * width),
      end = Math.min(values.length - 1, 1 + Math.floor((bucket + 1) * width))
    let low = start,
      high = start
    for (let index = start + 1; index < end; index++) {
      if (valueAt(index) < valueAt(low)) low = index
      if (valueAt(index) > valueAt(high)) high = index
    }
    for (const index of [...new Set([low, high])].sort((a, b) => a - b))
      result.push(clean(index))
  }
  result.push(clean(values.length - 1))
  return result
}
/**
 * Bounds the sample count, then connects the points with a cardinal spline. Raw peaks are
 * kept (see downsample) while the curve stays readable instead of turning into a sawtooth.
 */
export function sparkPath(values: readonly number[], samples = 64): string {
  const points = downsample(values, samples)
  const peak = Math.max(1, ...points.map((point) => point.value))
  const span = Math.max(1, values.length - 1)
  const coordinates = points.map((point) => ({
    x: (point.index / span) * 300,
    y: 66 - (point.value / peak) * 60,
  }))
  if (coordinates.length < 2)
    return coordinates.length
      ? 'M' + coordinates[0]!.x.toFixed(1) + ',' + coordinates[0]!.y.toFixed(1)
      : ''
  const tension = 0.35
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(maximum, Math.max(minimum, value))
  let path = 'M' + coordinates[0]!.x.toFixed(1) + ',' + coordinates[0]!.y.toFixed(1)
  for (let index = 0; index < coordinates.length - 1; index++) {
    const previous = coordinates[index - 1] ?? coordinates[index]!
    const current = coordinates[index]!
    const next = coordinates[index + 1]!
    const after = coordinates[index + 2] ?? next
    const control1 = {
      x: current.x + ((next.x - previous.x) / 6) * tension * 2,
      y: current.y + ((next.y - previous.y) / 6) * tension * 2,
    }
    const control2 = {
      x: next.x - ((after.x - current.x) / 6) * tension * 2,
      y: next.y - ((after.y - current.y) / 6) * tension * 2,
    }
    path +=
      'C' +
      clamp(control1.x, 0, 300).toFixed(1) +
      ',' +
      clamp(control1.y, 0, 72).toFixed(1) +
      ' ' +
      clamp(control2.x, 0, 300).toFixed(1) +
      ',' +
      clamp(control2.y, 0, 72).toFixed(1) +
      ' ' +
      next.x.toFixed(1) +
      ',' +
      next.y.toFixed(1)
  }
  return path
}
export function formatPercent(value: number): string {
  return Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—'
}
export function formatTimestamp(value: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}
export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60)
  return days
    ? days + 'd ' + hours + 'h'
    : hours
      ? hours + 'h ' + minutes + 'm'
      : minutes + 'm'
}
export function distributionSlices(
  rows: { method: string; count: number }[],
  total: number,
) {
  const slices = rows
      .slice(0, 7)
      .map((row) => ({ label: row.method, value: row.count })),
    represented = slices.reduce((sum, row) => sum + row.value, 0)
  if (total > represented)
    slices.push({ label: 'Other methods', value: total - represented })
  return slices
}

export { formatMs } from "cordis-webui-solidjs/utils"
