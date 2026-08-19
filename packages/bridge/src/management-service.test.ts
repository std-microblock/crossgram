import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import {
  BridgeManagementService, type BridgeManagementSource,
} from './management-service.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

class FakeMtproto extends Service {
  config = { host: '0.0.0.0' }
  port = 4430
  activeConnectionCount = 3
  authorizedConnectionCount = 2

  constructor(ctx: Context) {
    super(ctx, 'mtproto')
  }
}

async function createFixture() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  new FakeMtproto(ctx)
  defineModels(ctx)
  await ctx.database.prepared()
  const refresh = vi.fn(async () => {})
  const refreshStickers = vi.fn(async () => {})
  const approveLoginToken = vi.fn()
  const setStickerPackAssigned = vi.fn(async () => {})
  const source: BridgeManagementSource = {
    serverConfig: () => ({
      name: 'CrossGram', enable_special_config: false, host: 'relay.example.com', port: 4430,
      rsa_key: 'public-key', dcs: [{ id: 1, ip: 'relay.example.com', port: 4430 }],
    }),
    accounts: () => [
      {
        platformId: 'qq-main', platformKind: 'qq', status: 'ready', displayName: 'Alice',
        userId: '10001', virtualPhone: '+999000000000001', loginCode: '123456', validUntil: 60_000,
      },
      { platformId: 'discord', platformKind: 'discord', status: 'error', error: 'offline' },
    ],
    registeredPlatformIds: () => ['qq-main', 'discord'],
    activeSessions: () => [{
      platformId: 'qq-main', platformSessionId: 'session-a', userId: '10001',
      credentials: { token: 'must-not-leak' }, metadata: { firstName: 'Alice' },
    }],
    refresh,
    approveLoginToken,
    stickers: () => ({
      accounts: [{
        platformId: 'qq-main', platformSessionId: 'session-a', platformKind: 'qq',
        displayName: 'Alice', userId: '10001',
      }, {
        platformId: 'discord', platformSessionId: 'session-b', platformKind: 'discord',
        displayName: 'Bob', userId: 'bob',
      }],
      packs: [{
        providerId: 'qq-main', packId: 'pack-one', title: '收藏',
        assignments: [
          { platformSessionId: 'session-a', assigned: true, automatic: false },
          { platformSessionId: 'session-b', assigned: false, automatic: false },
        ],
      }],
      updatedAt: 42,
    }),
    refreshStickers,
    setStickerPackAssigned,
  }
  const service = new BridgeManagementService(ctx, source)
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return { ctx, service, refresh, refreshStickers, approveLoginToken, setStickerPackAssigned }
}

async function seed(ctx: Context) {
  await ctx.database.create('mtproto_platform_session', {
    id: 'session-a', platformId: 'qq-main', userId: '10001', credentials: { token: 'secret-a' },
    metadata: { firstName: 'Alice' }, active: true, createdAt: new Date(1_000),
  })
  await ctx.database.create('mtproto_platform_session', {
    id: 'session-b', platformId: 'discord', userId: 'bob', credentials: { token: 'secret-b' },
    metadata: {}, active: false, createdAt: new Date(2_000),
  })
  await ctx.database.create('mtproto_auth_session', {
    id: 'identity-a', virtualPhone: '999000000000001', totpSecret: 'seed-must-not-leak',
    platformId: 'qq-main', platformSessionId: 'session-a',
  })
  await ctx.database.create('mtproto_auth_binding', {
    authKeyId: 'auth-a', platformId: 'qq-main', platformSessionId: 'session-a',
  })
  await ctx.database.create('mtproto_client_authorization', {
    authKeyId: 'auth-a', platformSessionId: 'session-a', apiId: 2040,
    deviceModel: 'Desktop', platform: 'Windows', systemVersion: '11',
    appName: 'Telegram Desktop', appVersion: '6.1', dateCreated: 10, dateActive: 20,
    ip: '203.0.113.10', country: 'Unknown', region: '', encryptedRequestsDisabled: false,
    callRequestsDisabled: false, unconfirmed: false,
  })
}

describe('BridgeManagementService', () => {
  it('collects runtime/storage status and scoped identities without exposing durable secrets', async () => {
    const { ctx, service } = await createFixture()
    await seed(ctx)

    await expect(service.status()).resolves.toMatchObject({
      mtproto: { host: '0.0.0.0', port: 4430, activeConnections: 3, authorizedConnections: 2 },
      platforms: { registered: ['discord', 'qq-main'], activeSessions: 1 },
      storage: {
        platformSessions: 2, activePlatformSessions: 1, identities: 1,
        authBindings: 1, clientAuthorizations: 1,
      },
    })
    const identities = await service.identities('session-a')
    expect(identities).toEqual([{
      platformId: 'qq-main', platformSessionId: 'session-a', userId: '10001', active: true,
      createdAt: 1_000, virtualPhone: '+999000000000001', loginCode: '123456',
      loginCodeValidUntil: 60_000, authBindingCount: 1, clientAuthorizationCount: 1,
    }])
    expect(JSON.stringify({ status: await service.status(), identities })).not.toMatch(
      /seed-must-not-leak|secret-a|credentials|totpSecret/i,
    )
  })

  it('filters account, client and sticker views to one platform session and returns defensive copies', async () => {
    const { ctx, service } = await createFixture()
    await seed(ctx)

    expect(service.accounts('session-a')).toEqual([expect.objectContaining({ platformId: 'qq-main' })])
    await expect(service.clientAuthorizations('session-a')).resolves.toEqual([
      expect.objectContaining({ authKeyId: 'auth-a', deviceModel: 'Desktop' }),
    ])
    const stickers = service.stickers('session-a')
    expect(stickers).toEqual({
      accounts: [expect.objectContaining({ platformSessionId: 'session-a' })],
      packs: [expect.objectContaining({
        packId: 'pack-one', assignments: [{ platformSessionId: 'session-a', assigned: true, automatic: false }],
      })],
      updatedAt: 42,
    })
    stickers.accounts[0]!.displayName = 'mutated'
    stickers.packs[0]!.assignments[0]!.assigned = false
    expect(service.stickers('session-a').accounts[0]!.displayName).toBe('Alice')
    expect(service.stickers('session-a').packs[0]!.assignments[0]!.assigned).toBe(true)
    const server = service.serverConfig()
    server.dcs[0]!.ip = 'mutated'
    expect(service.serverConfig().dcs[0]!.ip).toBe('relay.example.com')
  })

  it('delegates refresh, login approval and sticker assignment operations', async () => {
    const fixture = await createFixture()
    await fixture.service.refresh()
    await fixture.service.refreshStickers()
    fixture.service.approveLoginToken('qq-main', 'token')
    await fixture.service.setStickerPackAssigned('session-a', 'qq-main', 'pack-one', false)

    expect(fixture.refresh).toHaveBeenCalledOnce()
    expect(fixture.refreshStickers).toHaveBeenCalledOnce()
    expect(fixture.approveLoginToken).toHaveBeenCalledWith('qq-main', 'token')
    expect(fixture.setStickerPackAssigned).toHaveBeenCalledWith(
      'session-a', 'qq-main', 'pack-one', false,
    )
  })
})
