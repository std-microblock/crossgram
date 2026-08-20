import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import type { Context } from 'cordis'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'
import { createSessionResolver, finalizeAuthorizedSession } from './index.js'
import type { BridgeSessionState } from './bridge-service.js'
import type { PlatformSession } from './platform.js'

const authKeyId = new Uint8Array(8).fill(0x11)
const session = {
  platformId: 'qqnt', platformSessionId: 'qq-main', userId: 'self', credentials: {}, metadata: {},
}

function createRpc(connection: object, platformData: { value: BridgeSessionState | null }): ServerRpcContext {
  return {
    connection: connection as ServerRpcContext['connection'],
    apiLayer: 228,
    authKeyId,
    sessionId: Long.ONE,
    isAuthorized: true,
    clientInfo: {
      apiId: 2040, deviceModel: 'Desktop', systemVersion: 'Linux', appVersion: '1.0',
      systemLangCode: 'en', langPack: 'tdesktop', langCode: 'en',
    },
    connectedAt: 1,
    lastActiveAt: 1,
    sendUpdate() {},
    getPlatformData: <T>() => platformData.value as T,
    setPlatformData: (value) => { platformData.value = value as BridgeSessionState },
  }
}

function setup(onAuthorizedSession: (session: PlatformSession, authKey: string, rpc: ServerRpcContext) => Promise<void>) {
  const platform = { platformKind: 'qq' }
  const context = {
    database: {
      get: vi.fn(async (table: string) => {
        if (table === 'mtproto_auth_binding') return [{ ...session }]
        if (table === 'mtproto_platform_session') return [{ ...session, id: session.platformSessionId, active: true }]
        if (table === 'mtproto_auth_session') return [{ virtualPhone: '888000000000' }]
        throw new Error(`unexpected table: ${table}`)
      }),
    },
  } as unknown as Context
  const subscriptions = { ensure: vi.fn(async () => {}) }
  const resolve = createSessionResolver(
    context,
    { get: vi.fn(() => platform) } as never,
    () => ({}) as never,
    () => ({}) as never,
    {} as never,
    { getUser: vi.fn(async () => ({ id: 1 })) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    subscriptions as never,
    {} as never,
    {} as never,
    {},
    async () => {},
    undefined,
    1,
    undefined,
    onAuthorizedSession,
  )
  return { resolve, subscriptions }
}

describe('createSessionResolver authorization lifecycle', () => {
  it('authorizes each live connection once when contexts share an auth-key cache', async () => {
    const onAuthorizedSession = vi.fn<(session: PlatformSession, authKey: string, rpc: ServerRpcContext) => Promise<void>>(async () => {})
    const { resolve } = setup(onAuthorizedSession)
    const platformData = { value: null as BridgeSessionState | null }
    const first = createRpc({}, platformData)
    const second = createRpc({}, platformData)

    await resolve(first)
    await resolve(first)
    await resolve(second)
    await resolve(second)

    expect(onAuthorizedSession).toHaveBeenCalledTimes(2)
    expect(onAuthorizedSession.mock.calls.map(([, , rpc]) => rpc.connection)).toEqual([
      first.connection, second.connection,
    ])
  })

  it('finalizes provisional authorization after binding persistence and retries failures once', async () => {
    let bindingPersisted = false
    const onAuthorizedSession = vi.fn<(session: PlatformSession, authKey: string, rpc: ServerRpcContext) => Promise<void>>()
      .mockImplementationOnce(async () => { expect(bindingPersisted).toBe(true) })
      .mockRejectedValueOnce(new Error('replay failed'))
      .mockResolvedValueOnce(undefined)
    const { resolve } = setup(onAuthorizedSession)
    const platformData = { value: null as BridgeSessionState | null }
    const first = createRpc({}, platformData)
    const second = createRpc({}, platformData)

    const provisional = await resolve(first, { platformId: session.platformId, platformSessionId: session.platformSessionId }, false)
    expect(onAuthorizedSession).not.toHaveBeenCalled()
    await finalizeAuthorizedSession(first, provisional, async () => { bindingPersisted = true }, resolve)
    expect(onAuthorizedSession).toHaveBeenCalledTimes(1)
    await resolve(first)
    expect(onAuthorizedSession).toHaveBeenCalledTimes(1)
    await expect(resolve(second)).rejects.toThrow('replay failed')
    await resolve(second)

    expect(onAuthorizedSession).toHaveBeenCalledTimes(3)
    expect(onAuthorizedSession.mock.calls.map(([, , rpc]) => rpc.connection)).toEqual([
      first.connection, second.connection, second.connection,
    ])
  })
})
