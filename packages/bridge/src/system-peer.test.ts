import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { IMMessage, PlatformSession } from './platform.js'
import { SystemPeerService, type SystemPeerProvider } from './system-peer.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'system-peer-session', userId: 'self', credentials: {}, metadata: {},
}

const message: IMMessage = {
  id: 'source', conversationId: 'bridge:test', senderId: 'bridge:test',
  content: { parts: [{ type: 'text', text: 'callback' }] }, timestamp: 1,
}

describe('SystemPeerService', () => {
  it('keeps callbacks bound to their resolving provider and permits read-only peers', async () => {
    const service = new SystemPeerService(new Context())
    const first: SystemPeerProvider = {
      bootstrap: async () => {},
      resolve: vi.fn(async (_session, conversationId) => conversationId === 'bridge:test'
        ? { id: conversationId, conversation: { id: conversationId, kind: 'direct' as const, title: 'First' } }
        : undefined),
      callback: vi.fn(async () => ({ message: 'first callback', cacheTime: 0 })),
    }
    const second: SystemPeerProvider = {
      bootstrap: async () => {},
      resolve: vi.fn(async () => ({ id: 'bridge:test', conversation: { id: 'bridge:test', kind: 'direct' as const, title: 'Second' } })),
      callback: vi.fn(async () => ({ message: 'second callback' })),
    }
    service.register(first)
    service.register(second)

    const resolution = await service.resolve(session, 'bridge:test')
    if (!resolution) throw new Error('missing system peer resolution')
    await expect(service.receive(session, resolution, message)).resolves.toBeUndefined()
    await expect(service.callback(session, resolution, { message, data: 'test' }))
      .resolves.toEqual({ message: 'first callback', cacheTime: 0 })
    expect(first.resolve).toHaveBeenCalledTimes(1)
    expect(second.resolve).not.toHaveBeenCalled()
    expect(first.callback).toHaveBeenCalledTimes(1)
    expect(second.callback).not.toHaveBeenCalled()
  })

  it('lists bridge bots, resolves their t.me usernames, and signals dynamic registry changes', async () => {
    const service = new SystemPeerService(new Context())
    const changed = vi.fn()
    service.onChanged(changed)
    const provider: SystemPeerProvider = {
      bootstrap: async () => {},
      resolve: vi.fn(async (_session, conversationId) => conversationId === 'bridge:admin'
        ? {
            id: conversationId,
            conversation: {
              id: conversationId, kind: 'direct' as const, title: 'CrossGram Admin',
              metadata: { bot: true, username: 'CrossGramAdminBot' },
            },
          }
        : undefined),
      listBots: () => [{
        conversationId: 'bridge:admin', title: 'CrossGram Admin', username: 'CrossGramAdminBot',
        sourcePlugin: '@mtproto-relay/platform-admin-bot',
      }],
    }

    const unregister = service.register(provider)
    expect(await service.listBots()).toEqual([{
      conversationId: 'bridge:admin', title: 'CrossGram Admin', username: 'CrossGramAdminBot',
      sourcePlugin: '@mtproto-relay/platform-admin-bot',
    }])
    await expect(service.resolveUsername(session, '@crossgramadminbot')).resolves.toMatchObject({
      peer: { id: 'bridge:admin' }, provider,
    })
    service.notifyChanged()
    unregister()
    expect(changed).toHaveBeenCalledTimes(3)
  })
})
