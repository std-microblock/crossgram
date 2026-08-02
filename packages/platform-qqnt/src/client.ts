import { createHash } from 'node:crypto'
import type { IMMediaSource, IMTransferOptions } from '@mtproto-relay/bridge'
import WebSocket, { type RawData } from 'ws'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMemberPage, WireMessage, WireMultiForwardLocator,
  WireReactionContext, WireReactionState, WireSticker, WireStickerPack, WireStickerPackSummary,
  WireTextPart,
} from './protocol.js'
import { uploadHighway, type QQMediaUploadPlan } from './highway.js'

export interface QQNTClientOptions {
  endpoint?: string
  webSocketEndpoint?: string
  token?: string
  fetch?: typeof globalThis.fetch
}

export interface QQNTSubscribeOptions {
  lastEventId?: string
  onEventId?(eventId: string): void | Promise<void>
}

export interface DirectUrl {
  url: string
  expiresAt: number
}

/** The QQNT message endpoint permanently rejected this exact send. */
export class QQNTMessageSendRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'QQNTMessageSendRejectedError'
  }
}

const MEDIA_LEASE_VERSION = 1
const MEDIA_LEASE_ID_HEX_LENGTH = 32
const MEDIA_LEASE_TOKEN_BYTES = 32

/** One short-lived, local-only capability for the QQ Bridge PCM gateway. */
export interface QQNTMediaLease {
  version: 1
  socketPath: string
  leaseId: string
  token: Uint8Array
  /** Monotonic gateway expiry; only the gateway compares it to its local clock. */
  expiry: number
}

export class QQNTClient {
  readonly endpoint: string
  readonly webSocketEndpoint: string
  private readonly token?: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly directUrls = new Map<string, DirectUrl>()
  private readonly directUrlRefreshes = new Map<string, Promise<DirectUrl>>()

