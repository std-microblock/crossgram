import { Readable } from 'node:stream'
import type { IMMediaSource, IMTransferOptions } from '@mtproto-relay/bridge'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMemberPage, WireMessage,
  WireReactionContext, WireReactionState, WireSticker, WireStickerPack, WireStickerPackSummary,
  WireTextPart,
} from './protocol.js'

export interface QQNTClientOptions {
  endpoint?: string
  token?: string
  fetch?: typeof globalThis.fetch
}

export class QQNTClient {
  readonly endpoint: string
  private readonly token?: string
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: QQNTClientOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://127.0.0.1:18767/v1').replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  status(): Promise<{ protocolVersion: number, ready: boolean, selfUin?: string, selfUid?: string }> {
    return this.json('/status')
  }

  getDialogs(query: { cursor?: string, limit?: number } = {}): Promise<{
    conversations: WireConversation[]
    nextCursor?: string
  }> {
    return this.json(`/dialogs${queryString(query)}`)
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
    media: {
      kind: 'image' | 'file'
      name: string
      mimeType?: string
      width?: number
      height?: number
      source: IMMediaSource
    } | undefined,
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
      media: media ? [{
        kind: media.kind, name: media.name, mimeType: media.mimeType, size: media.source.size,
        width: media.width, height: media.height,
      }] : undefined,
    }
    const headers = this.headers({
      'x-qqnt-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64url'),
      ...(media?.source.size === undefined ? {} : { 'content-length': String(media.source.size) }),
    })
    let body: BodyInit | undefined
    const uploadState: { error?: Error } = {}
    if (media) body = Readable.from(uploadStream(media.source, options, uploadState)) as unknown as BodyInit
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

  async *downloadMedia(
    locator: QQMediaLocator,
    options: { offset?: number, limit?: number, signal?: AbortSignal, onChunk?(size: number): Promise<void> | void } = {},
  ): AsyncIterable<Uint8Array> {
    const response = await this.fetchImpl(`${this.endpoint}/media/open`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        'x-qqnt-offset': String(options.offset ?? 0),
        ...(options.limit === undefined ? {} : { 'x-qqnt-limit': String(options.limit) }),
      }),
      body: JSON.stringify(locator),
      signal: options.signal,
    })
    if (!response.ok) throw new Error(await responseError(response))
    if (!response.body) throw new Error('QQNT media response has no body')
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        await options.onChunk?.(value.length)
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }

  async subscribe(handler: (event: WireEvent) => void | Promise<void>, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.endpoint}/events`, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    })
    if (!response.ok) throw new Error(await responseError(response))
    if (!response.body) throw new Error('QQNT event stream has no body')
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += value
        while (true) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame.split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data) await handler(JSON.parse(data) as WireEvent)
        }
      }
    } finally {
      reader.releaseLock()
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

async function* uploadStream(
  source: IMMediaSource,
  options: IMTransferOptions,
  state: { error?: Error },
): AsyncIterable<Uint8Array> {
  let transferred = 0
  for await (const chunk of source.stream({ signal: options.signal })) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('upload aborted')
    transferred += chunk.length
    await options.onProgress?.({
      phase: 'upload', mediaIndex: 0, transferredBytes: transferred, totalBytes: source.size,
    })
    yield chunk
  }
  if (source.size !== undefined && transferred !== source.size) {
    state.error = new Error(`incomplete media source: expected ${source.size} bytes, streamed ${transferred}`)
    throw state.error
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
