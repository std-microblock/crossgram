// Retain the deployed token key so existing sessions survive the UI migration.
export const TOKEN_KEY = 'cordis:webui-sso:token'
const OAUTH_KEY = 'solid-webui:oauth-pending'
let memoryToken: string | null = null
export function sessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return memoryToken
  }
}
export function setSessionToken(token: string | null) {
  memoryToken = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* Session remains usable while this page is open. */
  }
}
export async function ssoRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  authenticated = false,
  signal?: AbortSignal,
): Promise<T> {
  if (!path.startsWith('/sso/')) throw new Error('Invalid SSO endpoint')
  const headers = new Headers()
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (authenticated && sessionToken())
    headers.set('authorization', 'Bearer ' + sessionToken())
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    if (authenticated && response.status === 401) setSessionToken(null)
    let message = 'HTTP ' + response.status
    try {
      const data = await response.json()
      message = data.error ?? message
    } catch {
      /* Preserve status for non-JSON errors. */
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('The SSO server returned an unexpected response')
  return response.json()
}
export function beginOAuth(provider: string): {
  state: string
  redirect_uri: string
} {
  const state = crypto.randomUUID()
  // If session storage is unavailable, do not start a redirect we cannot correlate.
  sessionStorage.setItem(
    OAUTH_KEY,
    JSON.stringify({ state, provider, started: Date.now() }),
  )
  return {
    state,
    redirect_uri:
      location.origin + '/sso/callback/' + encodeURIComponent(provider),
  }
}
export function consumeOAuthResult(uiPath: string): string | undefined {
  const hash = new URLSearchParams(location.hash.slice(1)),
    query = new URLSearchParams(location.search)
  if (!hash.has('token') && !hash.has('error') && !query.has('error')) return
  let pending: { started: number } | undefined
  try {
    pending = JSON.parse(sessionStorage.getItem(OAUTH_KEY) ?? 'null')
    sessionStorage.removeItem(OAUTH_KEY)
  } catch {
    /* Correlation failure is handled below. */
  }
  // Always remove credentials from the address bar, including unsolicited ones.
  history.replaceState(history.state, '', uiPath + '/sso')
  if (
    !pending ||
    !Number.isFinite(pending.started) ||
    Date.now() - pending.started < 0 ||
    Date.now() - pending.started > 10 * 60_000
  )
    return 'The sign-in attempt expired or was not started in this tab. Please sign in again.'
  const error = hash.get('error') ?? query.get('error')
  if (error) return error
  const token = hash.get('token')
  if (token) setSessionToken(token)
}
