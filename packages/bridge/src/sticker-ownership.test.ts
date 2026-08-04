import { describe, expect, it } from 'vitest'
import { isAutomaticallyAssociated, providerBelongsToAccount } from './sticker-ownership.js'
import type { IMStickerProvider } from './sticker-provider.js'

describe('sticker ownership', () => {
  const provider: IMStickerProvider = {
    capabilities: { platformKinds: ['qq'], ownerPlatformId: 'qq/primary', sessionScoped: true },
    async listPacks() { return { packs: [] } },
    async getPack() { return null },
    async getSticker() { return null },
    async openAsset() { throw new Error('not used') },
  }

  it('keeps account-owned packs visible without a separate bridge assignment', () => {
    expect(isAutomaticallyAssociated(provider, {
      providerId: 'ignored', packId: 'market-1', title: 'QQ 商店表情', automaticAssociation: 'provider-account',
    }, 'qq/primary')).toBe(true)
    expect(isAutomaticallyAssociated(provider, {
      providerId: 'ignored', packId: 'market-1', title: 'QQ 商店表情', automaticAssociation: 'provider-account',
    }, 'qq/secondary')).toBe(false)
  })

  it('does not treat a same-kind foreign provider as native to the account', () => {
    expect(providerBelongsToAccount(provider, 'qq/primary', 'qq')).toBe(true)
    expect(providerBelongsToAccount(provider, 'qq/secondary', 'qq')).toBe(false)
  })
})
