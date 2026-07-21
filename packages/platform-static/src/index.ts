import type { Context } from 'cordis'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  IMConversation, IMConversationRef, IMDialog, IMDialogPage, IMDownloadOptions, IMEvent,
  IMHistoryPage, IMHistoryQuery, IMMedia, IMMessage, IMMessageContent, IMMessageInput,
  IMPageQuery, IMPlatform, IMTransferOptions, IMUser, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'

export interface StaticPlatformOptions {
  now?: () => number
  instanceId?: string
  /** Durable media directory. Set to undefined for an in-memory test adapter. */
  mediaPath?: string
  transferChunkSize?: number
  eventIntervalMs?: number
  historySize?: number
}

export interface Config {
  instanceId?: string
  mediaPath?: string
  transferChunkSize?: number
  eventIntervalMs?: number
  historySize?: number
}
export const name = 'im-platform-static'
export const inject = ['imPlatform']

const seededImage = new Uint8Array(readFileSync(new URL('./test-image.png', import.meta.url)))

/** Cordis plugin entrypoint. Each plugin instance registers one isolated adapter. */
export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'static')
  const mediaPath = config.mediaPath
    ?? (process.env.NODE_ENV === 'test' ? undefined : resolve(process.cwd(), 'data/static-media', id))
  ctx.imPlatform.register(new StaticPlatform({
    ...config,
    // Keep media storage stable across HMR and process restarts. Message IDs
    // still use a per-instance nonce to avoid sequence collisions after restart.
    mediaPath,
    // Synthetic traffic is opt-in. Enabling it by default creates an unbounded
    // durable update stream for every historical active platform session.
    eventIntervalMs: config.eventIntervalMs ?? 0,
    historySize: config.historySize ?? 10_000,
  }), id)
}

/** Complete in-memory reference adapter used for development and conformance tests. */
export class StaticPlatform implements IMPlatform {
  readonly capabilities: PlatformCapabilities = {
    history: true,
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 4096,
      maxMedia: 10,
    },
    conversations: { groups: true, channels: true, subchannels: true },
  }

  private readonly _now: () => number
  private readonly _transferChunkSize: number
  private readonly _eventIntervalMs: number
  private readonly _historySize: number
  private readonly _instanceId: string
  private readonly _mediaPath?: string
  private readonly _users = new Map<string, IMUser>()
  private readonly _conversations = new Map<string, IMConversation>()
  private readonly _messages = new Map<string, IMMessage[]>()
  private readonly _media = new Map<string, Uint8Array>()
  private readonly _subscribers = new Map<string, Set<(event: IMEvent) => void | Promise<void>>>()
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
    if (this._mediaPath) mkdirSync(this._mediaPath, { recursive: true })
    this._seed()
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent) => void | Promise<void>,
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

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage> {
    const dialogs = [...this._conversations.values()].map((conversation): IMDialog => {
      const messages = this._messages.get(conversation.id) ?? []
      return { conversation: clone(conversation), unreadCount: 0, lastMessage: clone(messages.at(-1)) }
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
  ): Promise<IMHistoryPage> {
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

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser | null> {
    return clone(this._users.get(userId) ?? null)
  }

  async sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage> {
    const target = this._requireConversation(conversation.id)
    this._validateContent(content)
    const messageId = this._messageId(target.id)
    const output: IMMessageContent['parts'] = []
    const sourceIds: string[] = []
    let mediaIndex = 0
    for (const part of content.parts) {
      if (part.type === 'text') {
        output.push({ ...part })
        continue
      }
      const bytes = await consumeSource(part.media.source, mediaIndex, options)
      const mediaId = `${messageId}:media:${mediaIndex}:${'m'.repeat(128)}`
      this._storeMedia(mediaId, bytes)
      const media: IMMedia = {
        id: mediaId,
        kind: part.media.kind,
        name: part.media.name,
        mimeType: part.media.mimeType,
        size: bytes.length,
        width: part.media.width,
        height: part.media.height,
        locator: { mediaId },
      }
      output.push({ type: 'media', media })
      sourceIds.push(`${messageId}:physical:${mediaIndex}`)
      mediaIndex++
    }
    const message: IMMessage = {
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
      const mirror: IMMessage = {
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

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia,
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

  /** Insert an incoming message and wait until every subscribed bridge handler has committed it. */
  async emitMessage(
    session: PlatformSession,
    conversation: IMConversation,
    message: IMMessage,
  ): Promise<void> {
    this._conversations.set(conversation.id, clone(conversation))
    this._append(clone(message))
    await this._dispatch(session, {
      type: 'message', conversation: clone(conversation), message: clone(message),
    })
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
      const edited: IMMessage = {
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

  private _append(message: IMMessage): void {
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

  private async _dispatch(session: PlatformSession, event: IMEvent): Promise<void> {
    const handlers = [...(this._subscribers.get(session.platformSessionId) ?? [])]
    await Promise.all(handlers.map((handler) => handler(clone(event))))
  }

  private _requireConversation(id: string): IMConversation {
    const conversation = this._conversations.get(id)
    if (!conversation) throw new Error(`static conversation not found: ${id}`)
    return conversation
  }

  private _validateContent(content: IMMessageInput): void {
    const text = content.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
    const media = content.parts.filter((part) => part.type === 'media')
    if (!text && !media.length) throw new Error('static message is empty')
    if (Array.from(text).length > this.capabilities.send.maxTextLength) throw new Error('static message is too long')
    if (media.length > this.capabilities.send.maxMedia) throw new Error('static message has too many media parts')
  }

  private _messageId(conversationId: string): string {
    return `static:${this._instanceId}:${conversationId}:${++this._sequence}:${'x'.repeat(256)}`
  }

  private _seed(): void {
    const users: IMUser[] = [
      { id: 'alice', firstName: 'Alice', username: 'alice' },
      { id: 'bob', firstName: 'Bob', username: 'bob' },
      { id: 'carol', firstName: 'Carol', username: 'carol' },
      { id: 'mirror-user', firstName: 'Mirror User', username: 'mirror_user' },
      { id: 'self', firstName: 'Static User', username: 'static_user' },
    ]
    for (const user of users) this._users.set(user.id, user)
    const conversations: IMConversation[] = [
      { id: 'alice', kind: 'direct', title: 'Alice' },
      { id: 'bob', kind: 'direct', title: 'Bob' },
      { id: 'qq-group', kind: 'group', title: 'Static QQ Group', metadata: { participantsCount: 3 } },
      { id: 'group-a', kind: 'group', title: 'Group A - Live Mutations', metadata: { participantsCount: 3 } },
      { id: 'group-b', kind: 'group', title: 'Group B - Mirror Source', metadata: { participantsCount: 3 } },
      {
        id: 'group-c', kind: 'group', title: 'Group C - Mirror Target',
        metadata: { participantsCount: 4, linkedConversationId: 'group-b' },
      },
      { id: 'group-d', kind: 'group', title: 'Group D - Long History', metadata: { participantsCount: 3 } },
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
    this._append(textMessage('group:2', 'qq-group', 'bob', 'Group history works', 1_700_000_400))
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
    const fileId = 'seed:file'
    this._storeMedia(imageId, seededImage)
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
              size: seededImage.length, width: 1240, height: 1754, locator: { mediaId: imageId },
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
): IMMessage {
  return { id, conversationId, senderId, timestamp, content: { parts: [{ type: 'text', text }] } }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
