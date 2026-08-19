import { describe, expect, it, vi } from 'vitest'
import { HostedTelegramBotApi, importShortName, mapStickerSet, parseStickerSetUrl } from './api.js'

describe('Telegram sticker URL parser', () => {
  it('accepts official URLs, query strings, decoded legacy names, and /import', () => {
    expect(parseStickerSetUrl('https://t.me/addstickers/Animals')).toBe('Animals')
    expect(parseStickerSetUrl('https://telegram.me/addstickers/Old-Pack_2001?start=app')).toBe('Old-Pack_2001')
    expect(parseStickerSetUrl('https://t.me/addstickers/legacy%2Dname')).toBe('legacy-name')
    expect(importShortName('/import https://t.me/addstickers/Old-Pack_2001')).toBe('Old-Pack_2001')
  })

  it('rejects non-official hosts and paths that are not exactly one sticker set', () => {
    expect(parseStickerSetUrl('https://example.test/addstickers/pack')).toBeUndefined()
    expect(parseStickerSetUrl('http://t.me/addstickers/pack')).toBeUndefined()
    expect(parseStickerSetUrl('https://t.me/addstickers/pack/extra')).toBeUndefined()
    expect(parseStickerSetUrl('https://t.me/addstickers/%2F')).toBeUndefined()
    expect(parseStickerSetUrl('https://t.me/addstickers/%E0%A4%A')).toBeUndefined()
  })
})

describe('Hosted Telegram Bot API mapping', () => {
  it('maps a mixed static, TGS, and WebM set using unique IDs only as stable IDs', () => {
    const set = mapStickerSet({
      name: 'mixed', title: 'Mixed set', stickers: [
        { file_id: 'download-static', file_unique_id: 'stable-static', emoji: '🙂', width: 512, height: 512 },
        { file_id: 'download-tgs', file_unique_id: 'stable-tgs', is_animated: true },
        { file_id: 'download-webm', file_unique_id: 'stable-webm', is_video: true, thumbnail: {
          file_id: 'thumb-download', file_unique_id: 'thumb-stable', file_size: 12, width: 100, height: 100,
        } },
      ],
    })

    expect(set.stickers).toMatchObject([
      { stickerId: '["mixed","stable-static"]', fileId: 'download-static', format: 'static', mimeType: 'image/webp', emoji: ['🙂'] },
      { stickerId: '["mixed","stable-tgs"]', fileId: 'download-tgs', format: 'animated', mimeType: 'application/x-tgsticker' },
      { stickerId: '["mixed","stable-webm"]', fileId: 'download-webm', format: 'video', mimeType: 'video/webm', thumbnail: { fileId: 'thumb-download', fileUniqueId: 'thumb-stable' } },
    ])
  })

  it('scopes identical unique IDs to their pack and hashes every client-visible field', () => {
    const base = {
      name: 'first-pack', title: 'First title', stickers: [{
        file_id: 'download', file_unique_id: 'shared-id', emoji: '🙂', file_size: 1, width: 2, height: 3,
        thumbnail: { file_id: 'thumb', file_unique_id: 'thumb-id', file_size: 4, width: 5, height: 6 },
      }],
    }
    const otherPack = mapStickerSet({ ...base, name: 'second-pack' })
    const mapped = mapStickerSet(base)

    expect(mapped.stickers[0]!.stickerId).not.toBe(otherPack.stickers[0]!.stickerId)
    expect(mapped.version).not.toBe(mapStickerSet({ ...base, title: 'Changed title' }).version)
    expect(mapped.version).not.toBe(mapStickerSet({ ...base, stickers: [{ ...base.stickers[0]!, emoji: '😎' }] }).version)
    expect(mapped.version).not.toBe(mapStickerSet({ ...base, stickers: [{
      ...base.stickers[0]!, thumbnail: { ...base.stickers[0]!.thumbnail!, file_id: 'new-thumb' },
    }] }).version)
  })

  it('sends an exact HTTP Range header for hosted file downloads', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {
        file_id: 'download', file_unique_id: 'stable', file_path: 'stickers/file.webp',
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.of(1), { status: 206 }))
    const api = new HostedTelegramBotApi('token', 'https://bot.test', request as typeof fetch)

    await api.download('download', { offset: 5, limit: 7 })

    expect(request).toHaveBeenLastCalledWith('https://bot.test/file/bottoken/stickers/file.webp', {
      headers: { range: 'bytes=5-11' }, signal: undefined,
    })
  })

  it('does not expose the bot token in API errors', async () => {
    const token = '123:super-secret-token'
    const api = new HostedTelegramBotApi(token, 'https://bot.test', vi.fn(async () => new Response(JSON.stringify({
      ok: false, description: `bad ${token}`,
    }), { status: 400 })) as unknown as typeof fetch)

    await expect(api.getStickerSet('missing')).rejects.not.toThrow(token)
  })
})
