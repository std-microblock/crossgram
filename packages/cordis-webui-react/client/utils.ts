export function pageSlice<T>(
  items: readonly T[],
  page: number,
  size = 50,
): T[] {
  return items.slice(Math.max(0, page) * size, (Math.max(0, page) + 1) * size)
}

export function displayValue(value: unknown): string {
  return value === null
    ? 'null'
    : value === undefined
      ? '—'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
}

export async function readResponse(
  response: Response,
  limit = 1024 * 1024,
  progress?: (text: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { text: '', truncated: false }
  const decoder = new TextDecoder()
  let text = '',
    bytes = 0,
    truncated = false,
    lastProgress = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const remaining = limit - bytes
      text += decoder.decode(value.subarray(0, Math.max(0, remaining)), {
        stream: true,
      })
      bytes += value.length
      if (progress && performance.now() - lastProgress > 100) {
        progress(text)
        lastProgress = performance.now()
      }
      if (bytes > limit) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  progress?.(text)
  return { text, truncated }
}

export function sameOriginPath(value: string): string {
  const url = new URL(value, location.href)
  if (
    url.origin !== location.origin ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('The server provided an unsafe API address')
  return url.href
}

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const previous = document.activeElement as HTMLElement | null,
    input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  try {
    input.select()
    if (!document.execCommand('copy'))
      throw new Error(
        'Clipboard access was denied. Select and copy the value manually.',
      )
  } finally {
    input.remove()
    previous?.focus()
  }
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value < 1
    ? Math.round(value * 1000) + ' µs'
    : value < 1000
      ? value.toFixed(value < 10 ? 2 : 1) + ' ms'
      : (value / 1000).toFixed(2) + ' s'
}
