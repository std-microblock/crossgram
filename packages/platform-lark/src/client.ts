import { fetch as undiciFetch, ProxyAgent as UndiciProxyAgent } from 'undici'
import type { LarkChat, LarkMessage, LarkTokenResponse, LarkUserInfo } from './types.js'

export interface LarkClientOptions {
  baseUrl: string
  appId: string
  appSecret: string
  proxy?: string
  requestTimeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export class LarkApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    readonly msg: string,
  ) {
    super(`Lark API ${code}: ${msg} (HTTP ${status})`)
    this.name = 'LarkApiError'
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'
  query?: Record<string, string | number | undefined>
  jsonBody?: unknown
  formBody?: FormData
  /** Bearer user_access_token；缺省用 tenant_access_token。 */
  userToken?: string
  /** 凭据接口自身不带 Bearer（否则递归获取 tenant token）。 */
  skipAuth?: boolean
  signal?: AbortSignal
}

export class LarkClient {
  readonly baseUrl: string
  private readonly appId: string
  private readonly appSecret: string
  private readonly requestTimeoutMs: number
  private readonly fetch: typeof globalThis.fetch
  private readonly proxyDispatcher?: UndiciProxyAgent

  constructor(options: LarkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    const proxy = normalizeHttpProxy(options.proxy)
    if (options.fetch) {
      this.fetch = options.fetch
    } else if (proxy) {
      this.proxyDispatcher = new UndiciProxyAgent(proxy)
      this.fetch = ((input, init) => undiciFetch(input as string | URL, {
        ...(init as import('undici').RequestInit),
        dispatcher: this.proxyDispatcher,
      }) as unknown as Promise<Response>) as typeof globalThis.fetch
    } else {
      this.fetch = globalThis.fetch
    }
  }

  async close(): Promise<void> {
    await this.proxyDispatcher?.close()
  }

  buildAuthorizeUrl(redirectUri: string, state: string): string {
    const url = new URL('/open-apis/authen/v2/authorize', this.baseUrl)
    url.searchParams.set('client_id', this.appId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    return url.toString()
  }

  async exchangeCode(code: string, redirectUri: string): Promise<LarkTokenResponse> {
    const form = new FormData()
    form.set('grant_type', 'authorization_code')
    form.set('client_id', this.appId)
    form.set('client_secret', this.appSecret)
    form.set('code', code)
    form.set('redirect_uri', redirectUri)
    return this.request<LarkTokenResponse>('/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      formBody: form,
      skipAuth: true,
    })
  }

