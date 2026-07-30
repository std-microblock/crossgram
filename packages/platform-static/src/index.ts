import type { Context } from 'cordis'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import z from 'schemastery'
import sharp from 'sharp'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialog,
  IMDialogPage, IMDownloadOptions, IMEvent, IMForwardMessagesOptions, IMHistoryPage, IMHistoryQuery,
  IMMedia, IMMessage, IMMessageContent, IMMessageInput, IMMessageTarget, IMPageQuery, IMPlatform, IMReadTarget,
  IMReactionContext, IMReactionDefinition, IMReactionResource,
  IMSticker, IMStickerAsset, IMStickerPack, IMStickerProvider,
  IMStickerSendPlan, IMTransferOptions, IMUser, PlatformCapabilities, PlatformSession,
  StickerProviderContext, Unsubscribe,
} from '@mtproto-relay/bridge'
import {
  expandTelegramStrippedThumbnail, resolvePlatformPluginId, stripTelegramJpegThumbnail,
} from '@mtproto-relay/bridge'

export interface StaticPlatformOptions {
  now?: () => number
  instanceId?: string
  /** Durable media directory. Set to undefined for an in-memory test adapter. */
  mediaPath?: string
  transferChunkSize?: number
  eventIntervalMs?: number
  historySize?: number
  providerIdPrefix?: string
}

export interface Config {
  instanceId?: string
  mediaPath?: string
  transferChunkSize?: number
  eventIntervalMs?: number
  historySize?: number
}

export const Config = z.object({
  instanceId: z.string(),
  mediaPath: z.string(),
  transferChunkSize: z.natural().min(1).default(64 * 1024),
  eventIntervalMs: z.natural().default(0),
  historySize: z.natural().default(10_000),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})
export const name = 'im-platform-static'
export const inject = ['imPlatform', 'imSticker']

export interface StaticMediaLocator {
  mediaId: string
}

const seededImage = new Uint8Array(readFileSync(new URL('./test-image.png', import.meta.url)))
const seededStrippedThumbnail = new Uint8Array(Buffer.from(
  'ASgcyhzwBzRjFTxoNoOKXaGHSrsK5BgYo2/WpjFx7VF0pAWo5YhGAykN7VKgUj5dv4tn+VV9o+UZAyad5WD94ZpXHYfMDs5Kgf7tU+hOCaslSwx5gP15qs3DEUXAdJIXfJ7cUpnYhQTwtFFKwXATssm9eCOmKjYksSe9FFAXPw==',
  'base64',
))
const seededImagePreview = expandTelegramStrippedThumbnail(seededStrippedThumbnail)
const staticStickerAsset = new Uint8Array(readFileSync(new URL('./assets/static.webp', import.meta.url)))
const videoStickerAsset = new Uint8Array(readFileSync(new URL('./assets/video.webm', import.meta.url)))

/** Cordis plugin entrypoint. Each plugin instance registers one isolated adapter. */
export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'static')
  const mediaPath = config.mediaPath
    ?? (process.env.NODE_ENV === 'test' ? undefined : resolve(process.cwd(), 'data/static-media', id))
  const platform = new StaticPlatform({
    ...config,
    // Keep media storage stable across HMR and process restarts. Message IDs
    // still use a per-instance nonce to avoid sequence collisions after restart.
    mediaPath,
    // Synthetic traffic is opt-in. Enabling it by default creates an unbounded
    // durable update stream for every historical active platform session.
    eventIntervalMs: config.eventIntervalMs ?? 0,
    historySize: config.historySize ?? 10_000,
    providerIdPrefix: id,
  })
  ctx.imPlatform.register(platform, id)
  ctx.imSticker.register(new StaticStickerProvider(`${id}:native`, true), `${id}:native`)
  ctx.imSticker.register(new StaticStickerProvider(`${id}:plugin`, false), `${id}:plugin`)
}

