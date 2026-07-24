import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialogPage,
  IMDownloadOptions, IMEvent, IMHistoryPage, IMHistoryQuery, IMMedia, IMMessage, IMMessageInput,
  IMPageQuery, IMPlatform, IMReactionContext, IMReactionResource, IMReactionTarget, IMTransferOptions,
  IMStickerAsset, IMUser, IMUserPage, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import { QQNTClient, type QQNTClientOptions } from './client.js'
import { QQStickerProvider } from './sticker-provider.js'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMedia, WireMessage, WireMultiForwardLocator,
  WireReactionState, WireTextPart,
} from './protocol.js'

export type MemberNameMode = 'nickname' | 'groupAlias'

export interface Config extends QQNTClientOptions {
  /**
   * `nickname` always exposes the QQ profile nickname.
   * `groupAlias` prefers the conversation-scoped group card when available.
   */
  memberName?: MemberNameMode
  /** Directory used for transformed stickers and optionally all QQ images. */
  mediaCachePath?: string
  /** Cache every downloaded QQ image and normalize it to WebP. */
  cacheAndConvertImages?: boolean
  /** Override the bundled FFmpeg executable used for GIF/APNG to WebM conversion. */
  ffmpegPath?: string
}

export const name = 'im-platform-qqnt'
export const inject = ['imPlatform', 'imSticker', 'database', 'model']

