import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialogPage,
  IMDownloadOptions, IMEvent, IMHistoryPage, IMHistoryQuery, IMMedia, IMMessage, IMMessageInput,
  IMMessageSearchPage, IMMessageSearchQuery, IMPageQuery, IMPlatform, IMReactionContext, IMReactionResource, IMReactionTarget, IMReadTarget, IMTransferOptions,
  IMSticker, IMStickerAsset, IMUser, IMUserPage, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { messagePartText, resolvePlatformPluginId } from '@mtproto-relay/bridge'
import { QQNTClient, type QQNTClientOptions } from './client.js'
import { QQStickerProvider } from './sticker-provider.js'
import { defineQQMediaCacheModel, QQMediaCache } from './media-cache.js'
import type {
  QQMediaLocator, QQStickerReference, WireConversation, WireEvent, WireMedia, WireMessage, WireMultiForwardLocator,
  WireReactionState, WireTextPart,
} from './protocol.js'

export type MemberNameMode = 'nickname' | 'groupAlias'

const MIN_PROTOCOL_VERSION = 18

export interface Config extends QQNTClientOptions {
  /**
   * `nickname` always exposes the QQ profile nickname.
   * `groupAlias` prefers the conversation-scoped group card when available.
   */
  memberName?: MemberNameMode
  /** Directory used for transformed media, stickers, and reactions. */
  mediaCachePath?: string
  /** Generate compact WebP previews and store them in the database. */
  generatePreviews?: boolean
  /** Maximum width/height of extracted image previews. */
  previewMaxDimension?: number
  /** Override the bundled FFmpeg executable used for GIF/APNG to WebM conversion. */
  ffmpegPath?: string
  /** Hide QQ gray-tip service messages whose text contains any configured entry. */
  grayTipFilters?: string[]
}

const DEFAULT_GRAY_TIP_FILTERS = ['回应了你的消息']

export const Config = z.object({
  endpoint: z.string().default('http://127.0.0.1:18767/v1'),
  webSocketEndpoint: z.string(),
  token: z.string().role('secret'),
  memberName: z.union([z.const('nickname'), z.const('groupAlias')]).default('groupAlias'),
  mediaCachePath: z.string(),
  generatePreviews: z.boolean().default(true),
  previewMaxDimension: z.natural().min(1).default(320),
  ffmpegPath: z.string(),
  grayTipFilters: z.array(z.string()).default(DEFAULT_GRAY_TIP_FILTERS),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export const name = 'im-platform-qqnt'
export const inject = ['imPlatform', 'imSticker', 'database', 'model']

const DIALOGS_POLL_INTERVAL_MS = 15_000
const REACTION_CATALOG_GRACE_MS = 10

export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'qqnt')
  const stickerProviderId = `${id}:stickers`
  defineQQMediaCacheModel(ctx)
  const mediaCache = new QQMediaCache({
    path: config.mediaCachePath ?? resolve(process.cwd(), 'data', 'qqnt-media-cache', id),
    generatePreviews: config.generatePreviews,
    previewMaxDimension: config.previewMaxDimension,
    ffmpegPath: config.ffmpegPath,
    database: ctx.database,
  })
  const logger = ctx.logger('platform-qqnt')
  const platform = new QQNTPlatform(config, stickerProviderId, mediaCache, logger)
  ctx.imPlatform.register(platform, id)
  ctx.imSticker.register(new QQStickerProvider(platform.client, stickerProviderId, mediaCache, logger), stickerProviderId)
}

export class QQNTPlatform implements IMPlatform<QQMediaLocator> {
  readonly platformKind = 'qq'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    readState: { markRead: true, events: false },
    search: true,
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 20_000,
      maxMedia: 9,
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
  private readonly grayTipFilters: readonly string[]
  private readonly originSessions = new Map<string, string>()
  private readonly multiForwardLocators = new Map<string, WireMultiForwardLocator>()
  private readonly eventHandlers = new Map<
    string,
    (event: IMEvent<QQMediaLocator>) => void | Promise<void>
  >()
  private readonly mediaPreparationJobs = new Map<string, Promise<void>>()
  private readonly mediaUpgradeJobs = new Map<string, Promise<void>>()

