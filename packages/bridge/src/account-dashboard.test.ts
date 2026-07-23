import { describe, expect, it } from 'vitest'
import type { ProvisionedPlatformAccount } from './platform-account.js'
import { makePlatformAccountView, makeUnavailableAccountView } from './account-dashboard.js'

const provisioned: ProvisionedPlatformAccount = {
  auth: {
    id: 'auth', platformId: 'qq/primary', platformSessionId: 'session',
    virtualPhone: '999123456789012', totpSecret: Buffer.from('12345678901234567890').toString('hex'),
  },
  session: {
    platformId: 'qq/primary', platformSessionId: 'session', userId: 'uid-1', credentials: {},
    metadata: { firstName: 'Alice' },
  },
  profile: {
    id: 'uid-1', firstName: 'Alice', lastName: 'Example', username: '10001',
    avatar: { id: 'avatar/self 1', kind: 'image', locator: { native: true } },
  },
}

describe('platform account dashboard projection', () => {
  it('projects platform-owned profile and current code without exposing secrets or credentials', () => {
    const view = makePlatformAccountView('qq/primary', 'qq', provisioned, '/api', 59_000)
    expect(view).toMatchObject({
      platformId: 'qq/primary', platformKind: 'qq', status: 'ready',
      displayName: 'Alice Example', username: '10001', userId: 'uid-1',
      virtualPhone: '+999123456789012', loginCode: '287082', remainingSeconds: 1,
      avatarUrl: '/api/platforms/qq%2Fprimary/avatar?v=avatar%2Fself%201',
    })
    expect(JSON.stringify(view)).not.toContain('totpSecret')
    expect(JSON.stringify(view)).not.toContain('credentials')
  })

  it('represents adapter errors and unsupported identity providers explicitly', () => {
    expect(makeUnavailableAccountView('broken', 'qq', 'error', new Error('not ready')))
      .toMatchObject({ status: 'error', error: 'not ready' })
    expect(makeUnavailableAccountView('legacy', 'legacy', 'unsupported'))
      .toEqual({ platformId: 'legacy', platformKind: 'legacy', status: 'unsupported', error: undefined })
  })
})