export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'qqnt')
  const stickerProviderId = `${id}:stickers`
  defineQQMediaCacheModel(ctx)
  const mediaCache = new QQMediaCache({
    path: config.mediaCachePath ?? resolve(process.cwd(), 'data', 'qqnt-media-cache', id),
    cacheAndConvertImages: config.cacheAndConvertImages,
    ffmpegPath: config.ffmpegPath,
    database: ctx.database,
  })
  const platform = new QQNTPlatform(config, stickerProviderId, mediaCache, ctx.logger('platform-qqnt'))
  ctx.imPlatform.register(platform, id)
  ctx.imSticker.register(new QQStickerProvider(platform.client, stickerProviderId, mediaCache), stickerProviderId)
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
      edit: { mode: 'delete-and-resend', maxAgeSeconds: 120 },
      forward: { mode: 'native', preservesAuthor: true },
    },
    reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 20 },
    stickers: { native: true, upload: false, formats: ['static', 'animated', 'video'] },
  }

  readonly client: QQNTClient
  private readonly conversations = new Map<string, IMConversation<QQMediaLocator>>()
  private readonly firstUnreadSeq = new Map<string, string>()
  private readonly reactionResources = new Map<string, Uint8Array>()
  private reactionCatalog?: IMReactionContext
  private reactionCatalogPromise?: Promise<IMReactionContext>
  private readonly memberName: MemberNameMode
  private readonly originSessions = new Map<string, string>()
  private readonly multiForwardLocators = new Map<string, WireMultiForwardLocator>()

  constructor(
    options: Config = {},
    private readonly stickerProviderId = 'qqnt:stickers',
    private readonly mediaCache?: QQMediaCache,
    private readonly logger?: QQNTLogger,
  ) {
    this.client = new QQNTClient(options)
    this.memberName = options.memberName ?? 'groupAlias'
  }

  async getAccount() {
    const status = await this.client.status()
    const userId = status.selfUid ?? status.selfUin
    if (!status.ready || !userId) throw new Error('QQNT account is not ready')
    const user = await this.client.getUser(userId)
    if (!user) throw new Error(`QQNT current user is unavailable: ${userId}`)
    return {
      credentials: {},
      user: {
        id: user.id,
        firstName: user.name,
        username: user.numericId ?? status.selfUin,
        avatar: user.avatar ? mapMedia(user.avatar) : undefined,
        metadata: user.numericId ? { qq: user.numericId } : undefined,
      },
    }
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    await this.ensureReactionCatalog().catch(() => undefined)
    const controller = new AbortController()
    const running = this.subscribeLoop(session.platformSessionId, handler, controller.signal)
    return async () => {
      controller.abort()
      await running
    }
  }

  private async subscribeLoop(
    platformSessionId: string,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let lastEventId: string | undefined
    let attempt = 0
    while (!signal.aborted) {
      attempt++
      this.logger?.info(
        'SSE subscribe start session=%s attempt=%d endpoint=%s lastEventId=%s',
        platformSessionId, attempt, this.client.endpoint, lastEventId ?? '<none>',
      )
      try {
        await this.client.subscribe(async (event, eventId) => {
          this.logger?.info(
            'SSE event received session=%s streamEventId=%s %s',
            platformSessionId, eventId ?? '<none>', wireEventSummary(event),
          )
          if (event.type === 'message' && event.message.originRequestId
            && this.originSessions.get(event.message.originRequestId) === platformSessionId) {
            this.logger?.info(
              'SSE event filtered session=%s reason=own-origin streamEventId=%s message=%s originRequestId=%s',
              platformSessionId, eventId ?? '<none>', event.message.id, event.message.originRequestId,
            )
            return
          }
          const mapped = this.mapEvent(event)
          this.logger?.info(
            'SSE event mapped session=%s streamEventId=%s %s',
            platformSessionId, eventId ?? '<none>', imEventSummary(mapped),
          )
          await handler(mapped)
          this.logger?.info(
            'SSE event handled session=%s streamEventId=%s %s',
            platformSessionId, eventId ?? '<none>', imEventSummary(mapped),
          )
        }, signal, {
          lastEventId,
          onEventId: (eventId) => { lastEventId = eventId },
        })
        if (!signal.aborted) this.logger?.warn(
          'SSE stream ended session=%s attempt=%d lastEventId=%s; reconnecting',
          platformSessionId, attempt, lastEventId ?? '<none>',
        )
      } catch (error) {
        if (signal.aborted) return
        this.logger?.warn(
          'SSE stream failed session=%s attempt=%d lastEventId=%s error=%s; reconnecting',
          platformSessionId, attempt, lastEventId ?? '<none>', formatError(error),
        )
      }
      await abortableDelay(1_000, signal)
    }
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<QQMediaLocator>> {
    await this.ensureReactionCatalog().catch(() => undefined)
    const response = await this.client.getDialogs({ cursor: query.cursor, limit: query.limit })
    for (const conversation of response.conversations) {
      if (conversation.firstUnread?.msgSeq) this.firstUnreadSeq.set(conversation.id, conversation.firstUnread.msgSeq)
      else this.firstUnreadSeq.delete(conversation.id)
    }
    return {
      dialogs: response.conversations.map((conversation) => ({
        conversation: this.mapConversation(conversation),
        unreadCount: conversation.unreadCount ?? 0,
        lastMessage: conversation.lastMessage
          ? this.mapMessage(conversation.lastMessage)
          : undefined,
        readInboxMaxMessage: conversation.readInboxMaxMessage
          ? this.mapMessage(conversation.readInboxMaxMessage)
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
    await this.ensureReactionCatalog()
    const multiForward = this.multiForwardLocators.get(conversation.id)
    if (multiForward) {
      const messages = await this.client.getMultiForwardMessages(multiForward)
      return {
        messages: messages.slice(0, query.limit ?? messages.length).map((message) => ({
          ...this.mapMessage(message),
          conversationId: conversation.id,
        })),
      }
    }
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
      messages: response.messages.map((message) => this.mapMessage(message)),
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

  async getMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<QQMediaLocator> | null> {
    const message = await this.client.getMessage(conversation.id, messageId)
    return message ? this.mapMessage(message) : null
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
    const known = this.conversations.get(conversation.id)
    const selfRole = known?.metadata?.qqSelfRole
    if (
      userId === session.userId
      && (selfRole === 'owner' || selfRole === 'administrator' || selfRole === 'member')
    ) {
      const user = await this.getUser(session, userId)
      if (user) return { user, role: selfRole, permissions: permissions(selfRole) }
    }
    // Opening a Telegram megagroup commonly probes inputPeerSelf. Never turn a
    // temporarily missing group profile into a full QQ member-list scan.
    if (userId === session.userId) return null
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
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<QQMediaLocator>> {
    const resolvedMentionUsers = new Map<string, Promise<string | undefined>>()
    const textParts: WireTextPart[] = []
    for (const part of content.parts) {
      if (part.type !== 'text') continue
      const entities: NonNullable<WireTextPart['entities']> = []
      for (const entity of part.entities ?? []) {
        if (entity.type === 'mention') {
          let numericId = entity.numericId
          if (!numericId) {
            let pending = resolvedMentionUsers.get(entity.userId)
            if (!pending) {
              pending = this.client.getUser(entity.userId)
                .then((user) => user?.numericId)
                .catch(() => undefined)
              resolvedMentionUsers.set(entity.userId, pending)
            }
            numericId = await pending
          }
          entities.push({ ...entity, numericId })
          continue
        }
        if (entity.type === 'conversation-link') continue
        const match = /^1:(\d+)$/.exec(entity.definition.key)
        if (match) entities.push({
          type: 'qq-face', offset: entity.offset, length: entity.length,
          faceId: match[1], faceType: 1,
        })
      }
      textParts.push({ type: 'text', text: part.text, entities: entities.length ? entities : undefined })
    }
    const text = textParts.map((part) => part.text).join('\n') || undefined
    const mediaParts = content.parts.filter((part) => part.type === 'media')
    const stickerParts = content.parts.filter((part) => part.type === 'sticker')
    if (stickerParts.length > 1 || stickerParts.length && mediaParts.length) {
      throw new Error('QQNT supports one sticker or one streamed media item per message')
    }
    const stickerPart = stickerParts[0]
    let sticker: QQStickerReference | undefined
    if (stickerPart?.type === 'sticker') {
      if (stickerPart.sticker.type !== 'native') {
        throw new Error('QQNT only accepts native QQ sticker send plans')
      }
      sticker = stickerPart.sticker.reference as unknown as QQStickerReference
    }
    if (mediaParts.length > 1) throw new Error('QQNT streaming transport supports at most one media per logical message')
    const part = mediaParts[0]
    const media = part?.type === 'media' ? {
      kind: part.media.kind,
      name: part.media.name ?? `upload-${Date.now()}`,
      mimeType: part.media.mimeType,
      width: part.media.width,
      height: part.media.height,
      source: part.media.source,
    } : undefined
    const originRequestId = randomUUID()
    this.originSessions.set(originRequestId, session.platformSessionId)
    try {
      return this.mapMessage(
        await this.client.sendMessage(
          conversation.id, text, media, options, originRequestId, sticker, textParts, content.replyToId,
        ),
      )
    } finally {
      const timer = setTimeout(() => this.originSessions.delete(originRequestId), 120_000)
      timer.unref()
    }
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
    options: import('@mtproto-relay/bridge').IMDeleteMessagesOptions,
  ): Promise<void> {
    await this.client.deleteMessages(conversation.id, messageIds, options.forEveryone)
  }

  async forwardMessages(
    session: PlatformSession,
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options: import('@mtproto-relay/bridge').IMForwardMessagesOptions = {},
  ): Promise<IMMessage<QQMediaLocator>[]> {
    if (!messageIds.length) return []
    if (options.dropAuthor) {
      const outputs: IMMessage<QQMediaLocator>[] = []
      for (const messageId of messageIds) {
        const wire = await this.client.getMessage(from.id, messageId)
        if (!wire) throw new Error(`QQ source message not found: ${messageId}`)
        const source = this.mapMessage(wire)
        const parts: IMMessageInput['parts'] = source.content.parts.map((part) => {
          if (part.type === 'text') return { ...part }
          if (part.type === 'sticker') return {
            type: 'sticker' as const,
            sticker: {
              type: 'native' as const,
              providerId: part.sticker.providerId,
              stickerId: part.sticker.stickerId,
              packId: part.sticker.packId,
              reference: part.sticker.locator!,
            },
          }
          if (!part.media.locator) throw new Error(`QQ source media has no locator: ${part.media.id}`)
          return {
            type: 'media' as const,
            media: {
              kind: part.media.kind, name: part.media.name, mimeType: part.media.mimeType,
              size: part.media.size, width: part.media.width, height: part.media.height,
              source: {
                size: part.media.size,
                stream: ({ signal } = {}) => this.client.downloadMedia(part.media.locator!, { signal }),
              },
            },
          }
        })
        outputs.push(await this.sendMessage(session, to, {
          parts,
          replyToId: options.replyToId,
        }))
      }
      return outputs
    }
    const merged = messageIds.length > 1
    const messages = await this.client.forwardMessages(from.id, messageIds, to.id, merged)
    return messages.map((message) => this.mapMessage(message))
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<QQMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    if (!media.locator) throw new Error(`QQ media ${media.id} has no locator`)
    if (this.mediaCache?.cacheAndConvertImages && media.kind === 'image') {
      yield* this.mediaCache.downloadImage(media, {
        size: media.size,
        stream: ({ signal } = {}) => this.client.downloadMedia(media.locator!, { signal }),
      }, options)
      return
    }
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
    target: IMReactionTarget,
  ): Promise<IMReactionContext> {
    if (!this.isGroupConversation(target.conversationId)) {
      return { available: [], reactions: [], maxSelected: 0 }
    }
    return this.ensureReactionCatalog()
  }

  async getMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
  ): Promise<IMReactionContext> {
    if (!this.isGroupConversation(target.conversationId)) {
      return { available: [], reactions: [], maxSelected: 0 }
    }
    return this.withReactionCatalog(
      await this.client.getMessageReactions(target.conversationId, target.targetId),
    )
  }

  async setMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
    reactionKeys: readonly string[],
  ): Promise<IMReactionContext> {
    if (!this.isGroupConversation(target.conversationId)) {
      throw new Error('QQ reactions are unavailable in direct conversations')
    }
    return this.withReactionCatalog(await this.client.setMessageReactions(
      target.conversationId, target.targetId, reactionKeys,
    ))
  }

  async *downloadReactionResource(
    _session: PlatformSession,
    resource: IMReactionResource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const locator = resource.locator
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)
      || typeof locator.cacheKey !== 'string') throw new Error('QQ reaction resource is not cached')
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('download aborted')
    const cached = this.reactionResources.get(locator.cacheKey)
    if (!cached) throw new Error(`QQ reaction resource cache miss: ${locator.cacheKey}`)
    const start = Math.min(cached.length, Math.max(0, options.offset ?? 0))
    const end = options.limit === undefined
      ? cached.length
      : Math.min(cached.length, start + Math.max(0, options.limit))
    const output = cached.subarray(start, end)
    if (!output.length) return
    await options.onProgress?.({
      phase: 'download',
      mediaIndex: 0,
      transferredBytes: output.length,
      totalBytes: resource.size,
    })
    yield output
  }

  private ensureReactionCatalog(): Promise<IMReactionContext> {
    if (this.reactionCatalog) return Promise.resolve(this.reactionCatalog)
    if (this.reactionCatalogPromise) return this.reactionCatalogPromise
    const pending = this.loadReactionCatalog()
    this.reactionCatalogPromise = pending
    return pending.finally(() => {
      if (this.reactionCatalogPromise === pending) this.reactionCatalogPromise = undefined
    })
  }

  private async loadReactionCatalog(): Promise<IMReactionContext> {
    const source = await this.client.getReactionCatalog()
    const available = await mapConcurrent(source.available, 8, async (definition) => {
      if (definition.presentation.type !== 'custom') return definition
      const { resource } = definition.presentation
      // Directly constructed test/lightweight instances may omit the cache;
      // the production plugin always supplies it from apply().
      if (!this.mediaCache) return definition
      const filePath = resource.locator.filePath
      const input: IMStickerAsset = {
        source: {
          size: resource.size,
          stream: ({ signal } = {}) => this.client.downloadMedia({
            messageId: `reaction:${filePath}`,
            elementId: `reaction:${filePath}`,
            chatType: 1,
            peerUid: '',
            kind: 'image',
            fileName: filePath.split('/').at(-1) ?? 'reaction.png',
            filePath,
            fileSize: resource.size === undefined ? undefined : String(resource.size),
          }, { signal }),
        },
        mimeType: resource.format === 'video' ? 'image/apng' : 'image/png',
        size: resource.size,
        width: resource.width,
        height: resource.height,
      }
      const asset = await this.mediaCache.openReaction(
        definition.key, resource.version, resource.format, input,
      )
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of asset.source.stream()) {
        chunks.push(chunk)
        size += chunk.length
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      const video = resource.format === 'video'
      const cacheKey = `${definition.key}:${resource.version}:${video ? 'webm' : 'webp'}-v1`
      this.reactionResources.set(cacheKey, bytes)
      return {
        ...definition,
        presentation: {
          ...definition.presentation,
          resource: {
            ...resource,
            version: resource.version * 100 + (video ? 2 : 1),
            format: video ? 'video' as const : 'static' as const,
            mimeType: video ? 'video/webm' as const : 'image/webp' as const,
            width: 100,
            height: 100,
            size: bytes.length,
            locator: { cacheKey },
          },
        },
      }
    })
    const catalog: IMReactionContext = {
      available,
      reactions: [],
      maxSelected: source.maxSelected,
    }
    this.reactionCatalog = catalog
    return catalog
  }

  private async withReactionCatalog(state: WireReactionState): Promise<IMReactionContext> {
    const catalog = await this.ensureReactionCatalog()
    return { available: catalog.available, reactions: state.reactions, maxSelected: state.maxSelected }
  }

  private isGroupConversation(conversationId: string): boolean {
    const known = this.conversations.get(conversationId)
    if (known) return known.kind === 'group'
    return conversationId.startsWith('2:') || /^\d+$/.test(conversationId)
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
      return {
        type: 'message',
        conversation,
        message: this.mapMessage(input.message),
      }
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
      context: {
        available: conversation.kind === 'group' ? this.reactionCatalog?.available ?? [] : [],
        reactions: input.context.reactions,
        maxSelected: conversation.kind === 'group' ? input.context.maxSelected : 0,
      },
      timestamp: input.timestamp,
    }
  }

  private mapMessage(input: WireMessage): IMMessage<QQMediaLocator> {
    return mapMessage(
      input, this.memberName, this.reactionCatalog, this.stickerProviderId, this.registerMultiForward,
    )
  }

  private readonly registerMultiForward = (
    title: string,
    locator: WireMultiForwardLocator,
  ): IMConversation<QQMediaLocator> => {
    const id = multiForwardConversationId(locator)
    const conversation: IMConversation<QQMediaLocator> = {
      id,
      kind: 'group',
      title: title || '聊天记录',
      metadata: { virtual: true, qqTemporaryMultiForward: true },
    }
    this.multiForwardLocators.set(id, locator)
    this.conversations.set(id, conversation)
    return conversation
  }
}

interface QQNTLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

function wireEventSummary(event: WireEvent): string {
  if (event.type === 'message') {
    return `type=message conversation=${event.conversation.id} message=${event.message.id} sender=${event.message.senderId} outgoing=${Boolean(event.message.outgoing)} parts=${event.message.parts.length}`
  }
  if (event.type === 'message-delete') {
    return `type=message-delete conversation=${event.conversation.id} eventId=${event.eventId} messages=${event.messageIds.join(',')}`
  }
  return `type=message-reactions conversation=${event.conversation.id} eventId=${event.eventId} message=${event.target.messageId} reactions=${event.context.reactions.length}`
}

function imEventSummary(event: IMEvent<QQMediaLocator>): string {
  if (event.type === 'message' || event.type === 'message-edit') {
    return `type=${event.type} conversation=${event.conversation.id} message=${event.message.id} sender=${event.message.senderId} outgoing=${Boolean(event.message.outgoing)} parts=${event.message.content.parts.length}`
  }
  if (event.type === 'message-delete') {
    return `type=message-delete conversation=${event.conversation.id} eventId=${event.eventId} messages=${event.messageIds.join(',')}`
  }
  if (event.type === 'message-reactions') {
    return `type=message-reactions conversation=${event.conversation.id} eventId=${event.eventId} message=${event.target.messageId} reactions=${event.context.reactions.length}`
  }
  if (event.type === 'read') {
    return `type=read conversation=${event.conversationId} upToMessage=${event.upToMessageId}`
  }
  return `type=conversation conversation=${event.conversation.id}`
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.stack ?? `${error.name}: ${error.message}`
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
      ...(input.participantCount === undefined ? {} : { participantsCount: input.participantCount }),
      ...(input.selfRole ? { qqSelfRole: input.selfRole } : {}),
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

function mapMessage(
  input: WireMessage,
  memberName: MemberNameMode,
  reactionCatalog?: IMReactionContext,
  stickerProviderId = 'qqnt:stickers',
  registerMultiForward?: (title: string, locator: WireMultiForwardLocator) => IMConversation<QQMediaLocator>,
): IMMessage<QQMediaLocator> {
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
    replyToId: input.replyToId,
    metadata: input.msgSeq ? { qqMsgSeq: input.msgSeq } : undefined,
    reactionContext: input.reactionContext ? {
      available: reactionCatalog?.available ?? [],
      reactions: input.reactionContext.reactions,
      maxSelected: input.reactionContext.maxSelected,
    } : undefined,
    content: {
      parts: mapParts(input, stickerProviderId, reactionCatalog, registerMultiForward),
    },
  }
}

function mapParts(
  input: WireMessage,
  stickerProviderId: string,
  reactionCatalog?: IMReactionContext,
  registerMultiForward?: (title: string, locator: WireMultiForwardLocator) => IMConversation<QQMediaLocator>,
): IMMessage<QQMediaLocator>['content']['parts'] {
  const parts: IMMessage<QQMediaLocator>['content']['parts'] = []
  for (const part of input.parts) {
    if (part.type === 'text') {
      const normalized = normalizeTextPart(part, reactionCatalog)
      const previous = parts.at(-1)
      if (previous?.type === 'text') {
        const offset = previous.text.length
        previous.text += normalized.text
        previous.entities = [
          ...(previous.entities ?? []),
          ...(normalized.entities ?? []).map((entity) => ({ ...entity, offset: entity.offset + offset })),
        ]
      } else {
        parts.push(normalized)
      }
    } else if (part.type === 'multi-forward') {
      const conversation = registerMultiForward?.(part.title, part.locator)
      parts.push({
        type: 'text', text: '\u200b',
        entities: conversation ? [{ type: 'conversation-link', offset: 0, length: 1, conversation }] : undefined,
      })
    } else if (part.type === 'sticker') {
      parts.push({
              type: 'sticker' as const,
              sticker: {
                providerId: stickerProviderId,
                stickerId: part.sticker.stickerId,
                packId: part.sticker.packId,
                title: part.sticker.title,
                format: part.sticker.format,
                mimeType: part.sticker.mimeType,
                width: part.sticker.width,
                height: part.sticker.height,
                size: part.sticker.size,
                version: part.sticker.version,
                locator: part.sticker.reference as never,
              },
      })
    } else {
      parts.push({ type: 'media', media: mapMedia(part.media) })
    }
  }
  return parts
}

function multiForwardConversationId(locator: WireMultiForwardLocator): string {
  return `qqnt-multi-forward:${JSON.stringify([
    locator.conversationId, locator.rootMessageId, locator.parentMessageId ?? '',
  ])}`
}

function normalizeTextPart(
  part: Extract<WireMessage['parts'][number], { type: 'text' }>,
  reactionCatalog?: IMReactionContext,
): Extract<IMMessage<QQMediaLocator>['content']['parts'][number], { type: 'text' }> {
  const face = part.entities?.find((entity) => entity.type === 'qq-face')
  if (face && face.offset === 0 && face.length === part.text.length) {
    const definition = reactionCatalog?.available.find((item) => item.key === `1:${face.faceId}`)
    if (definition?.presentation.type === 'emoji') {
      return { type: 'text', text: definition.presentation.emoticon }
    }
    if (definition?.presentation.type === 'custom') {
      const text = definition.presentation.alt
      return {
        type: 'text', text,
        entities: [{ type: 'custom-emoji', offset: 0, length: text.length, definition }],
      }
    }
  }
  return {
    type: 'text', text: part.text,
    entities: part.entities?.flatMap((entity) => entity.type === 'mention' ? [{ ...entity }] : []),
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

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      output[index] = await mapper(values[index]!)
    }
  }))
  return output
}

export type { QQMediaLocator } from './protocol.js'
export { QQNTClient } from './client.js'
export { QQStickerProvider } from './sticker-provider.js'