  constructor(
    options: Config = {},
    private readonly stickerProviderId = 'qqnt:stickers',
    private readonly mediaCache?: QQMediaCache,
    private readonly logger?: QQNTLogger,
  ) {
    this.client = new QQNTClient(options)
    this.memberName = options.memberName ?? 'groupAlias'
    this.grayTipFilters = options.grayTipFilters ?? DEFAULT_GRAY_TIP_FILTERS
  }

  async getAccount() {
    const status = await this.client.status()
    const userId = status.selfUid ?? status.selfUin
    if (!status.ready || !userId) throw new Error('QQNT account is not ready')
    if (status.protocolVersion < MIN_PROTOCOL_VERSION) {
      throw new Error(`QQNT bridge protocol ${status.protocolVersion} is unsupported; platform features require ${MIN_PROTOCOL_VERSION}`)
    }
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
    const knownConversationIds = new Set<string>()
    const inFlightMessageKeys = new Set<string>()
    this.eventHandlers.set(session.platformSessionId, handler)
    const running = Promise.all([
      this.subscribeLoop(session.platformSessionId, handler, knownConversationIds, inFlightMessageKeys, controller.signal),
      this.subscribeDialogsLoop(
        session.platformSessionId, handler, knownConversationIds, inFlightMessageKeys, controller.signal,
      ),
    ])
    return async () => {
      controller.abort()
      await running
      if (this.eventHandlers.get(session.platformSessionId) === handler) {
        this.eventHandlers.delete(session.platformSessionId)
      }
    }
  }

  private async subscribeLoop(
    platformSessionId: string,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    knownConversationIds: Set<string>,
    inFlightMessageKeys: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    let lastEventId: string | undefined
    let attempt = 0
    while (!signal.aborted) {
      attempt++
      this.logger?.info(
        'WebSocket subscribe start session=%s attempt=%d endpoint=%s lastEventId=%s',
        platformSessionId, attempt, this.client.webSocketEndpoint, lastEventId ?? '<none>',
      )
      try {
        await this.client.subscribe(async (event, eventId) => {
          this.logger?.info(
            'WebSocket event received session=%s streamEventId=%s %s',
            platformSessionId, eventId ?? '<none>', wireEventSummary(event),
          )
          if (event.type === 'message' && this.isFilteredGrayTip(event.message)) {
            knownConversationIds.add(event.conversation.id)
            this.logger?.info(
              'WebSocket event filtered session=%s reason=gray-tip streamEventId=%s message=%s text=%s',
              platformSessionId, eventId ?? '<none>', event.message.id,
              event.message.serviceAction?.text ?? '',
            )
            return
          }
          if (event.type === 'message' && event.message.originRequestId
            && this.originSessions.get(event.message.originRequestId) === platformSessionId) {
            knownConversationIds.add(event.conversation.id)
            this.logger?.info(
              'WebSocket event filtered session=%s reason=own-origin streamEventId=%s message=%s originRequestId=%s',
              platformSessionId, eventId ?? '<none>', event.message.id, event.message.originRequestId,
            )
            return
          }
          const mapped = this.mapEvent(event)
          this.logger?.info(
            'WebSocket event mapped session=%s streamEventId=%s %s',
            platformSessionId, eventId ?? '<none>', imEventSummary(mapped),
          )
          if (mapped.type === 'message') {
            const delivered = await this.dispatchMessage(handler, mapped, inFlightMessageKeys)
            if (delivered) knownConversationIds.add(event.conversation.id)
          } else {
            await handler(mapped)
          }
          this.logger?.info(
            'WebSocket event handled session=%s streamEventId=%s %s',
            platformSessionId, eventId ?? '<none>', imEventSummary(mapped),
          )
        }, signal, {
          lastEventId,
          onEventId: (eventId) => { lastEventId = eventId },
        })
        if (!signal.aborted) this.logger?.warn(
          'WebSocket stream ended session=%s attempt=%d lastEventId=%s; reconnecting',
          platformSessionId, attempt, lastEventId ?? '<none>',
        )
      } catch (error) {
        if (signal.aborted) return
        this.logger?.warn(
          'WebSocket stream failed session=%s attempt=%d lastEventId=%s error=%s; reconnecting',
          platformSessionId, attempt, lastEventId ?? '<none>', formatError(error),
        )
      }
      await abortableDelay(1_000, signal)
    }
  }

