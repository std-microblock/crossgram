import type { ComWeChatContact, ComWeChatResponse } from './types.js'

export interface ComWeChatClientOptions {
  endpoint: string
  requestTimeoutMs?: number
  fetch?: typeof globalThis.fetch
  onWarning?: (message: string) => void
}

export class ComWeChatClient {
  readonly endpoint: string
  private readonly requestTimeoutMs: number
  private readonly fetch: typeof globalThis.fetch
  private readonly onWarning?: (message: string) => void

  constructor(options: ComWeChatClientOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint)
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.fetch = options.fetch ?? globalThis.fetch
    this.onWarning = options.onWarning
  }

  async isLoggedIn(): Promise<boolean> {
    const response = await this.request(0, {})
    return response.is_login === 1 || response.is_login === '1'
  }

  getSelfInfo(): Promise<ComWeChatResponse> {
    return this.request(1, {})
  }

  startCallback(port: number): Promise<ComWeChatResponse> {
    return this.request(9, { port })
  }

  stopCallback(): Promise<ComWeChatResponse> {
    return this.request(10, {})
  }

  async getContacts(): Promise<ComWeChatContact[]> {
    return listFromResponse(await this.request(15, {}), 'contacts', this.onWarning)
  }

  async getGroupMembers(chatroomId: string): Promise<ComWeChatContact[]> {
    return groupMembersFromResponse(await this.request(25, { chatroom_id: chatroomId }), this.onWarning)
  }

  getGroupMemberNickname(chatroomId: string, wxid: string): Promise<ComWeChatResponse> {
    return this.request(26, { chatroom_id: chatroomId, wxid })
  }

  async request(type: number, body: Record<string, unknown>): Promise<ComWeChatResponse> {
    const url = new URL(this.endpoint)
    url.searchParams.set('type', String(type))
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    let response: Response
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeout,
      })
    } catch (error) {
      throw new Error(`ComWeChat request type ${type} failed`, { cause: error })
    }
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(`ComWeChat request type ${type} returned HTTP ${response.status}`)
    if (!isObject(payload)) throw new Error(`ComWeChat request type ${type} returned a non-object response`)
    return payload
  }
}

export function normalizeEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ComWeChat endpoint must use http:// or https://: ${url.protocol}`)
  }
  return url.toString()
}

function listFromResponse(
  response: ComWeChatResponse,
  label: string,
  onWarning?: (message: string) => void,
): ComWeChatContact[] {
  const data = response.data
  if (Array.isArray(data)) return data.filter(isObject)
  if (isObject(data) && Array.isArray(data.members)) return data.members.filter(isObject)
  if (Array.isArray(response.members)) return response.members.filter(isObject)
  onWarning?.(`ComWeChat ${label} response has no supported array payload`)
  return []
}

function groupMembersFromResponse(response: ComWeChatResponse, onWarning?: (message: string) => void): ComWeChatContact[] {
  if (typeof response.members === 'string') {
    return [...new Set(response.members.split('^G').filter(Boolean))].map(wxid => ({ wxid }))
  }
  const data = response.data
  if (Array.isArray(data)) return data.filter(isObject)
  if (isObject(data) && Array.isArray(data.members)) return data.members.filter(isObject)
  if (Array.isArray(response.members)) return response.members.filter(isObject)
  onWarning?.('ComWeChat group members response has no supported members payload')
  return []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
