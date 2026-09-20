export async function decodeQrImage(
  file: File,
  signal: AbortSignal,
): Promise<string> {
  if (!file.type.startsWith('image/'))
    throw new Error('Choose an image containing a Telegram login QR code')
  if (file.size > 8 * 1024 * 1024)
    throw new Error('QR images must be smaller than 8 MiB')
  signal.throwIfAborted()
  const bitmap = await createImageBitmap(file)
  try {
    signal.throwIfAborted()
    if (
      bitmap.width > 4096 ||
      bitmap.height > 4096 ||
      bitmap.width * bitmap.height > 16_000_000
    )
      throw new Error(
        'QR images must not exceed 4096 × 4096 or 16 million pixels',
      )
    let value: string | undefined
    if (
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined'
    ) {
      value = await new Promise<string | undefined>((resolve, reject) => {
        const worker = new Worker(new URL('./qr-worker.ts', import.meta.url), {
          type: 'module',
        })
        const finish = (error?: Error, value?: string) => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', aborted)
          worker.terminate()
          error ? reject(error) : resolve(value)
        }
        const aborted = () =>
          finish(new DOMException('QR scan cancelled', 'AbortError'))
        const timeout = setTimeout(
          () => finish(new Error('QR scanning timed out')),
          10_000,
        )
        signal.addEventListener('abort', aborted, { once: true })
        worker.onmessage = (event) =>
          finish(
            event.data.error ? new Error(event.data.error) : undefined,
            event.data.value,
          )
        worker.onerror = () =>
          finish(new Error('The QR scanner could not start'))
        try {
          worker.postMessage(bitmap, [bitmap])
        } catch (error) {
          finish(error as Error)
        }
      })
    } else {
      const { default: jsQR } = await import('jsqr')
      signal.throwIfAborted()
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)),
        canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Image decoding is not available')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      value = jsQR(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width,
        canvas.height,
      )?.data
    }
    signal.throwIfAborted()
    if (!value) throw new Error('No QR code was found in this image')
    return value
  } finally {
    bitmap.close()
  }
}
