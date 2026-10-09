import type { CrossGramServerConfig } from '../src/dashboard-types.js'
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
/**
 * Clipboard form of the server configuration. Android clients report "invalid JSON" when
 * the configuration is pasted with line breaks and import the identical document once the
 * line breaks are removed, so the copy button emits exactly one line, with the same fields
 * and values as the readable form rendered on the page.
 */
export function serializeServerConfig(
  config: CrossGramServerConfig | undefined,
): string | undefined {
  return config ? JSON.stringify(config) : undefined
}
/** Readable form of the server configuration, used for on-page display only. */
export function formatServerConfig(
  config: CrossGramServerConfig | undefined,
): string | undefined {
  return config ? JSON.stringify(config, null, 2) : undefined
}

export { sameOriginPath, copyText } from "cordis-webui-solidjs/utils"
