import type { Context } from 'cordis'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialogPage,
  IMDownloadOptions, IMEvent, IMHistoryPage, IMHistoryQuery, IMMedia, IMMessage, IMMessageInput,
  IMPageQuery, IMPlatform, IMReactionContext, IMReactionResource, IMReactionTarget, IMTransferOptions,
  IMUser, IMUserPage, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import { QQNTClient, type QQNTClientOptions } from './client.js'
import type {
  QQMediaLocator, WireConversation, WireEvent, WireMedia, WireMessage,
} from './protocol.js'

export type MemberNameMode = 'nickname' | 'groupAlias'

export interface Config extends QQNTClientOptions {
  /**
   * `nickname` always exposes the QQ profile nickname.
   * `groupAlias` prefers the conversation-scoped group card when available.
   */
  memberName?: MemberNameMode
}

export const name = 'im-platform-qqnt'
export const inject = ['imPlatform']

export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'qqnt')
  ctx.imPlatform.register(new QQNTPlatform(config), id)
}

export class QQNTPlatform implements IMPlatform<QQMediaLocator> {
  readonly platformKind = 'qq'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 20_000,
      // QQ's path-based native API can accept several images, but the local
      // streaming endpoint intentionally keeps one request == one media stream.
      maxMedia: 1,
    },
    conversations: { groups: true, channels: false, subchannels: false },
    members: { list: true, administrators: true, permissions: false },
    avatars: { users: true, conversations: true },
    messageActions: {
      delete: {
        own: { supported: true, maxAgeSeconds: 120 },
        others: { supported: true, maxAgeSeconds: 120 },
      },
      edit: { mode: 'unsupported' },
      forward: { mode: 'unsupported', preservesAuthor: false },
    },
    reactions: { read: true, write: true, events: true, actorList: false, maxSelected: 20 },
  }

  readonly client: QQNTClient
  private readonly conversations = new Map<string, IMConversation<QQMediaLocator>>()
  private readonly firstUnreadSeq = new Map<string, string>()
  private readonly memberName: MemberNameMode

  constructor(options: Config = {}) {
    this.client = new QQNTClient(options)
    this.memberName = options.memberName ?? 'groupAlias'
  }

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const controller = new AbortController()
    const running = this.subscribeLoop(handler, controller.signal)
    return async () => {
      controller.abort()
      await running
    }
  }

  private async subscribeLoop(
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.client.subscribe((event) => handler(this.mapEvent(event)), signal)
      } catch {
        if (signal.aborted) return
      }
      await abortableDelay(1_000, signal)
    }
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<QQMediaLocator>> {
    const response = await this.client.getDialogs({ cursor: query.cursor, limit: query.limit })
    for (const conversation of response.conversations) {
      if (conversation.firstUnread?.msgSeq) this.firstUnreadSeq.set(conversation.id, conversation.firstUnread.msgSeq)
      else this.firstUnreadSeq.delete(conversation.id)
    }
    return {
      dialogs: response.conversations.map((conversation) => ({
        conversation: this.mapConversation(conversation),
        unreadCount: conversation.unreadCount ?? 0,
        lastMessage: conversation.lastMessage ? mapMessage(conversation.lastMessage, this.memberName) : undefined,
        readInboxMaxMessage: conversation.readInboxMaxMessage
          ? mapMessage(conversation.readInboxMaxMessage, this.memberName)
          : undefined,
      })),
      nextCursor: response.nextCursor,
    }
  }

  async getContacts(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMUserPage<QQMediaLocator>> {
    const page = await this.client.getContacts({ cursor: query.cursor, limit: query.limit })
    return {
      users: page.users.map((user) => ({
        id: user.id,
        firstName: user.name,
        username: user.numericId,
        avatar: user.avatar ? mapMedia(user.avatar) : undefined,
        metadata: user.numericId ? { qq: user.numericId } : undefined,
      })),
      nextCursor: page.nextCursor,
    }
  }

  async getHistory(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<QQMediaLocator>> {
    const response = await this.client.getHistory(conversation.id, {
      cursor: query.cursor,
      limit: query.limit,
      beforeId: query.before?.id,
      afterId: query.after?.id,
      aroundUnreadSeq: !query.cursor && !query.before && !query.after
        ? this.firstUnreadSeq.get(conversation.id)
        : undefined,
    })
    return {
      messages: response.messages.map((message) => mapMessage(message, this.memberName)),
      nextCursor: response.nextCursor,
    }
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser<QQMediaLocator> | null> {
    const user = await this.client.getUser(userId)
    if (!user) return null
    return {
      id: user.id,
      firstName: user.name,
      username: user.numericId,
      avatar: user.avatar ? mapMedia(user.avatar) : undefined,
      metadata: user.numericId ? { qq: user.numericId } : undefined,
    }
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<QQMediaLocator>> {
    const page = await this.client.getMembers(conversation.id, { cursor: query.cursor, limit: query.limit })
    return {
      members: page.members.map((member): IMConversationMember<QQMediaLocator> => ({
        user: {
          id: member.user.id,
          firstName: memberDisplayName(member.user, this.memberName),
          username: member.user.numericId,
          avatar: member.user.avatar ? mapMedia(member.user.avatar) : undefined,
          metadata: {
            ...(member.user.numericId ? { qq: member.user.numericId } : {}),
            qqName: member.user.name,
            ...(member.user.alias ? { qqGroupAlias: member.user.alias } : {}),
          },
        },
        role: member.role,
        permissions: permissions(member.role),
      })),
      total: page.total,
      nextCursor: page.nextCursor,
    }
  }

  async getConversationMember(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<QQMediaLocator> | null> {
    let cursor: string | undefined
    do {
      const page = await this.getConversationMembers(session, conversation, { cursor, limit: 500 })
      const found = page.members.find((member) => member.user.id === userId)
      if (found) return found
      cursor = page.nextCursor
    } while (cursor)
    return null
  }

  async sendMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<QQMediaLocator>> {
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') || undefined
    const mediaParts = content.parts.filter((part) => part.type === 'media')
    if (content.parts.some((part) => part.type === 'sticker')) throw new Error('QQNT native stickers are not implemented')
    if (mediaParts.length > 1) throw new Error('QQNT streaming transport supports at most one media per logical message')
    const part = mediaParts[0]
    const media = part?.type === 'media' ? {
      kind: part.media.kind,
      name: part.media.name ?? `upload-${Date.now()}`,
      mimeType: part.media.mimeType,
      source: part.media.source,
    } : undefined
    return mapMessage(await this.client.sendMessage(conversation.id, text, media, options), this.memberName)
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
    options: import('@mtproto-relay/bridge').IMDeleteMessagesOptions,
  ): Promise<void> {
    await this.client.deleteMessages(conversation.id, messageIds, options.forEveryone)
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<QQMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    if (!media.locator) throw new Error(`QQ media ${media.id} has no locator`)
    let transferred = 0
    yield* this.client.downloadMedia(media.locator, {
      offset: options.offset,
      limit: options.limit,
      signal: options.signal,
      onChunk: async (size) => {
        transferred += size
        await options.onProgress?.({
          phase: 'download',
          mediaIndex: 0,
          transferredBytes: transferred,
          totalBytes: options.limit === undefined ? media.size : Math.min(options.limit, media.size ?? options.limit),
        })
      },
    })
  }

  async getAvailableReactions(
    _session: PlatformSession,
    _target: IMReactionTarget,
  ): Promise<IMReactionContext> {
    return this.client.getReactionCatalog() as Promise<IMReactionContext>
  }

  async getMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
  ): Promise<IMReactionContext> {
    return this.client.getMessageReactions(target.conversationId, target.targetId) as Promise<IMReactionContext>
  }

  async setMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
    reactionKeys: readonly string[],
  ): Promise<IMReactionContext> {
    return this.client.setMessageReactions(
      target.conversationId, target.targetId, reactionKeys,
    ) as Promise<IMReactionContext>
  }

  async *downloadReactionResource(
    _session: PlatformSession,
    resource: IMReactionResource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const locator = resource.locator
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)
      || typeof locator.filePath !== 'string') throw new Error('QQ reaction resource has no file path')
    let transferred = 0
    yield* this.client.downloadMedia({
      messageId: `reaction:${locator.filePath}`,
      elementId: `reaction:${locator.filePath}`,
      chatType: 1,
      peerUid: '',
      kind: 'image',
      fileName: locator.filePath.split('/').at(-1) ?? 'reaction.png',
      filePath: locator.filePath,
      fileSize: resource.size === undefined ? undefined : String(resource.size),
    }, {
      offset: options.offset,
      limit: options.limit,
      signal: options.signal,
      onChunk: async (size) => {
        transferred += size
        await options.onProgress?.({
          phase: 'download',
          mediaIndex: 0,
          transferredBytes: transferred,
          totalBytes: resource.size,
        })
      },
    })
  }

  private mapConversation(input: WireConversation): IMConversation<QQMediaLocator> {
    const current = this.conversations.get(input.id)
    const mapped = mapConversation(input)
    const fallbackTitles = new Set([input.id, input.peerUid, input.peerUin].filter(Boolean))
    const title = current?.title && fallbackTitles.has(mapped.title) ? current.title : mapped.title
    const conversation: IMConversation<QQMediaLocator> = {
      ...current,
      ...mapped,
      title,
      avatar: mapped.avatar ?? current?.avatar,
      metadata: { ...current?.metadata, ...mapped.metadata },
    }
    this.conversations.set(conversation.id, conversation)
    return conversation
  }

  private mapEvent(input: WireEvent): IMEvent<QQMediaLocator> {
    const conversation = this.mapConversation(input.conversation)
    if (input.type === 'message') {
      return { type: 'message', conversation, message: mapMessage(input.message, this.memberName) }
    }
    if (input.type === 'message-delete') return {
      type: 'message-delete',
      eventId: input.eventId,
      conversation,
      messageIds: input.messageIds,
      timestamp: input.timestamp,
    }
    return {
      type: 'message-reactions',
      eventId: input.eventId,
      conversation,
      target: input.target,
      context: input.context as IMReactionContext,
      timestamp: input.timestamp,
    }
  }
}