  private async subscribeDialogsLoop(
    platformSessionId: string,
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    knownConversationIds: Set<string>,
    inFlightMessageKeys: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    let hasBaseline = false
    while (!signal.aborted) {
      try {
        if (!hasBaseline) {
          // The baseline must include every page. Otherwise a conversation
          // outside the first page is misclassified as newly received when it
          // later moves to the top after a message arrives.
          let cursor: string | undefined
          const seenCursors = new Set<string>()
          do {
            const page = await this.getDialogsPage({ cursor, limit: 100 }, signal)
            for (const dialog of page.dialogs) knownConversationIds.add(dialog.conversation.id)
            cursor = page.nextCursor
            if (cursor && seenCursors.has(cursor)) break
            if (cursor) seenCursors.add(cursor)
          } while (cursor && !signal.aborted)
          hasBaseline = true
        } else {
          // Recent changes move to the first page, so subsequent polling only
          // needs that page rather than scanning hundreds of dialogs each time.
          const page = await this.getDialogsPage({ limit: 100 }, signal)
          for (const dialog of page.dialogs) {
            if (knownConversationIds.has(dialog.conversation.id) || !dialog.lastMessage) continue
            const originRequestId = dialog.lastMessage.metadata?.qqOriginRequestId
            if (typeof originRequestId === 'string'
              && this.originSessions.get(originRequestId) === platformSessionId) {
              knownConversationIds.add(dialog.conversation.id)
              continue
            }
            const delivered = await this.dispatchMessage(handler, {
              type: 'message', conversation: dialog.conversation, message: dialog.lastMessage,
            }, inFlightMessageKeys)
            if (delivered) knownConversationIds.add(dialog.conversation.id)
          }
        }
      } catch {
        if (signal.aborted) return
      }
      await abortableDelay(DIALOGS_POLL_INTERVAL_MS, signal)
    }
  }

  private async dispatchMessage(
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    event: Extract<IMEvent<QQMediaLocator>, { type: 'message' }>,
    inFlightMessageKeys: Set<string>,
  ): Promise<boolean> {
    const key = `${event.conversation.id}\0${event.message.id}`
    if (inFlightMessageKeys.has(key)) return false
    inFlightMessageKeys.add(key)
    try {
      const message = await this.prepareInitialMessage(event.message)
      await handler({ ...event, message })
      this.scheduleMediaUpgrade(handler, event.conversation, message)
      return true
    } finally {
      inFlightMessageKeys.delete(key)
    }
  }

