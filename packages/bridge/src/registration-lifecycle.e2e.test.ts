import { Context } from 'cordis'
import Long from 'long'
import { describe, expect, it, vi } from 'vitest'
import { ConversationViewService, type ConversationViewProvider } from './conversation-view.js'
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

const conversationProvider: ConversationViewProvider = {
  id: 'merged-forward-lifecycle',
  supports: (value) => value.metadata?.conversationView === 'merged-forward',
  makeLink: (context) => `https://t.me/bridgechat_${context.chatId}`,
  makePreview: (context, url) => ({
    _: 'messageMediaWebPage', manual: true, safe: true,
    webpage: {
      _: 'webPage', id: Long.ONE, url, displayUrl: context.conversation.title, hash: 0,
      type: 'telegram_message', title: context.conversation.title,
    },
  }),
  makeChat: (context) => ({
    _: 'chat', left: true, id: context.chatId, title: context.conversation.title,
    photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
  }),
  makeFullChat: (context, notifySettings) => ({
    _: 'messages.chatFull',
    fullChat: {
      _: 'chatFull', id: context.chatId, about: '',
      participants: { _: 'chatParticipantsForbidden', chatId: context.chatId },
      chatPhoto: { _: 'photoEmpty', id: Long.ZERO }, notifySettings, botInfo: [],
    },
    chats: [], users: [],
  }),
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
    const ownerPlugin = (scope: Context) => {
      scope.systemPeer.onChanged(changed)
      scope.systemPeer.register(systemProvider)
      scope.conversationView.register(conversationProvider)
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
