import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCardThumbnailFile, makeCardThumbnailPhoto } from './card-thumbnail.js'

afterEach(() => vi.restoreAllMocks())

describe('card thumbnail projection', () => {
  it('downloads a registered public image once and serves byte ranges from cache', async () => {
    const photo = makeCardThumbnailPhoto('https://images.example.com/card.webp', 4)
    if (photo?._ !== 'photo') throw new Error('expected photo')
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes, {
      headers: { 'content-type': 'image/webp', 'content-length': String(bytes.length) },
    }))
    const location = {
      _: 'inputPhotoFileLocation' as const, id: photo.id, accessHash: photo.accessHash,
      fileReference: photo.fileReference, thumbSize: 'x',
    }

    await expect(getCardThumbnailFile(location, 1, 3)).resolves.toEqual({
      mimeType: 'image/webp', bytes: Uint8Array.from([2, 3, 4]),
    })
    await expect(getCardThumbnailFile(location, 4, 10)).resolves.toEqual({
      mimeType: 'image/webp', bytes: Uint8Array.from([5]),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not register local URLs and rejects non-image responses', async () => {
    expect(makeCardThumbnailPhoto('http://127.0.0.1/private.png', 1)).toBeUndefined()
    expect(makeCardThumbnailPhoto('http://[::1]/private.png', 1)).toBeUndefined()
    const photo = makeCardThumbnailPhoto('https://files.example.com/not-image', 1)
    if (photo?._ !== 'photo') throw new Error('expected photo')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', {
      headers: { 'content-type': 'text/plain' },
    }))

    await expect(getCardThumbnailFile({
      _: 'inputPhotoFileLocation', id: photo.id, accessHash: photo.accessHash,
      fileReference: photo.fileReference, thumbSize: 'x',
    }, 0, 10)).rejects.toThrow('not an image')
  })

  it('projects explicit dimensions and adds a 1280px display tier for tall images', () => {
    const medium = makeCardThumbnailPhoto('https://images.example.com/tarot.png', 2, { width: 356, height: 600 })
    expect(medium?.sizes).toEqual([
      { _: 'photoSize', type: 'x', w: 356, h: 600, size: 0 },
    ])

    const tall = makeCardThumbnailPhoto('https://images.example.com/homework.png', 2, { width: 922, height: 2875 })
    expect(tall?.sizes).toEqual([
      { _: 'photoSize', type: 'y', w: 410, h: 1280, size: 0 },
      { _: 'photoSize', type: 'w', w: 922, h: 2875, size: 0 },
    ])

    const invalid = makeCardThumbnailPhoto('https://images.example.com/bad.png', 2, { width: 0, height: -5 })
    expect(invalid?.sizes).toEqual([
      { _: 'photoSize', type: 'x', w: 320, h: 180, size: 0 },
    ])
  })
})
