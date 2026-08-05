import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  StickerProviderRegistry, StickerRpc, type PlatformSession, type StickerProviderContext,
} from '@mtproto-relay/bridge'
import { defineModels } from '../../bridge/src/models.js'
import { QQStickerProvider } from './sticker-provider.js'
import type { WireSticker } from './protocol.js'

const session: PlatformSession = {
  platformSessionId: 'qq-store-sticker-contract', platformId: 'qqnt', userId: 'self',
  credentials: {}, metadata: {},
}
const context: StickerProviderContext = { session, platformKind: 'qq' }
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe('QQ store animated sticker object contract E2E', () => {
  it('keeps raw GIF/APNG MIME and projects both pack and message entries as Telegram sticker documents', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const stickers = [
      marketSticker('gif-wave', 'image/gif'),
      marketSticker('apng-wave', 'image/apng'),
    ]
    const client = {
      getStickerPacks: vi.fn(async () => ({
        packs: [{ packId: '11690', title: '股市风云', count: stickers.length, version: 9 }],
      })),
      getStickerPack: vi.fn(async () => ({
        packId: '11690', title: '股市风云', count: stickers.length, version: 9, stickers,
      })),
      getSticker: vi.fn(async (stickerId: string) =>
        stickers.find((sticker) => sticker.stickerId === stickerId) ?? null),
      stickerSource: vi.fn(() => { throw new Error('metadata projection must not open sticker bytes') }),
    }
    const provider = new QQStickerProvider(client as never, 'qqnt:stickers', undefined, undefined, 'qqnt')
    const registry = new StickerProviderRegistry()
    registry.register('qqnt:stickers', provider)
    const rpc = new StickerRpc(
      ctx.database, registry, { platformKind: 'qq' } as never, session,
    )
    await ctx.database.create('mtproto_sticker_set_install', {
      platformSessionId: session.platformSessionId, providerId: 'qqnt:stickers', providerPackId: '11690',
      installedAt: new Date('2026-08-02T00:00:00Z'), sortOrder: 0, archived: false, uninstalled: false,
    })

    const all = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    if (all._ !== 'messages.allStickers') throw new Error('expected complete sticker catalog')
    expect(all.sets).toHaveLength(1)
    const set = all.sets[0]!
    const pack = await rpc.getStickerSet({
      _: 'messages.getStickerSet',
      stickerset: { _: 'inputStickerSetID', id: set.id, accessHash: set.accessHash },
      hash: 0,
    })
    if (pack._ !== 'messages.stickerSet') throw new Error('expected complete sticker set')
    expect(pack.documents).toHaveLength(2)

    const mapped = await provider.getPack(context, '11690')
    if (!mapped) throw new Error('expected QQ store pack')
    for (const [index, sticker] of mapped.stickers.entries()) {
      const expectedMime = index === 0 ? 'image/gif' : 'image/apng'
      const packDocument = pack.documents[index]
      if (!packDocument || packDocument._ !== 'document') throw new Error('expected pack document')
      assertStickerDocument(wireRoundTrip(packDocument), expectedMime, set.id)

      const media = wireRoundTrip(rpc.makeMessageMedia(sticker))
      expect(media._).toBe('messageMediaDocument')
      expect(JSON.stringify(media)).not.toContain('messageMediaPhoto')
      if (!media.document || media.document._ !== 'document') throw new Error('expected message document')
      assertStickerDocument(media.document, expectedMime, set.id)
    }
    expect(client.stickerSource).not.toHaveBeenCalled()
  })
})

function assertStickerDocument(document: tl.RawDocument, mimeType: string, setId: Long): void {
  expect(document.mimeType).toBe(mimeType)
  expect(document.attributes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      _: 'documentAttributeSticker',
      stickerset: expect.objectContaining({ _: 'inputStickerSetID' }),
    }),
    { _: 'documentAttributeImageSize', w: 320, h: 180 },
  ]))
  expect(document.attributes).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ _: 'documentAttributeAnimated' }),
  ]))
  const attribute = document.attributes.find((item) => item._ === 'documentAttributeSticker')
  if (!attribute || attribute._ !== 'documentAttributeSticker'
    || attribute.stickerset._ !== 'inputStickerSetID') throw new Error('expected sticker set ID')
  expect(attribute.stickerset.id.equals(setId)).toBe(true)
  expect(attribute.stickerset.accessHash.equals(setId)).toBe(true)
}

function marketSticker(id: string, mimeType: 'image/gif' | 'image/apng'): WireSticker {
  return {
    stickerId: `market:11690:${id}`, packId: '11690', title: id,
    format: 'animated', mimeType, width: 320, height: 180, size: 4321, version: 9,
    reference: {
      kind: 'market', packageId: '11690', stickerId: id, name: id, key: `key-${id}`,
      width: 320, height: 180, animated: true,
      dynamicPath: `https://cdn.example.test/${id}.${mimeType === 'image/gif' ? 'gif' : 'apng'}`,
    },
  }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}
