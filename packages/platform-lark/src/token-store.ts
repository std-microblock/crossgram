import type { JsonObject } from '@mtproto-relay/bridge'
import type { LarkClient } from './client.js'
import type { LarkTokenResponse } from './types.js'

export interface LarkTokenState {
  userAccessToken: string
  /** 毫秒时间戳。 */
  userAccessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
  openId: string
  name?: string
}

/** 凭据持久化后端；生产为 bridge 数据库 `mtproto_platform_session.credentials`。 */
export interface LarkCredentialBackend {
  load(): Promise<JsonObject | undefined>
  persist(credentials: JsonObject): Promise<void>
}

interface TokenStoreDeps {
  client: LarkClient
  logger?: { warn: (format: string, ...args: unknown[]) => void }
  /** 测试注入时钟。 */
  now?: () => number
}

/** 管理 user_access_token 刷新；refresh_token 每次轮换，必须先落盘再使用。 */
export class TokenStore {
  private state?: LarkTokenState
  private readonly backend: LarkCredentialBackend
  private readonly client: LarkClient
  private readonly logger?: TokenStoreDeps['logger']
  private readonly now: () => number
  private refreshing?: Promise<string>

  constructor(backend: LarkCredentialBackend, deps: TokenStoreDeps) {
    this.backend = backend
    this.client = deps.client
    this.logger = deps.logger
    this.now = deps.now ?? (() => Date.now())
  }

  static parse(raw: unknown): LarkTokenState | undefined {
    const candidate = raw as Partial<LarkTokenState> | null | undefined
    if (typeof candidate?.refreshToken === 'string' && candidate.refreshToken
      && typeof candidate?.userAccessToken === 'string' && candidate.userAccessToken
      && typeof candidate?.openId === 'string' && candidate.openId) {
      return {
        userAccessToken: candidate.userAccessToken,
        userAccessTokenExpiresAt: Number(candidate.userAccessTokenExpiresAt ?? 0),
        refreshToken: candidate.refreshToken,
        refreshTokenExpiresAt: Number(candidate.refreshTokenExpiresAt ?? 0),
        openId: candidate.openId,
        ...(candidate.name !== undefined ? { name: candidate.name } : {}),
      }
    }
    return undefined
  }

  /** 惰性恢复持久化状态；内存已有则原样返回。 */
  async restore(): Promise<LarkTokenState | undefined> {
    if (this.state) return this.state
    const state = TokenStore.parse(await this.backend.load())
    if (state) this.state = state
    return state
  }

  /** OAuth 交换完成：先落盘再启用新状态。 */
  async adopt(exchange: LarkTokenResponse, openId: string, name?: string): Promise<LarkTokenState> {
    const next = fromExchange(exchange, openId, name, this.now())
    await this.backend.persist(toCredentials(next))
    this.state = next
    return next
  }

  /** 当前快照，provision 覆盖 credentials 时必须整份返回。 */
  requireSnapshot(): LarkTokenState {
    if (!this.state) throw new Error('Lark token state is not restored')
    return this.state
  }

  get openId(): string {
    return this.requireSnapshot().openId
  }

  /** 返回可用的 user_access_token；剩余不足 5 分钟时刷新（并发调用共享同一刷新）。 */
  async getFreshUserToken(): Promise<string> {
    const state = this.state ?? await this.restore()
    if (!state) throw new Error('Lark account is not authorized')
    if (state.userAccessTokenExpiresAt - this.now() > 5 * 60_000) return state.userAccessToken
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    const previous = this.requireSnapshot()
    const exchange = await this.client.refreshUserToken(previous.refreshToken)
    // 轮换协议：旧 refresh_token 已失效，先持久化新 refresh_token 再更新内存
    const next: LarkTokenState = {
      userAccessToken: exchange.access_token,
      userAccessTokenExpiresAt: this.now() + exchange.expires_in * 1000,
      refreshToken: exchange.refresh_token,
      refreshTokenExpiresAt: this.now() + exchange.refresh_token_expires_in * 1000,
      openId: previous.openId,
      ...(previous.name !== undefined ? { name: previous.name } : {}),
    }
    await this.backend.persist(toCredentials(next))
    this.state = next
    return next.userAccessToken
  }
}

function toCredentials(state: LarkTokenState): JsonObject {
  return state as unknown as JsonObject
}

function fromExchange(exchange: LarkTokenResponse, openId: string, name: string | undefined, now: number): LarkTokenState {
  return {
    userAccessToken: exchange.access_token,
    userAccessTokenExpiresAt: now + exchange.expires_in * 1000,
    refreshToken: exchange.refresh_token,
    refreshTokenExpiresAt: now + exchange.refresh_token_expires_in * 1000,
    openId,
    ...(name !== undefined ? { name } : {}),
  }
}
