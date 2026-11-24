import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { imageDimensions } from './image-dimensions.js'
import { findTextUrls } from './message-entities.js'
import type { IMMessage } from './platform.js'

/**
 * Telegram's link preview is normally built by the server: it scrapes the page,
 * downloads the picture and attaches a `webPage` to the message. The relay *is*
 * the server here, so nothing would ever appear. The bridge therefore builds the
 * preview itself: it fetches the first bare URL of a message, keeps the
 * OpenGraph metadata, caches the thumbnail on disk and projects the result as a
 * `manual` web page — a synthetic card, like the one a QQ ark card produces.
 *
 * Fetching never happens on the projection path. A message is published as it
 * arrived (plain blue link) and the card arrives afterwards as an edit; a page
 * that cannot be fetched only leaves the link alone.
 */

const PHOTO_FILE_REFERENCE = new TextEncoder().encode('bridge-link-preview:v1')
const PAGE_ID_SALT = 'link-preview:page'
const PHOTO_ID_SALT = 'link-preview:photo'
const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_HTML_BYTES = 512 * 1024
const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
/** A failed page is retried only after this pause. */
const FAILED_RETRY_MS = 10 * 60_000
const MAX_TITLE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 500
const MAX_ENTRY_COUNT = 2_048
const MAX_WAITERS_PER_URL = 32
/** Pages fetched at the same time: opening a busy history page must not spawn a storm. */
const MAX_CONCURRENT_FETCHES = 4
const MAX_PHOTO_BYTES_CACHED = 16 * 1024 * 1024
const MAX_PHOTO_ENTRIES = 128
const USER_AGENT = 'Mozilla/5.0 (compatible; crossgram-link-preview/1.0; +https://github.com/std-microblock/crossgram)'

export interface LinkPreviewOptions {
  enabled?: boolean
  thumbnails?: boolean
  /** Directory of the on-disk cache; an empty value keeps everything in memory. */
  cachePath?: string
  ttlSeconds?: number
  timeoutMs?: number
  maxHtmlBytes?: number
  maxImageBytes?: number
  /**
   * Skipped for loopback and private hosts. Only tests and intranet deployments
   * set it; the bridge config never does.
   */
  allowPrivateHosts?: boolean
}

/** One rendered preview: the page metadata plus its cached thumbnail. */
interface LinkPreviewEntry {
  url: string
  displayUrl: string
  siteName?: string
  title?: string
  description?: string
  image?: {
    file: string
    mimeType: string
    width: number
    height: number
    size: number
  }
  fetchedAt: number
  /** Set when the last fetch failed; kept to throttle retries. */
  failed?: boolean
}

interface PhotoEntry {
  file: string
  mimeType: string
  width: number
  height: number
  size: number
}

export interface LinkPreviewMetadata {
  title?: string
  description?: string
  siteName?: string
  displayUrl: string
  imageUrl?: string
  canonicalUrl?: string
}

interface FetchOptions {
  timeoutMs: number
  maxHtmlBytes: number
  maxImageBytes: number
  thumbnails: boolean
  cachePath: string
  allowPrivateHosts: boolean
}

/**
 * Thumbnail registry shared by every service instance, so any authorized
 * session can serve a picture another session fetched.
 */
const photoEntries = new Map<string, PhotoEntry>()
const photoBytes = new Map<string, Uint8Array>()
let cachedPhotoBytes = 0
/** Cache directory the module-level `upload.getFile` lookup reads its index from. */
let photoIndexPath: string | undefined
let photoIndexLoaded: Promise<void> | undefined

/**
 * Seeds the module registry from the cache directory so `upload.getFile` can
 * serve a thumbnail this process never projected (a client that cached the card
 * and asks for the picture again after a restart).
 */