/** Complete in-memory reference adapter used for development and conformance tests. */
export class StaticPlatform implements IMPlatform<StaticMediaLocator> {
  readonly platformKind = 'static'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    readState: { markRead: true, events: true },
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 4096,
      maxMedia: 10,
    },
    conversations: { groups: true, channels: true, subchannels: true },
    members: { list: true, administrators: true, permissions: true },
    avatars: { users: true, conversations: true },
    messageActions: {
      delete: {
        own: { supported: true, maxAgeSeconds: 120 },
        // StaticPlatform models services whose moderators may remove all history.
        others: { supported: true },
      },
      edit: { mode: 'native' },
      forward: { mode: 'native', preservesAuthor: true },
    },
    stickers: { native: true, upload: true, formats: ['static', 'video'] },
    reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 11 },
  }

  private readonly _now: () => number
  private readonly _transferChunkSize: number
  private readonly _eventIntervalMs: number
  private readonly _historySize: number
  private readonly _instanceId: string
  private readonly _mediaPath?: string
  private readonly _providerIdPrefix: string
  private readonly _users = new Map<string, IMUser<StaticMediaLocator>>()
  private readonly _conversations = new Map<string, IMConversation<StaticMediaLocator>>()
  private readonly _messages = new Map<string, IMMessage<StaticMediaLocator>[]>()
  private readonly _readUpTo = new Map<string, string>()
  private readonly _media = new Map<string, Uint8Array>()
  private readonly _subscribers = new Map<string, Set<(event: IMEvent<StaticMediaLocator>) => void | Promise<void>>>()
  private readonly _timers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly _tickTails = new Map<string, Promise<void>>()
  private _sequence = 1_000
  private _demoSequence = 0

  constructor(options: StaticPlatformOptions = {}) {
    this._now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this._transferChunkSize = options.transferChunkSize ?? 64 * 1024
    this._eventIntervalMs = options.eventIntervalMs ?? 0
    this._historySize = Math.max(0, Math.trunc(options.historySize ?? 10_000))
    this._instanceId = options.instanceId ?? randomUUID()
    this._mediaPath = options.mediaPath
    this._providerIdPrefix = options.providerIdPrefix ?? 'static'
    if (this._mediaPath) mkdirSync(this._mediaPath, { recursive: true })
    this._seed()
    this._readUpTo.set('alice', 'direct:alice:1')
  }

  async getAccount() {
    return { credentials: {}, user: clone(this._users.get('self')!) }
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<StaticMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const handlers = this._subscribers.get(session.platformSessionId) ?? new Set()
    handlers.add(handler)
    this._subscribers.set(session.platformSessionId, handlers)
    this._startTimer(session)
    return () => {
      handlers.delete(handler)
      if (!handlers.size) {
        this._subscribers.delete(session.platformSessionId)
        const timer = this._timers.get(session.platformSessionId)
        if (timer) clearInterval(timer)
        this._timers.delete(session.platformSessionId)
        this._tickTails.delete(session.platformSessionId)
      }
    }
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<StaticMediaLocator>> {
    const dialogs = [...this._conversations.values()].map((conversation): IMDialog<StaticMediaLocator> => {
      const messages = this._messages.get(conversation.id) ?? []
      const boundaryId = this._readUpTo.get(conversation.id)
      const boundary = boundaryId ? messages.findIndex((message) => message.id === boundaryId) : messages.length - 1
      const unread = boundaryId
        ? messages.slice(boundary + 1).filter((message) => !message.outgoing).length
        : 0
      return {
        conversation: clone(conversation),
        unreadCount: unread,
        lastMessage: clone(messages.at(-1)),
        readInboxMaxMessage: unread && boundary >= 0 ? clone(messages[boundary]) : undefined,
      }
    }).sort((left, right) => (right.lastMessage?.timestamp ?? 0) - (left.lastMessage?.timestamp ?? 0))
    const start = pageStart(dialogs.map((dialog) => dialog.conversation.id), query.cursor, query.afterId)
    const limit = clampLimit(query.limit)
    return {
      dialogs: clone(dialogs.slice(start, start + limit)),
      nextCursor: start + limit < dialogs.length ? String(start + limit) : undefined,
    }
  }

  async getHistory(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<StaticMediaLocator>> {
    this._requireConversation(conversation.id)
    const newestFirst = [...(this._messages.get(conversation.id) ?? [])].reverse()
    let start = pageStart(newestFirst.map((message) => message.id), query.cursor, query.before?.id)
    let candidates = newestFirst
    if (query.after) {
      const anchor = newestFirst.findIndex((message) => message.id === query.after!.id)
      candidates = anchor < 0 ? [] : newestFirst.slice(0, anchor)
      start = numericCursor(query.cursor)
    }
    const limit = clampLimit(query.limit)
    return {
      messages: clone(candidates.slice(start, start + limit)),
      nextCursor: start + limit < candidates.length ? String(start + limit) : undefined,
    }
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser<StaticMediaLocator> | null> {
    return clone(this._users.get(userId) ?? null)
  }

  async markRead(_session: PlatformSession, target: IMReadTarget): Promise<void> {
    this._requireConversation(target.conversationId)
    const messages = this._messages.get(target.conversationId) ?? []
    const next = messages.findIndex((message) => message.id === target.messageId)
    if (next < 0) throw new Error(`static read target not found: ${target.messageId}`)
    const currentId = this._readUpTo.get(target.conversationId)
    const current = currentId ? messages.findIndex((message) => message.id === currentId) : -1
    if (next >= current) this._readUpTo.set(target.conversationId, target.messageId)
  }

  async sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<StaticMediaLocator>> {
    const target = this._requireConversation(conversation.id)
    this._validateContent(content)
    const messageId = this._messageId(target.id)
    const output: IMMessageContent<StaticMediaLocator>['parts'] = []
    const sourceIds: string[] = []
    let mediaIndex = 0
    for (const part of content.parts) {
      if (part.type === 'text') {
        output.push({ ...part })
        continue
      }
      if (part.type === 'sticker') {
        const sticker = await this._consumeSticker(part.sticker, options, mediaIndex++)
        output.push({ type: 'sticker', sticker })
        continue
      }
      const bytes = await consumeSource(part.media.source, mediaIndex, options)
      const mediaId = `${messageId}:media:${mediaIndex}:${'m'.repeat(128)}`
      this._storeMedia(mediaId, bytes)
      const dimensions = part.media.kind === 'image' ? imageDimensions(bytes) : undefined
      const thumbnail = part.media.kind === 'image' ? await createThumbnail(bytes) : undefined
      const previewId = thumbnail ? `${mediaId}:preview` : undefined
      if (thumbnail && previewId) this._storeMedia(previewId, thumbnail.jpeg)
      const media: IMMedia<StaticMediaLocator> = {
        id: mediaId,
        kind: part.media.kind,
        name: part.media.name,
        mimeType: part.media.mimeType,
        size: bytes.length,
        width: part.media.width ?? dimensions?.width,
        height: part.media.height ?? dimensions?.height,
        strippedThumbnail: thumbnail?.stripped,
        preview: thumbnail && previewId ? {
          mimeType: 'image/jpeg', size: thumbnail.jpeg.length,
          width: thumbnail.width, height: thumbnail.height, locator: { mediaId: previewId },
        } : undefined,
        locator: { mediaId },
      }
      output.push({ type: 'media', media })
      sourceIds.push(`${messageId}:physical:${mediaIndex}`)
      mediaIndex++
    }
    const message: IMMessage<StaticMediaLocator> = {
      id: messageId,
      sourceIds: sourceIds.length ? sourceIds : undefined,
      conversationId: target.id,
      senderId: session.userId,
      content: { parts: output },
      timestamp: this._now(),
      outgoing: true,
      groupId: mediaIndex > 1 ? `${messageId}:group` : undefined,
    }
    this._append(message)
    if (target.id === 'group-b') {
      const mirror: IMMessage<StaticMediaLocator> = {
        id: `${messageId}:mirror:${'c'.repeat(128)}`,
        sourceIds: message.sourceIds?.map((id) => `${id}:mirror`),
        conversationId: 'group-c',
        senderId: 'mirror-user',
        content: clone(message.content),
        timestamp: message.timestamp,
        groupId: message.groupId ? `${message.groupId}:mirror` : undefined,
        metadata: { mirroredFromConversationId: target.id, mirroredFromMessageId: message.id },
      }
      this._append(mirror)
      await this._dispatch(session, {
        type: 'message', conversation: clone(this._requireConversation('group-c')), message: clone(mirror),
      })
    }
    return clone(message)
  }

  async getConversationMember(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<StaticMediaLocator> | null> {
    const page = await this.getConversationMembers(session, conversation, { limit: 500 })
    return clone(page.members.find((member) => member.user.id === userId) ?? null)
  }

  async getConversationMembers(
    session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<StaticMediaLocator>> {
    const target = this._requireConversation(conversation.id)
    const memberIds = target.kind === 'direct'
      ? [session.userId, target.id]
      : [session.userId, 'alice', 'bob', 'carol']
    const uniqueIds = [...new Set(memberIds)]
    const members = uniqueIds.flatMap((id): IMConversationMember<StaticMediaLocator>[] => {
      const user = id === session.userId
        ? {
            id, firstName: typeof session.metadata.firstName === 'string' ? session.metadata.firstName : 'Static User',
            lastName: typeof session.metadata.lastName === 'string' ? session.metadata.lastName : undefined,
            username: typeof session.metadata.username === 'string' ? session.metadata.username : undefined,
            avatar: this._avatar(`user:${id}`),
          }
        : this._users.get(id)
      if (!user) return []
      const owner = id === session.userId
      const administrator = !owner && id === (session.userId === 'alice' ? 'bob' : 'alice')
      return [{
        user: clone(user), role: owner ? 'owner' : administrator ? 'administrator' : 'member',
        permissions: {
          manageConversation: owner || administrator,
          manageMembers: owner || administrator,
          deleteAnyMessage: owner || administrator,
          editAnyMessage: owner,
          pinMessages: owner || administrator,
          inviteMembers: true,
        },
        joinedAt: 1_600_000_000,
        title: administrator ? 'Moderator' : undefined,
      }]
    })
    const start = pageStart(members.map((member) => member.user.id), query.cursor, query.afterId)
    const limit = clampLimit(query.limit)
    return {
      members: clone(members.slice(start, start + limit)), total: members.length,
      nextCursor: start + limit < members.length ? String(start + limit) : undefined,
    }
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
    _options: import('@mtproto-relay/bridge').IMDeleteMessagesOptions,
  ): Promise<void> {
    const target = this._requireConversation(conversation.id)
    const requested = new Set(messageIds)
    this._messages.set(target.id, (this._messages.get(target.id) ?? []).filter((message) =>
      !requested.has(message.id) && !message.sourceIds?.some((id) => requested.has(id))))
  }

  async editMessage(
    _session: PlatformSession,
    target: IMMessageTarget,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<StaticMediaLocator>> {
    const messages = this._messages.get(this._requireConversation(target.conversationId).id) ?? []
    const index = messages.findIndex((message) =>
      message.id === target.messageId || message.id === target.targetId || message.sourceIds?.includes(target.targetId))
    if (index < 0) throw new Error(`static edit target not found: ${target.targetId}`)
    this._validateContent(content)
    const original = messages[index]
    const parts: IMMessageContent<StaticMediaLocator>['parts'] = []
    let mediaIndex = 0
    for (const part of content.parts) {
      if (part.type === 'text') parts.push({ ...part })
      else if (part.type === 'sticker') {
        parts.push({ type: 'sticker', sticker: await this._consumeSticker(part.sticker, options, mediaIndex++) })
      } else {
        const bytes = await consumeSource(part.media.source, mediaIndex, options)
        const mediaId = `${original.id}:edit:${++this._sequence}:${mediaIndex}`
        this._storeMedia(mediaId, bytes)
        const dimensions = part.media.kind === 'image' ? imageDimensions(bytes) : undefined
        parts.push({ type: 'media', media: {
          id: mediaId, kind: part.media.kind, name: part.media.name, mimeType: part.media.mimeType,
          size: bytes.length, width: part.media.width ?? dimensions?.width,
          height: part.media.height ?? dimensions?.height, locator: { mediaId },
        } })
        mediaIndex++
      }
    }
    const edited = {
      ...original, content: { parts }, metadata: { ...(original.metadata ?? {}), editedAt: this._now() },
    }
    messages[index] = edited
    return clone(edited)
  }

  async forwardMessages(
    session: PlatformSession,
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options: IMForwardMessagesOptions = {},
  ): Promise<IMMessage<StaticMediaLocator>[]> {
    const sources = this._messages.get(this._requireConversation(from.id).id) ?? []
    const destination = this._requireConversation(to.id)
    const forwarded = messageIds.map((id) => {
      const source = sources.find((message) => message.id === id || message.sourceIds?.includes(id))
      if (!source) throw new Error(`static forward source not found: ${id}`)
      const output: IMMessage<StaticMediaLocator> = {
        ...clone(source), id: this._messageId(destination.id), sourceIds: undefined,
        conversationId: destination.id, senderId: session.userId, timestamp: this._now(), outgoing: true,
        metadata: {
          ...(source.metadata ?? {}), forwardedFromConversationId: from.id,
          forwardedFromMessageId: source.id, forwardAuthorPreserved: !options.dropAuthor,
        },
      }
      this._append(output)
      return output
    })
    return clone(forwarded)
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<StaticMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const mediaId = typeof media.locator === 'object' && media.locator && !Array.isArray(media.locator)
      ? media.locator.mediaId
      : media.id
    if (typeof mediaId !== 'string') throw new Error('static media locator is invalid')
    const stored = this._loadMedia(mediaId)
    if (!stored) throw new Error(`static media not found: ${mediaId}`)
    const offset = Math.max(0, options.offset ?? 0)
    const end = Math.min(stored.length, offset + (options.limit ?? stored.length))
    const selected = stored.subarray(offset, end)
    let transferredBytes = 0
    for (let position = 0; position < selected.length; position += this._transferChunkSize) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('download aborted')
      const chunk = selected.subarray(position, position + this._transferChunkSize)
      transferredBytes += chunk.length
      await options.onProgress?.({
        phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: selected.length,
      })
      yield chunk.slice()
    }
  }

  async setMessageReactions(
    session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
    reactionKeys: readonly string[],
  ): Promise<IMReactionContext> {
    const messages = this._messages.get(target.conversationId) ?? []
    const message = messages.find((item) => item.id === target.messageId || item.sourceIds?.includes(target.targetId))
    if (!message) throw new Error(`static reaction target not found: ${target.targetId}`)
    const context = await this.getAvailableReactions(session, target)
    const allowed = new Set(context.available.map((definition) => definition.key))
    if (reactionKeys.some((key) => !allowed.has(key))) throw new Error('static reaction is not available')
    const previous = new Map(context.reactions.map((reaction) => [reaction.key, reaction]))
    const selected = new Set(reactionKeys)
    const reactions = [...new Set([...previous.keys(), ...selected])].flatMap((key) => {
      const existing = previous.get(key)
      const wasSelected = existing?.selected ?? false
      const isSelected = selected.has(key)
      const count = Math.max(0, (existing?.count ?? 0) + Number(isSelected) - Number(wasSelected))
      if (!count && !isSelected) return []
      return [{
        key, count, selected: isSelected,
        recentActors: isSelected
          ? [{ userId: session.userId, timestamp: this._now() }]
          : (existing?.recentActors ?? []).filter((actor) => actor.userId !== session.userId),
      }]
    })
    message.reactionContext = { ...context, reactions }
    return clone(message.reactionContext)
  }

  async getAvailableReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMReactionTarget,
  ): Promise<IMReactionContext> {
    const message = target.messageId
      ? (this._messages.get(target.conversationId) ?? []).find((item) => item.id === target.messageId)
      : undefined
    const available = reactionDefinitions(target.conversationId, target.messageId)
    return {
      available,
      reactions: clone(message?.reactionContext?.reactions ?? []),
      maxSelected: target.messageId === 'lab:reaction:limited'
        ? 2
        : target.conversationId === 'reaction-sticker-lab' ? 11 : 3,
    }
  }

  async getMessageReactions(
    session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
  ): Promise<IMReactionContext> {
    return this.getAvailableReactions(session, target)
  }

  async *downloadReactionResource(
    _session: PlatformSession,
    resource: IMReactionResource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const key = typeof resource.locator === 'object' && resource.locator && !Array.isArray(resource.locator)
      ? resource.locator.asset
      : undefined
    const bytes = key === 'video' ? videoStickerAsset : staticStickerAsset
    const offset = Math.max(0, options.offset ?? 0)
    yield bytes.subarray(offset, offset + (options.limit ?? bytes.length))
  }

  async emitReactions(
    session: PlatformSession,
    conversation: IMConversation<StaticMediaLocator>,
    messageId: string,
    context: IMReactionContext,
    eventId = `reaction:${messageId}:${this._now()}`,
  ): Promise<void> {
    const message = (this._messages.get(conversation.id) ?? []).find((item) => item.id === messageId)
    if (!message) throw new Error(`static reaction target not found: ${messageId}`)
    message.reactionContext = clone(context)
    await this._dispatch(session, {
      type: 'message-reactions', eventId, conversation: clone(conversation),
      target: { conversationId: conversation.id, messageId, targetId: messageId },
      context: clone(context), timestamp: this._now(),
    })
  }

  /** Insert an incoming message and wait until every subscribed bridge handler has committed it. */
  async emitMessage(
    session: PlatformSession,
    conversation: IMConversation<StaticMediaLocator>,
    message: IMMessage<StaticMediaLocator>,
  ): Promise<void> {
    this._conversations.set(conversation.id, clone(conversation))
    this._append(clone(message))
    await this._dispatch(session, {
      type: 'message', conversation: clone(conversation), message: clone(message),
    })
  }

  /** Simulate another platform client advancing the current account's read boundary. */
  async emitRead(
    session: PlatformSession,
    conversationId: string,
    upToMessageId: string,
  ): Promise<void> {
    await this.markRead(session, { conversationId, messageId: upToMessageId })
    await this._dispatch(session, { type: 'read', conversationId, upToMessageId })
  }

  /** Run one deterministic Group A new/edit/delete cycle. */
  async tick(session: PlatformSession): Promise<void> {
    const conversation = this._requireConversation('group-a')
    const active = [...(this._messages.get(conversation.id) ?? [])]
    const sequence = ++this._demoSequence
    const timestamp = this._now()
    const created = textMessage(
      `group-a:live:${this._instanceId}:${sequence}:${'n'.repeat(128)}`,
      conversation.id,
      sequence % 2 ? 'alice' : 'bob',
      `Group A live message ${sequence}`,
      timestamp,
    )
    this._append(created)
    await this._dispatch(session, { type: 'message', conversation: clone(conversation), message: clone(created) })

    const editTarget = active.at(-1)
    if (editTarget) {
      const edited: IMMessage<StaticMediaLocator> = {
        ...clone(editTarget),
        content: { parts: [{ type: 'text', text: `Group A edited message ${sequence}` }] },
        metadata: { ...(editTarget.metadata ?? {}), revision: sequence },
      }
      this._append(edited)
      await this._dispatch(session, {
        type: 'message-edit', eventId: `group-a:edit:${this._instanceId}:${sequence}`,
        conversation: clone(conversation), message: clone(edited),
      })
    }

    const deleteTarget = active[0]
    if (deleteTarget) {
      this._messages.set(conversation.id, (this._messages.get(conversation.id) ?? [])
        .filter((message) => message.id !== deleteTarget.id))
      await this._dispatch(session, {
        type: 'message-delete', eventId: `group-a:delete:${this._instanceId}:${sequence}`,
        conversation: clone(conversation), messageIds: [deleteTarget.id], timestamp,
      })
    }
  }

  mediaBytes(mediaId: string): Uint8Array | undefined {
    return this._loadMedia(mediaId)?.slice()
  }

  private _append(message: IMMessage<StaticMediaLocator>): void {
    const messages = this._messages.get(message.conversationId) ?? []
    const existing = messages.findIndex((item) => item.id === message.id || item.sourceIds?.some((id) => message.sourceIds?.includes(id)))
    if (existing >= 0) messages[existing] = message
    else messages.push(message)
    messages.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    this._messages.set(message.conversationId, messages)
  }

  private _startTimer(session: PlatformSession): void {
    if (this._eventIntervalMs <= 0 || this._timers.has(session.platformSessionId)) return
    const timer = setInterval(() => {
      const previous = this._tickTails.get(session.platformSessionId) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(() => this.tick(session))
      this._tickTails.set(session.platformSessionId, current)
      current.finally(() => {
        if (this._tickTails.get(session.platformSessionId) === current) {
          this._tickTails.delete(session.platformSessionId)
        }
      }).catch(() => {})
    }, this._eventIntervalMs)
    this._timers.set(session.platformSessionId, timer)
  }

  private async _dispatch(session: PlatformSession, event: IMEvent<StaticMediaLocator>): Promise<void> {
    const handlers = [...(this._subscribers.get(session.platformSessionId) ?? [])]
    await Promise.all(handlers.map((handler) => handler(clone(event))))
  }

  private _requireConversation(id: string): IMConversation<StaticMediaLocator> {
    const conversation = this._conversations.get(id)
    if (!conversation) throw new Error(`static conversation not found: ${id}`)
    return conversation
  }

  private _validateContent(content: IMMessageInput): void {
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
    const media = content.parts.filter((part) => part.type === 'media')
    const stickers = content.parts.filter((part) => part.type === 'sticker')
    if (!text && !media.length && !stickers.length) throw new Error('static message is empty')
    if (Array.from(text).length > this.capabilities.send.maxTextLength) throw new Error('static message is too long')
    if (media.length > this.capabilities.send.maxMedia) throw new Error('static message has too many media parts')
    if (stickers.length > 1) throw new Error('static message has too many stickers')
  }

  private async _consumeSticker(
    input: IMStickerSendPlan,
    options: IMTransferOptions,
    mediaIndex: number,
  ): Promise<IMSticker> {
    if (input.type === 'native') {
      const reference = input.reference && typeof input.reference === 'object' && !Array.isArray(input.reference)
        ? input.reference
        : {}
      const format = reference.format === 'video' ? 'video' : 'static'
      return {
        providerId: input.providerId, stickerId: input.stickerId, packId: input.packId,
        format,
        mimeType: typeof reference.mimeType === 'string' ? reference.mimeType : stickerMimeType(format),
        width: 512, height: 512,
        emoji: Array.isArray(reference.emoji)
          ? reference.emoji.filter((item): item is string => typeof item === 'string')
          : ['🙂'],
        locator: input.reference,
      }
    }
    const bytes = await consumeSource(input.source, mediaIndex, options)
    const mediaId = `sticker:${input.providerId}:${input.stickerId}`
    this._storeMedia(mediaId, bytes)
    return {
      providerId: input.providerId, stickerId: input.stickerId, packId: input.packId,
      format: input.format, mimeType: input.mimeType, width: input.width, height: input.height,
      size: bytes.length, emoji: input.emoji, locator: { mediaId },
    }
  }

  private _messageId(conversationId: string): string {
    return `static:${this._instanceId}:${conversationId}:${++this._sequence}:${'x'.repeat(256)}`
  }

  private _avatar(owner: string): IMMedia<StaticMediaLocator> {
    const mediaId = `avatar:${owner}`
    if (!this._loadMedia(mediaId)) this._storeMedia(mediaId, seededImage)
    return {
      id: mediaId, kind: 'image', name: `${owner.replaceAll(':', '-')}.png`, mimeType: 'image/png',
      size: seededImage.length, width: 1240, height: 1754, locator: { mediaId },
    }
  }

  private _seed(): void {
    const users: IMUser<StaticMediaLocator>[] = [
      {
        id: 'alice', firstName: 'Alice', username: 'alice', about: 'Static Alice signature',
        avatar: this._avatar('user:alice'),
      },
      { id: 'bob', firstName: 'Bob', username: 'bob', avatar: this._avatar('user:bob') },
      { id: 'carol', firstName: 'Carol', username: 'carol', avatar: this._avatar('user:carol') },
      { id: 'mirror-user', firstName: 'Mirror User', username: 'mirror_user', avatar: this._avatar('user:mirror-user') },
      {
        id: 'self', firstName: 'Static User', username: 'static_user', about: 'Static self signature',
        avatar: this._avatar('user:self'),
      },
    ]
    for (const user of users) this._users.set(user.id, user)
    const conversations: IMConversation<StaticMediaLocator>[] = [
      { id: 'alice', kind: 'direct', title: 'Alice', avatar: this._avatar('user:alice') },
      { id: 'bob', kind: 'direct', title: 'Bob', avatar: this._avatar('user:bob') },
      {
        id: 'qq-group', kind: 'group', title: 'Static QQ Group',
        avatar: this._avatar('conversation:qq-group'), metadata: { participantsCount: 4 },
      },
      { id: 'group-a', kind: 'group', title: 'Group A - Live Mutations', metadata: { participantsCount: 3 } },
      { id: 'group-b', kind: 'group', title: 'Group B - Mirror Source', metadata: { participantsCount: 3 } },
      {
        id: 'group-c', kind: 'group', title: 'Group C - Mirror Target',
        metadata: { participantsCount: 4, linkedConversationId: 'group-b' },
      },
      { id: 'group-d', kind: 'group', title: 'Group D - Long History', metadata: { participantsCount: 3 } },
      {
        id: 'reaction-sticker-lab', kind: 'group', title: 'Reaction & Sticker Lab',
        metadata: {
          participantsCount: 4, reactionLab: true,
          participantIds: ['alice', 'bob', 'carol'],
        },
      },
      {
        id: 'discord-general', kind: 'channel', title: 'general',
        parentId: 'discord-category-chat', spaceId: 'discord-guild', metadata: { participantsCount: 12 },
      },
      {
        id: 'discord-support', kind: 'channel', title: 'support thread',
        parentId: 'discord-general', spaceId: 'discord-guild', metadata: { participantsCount: 4 },
      },
    ]
    for (const conversation of conversations) this._conversations.set(conversation.id, conversation)
    this._append(textMessage('direct:alice:1', 'alice', 'alice', 'Hey there!', 1_700_000_000))
    this._append(textMessage('direct:alice:2', 'alice', 'alice', 'How are you?', 1_700_000_100))
    this._append(textMessage('direct:bob:1', 'bob', 'bob', 'Meeting at 3?', 1_700_000_200))
    this._append(textMessage('group:1', 'qq-group', 'alice', 'Welcome to the group', 1_700_000_300))
    this._append({
      ...textMessage('group:2', 'qq-group', 'bob', 'Group history works', 1_700_000_400),
      reactionContext: {
        available: reactionDefinitions('qq-group'),
        maxSelected: 3,
        reactions: [{
          key: 'like', count: 2, selected: false,
          recentActors: [{ userId: 'alice', timestamp: 1_700_000_401 }],
        }],
      },
    })
    this._append(textMessage('channel:1', 'discord-general', 'carol', 'General channel message', 1_700_000_500))
    this._append(textMessage('channel:2', 'discord-support', 'alice', 'Support thread message', 1_700_000_600))
    this._append(textMessage('group-a:seed:1', 'group-a', 'alice', 'Group A seed 1', 1_700_000_710))
    this._append(textMessage('group-a:seed:2', 'group-a', 'bob', 'Group A seed 2', 1_700_000_720))
    this._append(textMessage('group-a:seed:3', 'group-a', 'carol', 'Group A seed 3', 1_700_000_730))
    this._append(textMessage('group-b:seed:1', 'group-b', 'alice', 'Messages sent here mirror to Group C', 1_700_000_610))
    this._append(textMessage('group-c:seed:1', 'group-c', 'mirror-user', 'Waiting for Group B messages', 1_700_000_620))
    this._messages.set('group-d', Array.from({ length: this._historySize }, (_, index) => textMessage(
      `group-d:${String(index + 1).padStart(8, '0')}:${'h'.repeat(96)}`,
      'group-d',
      index % 2 ? 'alice' : 'bob',
      `Group D history message ${index + 1}`,
      1_600_000_000 + index,
    )))
    const imageId = 'seed:image'
    const imagePreviewId = `${imageId}:preview`
    const fileId = 'seed:file'
    this._storeMedia(imageId, seededImage)
    this._storeMedia(imagePreviewId, seededImagePreview)
    this._storeMedia(fileId, new TextEncoder().encode('static seeded file'))
    this._append({
      id: 'group:album', sourceIds: ['group:album:photo', 'group:album:file'],
      conversationId: 'qq-group', senderId: 'carol', timestamp: 1_700_000_700,
      groupId: 'group:album:id',
      content: {
        parts: [
          { type: 'text', text: 'Seeded image and file' },
          {
            type: 'media',
            media: {
              id: imageId, kind: 'image', name: 'seed.png', mimeType: 'image/png',
              size: seededImage.length, width: 1240, height: 1754,
              strippedThumbnail: seededStrippedThumbnail,
              preview: {
                mimeType: 'image/jpeg', size: seededImagePreview.length,
                width: 28, height: 40, locator: { mediaId: imagePreviewId },
              },
              locator: { mediaId: imageId },
            },
          },
          {
            type: 'media',
            media: {
              id: fileId, kind: 'file', name: 'seed.txt', mimeType: 'text/plain',
              size: 18, locator: { mediaId: fileId },
            },
          },
        ],
      },
    })
    this._append({
      id: 'lab:sticker:static', conversationId: 'reaction-sticker-lab',
      senderId: 'alice', timestamp: 1_650_000_100,
      content: { parts: [{ type: 'sticker', sticker: this._labSticker('plugin-static') }] },
    })
    this._append({
      id: 'lab:sticker:loose', conversationId: 'reaction-sticker-lab',
      senderId: 'bob', timestamp: 1_650_000_105,
      content: { parts: [{ type: 'sticker', sticker: this._labSticker('loose-saved') }] },
    })
    this._append({
      id: 'lab:sticker:video', conversationId: 'reaction-sticker-lab',
      senderId: 'carol', timestamp: 1_650_000_110,
      content: { parts: [{ type: 'sticker', sticker: this._labSticker('plugin-video') }] },
    })
    this._append({
      ...textMessage(
        'lab:reaction:standard', 'reaction-sticker-lab', 'alice',
        'Standard reactions: 👍 ❤️ 😂 😢 🔥 🎉 👏 🤔 🤯', 1_650_000_120,
      ),
      reactionContext: { available: reactionDefinitions('reaction-sticker-lab'), maxSelected: 11, reactions: [
        { key: 'like', count: 3, recentActors: [{ userId: 'alice' }, { userId: 'bob' }] },
        { key: 'heart', count: 2, recentActors: [{ userId: 'carol' }] },
        { key: 'laugh', count: 4 },
        { key: 'sad', count: 1 },
        { key: 'fire', count: 5 },
        { key: 'party-emoji', count: 2 },
        { key: 'clap', count: 3 },
        { key: 'think', count: 1 },
        { key: 'mindblown', count: 2 },
      ] },
    })
    this._append({
      ...textMessage(
        'lab:reaction:custom', 'reaction-sticker-lab', 'bob',
        'Custom reactions: static / video', 1_650_000_130,
      ),
      reactionContext: { available: reactionDefinitions('reaction-sticker-lab'), maxSelected: 11, reactions: [
        { key: 'party', count: 2 },
        { key: 'motion', count: 4 },
      ] },
    })
    this._append({
      ...textMessage(
        'lab:reaction:limited', 'reaction-sticker-lab', 'carol',
        'This message only allows ❤️ and 👏', 1_650_000_140,
      ),
      reactionContext: {
        available: reactionDefinitions('reaction-sticker-lab', 'lab:reaction:limited'),
        maxSelected: 2,
        reactions: [],
      },
    })
  }

  private _labSticker(stickerId: string): IMSticker {
    const format = stickerId === 'plugin-video' ? 'video' : 'static'
    const asset = stickerAsset(format)
    return {
      providerId: `${this._providerIdPrefix}:plugin`,
      stickerId,
      packId: stickerId === 'loose-saved' ? undefined : 'plugin-pack',
      format,
      mimeType: stickerMimeType(format),
      width: 512,
      height: 512,
      size: asset.length,
      emoji: [format === 'video' ? '🎬' : '⭐'],
      version: 1,
    }
  }

  private _storeMedia(mediaId: string, bytes: Uint8Array): void {
    this._media.set(mediaId, bytes)
    if (!this._mediaPath) return
    const path = this._mediaFile(mediaId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }

  private _loadMedia(mediaId: string): Uint8Array | undefined {
    const cached = this._media.get(mediaId)
    if (cached) return cached
    if (!this._mediaPath) return undefined
    const path = this._mediaFile(mediaId)
    if (!existsSync(path)) return undefined
    const bytes = new Uint8Array(readFileSync(path))
    this._media.set(mediaId, bytes)
    return bytes
  }

  private _mediaFile(mediaId: string): string {
    const digest = createHash('sha256').update(mediaId).digest('hex')
    return join(this._mediaPath!, `${digest}.bin`)
  }
}

export class StaticStickerProvider implements IMStickerProvider {
  readonly capabilities = { platformKinds: ['static'], search: true }
  private readonly _pack: IMStickerPack
  private readonly _loose?: IMSticker

  constructor(private readonly _providerId: string, private readonly _native: boolean) {
    const kind = _native ? 'native' : 'plugin'
    this._pack = {
      providerId: _providerId,
      packId: `${kind}-pack`,
      title: _native ? 'Static Native Stickers' : 'Static Plugin Stickers',
      shortName: `static_${kind}`,
      version: 1,
      stickers: _native
        ? [this._sticker('native-smile', '🙂'), this._sticker('native-party', '🎉')]
        : [
            this._sticker('plugin-static', '⭐', 'static'),
            this._sticker('plugin-video', '🎬', 'video'),
          ],
    }
    if (!_native) {
      this._loose = {
        ...this._sticker('loose-saved', '💾', 'static'),
        packId: undefined,
        title: 'Platform Saved Loose Sticker',
      }
    }
  }

  async listPacks(_context: StickerProviderContext) {
    return {
      packs: [{
        providerId: this._providerId,
        packId: this._pack.packId,
        title: this._pack.title,
        shortName: this._pack.shortName,
        count: this._pack.stickers.length,
        version: this._pack.version,
      }],
    }
  }

  async getPack(_context: StickerProviderContext, packId: string) {
    return packId === this._pack.packId ? structuredClone(this._pack) : null
  }

  async getSticker(_context: StickerProviderContext, stickerId: string) {
    return structuredClone(
      this._pack.stickers.find((item) => item.stickerId === stickerId)
      ?? (this._loose?.stickerId === stickerId ? this._loose : null),
    )
  }

  async listSavedStickers(_context: StickerProviderContext) {
    return { stickers: this._loose ? [structuredClone(this._loose)] : [] }
  }

  async search(_context: StickerProviderContext, query: { emoji?: string }) {
    return {
      stickers: structuredClone(this._pack.stickers.filter((item) =>
        !query.emoji || item.emoji?.includes(query.emoji))),
    }
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const bytes = stickerAsset(sticker.format)
    return {
      mimeType: sticker.mimeType, size: bytes.length,
      width: sticker.width, height: sticker.height,
      source: {
        size: bytes.length,
        async *stream() { yield bytes.slice() },
      },
    }
  }

  async prepareSend(
    _context: StickerProviderContext,
    sticker: IMSticker,
  ): Promise<IMStickerSendPlan | null> {
    if (!this._native) return null
    return {
      type: 'native', providerId: this._providerId, stickerId: sticker.stickerId,
      packId: sticker.packId,
      reference: {
        nativeStickerId: sticker.stickerId,
        format: sticker.format,
        mimeType: sticker.mimeType,
        emoji: sticker.emoji ?? [],
      },
    }
  }

  private _sticker(stickerId: string, emoji: string, format: IMSticker['format'] = 'static'): IMSticker {
    const bytes = stickerAsset(format)
    return {
      providerId: this._providerId, stickerId, packId: this._pack?.packId ?? `${this._native ? 'native' : 'plugin'}-pack`,
      format, mimeType: stickerMimeType(format), width: 512, height: 512,
      size: bytes.length, emoji: [emoji], version: 1,
    }
  }
}

const emojiReactionDefinitions: IMReactionDefinition[] = [
  ['like', 'Like', '👍'],
  ['heart', 'Love', '❤️'],
  ['laugh', 'Laugh', '😂'],
  ['sad', 'Sad', '😢'],
  ['fire', 'Fire', '🔥'],
  ['party-emoji', 'Party', '🎉'],
  ['clap', 'Clap', '👏'],
  ['think', 'Thinking', '🤔'],
  ['mindblown', 'Mind Blown', '🤯'],
].map(([key, title, emoticon]) => ({
  key, title, presentation: { type: 'emoji', emoticon },
}))

const customReactionDefinitions: IMReactionDefinition[] = [{
  key: 'party',
  title: 'Lab Custom Static',
  presentation: {
    type: 'custom',
    alt: 'lab-static',
    resource: {
      version: 1, format: 'static', mimeType: 'image/webp',
      width: 128, height: 128, size: staticStickerAsset.length,
      locator: { asset: 'static' },
    },
  },
}, {
  key: 'motion',
  title: 'Lab Custom Video',
  presentation: {
    type: 'custom',
    alt: 'lab-video',
    resource: {
      version: 1, format: 'video', mimeType: 'video/webm',
      width: 128, height: 128, size: videoStickerAsset.length,
      locator: { asset: 'video' },
    },
  },
}]

function reactionDefinitions(conversationId: string, messageId?: string): IMReactionDefinition[] {
  if (messageId === 'lab:reaction:limited') {
    return clone(emojiReactionDefinitions.filter((item) => item.key === 'heart' || item.key === 'clap'))
  }
  if (conversationId === 'reaction-sticker-lab') {
    return clone([...emojiReactionDefinitions, ...customReactionDefinitions])
  }
  if (conversationId === 'group-d') {
    return clone([...emojiReactionDefinitions.slice(0, 2), ...customReactionDefinitions])
  }
  if (conversationId === 'group-a') {
    return clone(emojiReactionDefinitions.filter((item) => item.key === 'like' || item.key === 'fire'))
  }
  if (conversationId === 'qq-group') {
    return clone(emojiReactionDefinitions.filter((item) =>
      item.key === 'like' || item.key === 'heart' || item.key === 'laugh'))
  }
  return clone(emojiReactionDefinitions.slice(0, 2))
}

function stickerAsset(format: IMSticker['format']): Uint8Array {
  if (format === 'video') return videoStickerAsset
  return staticStickerAsset
}

function stickerMimeType(format: IMSticker['format']): string {
  if (format === 'video') return 'video/webm'
  return 'image/webp'
}

async function consumeSource(
  source: import('@mtproto-relay/bridge').IMMediaSource,
  mediaIndex: number,
  options: IMTransferOptions,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let transferredBytes = 0
  for await (const chunk of source.stream({ signal: options.signal })) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('upload aborted')
    const copied = chunk.slice()
    chunks.push(copied)
    transferredBytes += copied.length
    await options.onProgress?.({
      phase: 'upload', mediaIndex, transferredBytes, totalBytes: source.size,
    })
  }
  const bytes = new Uint8Array(transferredBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function pageStart(ids: string[], cursor?: string, afterId?: string): number {
  if (afterId) {
    const index = ids.indexOf(afterId)
    return index < 0 ? 0 : index + 1
  }
  return numericCursor(cursor)
}

function numericCursor(cursor?: string): number {
  if (!cursor) return 0
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid static cursor: ${cursor}`)
  return value
}

function clampLimit(limit = 100): number {
  return Math.max(0, Math.min(Math.trunc(limit), 100))
}

function textMessage(
  id: string,
  conversationId: string,
  senderId: string,
  text: string,
  timestamp: number,
): IMMessage<StaticMediaLocator> {
  return { id, conversationId, senderId, timestamp, content: { parts: [{ type: 'text', text }] } }
}

function imageDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (
    bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }

  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const segmentLength = view.getUint16(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      const height = view.getUint16(offset + 3)
      const width = view.getUint16(offset + 5)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    offset += segmentLength
  }
  return undefined
}

async function createThumbnail(
  bytes: Uint8Array,
): Promise<{ jpeg: Uint8Array, stripped: Uint8Array, width: number, height: number } | undefined> {
  try {
    const { data, info } = await sharp(bytes).rotate().resize({
      width: 40, height: 40, fit: 'inside', withoutEnlargement: true,
    }).jpeg({
      quality: 20, chromaSubsampling: '4:2:0', progressive: false, optimizeCoding: false,
    }).toBuffer({ resolveWithObject: true })
    const jpeg = new Uint8Array(data)
    return {
      jpeg, stripped: stripTelegramJpegThumbnail(jpeg), width: info.width, height: info.height,
    }
  } catch {
    return undefined
  }
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
