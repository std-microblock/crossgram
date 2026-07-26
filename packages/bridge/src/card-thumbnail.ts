import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { tl } from '@mtcute/core'
import Long from 'long'

const FILE_REFERENCE = new TextEncoder().encode('bridge-card-thumbnail:v1')
const MAX_ENTRIES = 2_048
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_CACHED_BYTES = 32 * 1024 * 1024
const MAX_REDIRECTS = 3
const entries = new Map<string, ThumbnailEntry>()
let cachedBytes = 0

interface ThumbnailEntry {
  url: string
  loaded?: Promise<{ bytes: Uint8Array, mimeType: string }>
  size?: number
}

export function makeCardThumbnailPhoto(url: string | undefined, dcId: number): tl.TypePhoto | undefined {
  const normalized = publicImageUrl(url)
  if (!normalized) return
  const [id, accessHash] = thumbnailIds(normalized)
  remember(thumbnailKey(id, accessHash), { url: normalized })
  return {
    _: 'photo', id, accessHash, fileReference: FILE_REFERENCE, date: 0,
    sizes: [{ _: 'photoSize', type: 'x', w: 320, h: 180, size: 0 }],
    dcId,
  }
}

export async function getCardThumbnailFile(
  location: tl.RawInputPhotoFileLocation,
  offset: number,
  limit: number,
): Promise<{ bytes: Uint8Array, mimeType: string } | undefined> {
  if (!sameBytes(location.fileReference, FILE_REFERENCE)) return
  const key = thumbnailKey(location.id, location.accessHash)
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  entries.set(key, entry)
  entry.loaded ??= loadImage(entry.url).then((loaded) => {
    entry.size = loaded.bytes.byteLength
    cachedBytes += entry.size
    trimCache(key)
    return loaded
  }).catch((error) => {
    entry.loaded = undefined
    throw error
  })
  const loaded = await entry.loaded
  return {
    mimeType: loaded.mimeType,
    bytes: loaded.bytes.subarray(offset, Math.min(loaded.bytes.length, offset + limit)),
  }
}

export function storageFileType(mimeType: string): tl.storage.TypeFileType {
  if (mimeType === 'image/jpeg') return { _: 'storage.fileJpeg' }
  if (mimeType === 'image/png') return { _: 'storage.filePng' }
  if (mimeType === 'image/gif') return { _: 'storage.fileGif' }
  if (mimeType === 'image/webp') return { _: 'storage.fileWebp' }
  return { _: 'storage.fileUnknown' }
}

function remember(key: string, incoming: ThumbnailEntry): void {
  const existing = entries.get(key)
  if (existing?.url === incoming.url) {
    entries.delete(key)
    entries.set(key, existing)
    return
  }
  remove(key)
  entries.set(key, incoming)
  while (entries.size > MAX_ENTRIES) remove(entries.keys().next().value!)
}

function trimCache(activeKey: string): void {
  for (const key of entries.keys()) {
    if (cachedBytes <= MAX_CACHED_BYTES) break
    if (key !== activeKey) remove(key)
  }
}

function remove(key: string): void {
  const entry = entries.get(key)
  if (entry?.size) cachedBytes -= entry.size
  entries.delete(key)
}

async function loadImage(initialUrl: string): Promise<{ bytes: Uint8Array, mimeType: string }> {
  let url = initialUrl
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const normalized = publicImageUrl(url)
    if (!normalized) throw new Error('card thumbnail URL is not public HTTP(S)')
    const response = await fetch(normalized, {
      redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/*' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects === MAX_REDIRECTS) throw new Error('card thumbnail redirected too many times')
      url = new URL(location, normalized).href
      continue
    }
    if (!response.ok) throw new Error(`card thumbnail request failed with HTTP ${response.status}`)
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (!mimeType.startsWith('image/')) throw new Error('card thumbnail response is not an image')
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > MAX_IMAGE_BYTES) throw new Error('card thumbnail exceeds size limit')
    if (!response.body) return { bytes: new Uint8Array(), mimeType }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw new Error('card thumbnail exceeds size limit')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) {
      bytes.set(chunk, cursor)
      cursor += chunk.byteLength
    }
    return { bytes, mimeType }
  }
  throw new Error('card thumbnail is unavailable')
}

function publicImageUrl(value: string | undefined): string | undefined {
  if (!value || /\s/u.test(value)) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '')
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal')) return
    if (isPrivateIp(hostname)) return
    return url.href
  } catch {
    return
  }
}

function isPrivateIp(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    const octets = hostname.split('.').map(Number)
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase()
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
      || normalized.startsWith('fd') || /^fe[89ab]/u.test(normalized)
  }
  return false
}

function thumbnailIds(url: string): [Long, Long] {
  const digest = createHash('sha256').update(url).digest('hex')
  return [stableLong(digest.slice(0, 15)), stableLong(digest.slice(15, 30))]
}

function stableLong(hex: string): Long {
  return Long.fromString(BigInt(`0x${hex}`).toString())
}

function thumbnailKey(id: Long, accessHash: Long): string {
  return `${id.toString()}:${accessHash.toString()}`
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
