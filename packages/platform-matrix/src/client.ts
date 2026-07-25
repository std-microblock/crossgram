import { randomUUID } from 'node:crypto'
import type {
  MatrixDirectAccountData, MatrixEvent, MatrixEventContextResponse, MatrixJoinedRoomsResponse, MatrixMembersResponse,
  MatrixMessagesResponse, MatrixProfile, MatrixSyncResponse, MatrixWhoAmI,
} from './types.js'

export interface MatrixClientOptions {
  homeserver: string
  accessToken: string
  requestTimeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export class MatrixHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'MatrixHttpError'
  }
}

export class MatrixClient {
  readonly homeserver: string
  private readonly accessToken: string
  private readonly requestTimeoutMs: number
  private readonly fetch: typeof globalThis.fetch

  constructor(options: MatrixClientOptions) {
    this.homeserver = options.homeserver.replace(/\/+$/, '')
    this.accessToken = options.accessToken
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.fetch = options.fetch ?? globalThis.fetch
  }

  whoAmI(): Promise<MatrixWhoAmI> {
    return this.request('/_matrix/client/v3/account/whoami')
  }

  getProfile(userId: string): Promise<MatrixProfile> {
    return this.request(`/_matrix/client/v3/profile/${segment(userId)}`)
  }

  getJoinedRooms(): Promise<MatrixJoinedRoomsResponse> {
    return this.request('/_matrix/client/v3/joined_rooms')
  }

  getDirectRooms(userId: string): Promise<MatrixDirectAccountData> {
    return this.request(`/_matrix/client/v3/user/${segment(userId)}/account_data/m.direct`)
  }

  getRoomState(roomId: string): Promise<MatrixEvent[]> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/state`)
  }

  getMembers(roomId: string): Promise<MatrixMembersResponse> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/members`, {
      query: { membership: 'join' },
    })
  }

  getMessages(
    roomId: string,
    options: { from?: string, dir?: 'b' | 'f', limit?: number } = {},
  ): Promise<MatrixMessagesResponse> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/messages`, {
      query: {
        from: options.from,
        dir: options.dir ?? 'b',
        limit: options.limit ?? 20,
      },
    })
  }

  getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/event/${segment(eventId)}`)
  }

  getEventContext(roomId: string, eventId: string): Promise<MatrixEventContextResponse> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/context/${segment(eventId)}`, {
      query: { limit: 0 },
    })
  }

  sync(options: {
    since?: string
    timeout?: number
    fullState?: boolean
    signal?: AbortSignal
  } = {}): Promise<MatrixSyncResponse> {
    return this.request('/_matrix/client/v3/sync', {
      query: {
        since: options.since,
        timeout: options.timeout ?? 0,
        full_state: options.fullState,
      },
      signal: options.signal,
      timeoutMs: (options.timeout ?? 0) + this.requestTimeoutMs,
    })
  }

  async sendEvent(roomId: string, eventType: string, content: unknown, transactionId = randomUUID()): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${segment(roomId)}/send/${segment(eventType)}/${segment(transactionId)}`,
      { method: 'PUT', body: content },
    )
    return response.event_id
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${segment(roomId)}/redact/${segment(eventId)}/${segment(randomUUID())}`,
      { method: 'PUT', body: reason ? { reason } : {} },
    )
    return response.event_id
  }

  async upload(
    source: AsyncIterable<Uint8Array>,
    options: {
      filename?: string
      contentType?: string
      signal?: AbortSignal
      onChunk?: (size: number) => void | Promise<void>
    } = {},
  ): Promise<string> {
    const iterator = source[Symbol.asyncIterator]()
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason ?? new Error('Matrix upload aborted'))
          return
        }
        try {
          const result = await iterator.next()
          if (result.done) {
            controller.close()
            return
          }
          const chunk = result.value.slice()
          await options.onChunk?.(chunk.length)
          controller.enqueue(chunk)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel: async () => { await iterator.return?.() },
    })
    const response = await this.request<{ content_uri: string }>('/_matrix/media/v3/upload', {
      method: 'POST',
      query: { filename: options.filename },
      headers: options.contentType ? { 'content-type': options.contentType } : undefined,
      binaryBody: body,
      signal: options.signal,
    })
    return response.content_uri
  }

  async download(mxc: string, options: { signal?: AbortSignal, timeoutMs?: number } = {}): Promise<Response> {
    const { serverName, mediaId } = parseMxc(mxc)
    return this.rawRequest(`/_matrix/media/v3/download/${segment(serverName)}/${segment(mediaId)}`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  }

  markRead(roomId: string, eventId: string): Promise<unknown> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/read_markers`, {
      method: 'POST',
      body: { 'm.fully_read': eventId, 'm.read': eventId },
    })
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.rawRequest(path, options)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private async rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(path, `${this.homeserver}/`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const headers = new Headers(options.headers)
    headers.set('authorization', `Bearer ${this.accessToken}`)
    let body: BodyInit | undefined
    if (options.binaryBody !== undefined) {
      body = options.binaryBody
    } else if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.body)
    }
    const init: RequestInit & { duplex?: 'half' } = { method: options.method ?? 'GET', headers, body, signal }
    if (body instanceof ReadableStream) init.duplex = 'half'
    const response = await this.fetch(url, init)
    if (response.ok) return response
    const error = await response.json().catch(() => ({})) as { errcode?: string, error?: string }
    throw new MatrixHttpError(
      response.status,
      error.errcode,
      error.error ?? `Matrix request failed with HTTP ${response.status}`,
    )
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  query?: Record<string, string | number | boolean | undefined>
  headers?: HeadersInit
  body?: unknown
  binaryBody?: BodyInit
  signal?: AbortSignal
  timeoutMs?: number
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

export function parseMxc(value: string): { serverName: string, mediaId: string } {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(value)
  if (!match) throw new Error(`invalid Matrix content URI: ${value}`)
  return { serverName: match[1]!, mediaId: match[2]! }
}
