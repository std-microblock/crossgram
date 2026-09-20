export function parseTelegramLoginUrl(value: string): string | undefined {
  try {
    const url = new URL(value),
      token = url.searchParams.get('token')
    if (
      url.protocol !== 'tg:' ||
      url.hostname !== 'login' ||
      (url.pathname && url.pathname !== '/') ||
      url.username ||
      url.password ||
      url.hash ||
      !token ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(token)
    )
      return
    const decoded = atob(
      token
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(token.length / 4) * 4, '='),
    )
    const padded = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_'),
      canonical = padded.replace(/=+$/, '')
    if (decoded.length !== 32 || (token !== canonical && token !== padded))
      return
    // Only the canonical login token is forwarded. Never forward extra query parameters.
    return 'tg://login?token=' + canonical
  } catch {
    return
  }
}
export function botLink(username: string): string | undefined {
  return /^[A-Za-z0-9_]{1,64}$/.test(username)
    ? 'https://t.me/' + username
    : undefined
}
export function safeImageURL(value?: string): string | undefined {
  if (!value) return
  try {
    const url = new URL(value, location.href)
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined
  } catch {
    return
  }
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
export function remainingSeconds(
  validUntil: number | undefined,
  now: number,
): number {
  return validUntil ? Math.max(0, Math.ceil((validUntil - now) / 1000)) : 0
}
export function formatPhone(value?: string): string {
  if (!value) return 'Unavailable'
  const digits = value.replace(/\D/g, '')
  if (digits.startsWith('888'))
    return '+888 ' + digits.slice(3).replace(/(\d)(?=(\d{3})+$)/g, '$1 ')
  return '+' + digits.replace(/(\d)(?=(\d{3})+$)/g, '$1 ')
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
