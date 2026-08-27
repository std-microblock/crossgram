import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { ConversationViewService } from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

describe('merged-forward Cordis lifecycle e2e', () => {
  it('lets the bridge route own RPC dispatch while the feature plugin only owns its provider', async () => {
    const ctx = new Context()
    const conversationViews = ctx.plugin((scope) => { new ConversationViewService(scope) })
    const mtproto = ctx.plugin(Mtproto, { host: '127.0.0.1', port: 0 })
    await Promise.all([conversationViews, mtproto])
    let routedViews!: ConversationViewService
    const coreRoute = vi.fn(async (_rpc: typeof ctx, request: {
      _: 'contacts.resolveUsername'
      username: string
    }) => {
      const chatId = /^bridgechat_(\d+)$/.exec(request.username)?.[1]
      if (!chatId) return
      const conversation = routedViews.resolve(
        'merged-forward-lifecycle', Number(chatId),
      )
      return conversation ? { _: 'boolTrue' as const } : undefined
    })
    const registerBridgeRoutes = (scope: Context) => {
      routedViews = scope.conversationView
      scope.mtproto.register('contacts.resolveUsername', coreRoute as never)
    }
    registerBridgeRoutes.inject = ['mtproto', 'conversationView']
    const bridgeRoutes = ctx.plugin(registerBridgeRoutes)
    await bridgeRoutes
    const plugin = ctx.plugin(mergedForward)
    await plugin
    try {
      const conversation = {
        id: 'qqnt-multi-forward:lifecycle', kind: 'group' as const, title: 'Merged forward lifecycle',
        metadata: { conversationView: 'merged-forward' },
      }
      expect(ctx.conversationView.remember('merged-forward-lifecycle', 123, conversation))
        .toBe('https://t.me/bridgechat_123')
      const request = { _: 'contacts.resolveUsername', username: 'bridgechat_123' } as never
      const rpc = {
        connection: { remoteAddress: '127.0.0.1' },
      } as never
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toEqual({ _: 'boolTrue' })
      expect(coreRoute).toHaveBeenCalledOnce()

      await plugin.dispose()

      expect(ctx.conversationView.supports(conversation)).toBe(false)
      expect(ctx.conversationView.resolve('merged-forward-lifecycle', 123)).toBeUndefined()
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toMatchObject({
        _: 'mt_rpc_error', errorCode: 500,
        errorMessage: 'METHOD_NOT_IMPLEMENTED: contacts.resolveUsername',
      })
      expect(coreRoute).toHaveBeenCalledTimes(2)
    } finally {
      await plugin.dispose()
      await bridgeRoutes.dispose()
      await mtproto.dispose()
      await conversationViews.dispose()
    }
  })
})