export function loadLinkPreviewIndex(cachePath: string): Promise<void> {
  const path = join(cachePath, 'index.json')
  if (photoIndexPath !== path) {
    photoIndexPath = path
    photoIndexLoaded = undefined
  }
  photoIndexLoaded ??= (async () => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, PhotoEntry>
      for (const [key, entry] of Object.entries(parsed)) {
        if (!entry?.file) continue
        photoEntries.set(key, entry)
      }
    } catch {
      // No index yet: previews are rebuilt by the next projection.
    }
  })()
  return photoIndexLoaded
}

/** Serves a cached preview thumbnail through `upload.getFile`. */
export async function getLinkPreviewPhotoFile(
  location: tl.RawInputPhotoFileLocation,
  offset: number,
  limit: number,
): Promise<{ bytes: Uint8Array, mimeType: string } | undefined> {
  if (!sameBytes(location.fileReference, PHOTO_FILE_REFERENCE)) return
  const key = photoKey(location.id, location.accessHash)
  const cached = photoBytes.get(key)
  if (cached) {
    photoBytes.delete(key)
    photoBytes.set(key, cached)
    return {
      bytes: cached.subarray(offset, Math.min(cached.byteLength, offset + limit)),
      mimeType: photoEntries.get(key)?.mimeType ?? 'image/jpeg',
    }
  }
  const entry = photoEntries.get(key) ?? await loadPhotoEntry(key)
  if (!entry) return
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(entry.file))
  } catch {
    return
  }
  rememberPhotoBytes(key, bytes)
  return {
    bytes: bytes.subarray(offset, Math.min(bytes.byteLength, offset + limit)),
    mimeType: entry.mimeType,
  }
}

async function loadPhotoEntry(key: string): Promise<PhotoEntry | undefined> {
  if (!photoIndexPath) return
  await loadLinkPreviewIndex(photoIndexPath.replace(/index\.json$/u, ''))
  return photoEntries.get(key)
}

/**
 * Fetches, caches and renders link previews for messages.
 */
export class LinkPreviewService {
  private readonly _entries = new Map<string, LinkPreviewEntry>()
  private readonly _disk = new Map<string, LinkPreviewEntry>()
  private readonly _inflight = new Map<string, Promise<void>>()
  private readonly _waiters = new Map<string, Set<() => void>>()
  private readonly _enabled: boolean
  private readonly _thumbnails: boolean
  private readonly _cachePath: string
  private readonly _ttlMs: number
  private readonly _timeoutMs: number
  private readonly _maxHtmlBytes: number
  private readonly _maxImageBytes: number
  private readonly _allowPrivateHosts: boolean
  private _activeFetches = 0
  private readonly _fetchQueue: Array<() => void> = []
  private _ready: Promise<void> | undefined

