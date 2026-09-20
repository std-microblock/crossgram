import jsQR from 'jsqr'
// The expensive pixel scan runs outside the UI thread. At most ~10 MiB of RGBA is allocated.
self.onmessage = (event: MessageEvent<ImageBitmap>) => {
  const bitmap = event.data
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale)),
      height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Image decoding is not available')
    context.drawImage(bitmap, 0, 0, width, height)
    const code = jsQR(
      context.getImageData(0, 0, width, height).data,
      width,
      height,
    )
    self.postMessage({ value: code?.data })
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    bitmap.close()
  }
}
