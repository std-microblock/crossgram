import type { Context } from 'cordis'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialogPage,
  IMDownloadOptions, IMEvent, IMHistoryPage, IMHistoryQuery, IMMedia, IMMessage, IMMessageInput,
  IMPageQuery, IMPlatform, IMReactionContext, IMReactionResource, IMReactionTarget, IMTransferOptions,
  IMUser, IMUserPage, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import { QQNTClient, type QQNTClientOptions } from './client.js'
import { QQStickerProvider } from './sticker-provider.js'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMedia, WireMessage, WireReactionState,
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
  const platform = new QQNTPlatform(config, stickerProviderId, mediaCache)
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
      edit: { mode: 'unsupported' },
      forward: { mode: 'unsupported', preservesAuthor: false },
    },
    reactions: { read: true, write: true, events: true, actorList: false, maxSelected: 20 },
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

  constructor(
    options: Config = {},
    private readonly stickerProviderId = 'qqnt:stickers',
    private readonly mediaCache?: QQMediaCache,
  ) {
    this.client = new QQNTClient(options)
    this.memberName = options.memberName ?? 'groupAlias'
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    await this.ensureReactionCatalog()
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
    while (!signal.aborted) {
      try {
        await this.client.subscribe((event) => {
          if (event.type === 'message' && event.message.originRequestId
            && this.originSessions.get(event.message.originRequestId) === platformSessionId) return
          return handler(this.mapEvent(event))
        }, signal)
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
        lastMessage: conversation.lastMessage
          ? mapMessage(
              conversation.lastMessage,
              this.memberName,
              conversation.kind === 'group' ? this.reactionCatalog : undefined,
              this.stickerProviderId,
            )
          : undefined,
        readInboxMaxMessage: conversation.readInboxMaxMessage
          ? mapMessage(
              conversation.readInboxMaxMessage,
              this.memberName,
              conversation.kind === 'group' ? this.reactionCatalog : undefined,
              this.stickerProviderId,
            )
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
      messages: response.messages.map((message) => mapMessage(
        message,
        this.memberName,
        this.isGroupConversation(conversation.id) ? this.reactionCatalog : undefined,
        this.stickerProviderId,
      )),
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
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') || undefined
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
      return mapMessage(
        await this.client.sendMessage(conversation.id, text, media, options, originRequestId, sticker),
        this.memberName,
        this.isGroupConversation(conversation.id) ? this.reactionCatalog : undefined,
        this.stickerProviderId,
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
      if (resource.format === 'video') {
        const assetKey = resource.locator.assetKey
        if (!assetKey || !/^sysface\/s\d+\.webm$/.test(assetKey)) {
          throw new Error(`invalid QQ animated reaction asset: ${String(assetKey)}`)
        }
        const bytes = await readFile(new URL(`../assets/reactions/${assetKey}`, import.meta.url))
        const cacheKey = `${definition.key}:${resource.version}:webm-v1`
        this.reactionResources.set(cacheKey, bytes)
        return {
          ...definition,
          presentation: {
            ...definition.presentation,
            resource: {
              ...resource,
              version: resource.version * 100 + 2,
              format: 'video' as const,
              mimeType: 'video/webm' as const,
              width: 100,
              height: 100,
              size: bytes.length,
              locator: { cacheKey },
            },
          },
        }
      }
      const filePath = resource.locator.filePath
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of this.client.downloadMedia({
        messageId: `reaction:${filePath}`,
        elementId: `reaction:${filePath}`,
        chatType: 1,
        peerUid: '',
        kind: 'image',
        fileName: filePath.split('/').at(-1) ?? 'reaction.png',
        filePath,
        fileSize: resource.size === undefined ? undefined : String(resource.size),
      })) {
        chunks.push(chunk)
        size += chunk.length
      }
      const sourceBytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        sourceBytes.set(chunk, offset)
        offset += chunk.length
      }
      const bytes = await sharp(sourceBytes)
        .resize(100, 100, { fit: 'contain' })
        .webp({ lossless: true })
        .toBuffer()
      const cacheKey = `${definition.key}:${resource.version}:webp-v1`
      this.reactionResources.set(cacheKey, bytes)
      return {
        ...definition,
        presentation: {
          ...definition.presentation,
          resource: {
            ...resource,
            version: resource.version * 100 + 1,
            mimeType: 'image/webp' as const,
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
        message: mapMessage(
          input.message,
          this.memberName,
          conversation.kind === 'group' ? this.reactionCatalog : undefined,
          this.stickerProviderId,
        ),
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
    metadata: input.msgSeq ? { qqMsgSeq: input.msgSeq } : undefined,
    reactionContext: input.reactionContext ? {
      available: reactionCatalog?.available ?? [],
      reactions: input.reactionContext.reactions,
      maxSelected: input.reactionContext.maxSelected,
    } : undefined,
    content: {
      parts: input.parts.map((part) =>
        part.type === 'text' ? { type: 'text' as const, text: part.text }
          : part.type === 'sticker' ? {
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
            }
          : { type: 'media' as const, media: mapMedia(part.media) }),
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