  async refreshUserToken(refreshToken: string): Promise<LarkTokenResponse> {
    const form = new FormData()
    form.set('grant_type', 'refresh_token')
    form.set('client_id', this.appId)
    form.set('client_secret', this.appSecret)
    form.set('refresh_token', refreshToken)
    return this.request<LarkTokenResponse>('/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      formBody: form,
      skipAuth: true,
    })
  }

  getUserInfo(userToken: string, signal?: AbortSignal): Promise<LarkUserInfo> {
    return this.request('/open-apis/authen/v1/user_info', { userToken, signal })
  }

  getChats(userToken: string, options: { pageSize?: number, pageToken?: string } = {}) {
    return this.request<{ items?: LarkChat[], has_more?: boolean, page_token?: string }>(
      '/open-apis/im/v1/chats',
      { userToken, query: { page_size: options.pageSize, page_token: options.pageToken } },
    )
  }

  async getChat(userToken: string, chatId: string): Promise<LarkChat | null> {
    const body = await this.request<LarkChat>(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { userToken })
      .catch((error: unknown) => {
        if (error instanceof LarkApiError && CHAT_UNAVAILABLE_CODES.has(error.code)) return null
        throw error
      })
    return body ?? null
  }

  sendMessage(
    userToken: string,
    message: { receiveId: string, msgType: string, content: string, replyToMessageId?: string },
    signal?: AbortSignal,
  ): Promise<{ message_id: string }> {
    return this.request('/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      jsonBody: {
        receive_id: message.receiveId,
        msg_type: message.msgType,
        content: message.content,
        ...(message.replyToMessageId ? { reply_to_message_id: message.replyToMessageId } : {}),
      },
      userToken,
      signal,
    })
  }

  async getMessage(userToken: string, messageId: string): Promise<LarkMessage | null> {
    const raw = await this.request<LarkMessage>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { userToken },
    ).catch((error: unknown) => {
      if (error instanceof LarkApiError && MESSAGE_UNAVAILABLE_CODES.has(error.code)) return null
      throw error
    })
    return raw ? normalizeRestMessage(raw) : null
  }

  async listMessages(
    userToken: string,
    options: {
      containerId: string
      startTime?: number
      endTime?: number
      sortType?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc'
      pageSize?: number
      pageToken?: string
      signal?: AbortSignal
    },
  ): Promise<{ items: LarkMessage[], has_more?: boolean, page_token?: string }> {
    const body = await this.request<{ items?: LarkMessage[], has_more?: boolean, page_token?: string }>(
      '/open-apis/im/v1/messages',
      {
        userToken,
        query: {
          container_id_type: 'chat',
          container_id: options.containerId,
          start_time: options.startTime,
          end_time: options.endTime,
          sort_type: options.sortType,
          page_size: options.pageSize,
          page_token: options.pageToken,
        },
        signal: options.signal,
      },
    )
    return {
      items: (body.items ?? []).map(normalizeRestMessage),
      has_more: body.has_more,
      page_token: body.page_token,
    }
  }

  recallMessage(userToken: string, messageId: string): Promise<void> {
    return this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      userToken,
    })
  }

  async uploadImage(
    userToken: string,
    source: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const form = new FormData()
    form.set('image_type', 'message')
    form.set('image', await toBlob(source, 'image/png'))
    const body = await this.request<{ image_key: string }>('/open-apis/im/v1/images', {
      method: 'POST',
      formBody: form,
      userToken,
      signal: options.signal,
    })
    return body.image_key
  }

  async uploadFile(
    userToken: string,
    source: AsyncIterable<Uint8Array>,
    options: { fileName: string, signal?: AbortSignal },
  ): Promise<string> {
    const form = new FormData()
    form.set('file_type', 'stream')
    form.set('file_name', options.fileName || 'file')
    form.set('file', await toBlob(source, 'application/octet-stream'))
    const body = await this.request<{ file_key: string }>('/open-apis/im/v1/files', {
      method: 'POST',
      formBody: form,
      userToken,
      signal: options.signal,
    })
    return body.file_key
  }

  async uploadAudio(
    userToken: string,
    source: AsyncIterable<Uint8Array>,
    options: { fileName: string, signal?: AbortSignal },
  ): Promise<string> {
    const form = new FormData()
    form.set('audio_type', 'opus')
    form.set('file_name', options.fileName || 'audio.opus')
    form.set('audio', await toBlob(source, 'audio/ogg'))
    const body = await this.request<{ file_key: string }>('/open-apis/im/v1/audios', {
      method: 'POST',
      formBody: form,
      userToken,
      signal: options.signal,
    })
    return body.file_key
  }

  downloadResource(
    userToken: string,
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.rawRequest(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      { query: { type }, userToken, signal },
    )
  }

  private async request<T>(path: string, options: RequestOptions & { unwrap?: boolean } = {}): Promise<T> {
    return this.rawJson<T>(path, { ...options, unwrap: options.unwrap ?? true })
  }

  private async rawJson<T>(
    path: string,
    options: RequestOptions & { unwrap: boolean },
  ): Promise<T> {
    let attempt = 0
    while (true) {
      try {
        const response = await this.rawRequest(path, options)
        const body = await response.json().catch(() => null)
        const payload = body as { code?: number, msg?: string, data?: T } | null
        if (payload && typeof payload.code === 'number' && payload.code !== 0) {
          throw new LarkApiError(response.status, payload.code, payload.msg ?? 'unknown error')
        }
        if (options.unwrap && payload && 'data' in payload) return payload.data as T
        return payload as T
      } catch (error) {
        if (error instanceof LarkApiError && (error.status === 429 || error.status >= 500) && attempt < 2) {
          await delay(1000 * 2 ** attempt++)
          continue
        }
        throw error
      }
    }
  }

  private async rawRequest(path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(path, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const headers = new Headers()
    if (!options.skipAuth) {
      // 全部业务接口以 user_access_token 调用（app 态仅用于 WS 事件长连接握手）
      if (!options.userToken) throw new Error(`Lark request without user token: ${path}`)
      headers.set('authorization', `Bearer ${options.userToken}`)
    }
    let body: BodyInit | undefined
    if (options.jsonBody !== undefined) {
      headers.set('content-type', 'application/json; charset=utf-8')
      body = JSON.stringify(options.jsonBody)
    } else if (options.formBody !== undefined) {
      body = options.formBody
    }
    const response = await this.fetch(url, { method: options.method ?? 'GET', headers, body, signal })
    if (response.ok) return response
    const errorBody = await response.json().catch(() => null) as { code?: number, msg?: string } | null
    const code = errorBody?.code ?? response.status
    throw new LarkApiError(response.status, code, errorBody?.msg ?? `HTTP ${response.status}`)
  }
}

// 230001 会话不存在 / 230002 机器人不在会话内
const CHAT_UNAVAILABLE_CODES = new Set([230001, 230002])
// 230027 权限不足（无权查看该消息）等
const MESSAGE_UNAVAILABLE_CODES = new Set([230001, 230027])

/** REST 原始消息（msg_type、body.content、sender.id）规范化为统一的 LarkMessage。 */
function normalizeRestMessage(raw: LarkMessage & { msg_type?: string, message_type?: string }): LarkMessage {
  return {
    ...raw,
    messageType: raw.messageType ?? raw.message_type ?? raw.msg_type ?? 'unknown',
    content: raw.content ?? raw.body?.content ?? '{}',
    sender: raw.sender?.sender_id
      ? raw.sender
      : { ...raw.sender, sender_id: { open_id: raw.sender?.id } },
  }
}

async function toBlob(source: AsyncIterable<Uint8Array>, type: string): Promise<Blob> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return new Blob(chunks as BlobPart[], { type })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeHttpProxy(input?: string): string | undefined {
  if (!input?.trim()) return undefined
  const url = new URL(input.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Lark proxy must use http:// or https://: ${url.protocol}`)
  }
  return url.toString()
}
