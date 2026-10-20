import type { BackfillConversationSnapshot, BackfillSessionStatus } from '../src/types.js'

export function sessionStatusLabel(status: BackfillSessionStatus): string {
  switch (status) {
    case 'disabled': return 'Paused'
    case 'waiting-idle': return 'Waiting for the account to go idle'
    case 'capped': return 'Daily request limit reached'
    case 'working': return 'Backfilling'
    case 'done': return 'Nothing left to backfill'
    case 'unsupported': return 'Platform has no history API'
  }
}

/** 进度描述：序号模式给出已覆盖的序号范围，锚点模式给出是否已到底。 */
export function conversationProgress(item: BackfillConversationSnapshot): string {
  if (item.mode === 'sequence') {
    if (!item.bootstrapped) return 'not scanned yet'
    if (item.minSequence === undefined) return 'no stored sequence'
    const top = Math.max(item.maxSequence ?? 0, item.upperSequence ?? 0)
    return `seq ${item.minSequence}–${top} · ${item.covered} covered`
  }
  return item.floorReached ? 'complete' : 'walking back'
}

export function formatDate(milliseconds: number): string {
  const date = new Date(milliseconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 相对现在的时间描述；未来时间（重试时刻）显示为「in …」。 */
export function formatAge(milliseconds: number | undefined, now = Date.now()): string {
  if (milliseconds === undefined) return 'never'
  const delta = Math.round((now - milliseconds) / 1000)
  const value = Math.abs(delta)
  const text = value < 60 ? `${value}s`
    : value < 3600 ? `${Math.floor(value / 60)}m`
      : value < 86_400 ? `${Math.floor(value / 3600)}h`
        : `${Math.floor(value / 86_400)}d`
  return delta >= 0 ? `${text} ago` : `in ${text}`
}