  constructor(options: LinkPreviewOptions = {}) {
    this._enabled = options.enabled !== false
    this._thumbnails = options.thumbnails !== false
    this._cachePath = (options.cachePath ?? 'data/bridge-link-preview').trim()
    this._ttlMs = Math.max(60, options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1_000
    this._timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this._maxHtmlBytes = Math.max(4_096, options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES)
    this._maxImageBytes = Math.max(4_096, options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES)
    this._allowPrivateHosts = options.allowPrivateHosts === true
    if (this._cachePath) void this.ready().catch(() => undefined)
  }

  /** Loads the on-disk cache once; projections await it before asking for media. */
  ready(): Promise<void> {
    this._ready ??= this._loadCache()
    return this._ready
  }

  /**
   * The preview a message should be projected with.  Waits for the disk index
   * (once), answers from memory when the page is cached, and otherwise starts a
   * background fetch whose `onReady` fires when the card becomes drawable.
   */
  async previewFor(
    message: IMMessage<any>,
    dcId: number,
    onReady?: () => void,
  ): Promise<tl.TypeMessageMedia | undefined> {
    if (!this._enabled) return
    const url = messageLinkPreviewUrl(message)
    if (!url) return
    await this.ready()
    const entry = this._entries.get(url) ?? this._disk.get(url)
    if (entry && !entry.failed) {
      this._remember(entry)
      if (!this._isFresh(entry)) void this._ensure(url, onReady)
      return makeLinkPreviewMedia(entry, dcId)
    }
    if (entry?.failed && Date.now() - entry.fetchedAt < FAILED_RETRY_MS) return
    void this._ensure(url, onReady)
  }

  /** The cached preview of a message, when one is ready right now. */
  media(message: IMMessage<any>, dcId: number): tl.TypeMessageMedia | undefined {
    if (!this._enabled) return
    const url = messageLinkPreviewUrl(message)
    if (!url) return
    const entry = this._entries.get(url)
    if (!entry || entry.failed) return
    return makeLinkPreviewMedia(entry, dcId)
  }

  /** Drops the in-memory state; the disk cache is kept. Used by tests. */
  clear(): void {
    this._entries.clear()
    this._disk.clear()
    this._waiters.clear()
    this._ready = undefined
  }

  private _isFresh(entry: LinkPreviewEntry): boolean {
    return Date.now() - entry.fetchedAt < this._ttlMs
  }

  private _ensure(url: string, onReady?: () => void): Promise<void> {
    if (onReady) {
      const waiters = this._waiters.get(url) ?? new Set<() => void>()
      waiters.add(onReady)
      while (waiters.size > MAX_WAITERS_PER_URL) waiters.delete(waiters.values().next().value!)
      this._waiters.set(url, waiters)
    }
    const running = this._inflight.get(url)
    if (running) return running
    const task = this._load(url)
      .catch(() => undefined)
      .finally(() => {
        if (this._inflight.get(url) === task) this._inflight.delete(url)
      })
    this._inflight.set(url, task)
    return task
  }

  private async _load(url: string): Promise<void> {
    const known = this._entries.get(url) ?? this._disk.get(url)
    if (known && this._isFresh(known) && !known.failed) {
      this._remember(known)
      this._notify(url)
      return
    }
    try {
      const fetched = await this._withFetchSlot(() => fetchLinkPreview(new URL(url), {
        timeoutMs: this._timeoutMs,
        maxHtmlBytes: this._maxHtmlBytes,
        maxImageBytes: this._maxImageBytes,
        thumbnails: this._thumbnails,
        cachePath: this._cachePath,
        allowPrivateHosts: this._allowPrivateHosts,
      }))
      this._remember(fetched)
      await this._writeEntry(fetched)
      this._notify(url)
    } catch {
      if (known && !known.failed) {
        // The site is down, not gone: keep showing the card we already had.
        this._remember(known)
        this._notify(url)
        return
      }
      this._remember({ url, displayUrl: displayUrlOf(new URL(url)), fetchedAt: Date.now(), failed: true })
      // Nothing to publish: the message keeps its plain link until the retry.
      this._waiters.delete(url)
    }
  }

  private async _withFetchSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this._activeFetches >= MAX_CONCURRENT_FETCHES) {
      await new Promise<void>((resolve) => this._fetchQueue.push(resolve))
    }
    this._activeFetches += 1
    try {
      return await task()
    } finally {
      this._activeFetches -= 1
      this._fetchQueue.shift()?.()
    }
  }

  private _remember(entry: LinkPreviewEntry): void {
    this._entries.delete(entry.url)
    this._entries.set(entry.url, entry)
    while (this._entries.size > MAX_ENTRY_COUNT) {
      this._entries.delete(this._entries.keys().next().value!)
    }
    if (entry.image) rememberPhotoEntry(entry.url, entry.image)
  }

  private _notify(url: string): void {
    const waiters = this._waiters.get(url)
    if (!waiters) return
    this._waiters.delete(url)
    for (const waiter of waiters) {
      try {
        waiter()
      } catch {
        // One failing publisher must not swallow the rest of the announcements.
      }
    }
  }

  private async _loadCache(): Promise<void> {
    if (!this._cachePath) return
    this._disk.clear()
    try {
      await mkdir(this._cachePath, { recursive: true })
      for (const name of await readdir(this._cachePath)) {
        if (!name.endsWith('.json') || name === 'index.json') continue
        const file = join(this._cachePath, name)
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8')) as LinkPreviewEntry
          if (typeof parsed?.url !== 'string' || !parsed.fetchedAt) continue
          this._disk.set(parsed.url, parsed)
        } catch {
          // A write torn by a killed process: drop it and refetch later.
          await rm(file, { force: true }).catch(() => undefined)
        }
      }
    } catch {
      // No cache directory yet; the first write creates it.
      return
    }
    await this._sweep()
    await loadLinkPreviewIndex(this._cachePath).catch(() => undefined)
    try {
      const index = JSON.parse(await readFile(join(this._cachePath, 'index.json'), 'utf8')) as Record<string, PhotoEntry>
      for (const [key, entry] of Object.entries(index)) {
        if (!entry?.file) continue
        photoEntries.set(key, entry)
      }
    } catch {
      // Same as above: the index is only an optimisation for restarts.
    }
  }

  /** Deletes cache files that fell out of the TTL well before this process started. */
  private async _sweep(): Promise<void> {
    const deadline = Date.now() - this._ttlMs * 2
    let checked = 0
    for (const [url, entry] of [...this._disk]) {
      if (checked++ > 512) break
      if (entry.fetchedAt >= deadline) continue
      this._disk.delete(url)
      await rm(join(this._cachePath, `${entryKey(url)}.json`), { force: true }).catch(() => undefined)
      if (entry.image) await rm(entry.image.file, { force: true }).catch(() => undefined)
    }
  }

  private async _writeEntry(entry: LinkPreviewEntry): Promise<void> {
    if (!this._cachePath) return
    try {
      await mkdir(this._cachePath, { recursive: true })
      await writeFile(join(this._cachePath, `${entryKey(entry.url)}.json`), JSON.stringify(entry), 'utf8')
      this._disk.set(entry.url, entry)
      while (this._disk.size > MAX_ENTRY_COUNT) this._disk.delete(this._disk.keys().next().value!)
      await this._writeIndex()
    } catch {
      // A read-only or missing cache directory only costs a refetch.
    }
  }

  private async _writeIndex(): Promise<void> {
    if (!this._cachePath) return
    const index: Record<string, PhotoEntry> = {}
    for (const entry of this._disk.values()) {
      if (!entry.image) continue
      index[photoKeyOfUrl(entry.url)] = entry.image
    }
    try {
      await writeFile(join(this._cachePath, 'index.json'), JSON.stringify(index), 'utf8')
    } catch {
      // Same as above.
    }
  }
}

