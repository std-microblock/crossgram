import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeQrImage } from './qr.js'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('bounded QR decoding lifecycle', () => {
  it('rejects non-images and oversized files before attempting to decode', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    await expect(
      decodeQrImage(
        new File(['text'], 'a.txt', { type: 'text/plain' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('image')
    await expect(
      decodeQrImage(
        new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'a.png', {
          type: 'image/png',
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('8 MiB')
    expect(decode).not.toHaveBeenCalled()
  })
  it('releases rejected bitmaps and aborts before scanning', async () => {
    const bitmap = { width: 5000, height: 20, close: vi.fn() }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    )
    await expect(
      decodeQrImage(
        new File(['image'], 'a.png', { type: 'image/png' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('4096')
    expect(bitmap.close).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(
      decodeQrImage(
        new File(['image'], 'a.png', { type: 'image/png' }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('terminates workers and releases images on cancellation', async () => {
    const bitmap = { width: 200, height: 200, close: vi.fn() },
      terminated = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    )
    vi.stubGlobal('OffscreenCanvas', class {})
    vi.stubGlobal(
      'Worker',
      class {
        postMessage() {}
        terminate = terminated
        onmessage = null
        onerror = null
      },
    )
    const controller = new AbortController(),
      result = decodeQrImage(
        new File(['image'], 'a.png', { type: 'image/png' }),
        controller.signal,
      ).catch((error) => error)
    await Promise.resolve()
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(terminated).toHaveBeenCalledOnce()
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
