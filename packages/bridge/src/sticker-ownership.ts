import type { IMStickerPackSummary, IMStickerProvider } from './sticker-provider.js'

/** Whether a pack is intrinsic to the active platform account. */
export function isAutomaticallyAssociated(
  provider: IMStickerProvider,
  pack: IMStickerPackSummary,
  targetPlatformId: string,
): boolean {
  return pack.automaticAssociation === 'provider-account'
    && provider.capabilities?.ownerPlatformId === targetPlatformId
}

/** Whether this provider can use the active platform account's native capabilities. */
export function providerBelongsToAccount(
  provider: IMStickerProvider,
  targetPlatformId: string,
  targetPlatformKind: string,
): boolean {
  const owner = provider.capabilities?.ownerPlatformId
  if (owner) return owner === targetPlatformId
  const kinds = provider.capabilities?.platformKinds
  return !kinds?.length || kinds.includes(targetPlatformKind)
}
