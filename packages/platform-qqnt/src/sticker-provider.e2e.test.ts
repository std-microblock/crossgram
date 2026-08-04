import { describe, expect, it, vi } from 'vitest'
import type { IMMediaSource, PlatformSession, StickerProviderContext } from '@mtproto-relay/bridge'
import type { QQStickerReference, WireSticker } from './protocol.js'
import { QQStickerProvider } from './sticker-provider.js'

const context: StickerProviderContext = {
  platformKind: 'qq',
  session: {
    platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
  } satisfies PlatformSession,
}

describe('QQStickerProvider raw saved-sticker pipeline', () => {
  it('keeps a QQ favorite as a native send plan without downloading its asset', async () => {
    const client = {
      getSavedStickers: vi.fn(async () => ({ stickers: [favorite('remote')] })),
      stickerSource: vi.fn(),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')

    const { stickers } = await provider.listSavedStickers(context)
    const plan = await provider.prepareSend(context, stickers[0]!)

    expect(plan).toEqual({
      type: 'native', providerId: 'qq:stickers', stickerId: 'favorite:remote', packId: 'qq-favorites',
      reference: {
        kind: 'favorite', resId: 'remote', path: '/saved/remote.png', name: 'remote.png', animated: false,
      },
    })
    expect(client.stickerSource).not.toHaveBeenCalled()
  })

  it('lists every native sticker without decoding bytes and streams the selected original on demand', async () => {
    const assets = new Map([
      ['bad', Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0xff])],
      ['good', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
    ])
    let opens = 0
    const client = {
      getSavedStickers: vi.fn(async () => ({ stickers: [favorite('bad'), favorite('good')] })),
      stickerSource: vi.fn((reference: QQStickerReference) => source(assets.get(
        reference.kind === 'favorite' ? reference.resId : reference.stickerId,
      )!, () => opens++)),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')

    const result = await provider.listSavedStickers(context)

    expect(result.stickers).toMatchObject([
      { stickerId: 'favorite:bad', format: 'static', mimeType: 'image/png' },
      { stickerId: 'favorite:good', format: 'static', mimeType: 'image/png' },
    ])
    expect(client.stickerSource).not.toHaveBeenCalled()
    const asset = await provider.openAsset(context, result.stickers[1]!)
    expect(await collect(asset.source.stream())).toEqual(Buffer.from(assets.get('good')!))
    expect(opens).toBe(1)
  })

  it('keeps a complete pack metadata-only even when one native path will be stale at download time', async () => {
    const client = {
      getStickerPack: vi.fn(async () => ({
        packId: 'qq-favorites', title: 'QQ 收藏表情', count: 2, version: 9,
        stickers: [favorite('stale'), favorite('good')],
      })),
      stickerSource: vi.fn(() => source(Uint8Array.from([1, 2, 3]), () => undefined)),
    }
    const provider = new QQStickerProvider(client as never, 'qq:stickers')

    await expect(provider.getPack(context, 'qq-favorites')).resolves.toMatchObject({
      packId: 'qq-favorites', count: 2,
      cover: { stickerId: 'favorite:stale' },
      stickers: [
        { stickerId: 'favorite:stale', mimeType: 'image/png' },
        { stickerId: 'favorite:good', mimeType: 'image/png' },
      ],
    })
    expect(client.stickerSource).not.toHaveBeenCalled()
  })
})

function favorite(id: string): WireSticker {
  return {
    stickerId: `favorite:${id}`, packId: 'qq-favorites', title: id,
    format: 'static', mimeType: 'image/png', width: 16, height: 12,
    reference: {
      kind: 'favorite', resId: id, path: `/saved/${id}.png`, name: `${id}.png`, animated: false,
    },
  }
}

function source(bytes: Uint8Array, opened: () => void): IMMediaSource {
  return { size: bytes.length, async *stream() { opened(); yield bytes } }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