  constructor(options: QQNTClientOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://127.0.0.1:18767/v1').replace(/\/+$/, '')
    this.webSocketEndpoint = options.webSocketEndpoint ?? `${this.endpoint}/events/ws`
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  status(): Promise<{ protocolVersion: number, ready: boolean, selfUin?: string, selfUid?: string }> {
    return this.json('/status')
  }

  async mediaLease(callId: string): Promise<QQNTMediaLease> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/calls/media-lease`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ callId }),
      })
      if (!response.ok) throw new Error('media lease request rejected')
      return parseMediaLease(await response.json())
    } catch {
      throw new Error('QQNT media lease request failed')
    }
  }

  getDialogs(
    query: { cursor?: string, afterId?: string, limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{
    conversations: WireConversation[]
    nextCursor?: string
    total?: number
  }> {
    return this.json(`/dialogs${queryString(query)}`, false, { signal })
  }

  getContacts(query: { cursor?: string, limit?: number } = {}): Promise<{
    users: Array<{
      id: string, numericId?: string, name: string, signature?: string, avatar?: import('./protocol.js').WireMedia
    }>
    nextCursor?: string
  }> {
    return this.json(`/contacts${queryString(query)}`)
  }

  getConversation(id: string): Promise<WireConversation> {
    return this.json(`/conversations/${encodeURIComponent(id)}`)
  }

  resolveConversation(kind: 'direct' | 'group', numericId: string): Promise<WireConversation> {
    return this.json(`/conversations/resolve?kind=${kind}&id=${encodeURIComponent(numericId)}`)
  }

  getHistory(id: string, query: {
    cursor?: string
    limit?: number
    beforeId?: string
    afterId?: string
    aroundUnreadSeq?: string
  } = {}): Promise<{ messages: WireMessage[], nextCursor?: string }> {
    return this.json(`/conversations/${encodeURIComponent(id)}/history${queryString(query)}`)
  }

  searchMessages(id: string, query: {
    q: string
    cursor?: string
    limit?: number
    fromUserId?: string
    minTimestamp?: number
    maxTimestamp?: number
    mediaKind?: 'image' | 'file'
  }): Promise<{ messages: WireMessage[], nextCursor?: string }> {
    return this.json(`/conversations/${encodeURIComponent(id)}/search${queryString(query)}`)
  }

  getMembers(id: string, query: { cursor?: string, limit?: number } = {}): Promise<WireMemberPage> {
    return this.json(`/conversations/${encodeURIComponent(id)}/members${queryString(query)}`)
  }

  getUser(id: string): Promise<{
    id: string
    numericId?: string
    name: string
    signature?: string
    avatarUrl?: string
    avatar?: import('./protocol.js').WireMedia
  } | null> {
    return this.json(`/users/${encodeURIComponent(id)}`, true)
  }

  getStickerPacks(query: { cursor?: string, limit?: number } = {}): Promise<{
    packs: WireStickerPackSummary[]
    nextCursor?: string
  }> {
    return this.json(`/stickers/packs${queryString(query)}`)
  }

  getStickerPack(packId: string): Promise<WireStickerPack | null> {
    return this.json(`/stickers/packs/${encodeURIComponent(packId)}`, true)
  }

  getSticker(stickerId: string): Promise<WireSticker | null> {
    return this.json(`/stickers/${encodeURIComponent(stickerId)}`, true)
  }

  getSavedStickers(query: { cursor?: string, limit?: number } = {}): Promise<{
    stickers: WireSticker[]
    nextCursor?: string
  }> {
    return this.json(`/stickers/saved${queryString(query)}`)
  }

  stickerSource(reference: QQStickerReference, size?: number): IMMediaSource {
    const client = this
    return {
      size,
      async *stream(options = {}) {
        const response = await client.fetchImpl(`${client.endpoint}/stickers/asset`, {
          method: 'POST',
          headers: client.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(reference),
          signal: options.signal,
        })
        if (!response.ok) throw new Error(await responseError(response))
        if (!response.body) throw new Error('QQNT sticker response has no body')
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            if (value?.length) yield value
          }
        } finally {
          reader.releaseLock()
        }
      },
    }
  }

  async setSavedSticker(reference: QQStickerReference, saved: boolean): Promise<void> {
    await this.json('/stickers/saved', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ reference, saved }),
    })
  }

  async sendMessage(
    conversationId: string,
    text: string | undefined,
    media: Array<{
      kind: 'image' | 'file'
      name: string
      mimeType?: string
      width?: number
      height?: number
      duration?: number
      source: IMMediaSource
    }> | undefined,
    options: IMTransferOptions = {},
    originRequestId?: string,
    sticker?: QQStickerReference,
    textParts?: WireTextPart[],
    replyToId?: string,
    replyToSequence?: string,
  ): Promise<WireMessage> {
    const preparedMedia = media && await Promise.all(media.map(async (item) => ({
      item,
      hashes: await hashMediaSource(item.source, options.signal),
    })))
    const uploadedMedia = preparedMedia && await Promise.all(preparedMedia.map(async ({ item, hashes }, mediaIndex) => {
      const mediaSpec = {
        kind: item.kind, name: item.name, mimeType: item.mimeType, size: hashes.size,
        md5: hashes.md5, sha1: hashes.sha1, file10MMd5: hashes.file10MMd5,
        width: item.width, height: item.height, duration: item.duration,
      }
      const plan = await this.json<QQMediaUploadPlan>('/uploads/prepare', false, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ conversationId, media: mediaSpec }),
        signal: options.signal,
      })
      if (plan.prepared.kind !== item.kind) throw new Error('QQNT bridge returned the wrong prepared media kind')
      if (plan.highway) {
        if (plan.highway.fileSize !== hashes.size || plan.highway.fileMd5.toLowerCase() !== hashes.md5) {
          throw new Error('QQNT bridge returned mismatched Highway file metadata')
        }
        await uploadHighway(
          plan.highway,
          item.source.stream({ signal: options.signal }),
          this.fetchImpl,
          {
            signal: options.signal,
            onProgress: (transferredBytes) => options.onProgress?.({
              phase: 'upload', mediaIndex, transferredBytes, totalBytes: hashes.size,
            }),
          },
        )
      } else {
        await options.onProgress?.({
          phase: 'upload', mediaIndex, transferredBytes: hashes.size, totalBytes: hashes.size,
        })
      }
      return plan.prepared
    }))
    const manifest = {
      conversationId,
      text,
      textParts,
      replyToId,
      replyToSequence,
      originRequestId,
      sticker,
      media: preparedMedia?.map(({ item, hashes }) => ({
        kind: item.kind, name: item.name, mimeType: item.mimeType, size: hashes.size,
        md5: hashes.md5, sha1: hashes.sha1, file10MMd5: hashes.file10MMd5,
        width: item.width, height: item.height, duration: item.duration,
      })),
      uploadedMedia,
    }
    const headers = this.headers({
      'x-qqnt-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64url'),
    })
    const response = await this.fetchImpl(`${this.endpoint}/messages`, {
      method: 'POST', headers, body: new Uint8Array(), signal: options.signal,
    })
    if (response.status === 403) {
      throw new QQNTMessageSendRejectedError(await responseError(response))
    }
    return responseJson(response)
  }

  async deleteMessages(conversationId: string, messageIds: readonly string[], forEveryone: boolean): Promise<void> {
    await this.json('/messages/delete', false, {
      method: 'POST',
      body: JSON.stringify({ conversationId, messageIds, forEveryone }),
      headers: this.headers({ 'content-type': 'application/json' }),
    })
  }

  async markRead(conversationId: string, messageId: string): Promise<void> {
    await this.json('/messages/read', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId, messageId }),
    })
  }

  async getMessage(conversationId: string, messageId: string): Promise<WireMessage | null> {
    const response = await this.fetchImpl(`${this.endpoint}/messages/get`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId, messageId }),
    })
    if (response.status === 404) return null
    return responseJson(response)
  }

  async getMultiForwardMessages(locator: WireMultiForwardLocator): Promise<WireMessage[]> {
    const response = await this.json<{ messages: WireMessage[] }>('/messages/multi-forward', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(locator),
    })
    return response.messages
  }

  async forwardMessages(
    from: string,
    messageIds: readonly string[],
    to: string,
    merged: boolean,
  ): Promise<WireMessage[]> {
    const response = await this.json<{ messages: WireMessage[] }>('/messages/forward', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ from, to, messageIds, merged }),
    })
    return response.messages
  }

  getReactionCatalog(): Promise<WireReactionContext> {
    return this.json('/reactions/catalog')
  }

  getMessageReactions(
    conversationId: string,
    messageId: string,
    messageSequence?: string,
  ): Promise<WireReactionState> {
    return this.json(`/messages/reactions${queryString({ conversationId, messageId, messageSequence })}`)
  }

  setMessageReactions(
    conversationId: string,
    messageId: string,
    reactionKeys: readonly string[],
    messageSequence?: string,
  ): Promise<WireReactionState> {
    return this.json('/messages/reactions', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId, messageId, messageSequence, reactionKeys }),
    })
  }

  clickInlineKeyboard(input: {
    conversationId: string
    messageId: string
    messageSequence?: string
    buttonId: string
    callbackData: string
    botAppid: string
  }): Promise<{ status: number, promptText: string, promptType: number, promptIcon: number }> {
    return this.json('/messages/inline-keyboard/click', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    })
  }

  async *downloadFile(
    locator: QQMediaLocator,
    options: {
      signal?: AbortSignal
      offset?: number
      limit?: number
      onChunk?(size: number): Promise<void> | void
    } = {},
  ): AsyncIterable<Uint8Array> {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit))
    if (limit === 0) return
    const ranged = offset > 0 || limit !== undefined
    const end = limit === undefined ? '' : String(offset + limit - 1)
    const rangeHeaders = ranged ? { range: `bytes=${offset}-${end}` } : {}
    const avatarUrl = qqAvatarUrl(locator)
    let response: Response
    if (locator.filePath && !avatarUrl) {
      response = await this.fetchImpl(`${this.endpoint}/files/asset`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', ...rangeHeaders }),
        body: JSON.stringify(locator),
        signal: options.signal,
      })
      if (!response.ok && response.status === 404 && hasDirectUrlIdentity(locator)) {
        const directUrl = (await this.resolveFileUrl(locator, options.signal)).url
        response = await this.fetchImpl(directUrl, {
          headers: rangeHeaders,
          signal: options.signal,
          redirect: 'follow',
        })
        if (!response.ok) throw new Error(await nativeResponseError(response))
        if (!response.body) throw new Error('QQNT native media response has no body')
      } else {
        if (!response.ok) throw new Error(await responseError(response))
        if (!response.body) throw new Error('QQNT media asset response has no body')
      }
    } else if (avatarUrl || hasDirectUrlIdentity(locator)) {
      const directUrl = avatarUrl ?? (await this.resolveFileUrl(locator, options.signal)).url
      response = await this.fetchImpl(directUrl, {
        headers: rangeHeaders,
        signal: options.signal,
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(await nativeResponseError(response))
      if (!response.body) throw new Error('QQNT native media response has no body')
    } else {
      throw new Error('QQNT media locator has no remote direct-link identity')
    }
    const reader = response.body.getReader()
    // QQ CDN and qlogo normally apply Range. Retain local slicing for a whole-file
    // 200 response so a CDN that ignores Range still satisfies upload.getFile.
    let skipped = response.status === 206 ? offset : 0
    let remaining = limit ?? Number.POSITIVE_INFINITY
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          completed = true
          break
        }
        if (!value?.length) continue
        if (skipped + value.length <= offset) {
          skipped += value.length
          continue
        }
        const start = Math.max(0, offset - skipped)
        const accepted = value.subarray(start, start + remaining)
        skipped += value.length
        if (!accepted.length) continue
        remaining -= accepted.length
        await options.onChunk?.(accepted.length)
        yield accepted
        if (remaining <= 0) return
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  async *downloadReactionResource(
    reactionKey: string,
    options: {
      signal?: AbortSignal
      offset?: number
      limit?: number
      onChunk?(size: number): Promise<void> | void
    } = {},
  ): AsyncIterable<Uint8Array> {
    if (!reactionKey) throw new Error('QQ reaction resource has no catalog key')
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit))
    if (limit === 0) return
    const ranged = offset > 0 || limit !== undefined
    const end = limit === undefined ? '' : String(offset + limit - 1)
    const response = await this.fetchImpl(`${this.endpoint}/reactions/asset`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        ...(ranged ? { range: `bytes=${offset}-${end}` } : {}),
      }),
      body: JSON.stringify({ reactionKey }),
      signal: options.signal,
    })
    if (!response.ok) throw new Error(await responseError(response))
    if (!response.body) throw new Error('QQ reaction asset response has no body')
    const reader = response.body.getReader()
    let skipped = response.status === 206 ? offset : 0
    let remaining = limit ?? Number.POSITIVE_INFINITY
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          completed = true
          break
        }
        if (!value?.length) continue
        if (skipped + value.length <= offset) {
          skipped += value.length
          continue
        }
        const start = Math.max(0, offset - skipped)
        const accepted = value.subarray(start, start + remaining)
        skipped += value.length
        if (!accepted.length) continue
        remaining -= accepted.length
        await options.onChunk?.(accepted.length)
        yield accepted
        if (remaining <= 0) return
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  async resolveFileUrl(locator: QQMediaLocator, signal?: AbortSignal): Promise<DirectUrl> {
    if (signal?.aborted) throw signal.reason ?? new Error('download aborted')
    if (!hasDirectUrlIdentity(locator)) throw new Error('QQNT media locator has no remote direct-link identity')
    const key = directUrlIdentity(locator)
    const cached = this.directUrls.get(key)
    if (cached && Date.now() < cached.expiresAt) return cached
    const active = this.directUrlRefreshes.get(key)
    const refresh = active ?? this.fetchDirectUrl(locator).then((value) => {
      this.rememberDirectUrl(key, value)
      return value
    }).finally(() => this.directUrlRefreshes.delete(key))
    if (!active) this.directUrlRefreshes.set(key, refresh)
    const resolved = await refresh
    if (signal?.aborted) throw signal.reason ?? new Error('download aborted')
    return resolved
  }

  private fetchDirectUrl(locator: QQMediaLocator): Promise<DirectUrl> {
    return this.json<DirectUrl>('/files/direct-url', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(locator),
    })
  }

  private rememberDirectUrl(key: string, value: DirectUrl): void {
    if (!value.url) throw new Error('QQNT bridge returned an empty direct URL')
    this.directUrls.delete(key)
    if (Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()) {
      this.directUrls.set(key, value)
    }
    while (this.directUrls.size > 1_024) this.directUrls.delete(this.directUrls.keys().next().value!)
  }

  async subscribe(
    handler: (event: WireEvent, eventId?: string) => void | Promise<void>,
    signal: AbortSignal,
    options: QQNTSubscribeOptions = {},
  ): Promise<void> {
    if (signal.aborted) return
    const url = new URL(this.webSocketEndpoint)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (options.lastEventId) url.searchParams.set('lastEventId', options.lastEventId)
    const webSocket = new WebSocket(url, { headers: this.headers() })
    const messages = new WebSocketMessageQueue(webSocket)
    const abort = () => webSocket.terminate()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await waitForWebSocketOpen(webSocket)
      while (true) {
        const { done, value } = await messages.next()
        if (done) return
        const frame = JSON.parse(rawDataText(value)) as { id?: string, event?: WireEvent }
        if (!frame.event) throw new Error('QQNT WebSocket frame has no event')
        await handler(frame.event, frame.id)
        if (frame.id) await options.onEventId?.(frame.id)
      }
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      signal.removeEventListener('abort', abort)
      if (webSocket.readyState === WebSocket.OPEN) webSocket.close()
      else if (webSocket.readyState === WebSocket.CONNECTING) webSocket.terminate()
      messages.dispose()
    }
  }

  private async json<T>(
    path: string,
    nullable404 = false,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      ...init,
      headers: init.headers ?? this.headers(),
    })
    if (nullable404 && response.status === 404) return null as T
    return responseJson(response)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra }
  }
}

class WebSocketMessageQueue {
  private readonly values: RawData[] = []
  private readonly waiters: Array<{
    resolve(value: IteratorResult<RawData>): void
    reject(error: unknown): void
  }> = []
  private ended = false
  private error?: unknown

  constructor(private readonly webSocket: WebSocket) {
    webSocket.on('message', this.onMessage)
    webSocket.once('close', this.onClose)
    webSocket.once('error', this.onError)
  }

  next(): Promise<IteratorResult<RawData>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.error) return Promise.reject(this.error)
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  dispose(): void {
    this.webSocket.off('message', this.onMessage)
    this.webSocket.off('close', this.onClose)
    this.webSocket.off('error', this.onError)
    this.finish()
  }

  private readonly onMessage = (data: RawData) => {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value: data, done: false })
    else this.values.push(data)
  }

  private readonly onClose = () => this.finish()

  private readonly onError = (error: Error) => {
    this.error = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }
}

function waitForWebSocketOpen(webSocket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = () => {
      cleanup()
      resolve()
    }
    const error = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const close = (code: number) => {
      cleanup()
      reject(new Error(`QQNT WebSocket closed before opening: ${code}`))
    }
    const cleanup = () => {
      webSocket.off('open', open)
      webSocket.off('error', error)
      webSocket.off('close', close)
    }
    webSocket.once('open', open)
    webSocket.once('error', error)
    webSocket.once('close', close)
  })
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString()
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString()
  return data.toString()
}

async function hashMediaSource(source: IMMediaSource, signal?: AbortSignal): Promise<{
  size: number
  md5: string
  sha1: string
  file10MMd5: string
}> {
  const md5 = createHash('md5')
  const sha1 = createHash('sha1')
  const first10M = createHash('md5')
  const first10MLimit = 10 * 1024 * 1024
  let size = 0
  let first10MSize = 0
  for await (const chunk of source.stream({ signal })) {
    if (signal?.aborted) throw signal.reason ?? new Error('upload aborted')
    size += chunk.length
    md5.update(chunk)
    sha1.update(chunk)
    if (first10MSize < first10MLimit) {
      const accepted = chunk.subarray(0, Math.min(chunk.length, first10MLimit - first10MSize))
      first10M.update(accepted)
      first10MSize += accepted.length
    }
  }
  if (source.size !== undefined && size !== source.size) {
    throw new Error(`incomplete media source: expected ${source.size} bytes, streamed ${size}`)
  }
  return { size, md5: md5.digest('hex'), sha1: sha1.digest('hex'), file10MMd5: first10M.digest('hex') }
}

function parseMediaLease(value: unknown): QQNTMediaLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid media lease')
  const lease = value as Record<string, unknown>
  const socketPath = lease.socketPath
  const leaseId = lease.leaseId
  const encodedToken = lease.token
  const expiry = lease.expiry
  if (lease.version !== MEDIA_LEASE_VERSION
    || typeof socketPath !== 'string'
    || !isAbsoluteUnixPath(socketPath)
    || typeof leaseId !== 'string'
    || !new RegExp(`^[0-9a-f]{${MEDIA_LEASE_ID_HEX_LENGTH}}$`).test(leaseId)
    || typeof encodedToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(encodedToken)
    || typeof expiry !== 'number'
    || !Number.isSafeInteger(expiry)
    || expiry < 0) {
    throw new Error('invalid media lease')
  }
  const token = Buffer.from(encodedToken, 'base64url')
  try {
    if (token.byteLength !== MEDIA_LEASE_TOKEN_BYTES) throw new Error('invalid media lease')
    return {
      version: MEDIA_LEASE_VERSION,
      socketPath,
      leaseId,
      token: new Uint8Array(token),
      expiry,
    }
  } finally {
    token.fill(0)
  }
}

function isAbsoluteUnixPath(value: string): boolean {
  return value.startsWith('/') && value.length <= 4_096 && !value.includes('\0')
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
  const output = params.toString()
  return output ? `?${output}` : ''
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await responseError(response))
  return await response.json() as T
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { error?: unknown }
    return `QQNT bridge ${response.status}: ${typeof body.error === 'string' ? body.error : text}`
  } catch {
    return `QQNT bridge ${response.status}: ${text || response.statusText}`
  }
}

async function nativeResponseError(response: Response): Promise<string> {
  const text = await response.text()
  return `QQNT native media ${response.status}: ${text || response.statusText}`
}

function qqAvatarUrl(locator: QQMediaLocator): string | undefined {
  const userUin = locator.avatarUin?.trim()
  if (userUin && /^\d+$/.test(userUin)) {
    return `https://q1.qlogo.cn/g?b=qq&nk=${userUin}&s=640`
  }
  const groupUin = locator.peerUid.trim()
  if (locator.chatType === 2
    && locator.messageId.startsWith('avatar:group:')
    && /^\d+$/.test(groupUin)) {
    return `https://p.qlogo.cn/gh/${groupUin}/${groupUin}/640/`
  }
}

function hasDirectUrlIdentity(locator: QQMediaLocator): boolean {
  return Boolean(locator.originImageUrl || locator.fileUuid)
}

function directUrlIdentity(locator: QQMediaLocator): string {
  return JSON.stringify([
    locator.chatType, locator.peerUid, locator.fileUuid ?? '', locator.file10MMd5 ?? '',
    locator.videoCodecFormat ?? null, locator.originImageUrl ?? '', locator.avatarUin ?? '',
  ])
}
