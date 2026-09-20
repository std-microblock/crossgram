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
export function sparkPath(values: readonly number[]): string {
  const points = downsample(values),
    maximum = Math.max(1, ...points.map((point) => point.value))
  return points
    .map(
      (point, index) =>
        (index ? 'L' : 'M') +
        ((point.index / Math.max(1, values.length - 1)) * 300).toFixed(1) +
        ',' +
        (66 - (point.value / maximum) * 60).toFixed(1),
    )
    .join(' ')
}
export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value < 1
    ? Math.round(value * 1000) + ' µs'
    : value < 1000
      ? value.toFixed(value < 10 ? 2 : 1) + ' ms'
      : (value / 1000).toFixed(2) + ' s'
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
