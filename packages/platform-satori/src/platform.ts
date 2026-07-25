import type { Context } from 'cordis'
import type { Bot, Session, Universal } from '@satorijs/core'
import type {
  IMConversation, IMConversationMemberPage, IMConversationRef, IMDialog, IMDialogPage,
  IMDownloadOptions, IMEvent, IMHistoryPage, IMHistoryQuery, IMMessage, IMMessageInput,
  IMMessageTarget, IMPageQuery, IMPlatform, IMTransferOptions, IMUserPage, PlatformCapabilities,
  PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import {
  mapSatoriConversation, mapSatoriMember, mapSatoriMessage, mapSatoriUser,
  toSatoriElements, type SatoriMediaLocator,
} from './convert.js'

interface DialogCursor {
  guilds: Universal.Guild[]
  guildNext?: string
  channelNext?: string
  pending: Universal.Channel[]
}

export class SatoriPlatform implements IMPlatform<SatoriMediaLocator> {
  private readonly conversations = new Map<string, IMConversation<SatoriMediaLocator>>()

  constructor(
    private readonly ctx: Context,
    readonly botSid?: string,
  ) {}

  get bot(): Bot | undefined {
    const bots = this.ctx.bots ?? []
    if (this.botSid) return bots.find((bot) => bot.sid === this.botSid)
    return bots.length === 1 ? bots[0] : undefined
  }

  get platformKind(): string {
    return this.bot?.platform ?? 'satori'
  }

  get capabilities(): PlatformCapabilities {
    const bot = this.requireBot()
    const supports = (name: string) => bot.features?.includes(name) ?? false
    const history = supports('message.list') && supports('guild.list') && supports('channel.list')
    return {
      history,
      send: {
        text: true,
        images: true,
        files: true,
        mixed: true,
        maxTextLength: 4096,
        maxMedia: 10,
      },
      conversations: { groups: true, channels: true, subchannels: true },
      members: supports('guild.member.list')
        ? { list: true, administrators: true, permissions: false }
        : undefined,
      avatars: { users: true, conversations: true },
      messageActions: {
        delete: {
          own: { supported: supports('message.delete') },
          others: { supported: supports('message.delete') },
        },
        edit: { mode: supports('message.update') ? 'native' : 'unsupported' },
        forward: { mode: 'copy', preservesAuthor: false },
      },
    }
  }

  async getAccount() {
    const bot = this.requireBot()
    const login = await bot.getLogin()
    return {
      user: mapSatoriUser(login.user ?? bot.user),
      credentials: { satoriBotSid: bot.sid },
    }
  }

  async subscribe(
    _platformSession: PlatformSession,
    handler: (event: IMEvent<SatoriMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const sid = this.requireBot().sid
    let queue = Promise.resolve()
    const deliver = (event: IMEvent<SatoriMediaLocator>) => {
      queue = queue.then(() => handler(event)).catch((error) => {
        this.ctx.logger('platform-satori').warn('event delivery failed for %s: %o', sid, error)
      })
    }
    const onMessage = (session: Session) => {
      if (session.bot.sid !== sid || !session.event.message || !session.event.channel) return
      const conversation = this.remember(mapSatoriConversation(session.event.channel, session.event.guild))
      deliver({
        type: 'message',
        conversation,
        message: mapSatoriMessage(session.event.message, conversation, session.selfId),
      })
    }
    const onUpdated = (session: Session) => {
      if (session.bot.sid !== sid || !session.event.message || !session.event.channel) return
      const conversation = this.remember(mapSatoriConversation(session.event.channel, session.event.guild))
      const message = mapSatoriMessage(session.event.message, conversation, session.selfId)
      deliver({ type: 'message-edit', eventId: `satori:update:${session.sn}`, conversation, message })
    }
    const onDeleted = (session: Session) => {
      const messageId = session.event.message?.id ?? session.event.message?.messageId
      if (session.bot.sid !== sid || !messageId || !session.event.channel) return
      const conversation = this.remember(mapSatoriConversation(session.event.channel, session.event.guild))
      deliver({
        type: 'message-delete',
        eventId: `satori:delete:${session.sn}`,
        conversation,
        messageIds: [messageId],
        timestamp: Math.trunc(session.timestamp / 1000),
      })
    }
    const disposers = [
      this.ctx.on('message-created', onMessage),
      this.ctx.on('message-updated', onUpdated),
      this.ctx.on('message-deleted', onDeleted),
    ]
    return async () => {
      for (const dispose of disposers.reverse()) dispose()
      await queue
    }
  }

  async sendMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<SatoriMediaLocator>> {
    const bot = this.requireBot()
    const elements = await toSatoriElements(bot, content, options)
    const messages = await bot.createMessage(conversation.id, elements)
    if (!messages.length) throw new Error('Satori adapter returned no message after send')
    const fallback = this.conversation(conversation.id)
    const mapped = messages.map((message) => mapSatoriMessage(message, fallback, bot.selfId))
    return { ...mapped[0], sourceIds: mapped.map((message) => message.id) }
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<SatoriMediaLocator>> {
    const bot = this.requireBot()
    if (!bot.getGuildList || !bot.getChannelList) return { dialogs: [] }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 100))
    let state = decodeCursor(query.cursor)
    if (!state) {
      const page = await bot.getGuildList()
      state = { guilds: page.data, guildNext: page.next, pending: [] }
    } else if (!state.guilds.length && state.guildNext) {
      const page = await bot.getGuildList(state.guildNext)
      state = { guilds: page.data, guildNext: page.next, pending: [] }
    }
    const dialogs: IMDialog<SatoriMediaLocator>[] = []
    while (dialogs.length < limit && (state.pending.length || state.guilds.length)) {
      const guild = state.guilds[0]
      if (!state.pending.length) {
        const page = await bot.getChannelList(guild.id, state.channelNext)
        state.pending.push(...page.data.filter((channel) => channel.type === 0 || channel.type === 1))
        state.channelNext = page.next
        if (!state.pending.length && !state.channelNext) {
          state.guilds.shift()
          continue
        }
      }
      while (dialogs.length < limit && state.pending.length) {
        const channel = state.pending.shift()!
        const conversation = this.remember(mapSatoriConversation(channel, guild))
        dialogs.push({ conversation, unreadCount: 0 })
      }
      if (!state.pending.length && !state.channelNext) state.guilds.shift()
      if (state.channelNext && dialogs.length >= limit) break
    }
    const after = query.afterId ? dialogs.findIndex((dialog) => dialog.conversation.id === query.afterId) : -1
    const page = after >= 0 ? dialogs.slice(after + 1) : dialogs
    const hasNext = Boolean(state.pending.length || state.guilds.length || state.guildNext)
    return { dialogs: page, nextCursor: hasNext ? encodeCursor(state) : undefined }
  }

  async getContacts(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMUserPage<SatoriMediaLocator>> {
    const bot = this.requireBot()
    if (!bot.getFriendList) return { users: [] }
    const page = await bot.getFriendList(query.cursor)
    return {
      users: page.data.flatMap((friend) => friend.user ? [mapSatoriUser(friend.user)] : []),
      nextCursor: page.next,
    }
  }

  async getHistory(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<SatoriMediaLocator>> {
    const bot = this.requireBot()
    if (!bot.getMessageList) return { messages: [] }
    const page = await bot.getMessageList(
      conversation.id,
      query.cursor,
      query.after ? 'after' : 'before',
      query.limit,
      'desc',
    )
    const fallback = this.conversation(conversation.id)
    return {
      messages: page.data.map((message) => mapSatoriMessage(message, fallback, bot.selfId)),
      nextCursor: query.after ? page.prev : page.next,
    }
  }

  async getMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<SatoriMediaLocator> | null> {
    const bot = this.requireBot()
    if (!bot.getMessage) return null
    const message = await bot.getMessage(conversation.id, messageId)
    return mapSatoriMessage(message, this.conversation(conversation.id), bot.selfId)
  }

  async getUser(_session: PlatformSession, userId: string) {
    const bot = this.requireBot()
    if (!bot.getUser) return null
    return mapSatoriUser(await bot.getUser(userId))
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<SatoriMediaLocator>> {
    const bot = this.requireBot()
    const guildId = this.conversations.get(conversation.id)?.spaceId
    if (!guildId || !bot.getGuildMemberList) return { members: [] }
    const page = await bot.getGuildMemberList(guildId, query.cursor)
    return { members: page.data.map(mapSatoriMember), nextCursor: page.next }
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
  ): Promise<void> {
    const bot = this.requireBot()
    if (!bot.deleteMessage) throw new Error('Satori adapter does not support message.delete')
    for (const messageId of messageIds) await bot.deleteMessage(conversation.id, messageId)
  }

  async editMessage(
    _session: PlatformSession,
    target: IMMessageTarget,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<SatoriMediaLocator>> {
    const bot = this.requireBot()
    if (!bot.editMessage) throw new Error('Satori adapter does not support message.update')
    const elements = await toSatoriElements(bot, content, options)
    await bot.editMessage(target.conversationId, target.messageId, elements)
    if (bot.getMessage) {
      const message = await bot.getMessage(target.conversationId, target.messageId)
      return mapSatoriMessage(message, this.conversation(target.conversationId), bot.selfId)
    }
    return {
      id: target.messageId,
      conversationId: target.conversationId,
      senderId: bot.selfId,
      outgoing: true,
      timestamp: Math.trunc(Date.now() / 1000),
      content: { parts: content.parts.filter((part) => part.type === 'text') as IMMessage['content']['parts'] },
    }
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: import('@mtproto-relay/bridge').IMMedia<SatoriMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const url = media.locator?.url
    if (!url) throw new Error(`Satori media ${media.id} has no URL`)
    if (url.startsWith('internal:')) {
      const file = await this.ctx.http.file(url)
      yield* sliceBytes(new Uint8Array(file.data), options.offset, options.limit)
      return
    }
    const start = Math.max(0, Math.trunc(options.offset ?? 0))
    const end = options.limit === undefined ? undefined : start + Math.max(0, Math.trunc(options.limit)) - 1
    const stream = await this.ctx.http.get(url, {
      responseType: 'stream',
      signal: options.signal,
      headers: start || end !== undefined ? { Range: `bytes=${start}-${end ?? ''}` } : undefined,
    })
    let transferredBytes = 0
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      transferredBytes += bytes.length
      await options.onProgress?.({ phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: media.size })
      yield bytes
    }
  }

  requireBot(): Bot {
    const bot = this.bot
    if (bot) return bot
    const available = (this.ctx.bots ?? []).map((item) => item.sid).join(', ') || 'none'
    if (this.botSid) throw new Error(`Satori bot is not available: ${this.botSid} (available: ${available})`)
    throw new Error(`Satori platform needs exactly one bot or an explicit bot SID (available: ${available})`)
  }

  private conversation(id: string): IMConversation<SatoriMediaLocator> {
    return this.conversations.get(id) ?? { id, kind: 'group', title: id }
  }

  private remember(conversation: IMConversation<SatoriMediaLocator>): IMConversation<SatoriMediaLocator> {
    this.conversations.set(conversation.id, conversation)
    return conversation
  }
}

function encodeCursor(cursor: DialogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(cursor?: string): DialogCursor | undefined {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as DialogCursor
    if (!Array.isArray(value.guilds) || !Array.isArray(value.pending)) throw new Error('invalid shape')
    return value
  } catch {
    throw new Error('invalid Satori dialog cursor')
  }
}

function* sliceBytes(bytes: Uint8Array, offset = 0, limit?: number): Iterable<Uint8Array> {
  const start = Math.max(0, Math.trunc(offset))
  const end = limit === undefined ? bytes.length : start + Math.max(0, Math.trunc(limit))
  const slice = bytes.subarray(start, end)
  if (slice.length) yield slice
}
