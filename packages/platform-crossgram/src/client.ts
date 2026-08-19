import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMMediaSource, IMTransferOptions } from '@mtproto-relay/bridge'
import WebSocket, { type RawData } from 'ws'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMemberPage, WireMessage, WireMultiForwardLocator,
  WireReactionActorPage, WireReactionContext, WireReactionState, WireRequest, WireRequestPage, WireSticker, WireStickerPack, WireStickerPackSummary,
  WireTextPart,
} from './protocol.js'
import { uploadHighway, type QQMediaUploadPlan } from './highway.js'

export interface QQNTClientOptions {
  endpoint?: string
  webSocketEndpoint?: string
  token?: string
  fetch?: typeof globalThis.fetch
  unrangedCachePath?: string
}

export interface QQNTSubscribeOptions {
  lastEventId?: string
  onEventId?(eventId: string): void | Promise<void>
}

export interface DirectUrl {
  url: string
  expiresAt: number
  supportsRange?: boolean
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
const MAX_UNRANGED_CACHE_BYTES = 4 * 1024 * 1024 * 1024
const MAX_UNRANGED_CACHE_ENTRIES = 8
const DIRECT_RANGE_BLOCK_BYTES = 1024 * 1024
const MAX_DIRECT_RANGE_CACHE_BYTES = 64 * 1024 * 1024
const MAX_REVALIDATED_JSON_RESPONSES = 256
let unrangedCacheSequence = 0

interface CachedUnrangedFile {
  path: string
  size: number
  complete: boolean
  accounted: boolean
  error?: unknown
  waiters: Set<() => void>
}

interface CachedDirectRangeBlock {
  start: number
  bytes: Uint8Array
}

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
  private readonly directRangeChecks = new Map<string, Promise<boolean>>()
  private readonly directRangeCapabilities = new Map<string, boolean>()
  private readonly unrangedFiles = new Map<string, CachedUnrangedFile>()
  private readonly unrangedFileLoads = new Map<string, Promise<CachedUnrangedFile>>()
  private readonly unrangedCachePath: string
  private unrangedFileBytes = 0
  private readonly directRangeBlocks = new Map<string, CachedDirectRangeBlock>()
  private readonly directRangeBlockLoads = new Map<string, Promise<CachedDirectRangeBlock>>()
  private directRangeBlockBytes = 0
  private bridgeProtocol?: number
  private readonly revalidatedJsonResponses = new Map<string, { etag: string, value: unknown }>()

  constructor(options: QQNTClientOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://127.0.0.1:18767/v1').replace(/\/+$/, '')
    this.webSocketEndpoint = options.webSocketEndpoint ?? `${this.endpoint}/events/ws`
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.unrangedCachePath = options.unrangedCachePath
      ?? join(tmpdir(), `crossgram-qqnt-unranged-${process.pid}-${++unrangedCacheSequence}`)
  }

  async status(): Promise<{ protocolVersion: number, ready: boolean, selfUin?: string, selfUid?: string }> {
    const status = await this.json<{ protocolVersion: number, ready: boolean, selfUin?: string, selfUid?: string }>('/status')
    this.bridgeProtocol = status.protocolVersion
    return status
  }

  getRequests(query: { kind?: 'friend' | 'group-join', cursor?: string, limit?: number } = {}): Promise<WireRequestPage> {
    return this.json(`/requests${queryString(query)}`)
  }

