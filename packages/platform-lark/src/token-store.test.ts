import { describe, expect, it } from 'vitest'
import type { JsonObject } from '@mtproto-relay/bridge'
import type { LarkClient } from './client.js'
import { TokenStore, type LarkCredentialBackend } from './token-store.js'
import type { LarkTokenResponse } from './types.js'

class MemoryBackend implements LarkCredentialBackend {
  stored?: JsonObject
  loads = 0

  async load(): Promise<JsonObject | undefined> {
    this.loads++
    return this.stored
  }

  async persist(credentials: JsonObject): Promise<void> {
    this.stored = credentials
  }
}

describe('TokenStore', () => {
  it('persists rotated refresh token before updating memory', async () => {
    const backend = new MemoryBackend()
    const persistedDuringRefresh: string[] = []
    const client = fakeClient({
      refresh: async () => {
        // 刷新返回但尚未持久化：后端里必须仍是旧 refresh_token（可恢复）
        persistedDuringRefresh.push(String((backend.stored as { refreshToken: string }).refreshToken))
        return exchange('u-new', 'r-new')
      },
    })
    backend.stored = state('u-old', 0, 'r-old')
    const store = new TokenStore(backend, { client })
    await store.restore()
    const token = await store.getFreshUserToken()
    expect(token).toBe('u-new')
    expect(persistedDuringRefresh).toEqual(['r-old'])
    // 刷新完成后后端是轮换后的新 refresh_token
    expect((backend.stored as { refreshToken: string }).refreshToken).toBe('r-new')
  })

  it('refreshes once for concurrent callers and reuses a fresh token otherwise', async () => {
    let refreshes = 0
    const client = fakeClient({
      refresh: async () => {
        refreshes++
        await delay(10)
        return exchange('u-1', 'r-1')
      },
    })
    const backend = new MemoryBackend()
    backend.stored = state('u-0', 0, 'r-0')
    const store = new TokenStore(backend, { client })
    await store.restore()
    const tokens = await Promise.all([store.getFreshUserToken(), store.getFreshUserToken()])
    expect(tokens).toEqual(['u-1', 'u-1'])
    expect(refreshes).toBe(1)
    expect(await store.getFreshUserToken()).toBe('u-1')
    expect(refreshes).toBe(1)
  })

  it('restore() parses persisted state and ignores malformed payloads', async () => {
    const backend = new MemoryBackend()
    backend.stored = { refreshToken: 'r', userAccessToken: 'u', openId: 'ou_self', userAccessTokenExpiresAt: 123 }
    const store = new TokenStore(backend, { client: fakeClient({}) })
    expect(await store.restore()).toEqual({
      userAccessToken: 'u',
      userAccessTokenExpiresAt: 123,
      refreshToken: 'r',
      refreshTokenExpiresAt: 0,
      openId: 'ou_self',
    })
    expect(TokenStore.parse({ userAccessToken: 'x' })).toBeUndefined()
    expect(TokenStore.parse('junk')).toBeUndefined()
  })

  it('adopt() persists the exchanged state before enabling it', async () => {
    const backend = new MemoryBackend()
    const store = new TokenStore(backend, { client: fakeClient({}) })
    await store.adopt(exchange('u-1', 'r-1'), 'ou_self', '张三')
    expect(backend.stored).toMatchObject({ userAccessToken: 'u-1', refreshToken: 'r-1', openId: 'ou_self', name: '张三' })
    expect(store.requireSnapshot()).toMatchObject({ openId: 'ou_self' })
  })
})

function state(userAccessToken: string, expiresAt: number, refreshToken: string): JsonObject {
  return {
    userAccessToken,
    userAccessTokenExpiresAt: expiresAt,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
    openId: 'ou_self',
  }
}

function exchange(accessToken: string, refreshToken: string): LarkTokenResponse {
  return {
    access_token: accessToken,
    expires_in: 6900,
    refresh_token: refreshToken,
    refresh_token_expires_in: 2_592_000,
  }
}

function fakeClient(hooks: { refresh?: (token: string) => Promise<LarkTokenResponse> }): LarkClient {
  return {
    refreshUserToken: hooks.refresh ?? (async () => exchange('u-x', 'r-x')),
  } as unknown as LarkClient
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
