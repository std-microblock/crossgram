import type {
  CrossGramServerConfig,
  PlatformAccountDuplicateGroup,
  PlatformAccountServerEndpoint,
} from '../src/dashboard-types.js'
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
/** `host:port`, bracketing IPv6 hosts the way a client configuration spells them. */
export function formatEndpoint(endpoint: { host: string; port: number }): string {
  return (
    (endpoint.host.includes(':') ? '[' + endpoint.host + ']' : endpoint.host) +
    ':' +
    endpoint.port
  )
}
/** Point a copy of the server configuration at one advertised endpoint. */
export function withServerEndpoint(
  config: CrossGramServerConfig,
  endpoint: PlatformAccountServerEndpoint,
): CrossGramServerConfig {
  return {
    ...config,
    host: endpoint.host,
    port: endpoint.port,
    dcs: config.dcs.map((dc) => ({ ...dc, ip: endpoint.host, port: endpoint.port })),
  }
}
/**
 * Entry each duplicated platform entry duplicates. The backend only reports
 * entries it can prove are duplicates, so the map is safe to render directly.
 */
export function duplicateOwners(
  groups: readonly PlatformAccountDuplicateGroup[],
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const group of groups)
    for (const platformId of group.remove)
      if (!owners.has(platformId)) owners.set(platformId, group.keep)
  return owners
}
/** Every entry that duplicates another one, in a stable order. */
export function duplicatePlatformIds(
  groups: readonly PlatformAccountDuplicateGroup[],
): string[] {
  return [...new Set(groups.flatMap((group) => group.remove))].sort()
}
/** Describe one duplicate group for the cleanup banner. */
export function describeDuplicateGroup(
  group: PlatformAccountDuplicateGroup,
): string {
  const reason =
    group.reason === 'virtual-phone'
      ? 'already serves the same virtual phone'
      : 'resolves to the same platform user'
  return (
    group.remove.join(', ') +
    (group.remove.length > 1 ? ' duplicate ' : ' duplicates ') +
    group.keep +
    ' (' +
    reason +
    ')'
  )
}

export { sameOriginPath, copyText } from "cordis-webui-solidjs/utils"
