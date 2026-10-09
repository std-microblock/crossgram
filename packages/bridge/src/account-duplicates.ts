import type { PlatformAccountDuplicateGroup } from './dashboard-types.js'

/** One registered platform entry, reduced to the durable facts duplicate detection needs. */
export interface PlatformAccountDuplicateCandidate {
  platformId: string
  platformKind: string
  /** Platform-owned user id, present once the adapter provisioned successfully. */
  userId?: string
  /**
   * Platform entry that already owns this entry's virtual phone. Only set when
   * provisioning failed on the deterministic phone invariant, which proves the
   * entry describes an account another entry is already serving.
   */
  claimedBy?: string
  /** Telegram clients signed in through the entry. */
  clientAuthorizations: number
}

/**
 * Group platform entries that describe the same platform account.
 *
 * Two entries are duplicates when either
 * - their adapters resolved to the same platform user (`platformKind` plus `userId`), or
 * - one of them could not be provisioned because another entry already owns its
 *   virtual phone, which is only possible for a platform identity that is already served.
 *
 * Entries that failed for any other reason (adapter offline, provider unsupported)
 * carry no identity at all, so they are never reported as duplicates.
 *
 * The kept entry is the one clients are already signed in through, with the stable
 * entry id order as the tie-breaker.
 */
export function findDuplicateAccounts(
  candidates: readonly PlatformAccountDuplicateCandidate[],
): PlatformAccountDuplicateGroup[] {
  const known = new Set(candidates.map((candidate) => candidate.platformId))
  const groups = new Map<string, PlatformAccountDuplicateGroup>()
  const claimed = new Set<string>()
  const groupFor = (keep: string, reason: PlatformAccountDuplicateGroup['reason']) => {
    const existing = groups.get(keep)
    if (existing) return existing
    const group: PlatformAccountDuplicateGroup = { keep, remove: [], reason }
    groups.set(keep, group)
    return group
  }
  // Claimed entries come first so a failed duplicate is never also reported as an
  // identity duplicate of the entry whose phone it failed to claim.
  for (const candidate of candidates) {
    if (!candidate.claimedBy || !known.has(candidate.claimedBy)) continue
    groupFor(candidate.claimedBy, 'virtual-phone').remove.push(candidate.platformId)
    claimed.add(candidate.platformId)
  }
  const byIdentity = new Map<string, PlatformAccountDuplicateCandidate[]>()
  for (const candidate of candidates) {
    if (claimed.has(candidate.platformId) || !candidate.userId) continue
    const key = `${candidate.platformKind}\0${candidate.userId}`
    const members = byIdentity.get(key)
    if (members) members.push(candidate)
    else byIdentity.set(key, [candidate])
  }
  for (const members of byIdentity.values()) {
    if (members.length < 2) continue
    const [keep, ...remove] = [...members].sort(compareDuplicateMembers)
    const group = groupFor(keep!.platformId, 'identity')
    for (const member of remove) {
      if (!group.remove.includes(member.platformId)) group.remove.push(member.platformId)
    }
  }
  return [...groups.values()]
    .filter((group) => group.remove.length > 0)
    .sort((left, right) => left.keep.localeCompare(right.keep))
}

function compareDuplicateMembers(
  left: PlatformAccountDuplicateCandidate,
  right: PlatformAccountDuplicateCandidate,
): number {
  return (
    right.clientAuthorizations - left.clientAuthorizations ||
    left.platformId.localeCompare(right.platformId)
  )
}
