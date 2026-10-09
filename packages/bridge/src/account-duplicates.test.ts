import { describe, expect, it } from 'vitest'
import { findDuplicateAccounts, type PlatformAccountDuplicateCandidate } from './account-duplicates.js'

const candidate = (
  platformId: string,
  values: Partial<PlatformAccountDuplicateCandidate> = {},
): PlatformAccountDuplicateCandidate => ({
  platformId,
  platformKind: 'qq',
  clientAuthorizations: 0,
  ...values,
})

describe('platform account duplicate detection', () => {
  it('groups entries that resolve to the same platform user and keeps the entry clients use', () => {
    expect(findDuplicateAccounts([
      candidate('qq-one', { userId: 'qq-10001', clientAuthorizations: 1 }),
      candidate('qq-two', { userId: 'qq-10001', clientAuthorizations: 3 }),
      candidate('qq-other', { userId: 'qq-10002' }),
      candidate('matrix', { platformKind: 'matrix', userId: 'qq-10001' }),
    ])).toEqual([
      { keep: 'qq-two', remove: ['qq-one'], reason: 'identity' },
    ])
  })

  it('prefers the stable entry id order when no entry is signed in', () => {
    expect(findDuplicateAccounts([
      candidate('qq-b', { userId: 'uid' }),
      candidate('qq-a', { userId: 'uid' }),
    ])).toEqual([{ keep: 'qq-a', remove: ['qq-b'], reason: 'identity' }])
  })

  it('reports an entry that lost its virtual phone to the entry already serving the account', () => {
    expect(findDuplicateAccounts([
      candidate('qqnt', { userId: 'uid', clientAuthorizations: 2 }),
      candidate('qqnt-2', { claimedBy: 'qqnt' }),
      candidate('qqnt-3', { claimedBy: 'qqnt' }),
    ])).toEqual([
      {
        keep: 'qqnt',
        remove: ['qqnt-2', 'qqnt-3'],
        reason: 'virtual-phone',
      },
    ])
  })

  it('never reports an entry twice or invents duplicates from unrelated failures', () => {
    expect(findDuplicateAccounts([
      candidate('qqnt', { userId: 'uid' }),
      // The same user id, but the phone claim already explains the entry.
      candidate('qqnt-2', { userId: 'uid', claimedBy: 'qqnt' }),
      // Adapter failures without an identity are not duplicates.
      candidate('offline', { platformKind: 'discord' }),
      candidate('unsupported', { platformKind: 'wechat' }),
      // A claim from an entry that is no longer registered proves nothing.
      candidate('stale', { claimedBy: 'removed-entry' }),
    ])).toEqual([
      { keep: 'qqnt', remove: ['qqnt-2'], reason: 'virtual-phone' },
    ])
  })

  it('reports nothing when every account is distinct', () => {
    expect(findDuplicateAccounts([
      candidate('qq-one', { userId: 'uid-1' }),
      candidate('qq-two', { userId: 'uid-2' }),
      candidate('offline'),
    ])).toEqual([])
  })
})
