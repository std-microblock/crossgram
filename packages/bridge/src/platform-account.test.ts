import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import {
  migrateLegacyVirtualPhones, PlatformAccountProvisioner, provisionPlatformAccount,
} from './platform-account.js'
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

function platform(
  profile = { id: 'qq-uid', firstName: 'Alice', username: '1234567890' },
  platformKind = 'qq',
  metadata?: Record<string, string | number>,
): IMPlatform {
  return {
    platformKind,
    capabilities,
    async getAccount() {
      return {
        credentials: { adapter: 'owned' },
        user: {
          ...profile,
          avatar: { id: 'avatar:qq-uid', kind: 'image', locator: { uin: '1234567890' } },
          metadata: metadata ?? {
            nativeId: profile.username,
            ...(platformKind === 'qq' ? { qq: profile.username } : {}),
          },
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
  it('maps QQ identity to a stable deterministic +888 phone while refreshing profile fields', async () => {
    const database = await createDatabase()
    const first = await provisionPlatformAccount(database, 'qqnt', platform())
    const second = await provisionPlatformAccount(database, 'qqnt', platform({
      id: 'qq-uid', firstName: 'Alice Renamed', username: '1234567890',
    }))

    expect(first).toBeDefined()
    expect(first!.auth.virtualPhone).toBe('8881234567890')
    expect(first!.auth.totpSecret).toMatch(/^[a-f\d]{40}$/)
    expect(second!.auth).toMatchObject({
      id: first!.auth.id,
      virtualPhone: '8881234567890',
      totpSecret: first!.auth.totpSecret,
      platformSessionId: first!.session.platformSessionId,
    })
    expect(second!.session).toMatchObject({
      platformId: 'qqnt', userId: 'qq-uid', credentials: { adapter: 'owned' },
      metadata: { firstName: 'Alice Renamed', username: '1234567890', nativeId: '1234567890', qq: '1234567890' },
    })
    expect(await database.get('mtproto_platform_session', { platformId: 'qqnt' })).toHaveLength(1)
    expect(await database.get('mtproto_auth_session', { platformId: 'qqnt' })).toHaveLength(1)
    expect(await database.get('mtproto_im_user', { platformId: 'qqnt' })).toMatchObject([{
      id: expect.any(Number), platformUserId: 'qq-uid', firstName: 'Alice Renamed', username: '1234567890',
      avatar: { id: 'avatar:qq-uid', locator: { uin: '1234567890' } },
      metadata: { nativeId: '1234567890', qq: '1234567890' },
    }])
  })

  it.each([
    '17778889999',
    '999123456789012',
    '888000000000002',
  ])('updates QQ legacy or random phone %s in place', async (legacyPhone) => {
    const database = await createDatabase()
    const totpSecret = 'ab'.repeat(20)
    await database.create('mtproto_platform_session', {
      id: 'legacy-session', platformId: 'qqnt', userId: 'qq-uid', credentials: { adapter: 'owned' },
      metadata: { firstName: 'Alice' }, active: true, createdAt: new Date(),
    })
    await database.create('mtproto_auth_session', {
      id: 'legacy-auth', virtualPhone: legacyPhone, totpSecret,
      platformId: 'qqnt', platformSessionId: 'legacy-session',
    })
    await database.create('mtproto_auth_binding', {
      authKeyId: '0011223344556677', platformId: 'qqnt', platformSessionId: 'legacy-session',
    })

    const provisioned = await provisionPlatformAccount(database, 'qqnt', platform())

    expect(provisioned!.auth).toMatchObject({
      id: 'legacy-auth', virtualPhone: '8881234567890', totpSecret,
      platformSessionId: 'legacy-session',
    })
    expect(await database.get('mtproto_auth_session', { virtualPhone: legacyPhone })).toEqual([])
    expect(await database.get('mtproto_auth_session', { id: 'legacy-auth' })).toMatchObject([{
      id: 'legacy-auth', virtualPhone: '8881234567890', totpSecret,
      platformSessionId: 'legacy-session',
    }])
    expect(await database.get('mtproto_auth_binding', { authKeyId: '0011223344556677' })).toEqual([{
      authKeyId: '0011223344556677', platformId: 'qqnt', platformSessionId: 'legacy-session',
    }])
  })

  it('keeps non-QQ 888 phones stable and assigns random 15-digit +888 fallbacks', async () => {
    const database = await createDatabase()
    const adapter = platform({ id: 'static-uid', firstName: 'Static', username: '10002' }, 'static')
    const first = await provisionPlatformAccount(database, 'static', adapter)
    const second = await provisionPlatformAccount(database, 'static', adapter)

    expect(first!.auth.virtualPhone).toMatch(/^888\d{12}$/)
    expect(second!.auth).toMatchObject({ id: first!.auth.id, virtualPhone: first!.auth.virtualPhone })
  })

  it.each([
    undefined,
    '',
    '123abc',
    1234567890,
  ])('rejects QQ accounts without a numeric metadata.qq value', async (qq) => {
    const database = await createDatabase()
    const metadata = qq === undefined ? {} : { qq }

    await expect(provisionPlatformAccount(database, 'qqnt', platform(undefined, 'qq', metadata)))
      .rejects.toThrow('metadata.qq as a non-empty ASCII digit string')
    expect(await database.get('mtproto_auth_session', {})).toEqual([])
  })

  it('allows only one concurrent QQ provision to claim the same virtual phone', async () => {
    const database = await createDatabase()
    const results = await Promise.allSettled([
      provisionPlatformAccount(database, 'qq-one', platform()),
      provisionPlatformAccount(database, 'qq-two', platform({
        id: 'other-uid', firstName: 'Other', username: '1234567890',
      })),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await database.get('mtproto_auth_session', { virtualPhone: '8881234567890' })).toHaveLength(1)
  })

  it('migrates only non-888 numbers when their platform adapters are inactive', async () => {
    const database = await createDatabase()
    const first = await provisionPlatformAccount(database, 'qqnt', platform())
    const second = await provisionPlatformAccount(database, 'static', platform({
      id: 'static-uid', firstName: 'Static', username: '10002',
    }, 'static'))
    await database.set('mtproto_auth_session', { id: first!.auth.id }, { virtualPhone: '17778889999' })
    await database.set('mtproto_auth_session', { id: second!.auth.id }, { virtualPhone: '888000000000002' })

    await expect(migrateLegacyVirtualPhones(database)).resolves.toBe(1)
    const rows = await database.get('mtproto_auth_session', {})
    expect(rows.find(row => row.id === first!.auth.id)!.virtualPhone).toMatch(/^888\d{12}$/)
    expect(rows.find(row => row.id === second!.auth.id)!.virtualPhone).toBe('888000000000002')
    await expect(migrateLegacyVirtualPhones(database)).resolves.toBe(0)
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
