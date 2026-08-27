import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import {
  MessageProjectionPipeline,
  MtprotoBridgeService,
  stableId,
  type BridgeSessionState,
  type MessageProjectionInput,
} from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

const session = {
  platformId: 'test', platformSessionId: 'merged-forward-lifecycle', userId: 'self',
  credentials: {}, metadata: {},
}

const conversation = {
  id: 'qqnt-multi-forward:lifecycle', kind: 'group' as const, title: 'Merged forward lifecycle',
  metadata: { conversationView: 'merged-forward', conversationViewPreview: 'Alice: hello' },
}

function projectionInput(): MessageProjectionInput {
  return {
    mode: 'history', session,
    conversation: { id: 'outer', kind: 'group', title: 'Outer' },
    tlMessageId: 100, ordinal: 0,
    draft: {
      source: {
        id: 'outer-message', conversationId: 'outer', senderId: 'alice', timestamp: 1,
        content: { parts: [{
          type: 'text', text: '查看聊天记录',
          entities: [{ type: 'conversation-link', offset: 0, length: 6, conversation }],
        }] },
      },
      chats: [],
    },
    loadConversation: async () => [{
      conversationId: conversation.id, platformMessageId: 'inner-message',
      tlMessageId: 456, timestamp: 2,
    }],
  }
}

describe('merged-forward Cordis lifecycle e2e', () => {
  it('owns projection state and RPC interception only for the feature plugin lifetime', async () => {
    const ctx = new Context()
    const listConversations = vi.fn(async () => [])
    const getProjectedHistory = vi.fn(async () => ({
      _: 'messages.messages' as const, messages: [], topics: [], chats: [], users: [],
    }))
    const services = ctx.plugin((scope) => {
      new MtprotoBridgeService(scope, async () => ({
        generation: {}, platform: {}, session,
        store: { listConversations } as never,
        dialogs: { getProjectedHistory } as never, stickers: {} as never,
      } as unknown as BridgeSessionState))
    })
    const mtproto = ctx.plugin(Mtproto, { host: '127.0.0.1', port: 0 })
    await Promise.all([services, mtproto])
    const fallbackRoute = vi.fn(async () => ({ _: 'boolTrue' as const }))
    ctx.mtproto.register('contacts.resolveUsername', fallbackRoute as never)
    const plugin = ctx.plugin(mergedForward)
    await plugin
    try {
      const pipeline = new MessageProjectionPipeline(ctx)
      const input = projectionInput()
      await pipeline.project(input, () => ({
        message: {
          _: 'message', id: input.tlMessageId,
          peerId: { _: 'peerChannel', channelId: 1 }, date: 1, message: '查看聊天记录',
        },
        chats: input.draft.chats,
      }))

      const chatId = stableId(`peer:${conversation.id}`)
      expect(input.draft.source.content.parts[0]).toMatchObject({
        entities: [{ type: 'text-link', url: `https://t.me/bridgechat_${chatId}/456` }],
      })
      const request = { _: 'contacts.resolveUsername', username: `bridgechat_${chatId}` } as never
      const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toMatchObject({
        _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId },
        chats: [{ _: 'chat', id: chatId, title: conversation.title }],
      })
      expect(listConversations).toHaveBeenCalledOnce()
      expect(fallbackRoute).not.toHaveBeenCalled()
      await expect(ctx.mtproto.dispatch(rpc, {
        _: 'messages.getHistory', peer: { _: 'inputPeerChat', chatId },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      } as never)).resolves.toMatchObject({ _: 'messages.messages' })
      expect(getProjectedHistory).toHaveBeenCalledOnce()
      const [historyRequest, projectedPeer] = getProjectedHistory.mock.calls[0] as unknown[]
      expect(historyRequest).toMatchObject({ _: 'messages.getHistory' })
      expect(projectedPeer).toMatchObject({
        conversation,
        peer: { _: 'peerChat', chatId },
        chat: { _: 'chat', id: chatId, title: conversation.title },
      })

      await plugin.dispose()

      const afterDispose = projectionInput()
      await pipeline.project(afterDispose, () => ({
        message: {
          _: 'message', id: afterDispose.tlMessageId,
          peerId: { _: 'peerChannel', channelId: 1 }, date: 1, message: '查看聊天记录',
        },
        chats: afterDispose.draft.chats,
      }))
      expect(afterDispose.draft.source.content.parts[0]).toMatchObject({
        entities: [{ type: 'conversation-link' }],
      })
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toEqual({ _: 'boolTrue' })
      expect(fallbackRoute).toHaveBeenCalledOnce()
    } finally {
      await plugin.dispose()
      await mtproto.dispose()
      await services.dispose()
    }
  })
})
