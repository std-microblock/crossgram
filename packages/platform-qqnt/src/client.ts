import { Readable } from 'node:stream'
import type { IMMediaSource, IMTransferOptions } from '@mtproto-relay/bridge'
import WebSocket, { type RawData } from 'ws'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMemberPage, WireMessage, WireMultiForwardLocator,
  WireReactionContext, WireReactionState, WireSticker, WireStickerPack, WireStickerPackSummary,
  WireTextPart,
} from './protocol.js'

export interface QQNTClientOptions {
  endpoint?: string
  webSocketEndpoint?: string
  token?: string
  fetch?: typeof globalThis.fetch
}

export interface QQNTSubscribeOptions {
  lastEventId?: string
  onEventId?(eventId: string): void
}

export class QQNTClient {
  readonly endpoint: string
  readonly webSocketEndpoint: string
  private readonly token?: string
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: QQNTClientOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://127.0.0.1:18767/v1').replace(/\/+$/, '')
    this.webSocketEndpoint = options.webSocketEndpoint ?? `${this.endpoint}/events/ws`
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  status(): Promise<{ protocolVersion: number, ready: boolean, selfUin?: string, selfUid?: string }> {
    return this.json('/status')
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
    users: Array<{ id: string, numericId?: string, name: string, avatar?: import('./protocol.js').WireMedia }>
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
  ): Promise<WireMessage> {
    const manifest = {
      conversationId,
      text,
      textParts,
      replyToId,
      originRequestId,
      sticker,
      media: media?.map((item) => ({
        kind: item.kind, name: item.name, mimeType: item.mimeType, size: item.source.size,
        width: item.width, height: item.height, duration: item.duration,
      })),
      mediaFraming: media && media.length > 1 ? 'length-prefixed-v1' : undefined,
    }
    const headers = this.headers({
      'x-qqnt-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64url'),
      ...(media?.length === 1 && media[0].source.size !== undefined
        ? { 'content-length': String(media[0].source.size) }
        : {}),
    })
    let body: BodyInit | undefined
    const uploadState: { error?: Error } = {}
    if (media?.length) body = Readable.from(media.length === 1
      ? uploadStream(media[0].source, options, uploadState, 0)
      : framedUploadStream(media.map((item) => item.source), options, uploadState)) as unknown as BodyInit
    else body = new Uint8Array()
    try {
      const response = await this.fetchImpl(`${this.endpoint}/messages`, {
        method: 'POST', headers, body, signal: options.signal, duplex: 'half',
      } as RequestInit)
      return responseJson(response)
    } catch (error) {
      throw uploadState.error ?? error
    }
  }

  async deleteMessages(conversationId: string, messageIds: readonly string[], forEveryone: boolean): Promise<void> {
    await this.json('/messages/delete', false, {
      method: 'POST',
      body: JSON.stringify({ conversationId, messageIds, forEveryone }),
      headers: this.headers({ 'content-type': 'application/json' }),
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

  getMessageReactions(conversationId: string, messageId: string): Promise<WireReactionState> {
    return this.json(`/messages/reactions${queryString({ conversationId, messageId })}`)
  }

  setMessageReactions(
    conversationId: string,
    messageId: string,
    reactionKeys: readonly string[],
  ): Promise<WireReactionState> {
    return this.json('/messages/reactions', false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId, messageId, reactionKeys }),
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
    const native = Boolean(locator.originImageUrl) || locator.videoCodecFormat !== undefined
    const avatarUrl = qqAvatarUrl(locator)
    let response: Response
    if (native || avatarUrl) {
      const directUrl = avatarUrl ?? await this.resolveDirectUrl(locator, options.signal)
      response = await this.fetchImpl(directUrl, {
        headers: rangeHeaders,
        signal: options.signal,
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(await nativeResponseError(response))
      if (!response.body) throw new Error('QQNT native media response has no body')
    } else if (locator.filePath) {
      response = await this.fetchImpl(`${this.endpoint}/files/download`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', ...rangeHeaders }),
        body: JSON.stringify(locator),
        signal: options.signal,
      })
      if (!response.ok) throw new Error(await responseError(response))
      if (!response.body) throw new Error('QQNT media response has no body')
    } else {
      throw new Error('QQNT media locator has no native URL or bridge-local path')
    }
    const reader = response.body.getReader()
    // Direct targets and protocol v13 bridges apply Range. Retain local slicing
    // for whole-file 200 responses during rolling upgrades and from qlogo.
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

  private async resolveDirectUrl(locator: QQMediaLocator, signal?: AbortSignal): Promise<string> {
    const init = {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(locator),
      signal,
    }
    try {
      return (await this.json<{ url: string }>('/files/direct-url', false, init)).url
    } catch (error) {
      if (signal?.aborted || locator.videoCodecFormat === undefined) throw error
      // Protocol v13 exposed only the video resolver. Keep rolling upgrades
      // seekable while v14 adds the generic image/video endpoint.
      return (await this.json<{ url: string }>('/files/play-url', false, init)).url
    }
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
        if (frame.id) options.onEventId?.(frame.id)
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

async function* uploadStream(
  source: IMMediaSource,
  options: IMTransferOptions,
  state: { error?: Error },
  mediaIndex: number,
): AsyncIterable<Uint8Array> {
  let transferred = 0
  for await (const chunk of source.stream({ signal: options.signal })) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('upload aborted')
    transferred += chunk.length
    await options.onProgress?.({
      phase: 'upload', mediaIndex, transferredBytes: transferred, totalBytes: source.size,
    })
    yield chunk
  }
  if (source.size !== undefined && transferred !== source.size) {
    state.error = new Error(`incomplete media source: expected ${source.size} bytes, streamed ${transferred}`)
    throw state.error
  }
}

async function* framedUploadStream(
  sources: IMMediaSource[],
  options: IMTransferOptions,
  state: { error?: Error },
): AsyncIterable<Uint8Array> {
  const maxFrame = 64 * 1024
  for (const [mediaIndex, source] of sources.entries()) {
    for await (const chunk of uploadStream(source, options, state, mediaIndex)) {
      for (let offset = 0; offset < chunk.length; offset += maxFrame) {
        const frame = chunk.subarray(offset, Math.min(chunk.length, offset + maxFrame))
        const header = Buffer.allocUnsafe(4)
        header.writeUInt32BE(frame.length)
        yield header
        yield frame
      }
    }
    yield Buffer.alloc(4)
  }
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
