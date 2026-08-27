import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { ConversationViewService } from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

describe('merged-forward Cordis lifecycle e2e', () => {
  it('lets Cordis remove its provider and every RPC route without an apply disposer', async () => {
    const ctx = new Context()
    const resolveUsername = vi.fn(async () => ({ _: 'boolTrue' as const }))
    const disposeBridge = ctx.provide('mtprotoBridge', {
      resolveSession: async () => ({
        session: { platformSessionId: 'merged-forward-lifecycle' },
        dialogs: { resolveUsername },
      }),
    } as never)
    const conversationViews = ctx.plugin((scope) => { new ConversationViewService(scope) })
    const mtproto = ctx.plugin(Mtproto, { host: '127.0.0.1', port: 0 })
    await Promise.all([conversationViews, mtproto])
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
      expect(resolveUsername).toHaveBeenCalledOnce()

      await plugin.dispose()

      expect(ctx.conversationView.supports(conversation)).toBe(false)
      expect(ctx.conversationView.resolve('merged-forward-lifecycle', 123)).toBeUndefined()
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toMatchObject({
        _: 'mt_rpc_error', errorCode: 500,
        errorMessage: 'METHOD_NOT_IMPLEMENTED: contacts.resolveUsername',
      })
      expect(resolveUsername).toHaveBeenCalledOnce()
    } finally {
      await plugin.dispose()
      await mtproto.dispose()
      await conversationViews.dispose()
      await Promise.resolve(disposeBridge())
    }
  })
})
