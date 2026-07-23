import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import { PlatformAccountProvisioner, provisionPlatformAccount } from './platform-account.js'
import type { IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities, PlatformSession } from './platform.js'

const disposals: Array<() => Promise<void>> = []
const capabilities: PlatformCapabilities = {
  history: false,
  send: { text: true, images: false, files: false, mixed: false, maxTextLength: 100, maxMedia: 0 },
  conversations: { groups: false, channels: false, subchannels: false },
}

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

async function createDatabase() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return ctx.database
}

function platform(profile = { id: 'qq-uid', firstName: 'Alice', username: '10001' }): IMPlatform {
  return {
    capabilities,
    async getAccount() {
      return {
        credentials: { adapter: 'owned' },
        user: {
          ...profile,
          avatar: { id: 'avatar:qq-uid', kind: 'image', locator: { uin: '10001' } },
          metadata: { nativeId: '10001' },
        },
      }
    },
    async subscribe() { return () => undefined },
    async sendMessage(_session: PlatformSession, conversation, content: IMMessageInput): Promise<IMMessage> {
      return { id: 'sent', conversationId: conversation.id, senderId: profile.id, content: content as any, timestamp: 1 }
    },
  }
}

describe('platform-owned account provisioning', () => {
  it('persists one stable phone while refreshing platform-owned identity fields', async () => {
    const database = await createDatabase()
    const first = await provisionPlatformAccount(database, 'qqnt', platform())
    const second = await provisionPlatformAccount(database, 'qqnt', platform({
      id: 'qq-uid', firstName: 'Alice Renamed', username: '10001',
    }))

    expect(first).toBeDefined()
    expect(first!.auth.virtualPhone).toMatch(/^999\d{12}$/)
    expect(first!.auth.totpSecret).toMatch(/^[a-f\d]{40}$/)
    expect(second!.auth).toMatchObject({
      id: first!.auth.id,
      virtualPhone: first!.auth.virtualPhone,
      totpSecret: first!.auth.totpSecret,
      platformSessionId: first!.session.platformSessionId,
    })
    expect(second!.session).toMatchObject({
      platformId: 'qqnt', userId: 'qq-uid', credentials: { adapter: 'owned' },
      metadata: { firstName: 'Alice Renamed', username: '10001', nativeId: '10001' },
    })
    expect(await database.get('mtproto_platform_session', { platformId: 'qqnt' })).toHaveLength(1)
    expect(await database.get('mtproto_auth_session', { platformId: 'qqnt' })).toHaveLength(1)
  })

  it('does nothing for legacy adapters without a current-account provider', async () => {
    const database = await createDatabase()
    const adapter = platform()
    delete adapter.getAccount
    await expect(provisionPlatformAccount(database, 'legacy', adapter)).resolves.toBeUndefined()
    expect(await database.get('mtproto_platform_session', {})).toEqual([])
    expect(await database.get('mtproto_auth_session', {})).toEqual([])
  })

  it('coalesces concurrent startup and registry provisioning into one database identity', async () => {
    const database = await createDatabase()
    const adapter = platform()
    const getAccount = adapter.getAccount!.bind(adapter)
    let calls = 0
    adapter.getAccount = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return getAccount()
    }
    const provisioner = new PlatformAccountProvisioner(database)
    const results = await Promise.all(Array.from({ length: 20 }, () => provisioner.provision('qqnt', adapter)))

    expect(calls).toBe(1)
    expect(new Set(results.map(result => result!.auth.id)).size).toBe(1)
    expect(await database.get('mtproto_platform_session', { platformId: 'qqnt' })).toHaveLength(1)
    expect(await database.get('mtproto_auth_session', { platformId: 'qqnt' })).toHaveLength(1)
  })

  it('rejects incomplete platform identity instead of inventing a user', async () => {
    const database = await createDatabase()
    await expect(provisionPlatformAccount(database, 'broken', platform({
      id: '', firstName: '', username: '',
    }))).rejects.toThrow('non-empty user.id')
  })
})