/**
 * The URL a message should preview: the first bare `http(s)` link of its text.
 * Cards, stickers and media parts carry their own Telegram media, and a card
 * relayed from QQ (an ark share) already is a preview.
 */
export function messageLinkPreviewUrl(message: IMMessage<any>): string | undefined {
  if (message.content.parts.some((part) => part.type === 'card'
    || part.type === 'sticker' || part.type === 'media')) return
  for (const part of message.content.parts) {
    if (part.type !== 'text') continue
    for (const candidate of findTextUrls(part.text)) {
      const normalized = normalizePreviewUrl(candidate)
      if (normalized) return normalized
    }
  }
}

/**
 * Stable event id of the "preview is ready" republication, so two sessions that
 * projected the same message collapse into one delivered edit.
 */
export function linkPreviewEditEventId(conversationId: string, messageId: string): string {
  return `link-preview:${encodeURIComponent(conversationId)}:${encodeURIComponent(messageId)}`
}

function normalizePreviewUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (!url.hostname) return
    url.hash = ''
    return url.href
  } catch {
    return
  }
}

/**
 * Renders a cached preview into Telegram's media object. A page with neither a
 * title nor a picture is not worth a card over the plain link.
 */
export function makeLinkPreviewMedia(
  entry: LinkPreviewEntry,
  dcId: number,
): tl.RawMessageMediaWebPage | undefined {
  if (!entry.title && !entry.description && !entry.image) return
  const photo = entry.image ? makeLinkPreviewPhoto(entry, dcId) : undefined
  return {
    _: 'messageMediaWebPage', manual: true, safe: true,
    webpage: {
      _: 'webPage',
      id: Long.fromString(stableLongHex(sha256Hex(`${PAGE_ID_SALT}\u0000${entry.url}`, 15))),
      url: entry.url,
      displayUrl: entry.displayUrl,
      hash: 0,
      type: 'article',
      ...(entry.siteName ? { siteName: entry.siteName } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(photo ? { photo } : {}),
    },
  }
}

function makeLinkPreviewPhoto(entry: LinkPreviewEntry, dcId: number): tl.TypePhoto | undefined {
  if (!entry.image) return
  const [id, accessHash] = photoIds(entry.url)
  rememberPhotoEntry(entry.url, entry.image)
  return {
    _: 'photo',
    id,
    accessHash,
    fileReference: PHOTO_FILE_REFERENCE,
    date: Math.floor(entry.fetchedAt / 1_000),
    sizes: [{ _: 'photoSize', type: 'x', w: entry.image.width, h: entry.image.height, size: entry.image.size }],
    dcId,
  }
}

async function fetchLinkPreview(url: URL, options: FetchOptions): Promise<LinkPreviewEntry> {
  const { html, finalUrl } = await fetchHtml(url, options)
  const metadata = parsePreviewMetadata(html, finalUrl)
  const previewUrl = safeUrl(metadata.canonicalUrl) ?? finalUrl
  const entry: LinkPreviewEntry = {
    url: url.href,
    displayUrl: displayUrlOf(previewUrl),
    fetchedAt: Date.now(),
    ...(metadata.siteName ? { siteName: metadata.siteName } : {}),
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
  }
  if (!options.thumbnails || !metadata.imageUrl) return entry
  const image = await fetchThumbnail(metadata.imageUrl, previewUrl, options).catch(() => undefined)
  if (!image) return entry
  const stored = await storeThumbnail(image, url.href, options.cachePath)
  if (stored) entry.image = stored
  return entry
}

async function fetchHtml(initial: URL, options: FetchOptions): Promise<{ html: string, finalUrl: URL }> {
  let current = initial
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current, options.allowPrivateHosts)
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': USER_AGENT,
      },
    })
    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new Error('link preview redirect without a location')
      if (hop === MAX_REDIRECTS) throw new Error('link preview redirected too many times')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`link preview request failed with HTTP ${response.status}`)
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('link preview response is not an HTML document')
    }
    return { html: new TextDecoder('utf-8').decode(await readCappedBody(response, options.maxHtmlBytes)), finalUrl: current }
  }
  throw new Error('link preview redirect loop')
}

