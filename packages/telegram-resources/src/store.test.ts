import { describe, expect, it } from 'vitest'
import { TelegramResources } from './store.js'

describe('TelegramResources', () => {
  it('builds the complete reaction catalog when optional animations are absent', () => {
    const resources = new TelegramResources()
    const catalog = resources.availableReactions()
    const laugh = catalog.reactions.find((reaction) => reaction.reaction === '😂')

    expect(catalog.reactions.length).toBeGreaterThan(0)
    expect(laugh).toBeDefined()
    expect(laugh?.aroundAnimation).toBeUndefined()
    expect(laugh?.centerIcon).toBeUndefined()
  })

  it('returns the exact bytes referenced by reaction documents', () => {
    const resources = new TelegramResources()
    const [reaction] = resources.availableReactions().reactions
    expect(reaction.staticIcon._).toBe('document')
    if (reaction.staticIcon._ !== 'document') throw new Error('expected reaction document')
    const file = resources.getFile(reaction.staticIcon.id)

    expect(file?.mimeType).toBe(reaction.staticIcon.mimeType)
    expect(file?.bytes.byteLength).toBe(reaction.staticIcon.size)
    expect([...file!.bytes.subarray(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46])
  })

  it('builds effects with optional document IDs omitted', () => {
    const resources = new TelegramResources()
    const effects = resources.availableEffects()

    expect(effects.effects.length).toBeGreaterThan(0)
    expect(effects.effects.some((effect) => effect.staticIconId === undefined)).toBe(true)
    expect(effects.effects.some((effect) => effect.effectAnimationId === undefined)).toBe(true)
  })
})