  resolveRequest(id: string, action: 'accept' | 'reject'): Promise<WireRequest> {
    return this.json(`/requests/${encodeURIComponent(id)}/resolve`, false, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ action }),
    })
  }

  async mediaLease(callId: string): Promise<QQNTMediaLease> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/calls/media-lease`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ callId }),
      })
      if (!response.ok) {
        await discardResponseBody(response)
        throw new Error('media lease request rejected')
      }
      return parseMediaLease(await response.json())
    } catch {
      throw new Error('QQNT media lease request failed')
    }
  }

  async controlCall(callId: string, operation: 'accept' | 'reject' | 'hangup'): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/calls/control`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ callId, operation }),
      })
      if (!response.ok) {
        await discardResponseBody(response)
        throw new Error('call control rejected')
      }
      await discardResponseBody(response)
    } catch {
      throw new Error('QQNT call control failed')
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
    return this.revalidatedJson(`/dialogs${queryString(query)}`, { signal })
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
    return this.revalidatedJson(`/conversations/${encodeURIComponent(id)}/history${queryString(query)}`)
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
        yield* client.downloadSticker(reference, { signal: options.signal })
      },
      async *streamRange(options) {
        yield* client.downloadSticker(reference, options)
      },
    }
  }

  private async *downloadSticker(
    reference: QQStickerReference,
    options: { signal?: AbortSignal, offset?: number, limit?: number } = {},
  ): AsyncIterable<Uint8Array> {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit))
    if (limit === 0) return
    const ranged = offset > 0 || limit !== undefined
    const end = limit === undefined ? '' : String(offset + limit - 1)
    const response = await this.fetchImpl(`${this.endpoint}/stickers/asset`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        ...(ranged ? { range: `bytes=${offset}-${end}` } : {}),
      }),
      body: JSON.stringify(reference),
      signal: options.signal,
    })
    if (!response.ok) throw new Error(await responseError(response))
    if (!response.body) throw new Error('QQNT sticker response has no body')
    const reader = response.body.getReader()
    let skipped = response.status === 206 ? offset : 0
    let remaining = limit ?? Number.POSITIVE_INFINITY
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          completed = true
          return
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
        yield accepted
        if (remaining <= 0) return
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
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
      voice?: boolean
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
    const voice = media?.find((item) => item.voice)
    if (voice) {
      if (this.bridgeProtocol === undefined) await this.status()
      if (this.bridgeProtocol! < 21) {
        throw new Error('QQNT bridge protocol 21 is required for voice messages')
      }
      if (media?.length !== 1 || text || textParts?.length || sticker || replyToId || replyToSequence) {
        throw new Error('QQNT voice messages must contain exactly one voice item without a reply')
      }
      const manifest = {
        conversationId, replyToId, replyToSequence, originRequestId,
        media: [{ kind: 'voice', name: voice.name, mimeType: voice.mimeType, duration: voice.duration }],
      }
      const response = await this.fetchImpl(`${this.endpoint}/messages`, {
        method: 'POST', headers: this.headers({
          'x-qqnt-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64url'),
        }),
        body: sourceReadableStream(voice.source, options.signal), signal: options.signal,
        // Node's fetch requires this for a streaming request body.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      if (response.status === 403) throw new QQNTMessageSendRejectedError(await responseError(response))
      return responseJson(response)
    }
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

  async setNotificationMask(chatType: number, peerUin: string, msgMask: number): Promise<void> {
    await this.json(
      `/conversations/${chatType}/${encodeURIComponent(peerUin)}/notification-mask`,
      false,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ msgMask }),
      },
    )
  }

  async getMessage(conversationId: string, messageId: string): Promise<WireMessage | null> {
    const response = await this.fetchImpl(`${this.endpoint}/messages/get`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId, messageId }),
    })
    if (response.status === 404) {
      await discardResponseBody(response)
      return null
    }
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

  getMessageReactionActors(
    conversationId: string,
    messageId: string,
    reactionKey: string | undefined,
    offset: string | undefined,
    limit: number,
    messageSequence?: string,
  ): Promise<WireReactionActorPage> {
    return this.json(`/messages/reactions/list${queryString({
      conversationId, messageId, reactionKey, offset, limit, messageSequence,
    })}`)
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
    let directKey: string | undefined
    let direct: DirectUrl | undefined
    if (locator.filePath && !avatarUrl) {
      response = await this.fetchImpl(`${this.endpoint}/files/asset`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', ...rangeHeaders }),
        body: JSON.stringify(locator),
        signal: options.signal,
      })
      if (!response.ok && response.status === 404 && hasDirectUrlIdentity(locator)) {
        await discardResponseBody(response)
        directKey = directUrlIdentity(locator)
        direct = await this.resolveFileUrl(locator, options.signal)
        const cached = ranged && direct.supportsRange === false
          ? await this.cachedUnrangedFile(directKey, direct.url)
          : undefined
        if (cached) {
          yield* this.readCachedUnrangedFile(cached, offset, limit, options)
          return
        }
        if (limit !== undefined && direct.supportsRange === true) {
          const bytes = await this.cachedDirectRange(directKey, direct.url, offset, limit, options.signal)
          await options.onChunk?.(bytes.length)
          if (bytes.length) yield bytes
          return
        }
        response = await this.fetchImpl(direct.url, {
          headers: direct.supportsRange === false ? {} : rangeHeaders,
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
      directKey = avatarUrl ? undefined : directUrlIdentity(locator)
      direct = avatarUrl ? undefined : await this.resolveFileUrl(locator, options.signal)
      const directUrl = avatarUrl ?? direct!.url
      const cached = directKey && ranged && direct?.supportsRange === false
        ? await this.cachedUnrangedFile(directKey, directUrl)
        : undefined
      if (cached) {
        yield* this.readCachedUnrangedFile(cached, offset, limit, options)
        return
      }
      if (directKey && limit !== undefined && direct?.supportsRange === true) {
        const bytes = await this.cachedDirectRange(directKey, directUrl, offset, limit, options.signal)
        await options.onChunk?.(bytes.length)
        if (bytes.length) yield bytes
        return
      }
      response = await this.fetchImpl(directUrl, {
        headers: direct?.supportsRange === false ? {} : rangeHeaders,
        signal: options.signal,
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(await nativeResponseError(response))
      if (!response.body) throw new Error('QQNT native media response has no body')
    } else {
      throw new Error('QQNT media locator has no remote direct-link identity')
    }
    if (directKey && ranged && response.status === 200) {
      const cached = await this.cacheUnrangedResponse(directKey, response)
      this.markDirectRangeSupport(directKey, false)
      this.rememberUnrangedFile(directKey, cached)
      yield* this.readCachedUnrangedFile(cached, offset, limit, options)
      return
    }
    if (directKey && response.status === 206) this.markDirectRangeSupport(directKey, true)
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

  async resolveFileUrlForDirectDownload(
    locator: QQMediaLocator,
    signal?: AbortSignal,
  ): Promise<DirectUrl & { supportsRange: boolean }> {
    const key = directUrlIdentity(locator)
    const resolved = await this.resolveFileUrl(locator, signal)
    if (resolved.supportsRange !== undefined) return resolved as DirectUrl & { supportsRange: boolean }
    const inspected = await this.inspectDirectUrl(resolved.url, resolved.expiresAt, signal)
    this.rememberDirectUrl(key, inspected)
    return inspected
  }

  async inspectDirectUrl(
    url: string,
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<DirectUrl & { supportsRange: boolean }> {
    const capabilityKey = directRangeCapabilityKey(url)
    const cached = this.directRangeCapabilities.get(capabilityKey)
    if (cached !== undefined) return { url, expiresAt, supportsRange: cached }
    const active = this.directRangeChecks.get(capabilityKey)
    const pending = active ?? this.probeDirectRange(url, signal)
      .finally(() => this.directRangeChecks.delete(capabilityKey))
    if (!active) this.directRangeChecks.set(capabilityKey, pending)
    const supportsRange = await pending
    if (!this.directRangeCapabilities.has(capabilityKey)) {
      this.directRangeCapabilities.set(capabilityKey, supportsRange)
      while (this.directRangeCapabilities.size > 128) {
        this.directRangeCapabilities.delete(this.directRangeCapabilities.keys().next().value!)
      }
    }
    return { url, expiresAt, supportsRange }
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

  private async cachedDirectRange(
    identity: string,
    url: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const blockStart = Math.floor(offset / DIRECT_RANGE_BLOCK_BYTES) * DIRECT_RANGE_BLOCK_BYTES
    const requiredSize = offset - blockStart + limit
    const blockSize = Math.ceil(requiredSize / DIRECT_RANGE_BLOCK_BYTES) * DIRECT_RANGE_BLOCK_BYTES
    const cacheKey = `${identity}\0${blockStart}\0${blockSize}`
    let block = this.directRangeBlocks.get(cacheKey)
    if (block) {
      this.directRangeBlocks.delete(cacheKey)
      this.directRangeBlocks.set(cacheKey, block)
    } else {
      const active = this.directRangeBlockLoads.get(cacheKey)
      const pending = active ?? this.fetchDirectRangeBlock(url, blockStart, blockSize, signal)
        .finally(() => this.directRangeBlockLoads.delete(cacheKey))
      if (!active) this.directRangeBlockLoads.set(cacheKey, pending)
      block = await pending
      if (!this.directRangeBlocks.has(cacheKey)) {
        this.directRangeBlocks.set(cacheKey, block)
        this.directRangeBlockBytes += block.bytes.length
        while (this.directRangeBlockBytes > MAX_DIRECT_RANGE_CACHE_BYTES && this.directRangeBlocks.size > 1) {
          const oldestKey = this.directRangeBlocks.keys().next().value!
          const oldest = this.directRangeBlocks.get(oldestKey)!
          this.directRangeBlocks.delete(oldestKey)
          this.directRangeBlockBytes -= oldest.bytes.length
        }
      }
    }
    const relative = offset - block.start
    if (relative < 0 || relative >= block.bytes.length) return new Uint8Array()
    return block.bytes.subarray(relative, Math.min(block.bytes.length, relative + limit))
  }

  private async fetchDirectRangeBlock(
    url: string,
    start: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<CachedDirectRangeBlock> {
    const response = await this.fetchImpl(url, {
      headers: { 'accept-encoding': 'identity', range: `bytes=${start}-${start + size - 1}` },
      signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(await nativeResponseError(response))
    if (response.status !== 206) {
      await discardResponseBody(response)
      throw new Error('QQNT direct media origin stopped honoring byte ranges')
    }
    const contentRange = response.headers.get('content-range') ?? ''
    if (!new RegExp(`^bytes\\s+${start}-`, 'i').test(contentRange)) {
      await discardResponseBody(response)
      throw new Error('QQNT direct media origin returned a mismatched byte range')
    }
    return { start, bytes: new Uint8Array(await response.arrayBuffer()) }
  }

  private async probeDirectRange(url: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, {
        // QQ multimedia has URLs that return `200` with an empty body for the
        // degenerate 0-0 probe while serving every real multi-byte range as
        // proper 206. Probe two bytes so capability detection matches the
        // client's actual chunk requests without downloading a full chunk.
        headers: { 'accept-encoding': 'identity', range: 'bytes=0-1' },
        signal,
        redirect: 'follow',
      })
      const supported = response.status === 206 && /^bytes\s+0-1\//i.test(response.headers.get('content-range') ?? '')
      await discardResponseBody(response)
      return supported
    } catch {
      return false
    }
  }

  private markDirectRangeSupport(key: string, supportsRange: boolean): void {
    const resolved = this.directUrls.get(key)
    if (resolved) this.rememberDirectUrl(key, { ...resolved, supportsRange })
  }

  private async cachedUnrangedFile(
    key: string,
    url: string,
  ): Promise<CachedUnrangedFile | undefined> {
    const cached = this.unrangedFiles.get(key)
    if (cached) {
      this.unrangedFiles.delete(key)
      this.unrangedFiles.set(key, cached)
      return cached
    }
    const active = this.unrangedFileLoads.get(key)
    const pending = active ?? this.fetchUnrangedFile(key, url)
      .finally(() => this.unrangedFileLoads.delete(key))
    if (!active) this.unrangedFileLoads.set(key, pending)
    const bytes = await pending
    this.rememberUnrangedFile(key, bytes)
    return bytes
  }

  private async fetchUnrangedFile(
    key: string,
    url: string,
  ): Promise<CachedUnrangedFile> {
    const response = await this.fetchImpl(url, {
      headers: { 'accept-encoding': 'identity' }, redirect: 'follow',
    })
    if (!response.ok) throw new Error(await nativeResponseError(response))
    return this.cacheUnrangedResponse(key, response)
  }

  private async cacheUnrangedResponse(key: string, response: Response): Promise<CachedUnrangedFile> {
    if (!response.body) throw new Error('QQNT native media response has no body')
    await mkdir(this.unrangedCachePath, { recursive: true })
    const digest = createHash('sha256').update(key).digest('hex')
    const path = join(this.unrangedCachePath, digest)
    await rm(path, { force: true })
    const file = await open(path, 'wx')
    const cached: CachedUnrangedFile = {
      path, size: 0, complete: false, accounted: false, waiters: new Set(),
    }
    // Keep consuming the single whole-file response after the first Telegram
    // getFile chunk has been satisfied. Later 128 KiB requests wait only for
    // their byte boundary to reach disk instead of starting another HTTP GET.
    void this.populateUnrangedFile(key, cached, response, file)
    return cached
  }

  private async populateUnrangedFile(
    key: string,
    cached: CachedUnrangedFile,
    response: Response,
    file: FileHandle,
  ): Promise<void> {
    const reader = response.body!.getReader()
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          completed = true
          break
        }
        if (!value?.length) continue
        let offset = 0
        while (offset < value.length) {
          const { bytesWritten } = await file.write(value, offset, value.length - offset, null)
          if (!bytesWritten) throw new Error('QQNT unranged cache write made no progress')
          offset += bytesWritten
        }
        cached.size += value.length
        notifyUnrangedFileWaiters(cached)
      }
    } catch (error) {
      cached.error = error
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      await file.close().catch(() => undefined)
      cached.complete = true
      notifyUnrangedFileWaiters(cached)
      if (cached.error) {
        if (this.unrangedFiles.get(key) === cached) this.unrangedFiles.delete(key)
        await rm(cached.path, { force: true }).catch(() => undefined)
      } else {
        this.accountCompletedUnrangedFile(key, cached)
      }
    }
  }

  private async *readCachedUnrangedFile(
    cached: CachedUnrangedFile,
    offset: number,
    limit: number | undefined,
    options: { signal?: AbortSignal, onChunk?(size: number): Promise<void> | void },
  ): AsyncIterable<Uint8Array> {
    const requiredSize = limit === undefined ? Number.POSITIVE_INFINITY : offset + limit
    while (!cached.complete && cached.size < requiredSize) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('download aborted')
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          options.signal?.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          cached.waiters.delete(wake)
          reject(options.signal?.reason ?? new Error('download aborted'))
        }
        cached.waiters.add(wake)
        options.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (cached.error) throw cached.error
    if (offset >= cached.size) return
    const end = limit === undefined
      ? cached.size - 1
      : Math.min(cached.size - 1, offset + limit - 1)
    for await (const chunk of createReadStream(cached.path, { start: offset, end, signal: options.signal })) {
      const bytes = new Uint8Array(chunk)
      await options.onChunk?.(bytes.length)
      yield bytes
    }
  }

  private rememberUnrangedFile(key: string, cached: CachedUnrangedFile): void {
    if (cached.error) return
    const previous = this.unrangedFiles.get(key)
    if (previous === cached) {
      this.unrangedFiles.delete(key)
      this.unrangedFiles.set(key, cached)
      return
    }
    if (previous?.accounted) this.unrangedFileBytes -= previous.size
    this.unrangedFiles.delete(key)
    this.unrangedFiles.set(key, cached)
    if (previous && previous.path !== cached.path) void rm(previous.path, { force: true }).catch(() => undefined)
    if (cached.complete && !cached.error) this.accountCompletedUnrangedFile(key, cached)
  }

  private accountCompletedUnrangedFile(key: string, cached: CachedUnrangedFile): void {
    if (this.unrangedFiles.get(key) !== cached || cached.accounted) return
    cached.accounted = true
    this.unrangedFileBytes += cached.size
    this.evictUnrangedFiles()
  }

  private evictUnrangedFiles(): void {
    while (this.unrangedFileBytes > MAX_UNRANGED_CACHE_BYTES
      || this.unrangedFiles.size > MAX_UNRANGED_CACHE_ENTRIES) {
      // Retain one oversized file so its later upload.getFile chunks never
      // fall back to re-downloading the same whole response.
      if (this.unrangedFiles.size <= 1) return
      const oldest = [...this.unrangedFiles].find(([, cached]) => cached.complete)
      if (!oldest) return
      const [key, removed] = oldest
      this.unrangedFiles.delete(key)
      if (removed.accounted) this.unrangedFileBytes -= removed.size
      void rm(removed.path, { force: true }).catch(() => undefined)
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

  private async revalidatedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const cached = this.revalidatedJsonResponses.get(path)
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      ...init,
      headers: this.headers(cached ? { 'if-none-match': cached.etag } : {}),
    })
    if (response.status === 304) {
      await discardResponseBody(response)
      if (!cached) throw new Error('QQNT bridge returned 304 without a cached response')
      this.revalidatedJsonResponses.delete(path)
      this.revalidatedJsonResponses.set(path, cached)
      return cached.value as T
    }
    const value = await responseJson<T>(response)
    const etag = response.headers.get('etag')
    if (etag) {
      this.revalidatedJsonResponses.delete(path)
      this.revalidatedJsonResponses.set(path, { etag, value })
      if (this.revalidatedJsonResponses.size > MAX_REVALIDATED_JSON_RESPONSES) {
        this.revalidatedJsonResponses.delete(this.revalidatedJsonResponses.keys().next().value!)
      }
    } else {
      this.revalidatedJsonResponses.delete(path)
    }
    return value
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
    if (nullable404 && response.status === 404) {
      await discardResponseBody(response)
      return null as T
    }
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

function sourceReadableStream(source: IMMediaSource, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const iterator = source.stream({ signal })[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) throw signal.reason ?? new Error('upload aborted')
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() { await iterator.return?.() },
  })
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

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return
  await response.body.cancel().catch(() => undefined)
}

function notifyUnrangedFileWaiters(cached: CachedUnrangedFile): void {
  const waiters = [...cached.waiters]
  cached.waiters.clear()
  for (const wake of waiters) wake()
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
    locator.videoCodecFormat ?? null, locator.originImageUrl ?? '', locator.imageSpec ?? null,
    locator.avatarUin ?? '',
  ])
}

function directRangeCapabilityKey(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value
  }
}
