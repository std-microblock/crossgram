import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession } from './platform.js'
import { SystemPeerService, type SystemPeerProvider } from './system-peer.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'registration-lifecycle', userId: 'self',
  credentials: {}, metadata: {},
}

const systemProvider: SystemPeerProvider = {
  bootstrap: async () => {},
  resolve: async (_session, conversationId) => conversationId === 'bridge:lifecycle'
    ? {
        id: conversationId,
        conversation: { id: conversationId, kind: 'direct', title: 'Lifecycle bot' },
      }
    : undefined,
  listBots: () => [{
    conversationId: 'bridge:lifecycle', title: 'Lifecycle bot', username: 'LifecycleBot',
    sourcePlugin: '@mtproto-relay/test',
  }],
}

describe('Cordis-owned bridge registrations', () => {
  it('unregisters providers and listeners when only the owning plugin fiber is disposed', async () => {
    const ctx = new Context()
    const services = ctx.plugin((scope) => { new SystemPeerService(scope) })
    await services
    const changed = vi.fn()
    const ownerPlugin = (scope: Context) => {
      scope.systemPeer.onChanged(changed)
      scope.systemPeer.register(systemProvider)
    }
    ownerPlugin.inject = ['systemPeer']
    const owner = ctx.plugin(ownerPlugin)
    await owner
    try {
      expect(await ctx.systemPeer.resolveUsername(session, '@lifecyclebot')).toMatchObject({
        peer: { id: 'bridge:lifecycle' }, provider: systemProvider,
      })
      ctx.systemPeer.notifyChanged()
      expect(changed).toHaveBeenCalled()

      await owner.dispose()
      const changedAfterDispose = changed.mock.calls.length
      ctx.systemPeer.notifyChanged()

      expect(changed).toHaveBeenCalledTimes(changedAfterDispose)
      expect(await ctx.systemPeer.listBots()).toEqual([])
    } finally {
      await owner.dispose()
      await services.dispose()
    }
  })
})
