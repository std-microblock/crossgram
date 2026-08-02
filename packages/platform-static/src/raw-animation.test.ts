import { describe, expect, it } from 'vitest'
import type { IMStickerAsset, PlatformSession, StickerProviderContext } from '@mtproto-relay/bridge'
import { StaticPlatform, StaticStickerProvider } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'raw-animation-session',
  platformId: 'static',
  userId: 'self',
  credentials: {},
  metadata: { firstName: 'Static User', username: 'static_user' },
}

const context = { session } as StickerProviderContext

async function readAsset(asset: IMStickerAsset): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of asset.source.stream()) chunks.push(chunk)
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

describe('StaticPlatform raw animated sticker fixtures', () => {
  it('seeds GIF/APNG messages with packed and saved sticker identity', async () => {
    const platform = new StaticPlatform({ instanceId: 'raw-animation', historySize: 0 })
    expect(platform.capabilities.stickers?.formats).toContain('animated')

    const history = await platform.getHistory(
      session,
      { id: 'reaction-sticker-lab' },
      { limit: 100 },
    )
    const stickers = history.messages.flatMap((message) => message.content.parts)
      .filter((part) => part.type === 'sticker')
      .map((part) => part.sticker)

    expect(stickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stickerId: 'plugin-gif', packId: 'plugin-pack',
        format: 'animated', mimeType: 'image/gif',
      }),
      expect.objectContaining({
        stickerId: 'plugin-apng', packId: 'plugin-pack',
        format: 'animated', mimeType: 'image/apng',
      }),
      expect.objectContaining({
        stickerId: 'loose-saved', packId: undefined,
        format: 'animated', mimeType: 'image/apng',
      }),
    ]))
  })

  it('serves real GIF/APNG bytes from the pack and saved-sticker APIs', async () => {
    const provider = new StaticStickerProvider('static:plugin', false, 'static')
    const pack = await provider.getPack(context, 'plugin-pack')
    const saved = await provider.listSavedStickers(context)
    const gif = pack!.stickers.find((sticker) => sticker.stickerId === 'plugin-gif')!
    const apng = pack!.stickers.find((sticker) => sticker.stickerId === 'plugin-apng')!
    const savedApng = saved.stickers.find((sticker) => sticker.stickerId === 'loose-saved')!

    expect(pack).toMatchObject({ title: 'Static Plugin Stickers' })
    expect(gif).toMatchObject({ packId: 'plugin-pack', format: 'animated', mimeType: 'image/gif' })
    expect(apng).toMatchObject({ packId: 'plugin-pack', format: 'animated', mimeType: 'image/apng' })
    expect(savedApng).toMatchObject({ packId: undefined, format: 'animated', mimeType: 'image/apng' })

    const gifBytes = await readAsset(await provider.openAsset(context, gif))
    const apngBytes = await readAsset(await provider.openAsset(context, apng))
    const savedBytes = await readAsset(await provider.openAsset(context, savedApng))
    expect(new TextDecoder().decode(gifBytes.slice(0, 6))).toBe('GIF89a')
    expect([...apngBytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(new TextDecoder().decode(apngBytes)).toContain('acTL')
    expect(savedBytes).toEqual(apngBytes)
  })
})
