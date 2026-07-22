import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Long from 'long'
import { TelegramResourceService } from './resource-provider.js'

describe('TelegramResourceService', () => {
  it('uses registered providers in order and unregisters with the context effect', async () => {
    const ctx = new Context()
    const resources = new TelegramResourceService(ctx)
    const dispose = resources.register({
      getAvailableReactions: () => ({
        _: 'messages.availableReactions',
        hash: 1,
        reactions: [],
      }),
      getFile: (id) => id.equals(Long.ONE)
        ? { bytes: Uint8Array.of(1, 2, 3), mimeType: 'application/test' }
        : undefined,
    }, 'test')

    expect((await resources.availableReactions()).hash).toBe(1)
    expect(await resources.getFile(Long.ONE)).toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: 'application/test',
    })

    dispose()
    expect((await resources.availableReactions()).reactions).toEqual([])
  })
})
