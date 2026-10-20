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

export { formatMs } from "cordis-webui-react/utils"