  async getDialogs(session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<QQMediaLocator>> {
    await waitAtMost(this.ensureReactionCatalog().catch(() => undefined), REACTION_CATALOG_GRACE_MS)
    const page = await this.getDialogsPage(query)
    return {
      ...page,
      dialogs: await Promise.all(page.dialogs.map(async (dialog) => ({
        ...dialog,
        lastMessage: dialog.lastMessage
          ? await this.prepareRequestedMessage(session, dialog.conversation, dialog.lastMessage)
          : undefined,
        readInboxMaxMessage: dialog.readInboxMaxMessage
          ? await this.prepareRequestedMessage(session, dialog.conversation, dialog.readInboxMaxMessage)
          : undefined,
      }))),
    }
  }

  private async getDialogsPage(
    query: IMPageQuery = {},
    signal?: AbortSignal,
  ): Promise<IMDialogPage<QQMediaLocator>> {
    const response = await this.client.getDialogs({
      cursor: query.cursor, afterId: query.afterId, limit: query.limit,
    }, signal)
    for (const conversation of response.conversations) {
      if (conversation.firstUnread?.msgSeq) this.firstUnreadSeq.set(conversation.id, conversation.firstUnread.msgSeq)
      else this.firstUnreadSeq.delete(conversation.id)
    }
    return {
      dialogs: response.conversations.map((conversation) => ({
        conversation: this.mapConversation(conversation),
        unreadCount: conversation.unreadCount ?? 0,
        lastMessage: conversation.lastMessage
          && !this.isFilteredGrayTip(conversation.lastMessage)
          ? this.mapMessage(conversation.lastMessage)
          : undefined,
        readInboxMaxMessage: conversation.readInboxMaxMessage
          ? this.mapMessage(conversation.readInboxMaxMessage)
          : undefined,
      })),
      nextCursor: response.nextCursor,
      total: response.total,
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
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<QQMediaLocator>> {
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const multiForward = this.multiForwardLocators.get(conversation.id)
    if (multiForward) {
      const messages = await this.client.getMultiForwardMessages(multiForward)
      await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
      return {
        messages: await Promise.all(messages.filter((message) => !this.isFilteredGrayTip(message))
          .slice(0, query.limit ?? messages.length).map((message) => {
            const mapped = this.rebaseMultiForwardMedia(this.mapMessage(message), multiForward)
            return this.prepareRequestedMessage(session, this.conversationFor(conversation.id), {
              ...mapped, conversationId: conversation.id,
            })
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
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    return {
      messages: await Promise.all(response.messages.filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(session, this.conversationFor(conversation.id), this.mapMessage(message)))),
      nextCursor: response.nextCursor,
    }
  }

  async searchMessages(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMMessageSearchQuery,
  ): Promise<IMMessageSearchPage<QQMediaLocator>> {
    const reactionWarmup = this.ensureReactionCatalog().catch(() => undefined)
    const response = await this.client.searchMessages(conversation.id, {
      q: query.query,
      cursor: query.cursor,
      limit: query.limit,
      fromUserId: query.fromUserId,
      minTimestamp: query.minTimestamp,
      maxTimestamp: query.maxTimestamp,
      mediaKind: query.mediaKind,
    })
    await waitAtMost(reactionWarmup, REACTION_CATALOG_GRACE_MS)
    return {
      messages: await Promise.all(response.messages.filter((message) => !this.isFilteredGrayTip(message)).map((message) =>
        this.prepareRequestedMessage(session, this.conversationFor(conversation.id), this.mapMessage(message)))),
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
    session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<QQMediaLocator> | null> {
    const message = await this.client.getMessage(conversation.id, messageId)
    return message && !this.isFilteredGrayTip(message)
      ? this.prepareRequestedMessage(session, this.conversationFor(conversation.id), this.mapMessage(message))
      : null
  }

  async markRead(_session: PlatformSession, target: IMReadTarget): Promise<void> {
    await this.client.markRead(target.conversationId, target.messageId)
    this.firstUnreadSeq.delete(target.conversationId)
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
      throw new Error('QQNT supports either one sticker or up to nine media items per message')
    }
    const stickerPart = stickerParts[0]
    let sticker: QQStickerReference | undefined
    if (stickerPart?.type === 'sticker') {
      if (stickerPart.sticker.type !== 'native') {
        throw new Error('QQNT only accepts native QQ sticker send plans')
      }
      sticker = stickerPart.sticker.reference as unknown as QQStickerReference
    }
    if (mediaParts.length > 9) throw new Error('QQNT supports at most nine media items per message')
    const media = mediaParts.map((part, index) => ({
      kind: part.media.kind,
      name: part.media.name ?? `upload-${Date.now()}-${index}`,
      mimeType: part.media.mimeType,
      width: part.media.width,
      height: part.media.height,
      duration: part.media.duration,
      source: part.media.source,
    }))
    const originRequestId = randomUUID()
    this.originSessions.set(originRequestId, session.platformSessionId)
    try {
      return this.prepareInitialMessage(this.mapMessage(
        await this.client.sendMessage(
          conversation.id, text, media.length ? media : undefined,
          options, originRequestId, sticker, textParts, content.replyToId,
        ),
      ))
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
          if (part.type === 'card') return { type: 'text' as const, text: messagePartText(part) }
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
                stream: ({ signal } = {}) => this.downloadMedia(session, part.media, { signal }),
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
    if (media.locator.deferred) return
    const original = {
      size: media.size,
      stream: ({ signal }: { signal?: AbortSignal } = {}) => this.client.downloadFile(media.locator!, { signal }),
    }
    if (this.mediaCache && (media.locator.previewKey || media.locator.cachedPath)) {
      yield* this.mediaCache.download(media, original, options)
      return
    }
    let transferred = 0
    for await (const chunk of this.client.downloadFile(media.locator, {
      signal: options.signal, offset: options.offset, limit: options.limit,
    })) {
      transferred += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes: transferred,
        totalBytes: rangedSize(media.size, options.offset, options.limit),
      })
      yield chunk
    }
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
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
      throw new Error('QQ reaction resource has no usable locator')
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('download aborted')
    if (typeof locator.cacheKey === 'string') {
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
      return
    }
    if (isReactionResourceLocator(locator)) {
      let transferredBytes = 0
      for await (const chunk of this.client.downloadReactionResource(locator.reactionKey, {
        signal: options.signal,
        offset: options.offset,
        limit: options.limit,
        onChunk: async (size) => {
          transferredBytes += size
          await options.onProgress?.({
            phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: resource.size,
          })
        },
      })) yield chunk
      return
    }
    if (!isRemoteQQMediaLocator(locator)) throw new Error('QQ reaction resource has no cached remote asset')
    let transferredBytes = 0
    for await (const chunk of sliceStream(
      this.client.downloadFile(locator, { signal: options.signal }),
      options.offset, options.limit,
    )) {
      transferredBytes += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: resource.size,
      })
      yield chunk
    }
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
      const locator = resource.locator
      if (!isReactionResourceLocator(locator) && !isRemoteQQMediaLocator(locator)) return definition
      const input: IMStickerAsset = {
        source: {
          size: resource.size,
          stream: ({ signal } = {}) => isReactionResourceLocator(locator)
            ? this.client.downloadReactionResource(locator.reactionKey, { signal })
            : this.client.downloadFile(locator, { signal }),
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

  private conversationFor(conversationId: string): IMConversation<QQMediaLocator> {
    return this.conversations.get(conversationId) ?? {
      id: conversationId,
      kind: this.isGroupConversation(conversationId) ? 'group' : 'direct',
      title: conversationId,
    }
  }

  private async prepareRequestedMessage(
    session: PlatformSession,
    conversation: IMConversation<QQMediaLocator>,
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    const handler = this.eventHandlers.get(session.platformSessionId)
    if (!handler || !this.mediaCache) return this.prepareInitialMessage(message)
    let deferred = false
    const parts = await Promise.all(message.content.parts.map(async (part) => {
      if (part.type === 'sticker') {
        try {
          const restored = await this.restoreSticker(part.sticker)
          if (restored) return { ...part, sticker: restored }
        } catch {
          // Treat a failed cache lookup as a miss. Background preparation logs
          // the actionable error and leaves the placeholder intact.
        }
        const locator = part.sticker.locator as unknown as QQStickerReference | undefined
        if (!locator) return part
        deferred = true
        return {
          ...part,
          sticker: {
            ...part.sticker,
            size: 0,
            thumbnail: undefined,
            outline: undefined,
            locator: { ...locator, deferred: true } as never,
          },
        }
      }
      if (part.type !== 'media' || !part.media.locator || !this.mediaCache!.shouldPrepare(part.media)) return part
      const restored = await this.mediaCache!.restoreInitialMedia(part.media)
      if (restored) return { type: 'media' as const, media: restored }
      deferred = true
      return {
        type: 'media' as const,
        media: {
          ...part.media,
          locator: { ...part.media.locator, deferred: true as const },
        },
      }
    }))
    const prepared = { ...message, content: { ...message.content, parts } }
    const timer = setTimeout(() => {
      if (deferred) this.scheduleMediaPreparation(handler, conversation, message)
      else this.scheduleMediaUpgrade(handler, conversation, prepared)
    }, 0)
    timer.unref()
    return prepared
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

  private isFilteredGrayTip(message: WireMessage): boolean {
    const text = message.serviceAction?.text
    return Boolean(text && this.grayTipFilters.some((filter) => filter && text.includes(filter)))
  }

  private mapMessage(input: WireMessage): IMMessage<QQMediaLocator> {
    const message = mapMessage(
      input, this.memberName, this.reactionCatalog, this.stickerProviderId, this.registerMultiForward,
    )
    if (!this.mediaCache) return message
    return {
      ...message,
      content: {
        ...message.content,
        parts: message.content.parts.map((part) => part.type === 'sticker'
          ? { ...part, sticker: this.mediaCache!.projectSticker(part.sticker) }
          : part),
      },
    }
  }

  private rebaseMultiForwardMedia(
    message: IMMessage<QQMediaLocator>,
    locator: WireMultiForwardLocator,
  ): IMMessage<QQMediaLocator> {
    const outer = this.conversations.get(locator.conversationId)
    const chatType = outer?.metadata?.chatType
    const peerUid = outer?.metadata?.qqPeerUid
    if ((chatType !== 1 && chatType !== 2) || typeof peerUid !== 'string' || !peerUid) return message
    const physicalChatType: 1 | 2 = chatType === 1 ? 1 : 2

    let changed = false
    const parts = message.content.parts.map((part) => {
      if (part.type !== 'media' || !part.media.locator) return part
      changed ||= part.media.locator.chatType !== physicalChatType || part.media.locator.peerUid !== peerUid
      return {
        ...part,
        media: {
          ...part.media,
          locator: { ...part.media.locator, chatType: physicalChatType, peerUid },
        },
      }
    })
    return changed ? { ...message, content: { ...message.content, parts } } : message
  }

  private async prepareInitialMessage(
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator>> {
    if (!this.mediaCache) return message
    const parts = await Promise.all(message.content.parts.map(async (part) => {
      if (part.type === 'sticker') {
        try {
          return {
            ...part,
            sticker: await this.prepareSticker(part.sticker),
          }
        } catch (error) {
          this.logger?.warn(
            'cached sticker thumbnail lookup failed message=%s sticker=%s error=%s',
            message.id, part.sticker.stickerId, formatError(error),
          )
          return part
        }
      }
      if (part.type !== 'media' || !part.media.locator || !this.mediaCache!.shouldPrepare(part.media)) return part
      try {
        const media = await this.mediaCache!.prepareInitialMedia(part.media, {
          size: part.media.size,
          stream: ({ signal } = {}) => this.client.downloadFile(part.media.locator!, { signal }),
        })
        return { type: 'media' as const, media }
      } catch (error) {
        this.logger?.warn(
          'automatic media cache failed message=%s media=%s error=%s',
          message.id, part.media.id, formatError(error),
        )
        return part
      }
    }))
    return { ...message, content: { ...message.content, parts } }
  }

  private scheduleMediaPreparation(
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    conversation: IMConversation<QQMediaLocator>,
    message: IMMessage<QQMediaLocator>,
  ): void {
    const key = `${conversation.id}\0${message.id}`
    if (this.mediaPreparationJobs.has(key)) return
    const pending = this.prepareInitialMessage(message).then(async (prepared) => {
      await handler({
        type: 'message-edit',
        eventId: `qqnt-media-ready-v1:${conversation.id}:${message.id}`,
        conversation,
        message: prepared,
      })
      this.scheduleMediaUpgrade(handler, conversation, prepared)
    }).catch((error) => {
      this.logger?.warn(
        'deferred media preparation failed conversation=%s message=%s error=%s',
        conversation.id, message.id, formatError(error),
      )
    }).finally(() => {
      if (this.mediaPreparationJobs.get(key) === pending) this.mediaPreparationJobs.delete(key)
    })
    this.mediaPreparationJobs.set(key, pending)
  }

  private scheduleMediaUpgrade(
    handler: (event: IMEvent<QQMediaLocator>) => void | Promise<void>,
    conversation: IMConversation<QQMediaLocator>,
    message: IMMessage<QQMediaLocator>,
  ): void {
    if (!this.mediaCache || !message.content.parts.some((part) =>
      part.type === 'media' && part.media.kind === 'image' && part.media.locator
      || part.type === 'sticker' && part.sticker.format === 'video'
        && part.sticker.locator && !part.sticker.thumbnail)) return
    const key = `${conversation.id}\0${message.id}`
    if (this.mediaUpgradeJobs.has(key)) return
    const pending = this.upgradeAnimatedMessage(message).then(async (upgraded) => {
      if (!upgraded) return
      await handler({
        type: 'message-edit',
        eventId: `qqnt-media-webm-v1:${conversation.id}:${message.id}`,
        conversation,
        message: upgraded,
      })
    }).catch((error) => {
      this.logger?.warn(
        'animated media upgrade failed conversation=%s message=%s error=%s',
        conversation.id, message.id, formatError(error),
      )
    }).finally(() => {
      if (this.mediaUpgradeJobs.get(key) === pending) this.mediaUpgradeJobs.delete(key)
    })
    this.mediaUpgradeJobs.set(key, pending)
  }

  private async upgradeAnimatedMessage(
    message: IMMessage<QQMediaLocator>,
  ): Promise<IMMessage<QQMediaLocator> | undefined> {
    if (!this.mediaCache) return
    let changed = false
    const parts = await Promise.all(message.content.parts.map(async (part) => {
      if (part.type === 'sticker') {
        if (part.sticker.format !== 'video' || !part.sticker.locator || part.sticker.thumbnail) return part
        const reference = part.sticker.locator as unknown as QQStickerReference
        const sticker = await this.mediaCache!.prepareStickerThumbnail(
          part.sticker, this.client.stickerSource(reference, part.sticker.size),
        )
        if (!sticker.thumbnail) return part
        changed = true
        return { type: 'sticker' as const, sticker }
      }
      if (part.type !== 'media' || part.media.kind !== 'image' || !part.media.locator) return part
      const locator = part.media.locator
      const upgraded = await this.mediaCache!.prepareAnimatedUpgrade(part.media, {
        size: part.media.size,
        stream: ({ signal } = {}) => this.client.downloadFile(locator, { signal }),
      }, {
        read: ({ offset, limit, signal }) => this.client.downloadFile(locator, { offset, limit, signal }),
      })
      if (!upgraded) return part
      changed = true
      return { type: 'media' as const, media: upgraded }
    }))
    return changed ? { ...message, content: { ...message.content, parts } } : undefined
  }

  private prepareSticker(sticker: IMSticker): Promise<IMSticker> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!this.mediaCache || !reference) return Promise.resolve(sticker)
    return this.mediaCache.prepareSticker({
      ...sticker,
      format: reference.animated ? 'animated' : 'static',
      mimeType: reference.animated ? 'image/gif' : 'image/png',
    }, {
      source: this.client.stickerSource(reference, sticker.size),
      mimeType: reference.animated ? 'image/gif' : 'image/png',
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
    })
  }

  private restoreSticker(sticker: IMSticker): Promise<IMSticker | undefined> {
    const reference = sticker.locator as unknown as QQStickerReference | undefined
    if (!this.mediaCache || !reference) return Promise.resolve(undefined)
    return this.mediaCache.restoreSticker({
      ...sticker,
      format: reference.animated ? 'animated' : 'static',
      mimeType: reference.animated ? 'image/gif' : 'image/png',
    })
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
    id: `${input.id}:original-v1`,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    width: input.width,
    height: input.height,
    duration: input.duration,
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
    metadata: input.msgSeq || input.originRequestId || input.telegramMessageId || input.telegramReplyToMessageId ? {
      ...(input.msgSeq ? { qqMsgSeq: input.msgSeq } : {}),
      ...(input.telegramMessageId ? { telegramMessageId: input.telegramMessageId } : {}),
      ...(input.telegramReplyToMessageId ? {
        telegramReplyToMessageId: input.telegramReplyToMessageId,
        qqReplyToMsgSeq: String(input.telegramReplyToMessageId),
      } : {}),
      ...(input.originRequestId ? { qqOriginRequestId: input.originRequestId } : {}),
    } : undefined,
    reactionContext: input.reactionContext ? {
      available: reactionCatalog?.available ?? [],
      reactions: input.reactionContext.reactions,
      maxSelected: input.reactionContext.maxSelected,
    } : undefined,
    content: {
      serviceAction: input.serviceAction,
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
      const text = '查看聊天记录'
      parts.push({
        type: 'text', text,
        entities: conversation ? [{
          type: 'conversation-link', offset: 0, length: text.length, conversation,
        }] : undefined,
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
    } else if (part.type === 'card') {
      parts.push({ type: 'card', card: { ...part.card } })
    } else {
      parts.push({ type: 'media', media: mapMedia(part.media) })
    }
  }
  return parts
}

function isRemoteQQMediaLocator(value: unknown): value is QQMediaLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const locator = value as Partial<QQMediaLocator>
  return typeof locator.messageId === 'string'
    && typeof locator.elementId === 'string'
    && (locator.chatType === 1 || locator.chatType === 2)
    && typeof locator.peerUid === 'string'
    && (locator.kind === 'image' || locator.kind === 'file')
    && typeof locator.fileName === 'string'
    && Boolean(locator.originImageUrl || locator.fileUuid || locator.avatarUin)
}

function isReactionResourceLocator(value: unknown): value is { reactionKey: string } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { reactionKey?: unknown }).reactionKey === 'string')
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

async function* sliceStream(
  source: AsyncIterable<Uint8Array>,
  offset = 0,
  limit?: number,
): AsyncIterable<Uint8Array> {
  let skipped = 0
  let emitted = 0
  const start = Math.max(0, Math.trunc(offset))
  const maximum = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit))
  if (!maximum) return
  for await (const chunk of source) {
    if (skipped + chunk.length <= start) {
      skipped += chunk.length
      continue
    }
    const chunkStart = Math.max(0, start - skipped)
    const accepted = chunk.subarray(chunkStart, chunkStart + maximum - emitted)
    skipped += chunk.length
    if (accepted.length) {
      emitted += accepted.length
      yield accepted
    }
    if (emitted >= maximum) return
  }
}

function rangedSize(size: number | undefined, offset = 0, limit?: number): number | undefined {
  if (size === undefined) return limit
  const available = Math.max(0, size - Math.max(0, Math.trunc(offset)))
  return limit === undefined ? available : Math.min(available, Math.max(0, Math.trunc(limit)))
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

async function waitAtMost(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
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
