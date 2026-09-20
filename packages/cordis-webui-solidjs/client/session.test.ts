import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginOAuth,
  consumeOAuthResult,
  sessionToken,
  setSessionToken,
  ssoRequest,
  TOKEN_KEY,
} from './session.js'
afterEach(() => {
  setSessionToken(null)
  sessionStorage.clear()
  history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('SSO session client', () => {
  it('retains existing deployed sessions and sends bearer credentials only for authenticated API calls', async () => {
    localStorage.setItem(TOKEN_KEY, 'existing-token')
    expect(sessionToken()).toBe('existing-token')
    const fetcher = vi.fn(async () => Response.json({ id: 1 }))
    vi.stubGlobal('fetch', fetcher)
    await ssoRequest('GET', '/sso/me', undefined, true)
    expect((fetcher.mock.calls[0] as any)[1].headers.get('authorization')).toBe(
      'Bearer existing-token',
    )
    await ssoRequest('POST', '/sso/sessions/password', {
      username: 'me',
      password: 'secret',
    })
    expect((fetcher.mock.calls[1] as any)[1].headers.has('authorization')).toBe(
      false,
    )
    await expect(
      ssoRequest('GET', 'https://elsewhere.test', undefined, true),
    ).rejects.toThrow('endpoint')
  })
  it('clears rejected sessions, preserves server errors and rejects HTML fallback responses', async () => {
    setSessionToken('expired')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'SESSION_REQUIRED' }, { status: 401 }),
      ),
    )
    await expect(ssoRequest('GET', '/sso/me', undefined, true)).rejects.toThrow(
      'SESSION_REQUIRED',
    )
    expect(sessionToken()).toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>fallback</html>')),
    )
    await expect(ssoRequest('GET', '/sso/me')).rejects.toThrow(
      'unexpected response',
    )
  })
  it('accepts correlated OAuth results, removes tokens from the URL and rejects unsolicited fragments', () => {
    beginOAuth('provider')
    history.replaceState({}, '', '/#token=valid-token')
    expect(consumeOAuthResult('/console')).toBeUndefined()
    expect(sessionToken()).toBe('valid-token')
    expect(location.hash).toBe('')
    expect(location.pathname).toBe('/console/sso')
    setSessionToken(null)
    history.replaceState({}, '', '/#token=unsolicited')
    expect(consumeOAuthResult('')).toContain('not started')
    expect(sessionToken()).toBeNull()
    expect(location.hash).toBe('')
  })
  it('rejects expired OAuth attempts and reports provider errors without adopting a token', () => {
    beginOAuth('provider')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 700_000)
    history.replaceState({}, '', '/#token=late')
    expect(consumeOAuthResult('')).toContain('expired')
    expect(sessionToken()).toBeNull()
    vi.restoreAllMocks()
    beginOAuth('provider')
    history.replaceState({}, '', '/?error=ACCESS_DENIED')
    expect(consumeOAuthResult('')).toBe('ACCESS_DENIED')
  })
})