async function fetchThumbnail(
  rawUrl: string,
  base: URL,
  options: FetchOptions,
): Promise<{ bytes: Uint8Array, mimeType: string, width: number, height: number } | undefined> {
  let current: URL
  try {
    current = new URL(rawUrl, base)
  } catch {
    return
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current, options.allowPrivateHosts)
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { accept: 'image/*', 'user-agent': USER_AGENT },
    })
    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) return
      current = new URL(location, current)
      continue
    }
    if (!response.ok) return
    const mimeType = normalizeImageMimeType(response.headers.get('content-type'))
    if (!mimeType) return
    const bytes = await readCappedBody(response, options.maxImageBytes)
    const dimensions = imageDimensions(bytes)
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return
    return { bytes, mimeType, width: dimensions.width, height: dimensions.height }
  }
}

async function storeThumbnail(
  image: { bytes: Uint8Array, mimeType: string, width: number, height: number },
  url: string,
  cachePath: string,
): Promise<LinkPreviewEntry['image'] | undefined> {
  if (!cachePath) return
  const file = join(cachePath, `${entryKey(url)}${extensionOf(image.mimeType)}`)
  try {
    await mkdir(cachePath, { recursive: true })
    await writeFile(file, image.bytes)
  } catch {
    return
  }
  return { file, mimeType: image.mimeType, width: image.width, height: image.height, size: image.bytes.byteLength }
}

