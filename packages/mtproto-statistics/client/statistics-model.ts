export type SeriesRange = 'seconds' | 'minutes' | 'hours'

const BUCKET_MS: Record<SeriesRange, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

export function formatPercent(value: number): string {
  return Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—'
}
export function formatTimestamp(value: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}
/**
 * Wall-clock label of one series sample. Aggregate buckets carry the timestamp
 * of their last sample, so snap them back to the start of the bucket they cover.
 */
export function formatSampleTime(
  at: number,
  range: SeriesRange = 'seconds',
): string {
  if (!at) return '—'
  const bucket = BUCKET_MS[range]
  const date = new Date(Math.floor(at / bucket) * bucket)
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
  if (range === 'hours')
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + clock
  return range === 'minutes' ? clock : clock + ':' + pad(date.getSeconds())
}
export function sampleUnit(range: SeriesRange): string {
  return range === 'seconds'
    ? 'sample'
    : range === 'minutes'
      ? 'minute'
      : 'hour'
}
/** One plotted value together with the moment it was observed at. */
export interface SampleValue {
  at: number
  value: number
}
export interface TimedValue extends SampleValue {
  index: number
  time: string
}
/** Pair series values with their wall-clock label so charts stay time-addressable. */
export function timedSeries(
  points: SampleValue[] | undefined,
  range: SeriesRange = 'seconds',
): TimedValue[] {
  return (points ?? []).map((point, index) => ({
    index,
    at: point.at,
    time: formatSampleTime(point.at, range),
    value: point.value,
  }))
}
/** The "from → to" window covered by the samples currently on screen. */
export function sampleWindow(
  points: { at: number }[],
  range: SeriesRange = 'seconds',
): string {
  const first = points[0]?.at,
    last = points.at(-1)?.at
  if (!first || !last) return '—'
  const from = formatSampleTime(first, range)
  return first === last ? from : from + ' → ' + formatSampleTime(last, range)
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

export { formatMs } from "cordis-webui-react/utils"