function mapConversation(input: WireConversation): IMConversation<QQMediaLocator> {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    avatar: input.avatar ? mapMedia(input.avatar) : undefined,
    metadata: {
      qqPeerUid: input.peerUid,
      qq: input.peerUin,
      chatType: input.chatType,
    },
  }
}

function mapMedia(input: WireMedia): IMMedia<QQMediaLocator> {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    width: input.width,
    height: input.height,
    locator: input.locator,
  }
}

function mapMessage(input: WireMessage, memberName: MemberNameMode): IMMessage<QQMediaLocator> {
  return {
    id: input.id,
    sourceIds: input.sourceIds,
    conversationId: input.conversationId,
    senderId: input.senderId,
    sender: input.sender ? {
      id: input.sender.id,
      firstName: memberDisplayName(input.sender, memberName),
      username: input.sender.numericId,
      avatar: input.sender.avatar ? mapMedia(input.sender.avatar) : undefined,
      metadata: {
        ...(input.sender.numericId ? { qq: input.sender.numericId } : {}),
        qqName: input.sender.name,
        ...(input.sender.alias ? { qqGroupAlias: input.sender.alias } : {}),
      },
    } : undefined,
    timestamp: input.timestamp,
    outgoing: input.outgoing,
    metadata: input.msgSeq ? { qqMsgSeq: input.msgSeq } : undefined,
    reactionContext: input.reactionContext as IMReactionContext | undefined,
    content: {
      parts: input.parts.map((part) =>
        part.type === 'text' ? { type: 'text' as const, text: part.text } : {
          type: 'media' as const, media: mapMedia(part.media),
        }),
    },
  }
}

function memberDisplayName(
  user: { name: string, alias?: string },
  mode: MemberNameMode,
): string {
  return mode === 'groupAlias' ? user.alias?.trim() || user.name : user.name
}

function permissions(role: 'owner' | 'administrator' | 'member') {
  const administrator = role === 'owner' || role === 'administrator'
  return {
    manageConversation: administrator,
    manageMembers: administrator,
    deleteAnyMessage: administrator,
    editAnyMessage: false,
    pinMessages: administrator,
    inviteMembers: true,
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export type { QQMediaLocator } from './protocol.js'
export { QQNTClient } from './client.js'
