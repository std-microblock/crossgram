import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { ConversationViewService } from './conversation-view.js'
import type { PlatformSession } from './platform.js'
import { SystemPeerService, type SystemPeerProvider } from './system-peer.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'registration-lifecycle', userId: 'self',
  credentials: {}, metadata: {},
}

const conversation = {
  id: 'merged-forward:lifecycle', kind: 'group' as const, title: 'Lifecycle view',
  metadata: { conversationView: 'merged-forward' },
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
    const services = ctx.plugin((scope) => {
      new ConversationViewService(scope)
      new SystemPeerService(scope)
    })
    await services
    const changed = vi.fn()
    const records = new Map<number, typeof conversation>()
    const ownerPlugin = (scope: Context) => {
      scope.systemPeer.onChanged(changed)
      scope.systemPeer.register(systemProvider)
      scope.on('bridge/conversation-view/supports', (value) =>
        value.metadata?.conversationView === 'merged-forward' || undefined)
      scope.on('bridge/conversation-view/remember', (_sessionId, chatId, value) => {
        if (value.metadata?.conversationView !== 'merged-forward') return
        records.set(chatId, value as typeof conversation)
        return `https://t.me/bridgechat_${chatId}`
      })
      scope.on('bridge/conversation-view/resolve', (_sessionId, chatId) => records.get(chatId))
    }
    ownerPlugin.inject = ['systemPeer', 'conversationView']
    const owner = ctx.plugin(ownerPlugin)
    await owner
    try {
      expect(ctx.conversationView.remember(session.platformSessionId, 321, conversation))
        .toBe('https://t.me/bridgechat_321')
      expect(await ctx.systemPeer.resolveUsername(session, '@lifecyclebot')).toMatchObject({
        peer: { id: 'bridge:lifecycle' }, provider: systemProvider,
      })
      ctx.systemPeer.notifyChanged()
      expect(changed).toHaveBeenCalled()

      await owner.dispose()
      const changedAfterDispose = changed.mock.calls.length
      ctx.systemPeer.notifyChanged()

      expect(changed).toHaveBeenCalledTimes(changedAfterDispose)
      expect(ctx.conversationView.supports(conversation)).toBe(false)
      expect(ctx.conversationView.resolve(session.platformSessionId, 321)).toBeUndefined()
      expect(await ctx.systemPeer.listBots()).toEqual([])
    } finally {
      await owner.dispose()
      await services.dispose()
    }
  })
})
