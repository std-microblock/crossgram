import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import {
  MessageProjectionPipeline,
  MtprotoBridgeService,
  stableId,
  type BridgeSessionState,
  type IMMessageBundle,
  type IMPlatform,
  type MessageProjectionInput,
} from '@mtproto-relay/bridge'
import { Mtproto } from '@mtproto-relay/mtproto'
import * as mergedForward from './index.js'

const session = {
  platformId: 'test', platformSessionId: 'merged-forward-lifecycle', userId: 'self',
  credentials: {}, metadata: {},
}

const bundle: IMMessageBundle = {
  id: 'bundle:lifecycle', title: 'Merged forward lifecycle',
  preview: 'Alice: hello', locator: { root: 'lifecycle' },
}

const load = vi.fn(async () => [{
  id: 'inner-message', senderId: 'alice', timestamp: 2,
  sender: { id: 'alice', firstName: 'Alice' },
  content: { parts: [{ type: 'text' as const, text: 'hello' }] },
}])

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  messageBundles: { load },
  async subscribe() { return () => {} },
  async sendMessage() { throw new Error('unused') },
}

function projectionInput(): MessageProjectionInput {
  return {
    mode: 'history', platform, session,
    target: {
      conversation: { id: 'outer', kind: 'group', title: 'Outer' },
      peer: { _: 'peerChannel', channelId: 1 }, title: 'Outer',
    },
    tlMessageId: 100, ordinal: 0,
    draft: {
      source: {
        id: 'outer-message', conversationId: 'outer', senderId: 'alice', timestamp: 1,
        content: { parts: [{ type: 'message-bundle', bundle }] },
      },
      chats: [],
    },
  }
}

describe('merged-forward Cordis lifecycle e2e', () => {
  it('owns projection state and RPC interception only for the feature plugin lifetime', async () => {
    const ctx = new Context()
    const pipeline = new MessageProjectionPipeline(ctx)
    const services = ctx.plugin((scope) => {
      new MtprotoBridgeService(scope, async () => ({
        generation: {}, platform, session, projection: pipeline,
        dialogs: {} as never, stickers: {} as never,
      } satisfies BridgeSessionState))
    })
    const mtproto = ctx.plugin(Mtproto, { host: '127.0.0.1', port: 0 })
    await Promise.all([services, mtproto])
    const fallbackRoute = vi.fn(async () => ({ _: 'boolTrue' as const }))
    ctx.mtproto.register('contacts.resolveUsername', fallbackRoute as never)
    const plugin = ctx.plugin(mergedForward)
    await plugin
    try {
      const input = projectionInput()
      await pipeline.project(input, () => ({
        message: {
          _: 'message', id: input.tlMessageId,
          peerId: input.target.peer, date: 1, message: '查看聊天记录',
        },
        chats: input.draft.chats,
      }))

      const chatId = stableId(`merged-forward-chat:${bundle.id}`)
      const targetId = stableId(`merged-forward-message:${bundle.id}:inner-message:0`)
      expect(input.draft.source.content.parts[0]).toMatchObject({
        type: 'text',
        entities: [{ type: 'text-link', url: `https://t.me/bridgebundle_${chatId}/${targetId}` }],
      })
      const request = { _: 'contacts.resolveUsername', username: `bridgebundle_${chatId}` } as never
      const rpc = { connection: { remoteAddress: '127.0.0.1' } } as never
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toMatchObject({
        _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId },
        chats: [{ _: 'chat', id: chatId, title: bundle.title }],
      })
      expect(fallbackRoute).not.toHaveBeenCalled()
      await expect(ctx.mtproto.dispatch(rpc, {
        _: 'messages.getHistory', peer: { _: 'inputPeerChat', chatId },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      } as never)).resolves.toMatchObject({
        _: 'messages.messagesSlice',
        messages: [{ _: 'message', id: targetId, message: 'hello' }],
      })
      expect(load).toHaveBeenCalledOnce()

      await plugin.dispose()

      const afterDispose = projectionInput()
      await pipeline.project(afterDispose, () => ({
        message: {
          _: 'message', id: afterDispose.tlMessageId,
          peerId: afterDispose.target.peer, date: 1, message: '',
        },
        chats: afterDispose.draft.chats,
      }))
      expect(afterDispose.draft.source.content.parts[0]).toMatchObject({ type: 'message-bundle' })
      await expect(ctx.mtproto.dispatch(rpc, request)).resolves.toEqual({ _: 'boolTrue' })
      expect(fallbackRoute).toHaveBeenCalledOnce()
    } finally {
      await plugin.dispose()
      await mtproto.dispose()
      await services.dispose()
    }
  })
})