/**
 * Rejects anything that is not a public HTTP(S) destination: file handlers,
 * loopback, RFC1918, CGNAT, link-local and private IPv6 are off limits. Host
 * names are resolved first, so a DNS record cannot smuggle a private address in
 * (a name that resolves between the check and the request is still possible;
 * `fetch` has no API to pin the resolved address).
 */
export async function assertPublicUrl(url: URL, allowPrivateHosts = false): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('link preview requires an HTTP(S) URL')
  }
  if (allowPrivateHosts) return
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '')
  if (!hostname) throw new Error('link preview URL has no host')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) {
    throw new Error('link preview refuses a private host')
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('link preview refuses a private address')
    return
  }
  const records = await lookup(hostname, { all: true, verbatim: true }).catch(() => [])
  if (!records.length) throw new Error('link preview host does not resolve')
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('link preview host resolves to a private address')
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/gu, '')
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(value)
  if (mapped) return isPrivateIPv4(mapped[1]!)
  if (isIP(value) === 4) return isPrivateIPv4(value)
  if (isIP(value) === 6) return isPrivateIPv6(value)
  return true
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [first, second] = octets as [number, number, number, number]
  return first === 0 || first === 10 || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase()
  const embedded = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/u.exec(value)
  if (embedded) return isPrivateIPv4(embedded[1]!)
  const groups = expandIPv6(value)
  if (!groups) return true
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups as [
    number, number, number, number, number, number, number, number,
  ]
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && eighth === 1) return true
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96) forms.
  if (groups.slice(0, 5).every((group) => group === 0)
    && (sixth === 0xffff || (sixth === 0 && seventh === 0))) {
    return isPrivateIPv4(`${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`)
  }
  void second
  void third
  void fourth
  void fifth
  return false
}

/** Expands a (possibly abbreviated) IPv6 address into its eight 16-bit groups. */
function expandIPv6(value: string): number[] | undefined {
  const halves = value.split('::')
  if (halves.length > 2) return
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return
  const numbers = groups.map((group) => Number.parseInt(group, 16))
  return numbers.some((number) => !Number.isInteger(number) || number < 0 || number > 0xffff)
    ? undefined
    : numbers
}

/**
 * Reads OpenGraph, Twitter card and plain HTML fallbacks out of a page. The
 * parser is deliberately forgiving: pages in the wild nest tags, quote
 * attributes either way, and wrap the whole document in comments.
 */
export function parsePreviewMetadata(html: string, url: URL): LinkPreviewMetadata {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
  const metas = new Map<string, string>()
  for (const tag of cleaned.matchAll(/<meta\b[^>]*>/giu)) {
    const attributes = parseAttributes(tag[0])
    const key = (attributes.get('property') ?? attributes.get('name') ?? attributes.get('itemprop') ?? '')
      .trim().toLowerCase()
    const content = attributes.get('content')
    if (!key || !content || metas.has(key)) continue
    metas.set(key, decodeEntities(content))
  }
  const title = firstText([metas.get('og:title'), metas.get('twitter:title'), htmlTitle(cleaned)], MAX_TITLE_CHARS)
  const description = firstText([
    metas.get('og:description'), metas.get('description'), metas.get('twitter:description'),
  ], MAX_DESCRIPTION_CHARS)
  const siteName = firstText([metas.get('og:site_name'), metas.get('application-name')], MAX_TITLE_CHARS)
    ?? displayUrlOf(url)
  const imageUrl = firstText([
    metas.get('og:image:secure_url'), metas.get('og:image'), metas.get('og:image:url'),
    metas.get('twitter:image'), metas.get('twitter:image:src'),
  ], 2_048)
  const canonicalUrl = canonicalLink(cleaned)
  const resolved = safeUrl(canonicalUrl, url)
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(imageUrl ? { imageUrl: resolveHttpUrl(imageUrl, url) } : {}),
    ...(resolved ? { canonicalUrl: resolved.href } : {}),
    displayUrl: displayUrlOf(resolved ?? url),
  }
}

function htmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  return match ? decodeEntities(match[1]!) : undefined
}

function canonicalLink(html: string): string | undefined {
  for (const tag of html.matchAll(/<link\b[^>]*>/giu)) {
    const attributes = parseAttributes(tag[0])
    if (attributes.get('rel')?.toLowerCase() !== 'canonical') continue
    const href = attributes.get('href')
    if (href) return decodeEntities(href)
  }
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu)) {
    const name = match[1]!.toLowerCase()
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attributes
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/gu, (whole, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return ' '
      default: break
    }
    const code = entity.startsWith('#x') || entity.startsWith('#X')
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith('#') ? Number.parseInt(entity.slice(1), 10) : Number.NaN
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

function firstText(candidates: Array<string | undefined>, limit: number): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = candidate.replace(/[\s\u00a0]+/gu, ' ').trim()
    if (!normalized) continue
    return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized
  }
}

function resolveHttpUrl(value: string, base: URL): string | undefined {
  return safeUrl(value, base)?.href
}

function safeUrl(value: string | undefined, base?: URL): URL | undefined {
  if (!value) return
  try {
    const resolved = base ? new URL(value, base) : new URL(value)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return
    return resolved
  } catch {
    return
  }
}

/** What a client draws on the card's second line: `host/path`, never a query. */
export function displayUrlOf(url: URL): string {
  const host = url.hostname.replace(/^www\./u, '')
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '')
  const display = `${host}${path}`
  return display.length > 120 ? display.slice(0, 120) : display
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function normalizeImageMimeType(header: string | null): string | undefined {
  const value = header?.split(';', 1)[0]?.trim().toLowerCase()
  if (value === 'image/jpeg' || value === 'image/png' || value === 'image/webp' || value === 'image/gif') return value
}

async function readCappedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('link preview body exceeds the size limit')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error('link preview body exceeds the size limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let cursor = 0
  for (const chunk of chunks) {
    bytes.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  return bytes
}

function rememberPhotoEntry(url: string, image: PhotoEntry): void {
  const key = photoKeyOfUrl(url)
  photoEntries.delete(key)
  photoEntries.set(key, { ...image })
  while (photoEntries.size > MAX_PHOTO_ENTRIES) photoEntries.delete(photoEntries.keys().next().value!)
}

function rememberPhotoBytes(key: string, bytes: Uint8Array): void {
  const previous = photoBytes.get(key)
  if (previous) {
    cachedPhotoBytes -= previous.byteLength
    photoBytes.delete(key)
  }
  photoBytes.set(key, bytes)
  cachedPhotoBytes += bytes.byteLength
  while (cachedPhotoBytes > MAX_PHOTO_BYTES_CACHED || photoBytes.size > MAX_PHOTO_ENTRIES) {
    const oldest = photoBytes.keys().next().value
    if (oldest === undefined) break
    cachedPhotoBytes -= photoBytes.get(oldest)!.byteLength
    photoBytes.delete(oldest)
  }
}

function photoKeyOfUrl(url: string): string {
  const [id, accessHash] = photoIds(url)
  return photoKey(id, accessHash)
}

function photoKey(id: Long, accessHash: Long): string {
  return `${id}:${accessHash}`
}

function photoIds(url: string): [Long, Long] {
  const digest = sha256Hex(`${PHOTO_ID_SALT}\u0000${url}`, 30)
  return [Long.fromString(stableLongHex(digest.slice(0, 15))), Long.fromString(stableLongHex(digest.slice(15, 30)))]
}

function entryKey(url: string): string {
  return sha256Hex(url, 32)
}

function sha256Hex(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function stableLongHex(hex: string): string {
  return (BigInt(`0x${hex}`) % 0x7fffffffffffffffn).toString()
}

function extensionOf(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png'
    case 'image/gif': return '.gif'
    case 'image/webp': return '.webp'
    default: return '.jpg'
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
