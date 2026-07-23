import type { ProvisionedPlatformAccount } from './platform-account.js'
import { getLoginCodeState } from './login-code.js'

export type PlatformAccountStatus = 'ready' | 'loading' | 'error' | 'unsupported'

export interface PlatformAccountView {
  platformId: string
  platformKind: string
  status: PlatformAccountStatus
  displayName?: string
  firstName?: string
  lastName?: string
  username?: string
  userId?: string
  avatarUrl?: string
  virtualPhone?: string
  loginCode?: string
  validUntil?: number
  remainingSeconds?: number
  error?: string
}

export interface PlatformAccountDashboardData {
  accounts: PlatformAccountView[]
  updatedAt: number
  refresh(): Promise<void>
}

export function makePlatformAccountView(
  platformId: string,
  platformKind: string,
  account: ProvisionedPlatformAccount,
  apiPrefix: string,
  now = Date.now(),
): PlatformAccountView {
  const code = getLoginCodeState(account.auth.totpSecret, now)
  const profile = account.profile
  return {
    platformId,
    platformKind,
    status: 'ready',
    displayName: [profile.firstName, profile.lastName].filter(Boolean).join(' '),
    firstName: profile.firstName,
    lastName: profile.lastName,
    username: profile.username,
    userId: profile.id,
    avatarUrl: profile.avatar
      ? `${apiPrefix}/platforms/${encodeURIComponent(platformId)}/avatar?v=${encodeURIComponent(profile.avatar.id)}`
      : undefined,
    virtualPhone: `+${account.auth.virtualPhone}`,
    loginCode: code.code,
    validUntil: code.validUntil,
    remainingSeconds: code.remainingSeconds,
  }
}

export function makeUnavailableAccountView(
  platformId: string,
  platformKind: string,
  status: Exclude<PlatformAccountStatus, 'ready'>,
  error?: unknown,
): PlatformAccountView {
  return {
    platformId,
    platformKind,
    status,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
  }
}
