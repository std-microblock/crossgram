import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  stableId,
  type ConversationViewContext,
  type ConversationViewMessageTarget,
  type ConversationViewProvider,
  type IMConversation,
} from '@mtproto-relay/bridge'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['conversationView', 'mtproto', 'mtprotoBridge']

export const MERGED_FORWARD_VIEW = 'merged-forward'

export function isMergedForwardConversation(conversation: IMConversation): boolean {
  return conversation.metadata?.conversationView === MERGED_FORWARD_VIEW
}

export function makeMergedForwardProvider(): ConversationViewProvider {
  return {
    id: MERGED_FORWARD_VIEW,
    supports: isMergedForwardConversation,
    makeLink(context, target) {
      return `https://t.me/bridgechat_${context.chatId}${target ? `/${target.tlMessageId}` : ''}`
    },
    makePreview(context, url) {
      const preview = context.conversation.metadata?.qqMultiForwardPreview
      const detailedPreview = typeof preview === 'string' && isDetailedConversationPreview(preview)
        ? preview.trim()
        : undefined
      return {
        _: 'messageMediaWebPage', manual: true, safe: true,
        webpage: {
          _: 'webPage',
          id: Long.fromNumber(stableId(`conversation-preview:${context.conversation.id}`)),
          url, displayUrl: context.conversation.title, hash: 0,
          type: 'telegram_message',
          title: context.conversation.title,
          description: detailedPreview ?? '点击查看合并转发消息',
        },
      }
    },
    makeChat(context) {
      return {
        _: 'chat', left: true, id: context.chatId, title: context.conversation.title,
        photo: { _: 'chatPhotoEmpty' }, participantsCount: 1, date: 0, version: 1,
      }
    },
    makeFullChat(context, notifySettings) {
      return {
        _: 'messages.chatFull',
        fullChat: {
          _: 'chatFull', id: context.chatId, about: '',
          participants: { _: 'chatParticipantsForbidden', chatId: context.chatId },
          chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
          notifySettings, botInfo: [],
        },
        chats: [this.makeChat(context, 1)], users: [],
      }
    },
    resolveUsername(username) {
      const match = /^bridgechat_(\d+)$/.exec(username)
      return match ? Number(match[1]) : undefined
    },
  }
}

export function apply(ctx: Context): () => void {
  const provider = makeMergedForwardProvider()
  const disposers: Array<() => unknown> = [ctx.conversationView.register(provider)]
  const register = (method: string, handler: (
    rpc: ServerRpcContext,
    request: tl.RpcMethod,
  ) => Promise<tl.TlObject | undefined>) => {
    disposers.push(ctx.mtproto.register(method, handler))
  }

  register('contacts.resolveUsername', async (rpc, request) => {
    const req = request as tl.contacts.RawResolveUsernameRequest
    const chatId = provider.resolveUsername!(req.username)
    if (chatId === undefined) return
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!ctx.conversationView.resolve(state.session.platformSessionId, chatId)) return
    return state.dialogs.resolveUsername(req)
  })

  register('messages.getFullChat', async (rpc, request) => {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!ctx.conversationView.resolve(state.session.platformSessionId, req.chatId)) return
    return state.dialogs.getFullChat(req)
  })

  register('messages.getHistory', async (rpc, request) => {
    const req = request as tl.messages.RawGetHistoryRequest
    const state = await resolveViewPeer(ctx, rpc, req.peer)
    if (!state) return
    return state.dialogs.getHistory(req)
  })

  register('messages.readHistory', async (rpc, request) => {
    const req = request as tl.messages.RawReadHistoryRequest
    const state = await resolveViewPeer(ctx, rpc, req.peer)
    if (!state) return
    return state.dialogs.readHistory(req, rpc.connection)
  })

  register('messages.getScheduledHistory', async (rpc, request) => {
    const req = request as tl.messages.RawGetScheduledHistoryRequest
    const state = await resolveViewPeer(ctx, rpc, req.peer)
    if (!state) return
    return state.dialogs.getScheduledHistory(req)
  })

  register('messages.getPeerSettings', async (rpc, request) => {
    const req = request as tl.messages.RawGetPeerSettingsRequest
    const state = await resolveViewPeer(ctx, rpc, req.peer)
    if (!state) return
    return state.dialogs.getPeerSettings(req)
  })

  register('messages.getPeerDialogs', async (rpc, request) => {
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const chatIds = req.peers.flatMap((item) => {
      const peer = item._ === 'inputDialogPeer' ? item.peer : undefined
      return peer?._ === 'inputPeerChat' ? [peer.chatId] : []
    })
    if (!chatIds.length) return
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!chatIds.some((chatId) =>
      ctx.conversationView.resolve(state.session.platformSessionId, chatId))) return
    return state.dialogs.getPeerDialogs(req)
  })

  register('messages.getMessages', async (rpc, request) => {
    const req = request as tl.messages.RawGetMessagesRequest
    const ids = req.id.flatMap((item) => item._ === 'inputMessageID' ? [item.id] : [])
    if (!ids.length) return
    const state = await ctx.mtprotoBridge.resolveSession(rpc)
    if (!ids.some((id) => ctx.conversationView.ownsMessage(state.session.platformSessionId, id))) return
    return state.dialogs.getMessages(req)
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

async function resolveViewPeer(ctx: Context, rpc: ServerRpcContext, peer: tl.TypeInputPeer) {
  if (peer._ !== 'inputPeerChat') return
  const state = await ctx.mtprotoBridge.resolveSession(rpc)
  if (!ctx.conversationView.resolve(state.session.platformSessionId, peer.chatId)) return
  return state
}

function isDetailedConversationPreview(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  return !(/^(?:点击)?查看(?:[xX×\d]+条)?(?:消息的)?(?:合并)?转发(?:消息)?$/.test(compact)
    || /^(?:共)?[xX×\d]+条消息的合并转发$/.test(compact)
    || /^(?:合并转发|聊天记录)$/.test(compact))
}

export type { ConversationViewContext, ConversationViewMessageTarget }
