import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { fetch as undiciFetch, ProxyAgent as UndiciProxyAgent } from 'undici'
import {
  Client, type AnyChannel, type ClientEvents, type DMChannel, type Guild, type GuildBasedChannel,
  type GuildEmoji, type GuildMember, type GroupDMChannel, type Message, type MessageAttachment,
  type MessageReaction, type NewsChannel, type PartialMessage, Permissions, type TextChannel,
  type ThreadChannel, type User,
} from 'discord.js-selfbot-v13'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationPermissions,
  IMConversationRef, IMDialog, IMDialogPage, IMDownloadOptions, IMEvent, IMHistoryPage,
  IMHistoryQuery, IMMedia, IMMessage, IMMessageInput, IMPageQuery, IMPlatform, IMReactionContext,
  IMReactionDefinition, IMReactionResource, IMReactionTarget, IMReadTarget, IMTransferOptions,
  IMUser, IMUserPage, JsonObject, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export interface DiscordMediaLocator extends JsonObject {
  url: string
  refreshable?: boolean
}

export interface Config {
  /** Normal Discord user-account token. This is not a Bot token. */
  token?: string
  /** Include messages authored by bot accounts. */
  includeBots?: boolean
  /** HTTP(S) proxy shared by Discord REST, Gateway, and CDN requests. */
  proxy?: string
  /** Maximum chunk size yielded by CDN downloads. */
  downloadChunkSize?: number
}

export const Config = z.object({
  token: z.string().role('secret').required(),
  includeBots: z.boolean().default(true),
  proxy: z.string().role('secret'),
  downloadChunkSize: z.natural().min(1).default(256 * 1024),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export const name = 'im-platform-discord-userbot'
export const inject = ['imPlatform']

interface DiscordLogger {
  debug?(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

interface ReadState {
  lastMessageId?: string
  mentionCount: number
}

type DiscordChannel = DMChannel | GroupDMChannel | TextChannel | NewsChannel | ThreadChannel

const COMMON_REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🔥', '🎉', '👏', '🤔'] as const
const MAX_PAGE_SIZE = 100

export interface DiscordPlatformDependencies {
  client?: Client
  fetch?: typeof globalThis.fetch
}

export function apply(ctx: Context, config: Config): void {
  const id = resolvePlatformPluginId(ctx, 'discord')
  const platform = new DiscordPlatform(config, {}, ctx.logger('platform-discord'))
  ctx.imPlatform.register(platform, id)
  ctx.effect(() => () => platform.stop())
}

export class DiscordPlatform implements IMPlatform<DiscordMediaLocator> {
  readonly platformKind = 'discord'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    readState: { markRead: true, events: true },
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 2_000,
      maxMedia: 10,
    },
    conversations: { groups: true, channels: true, subchannels: true },
    members: { list: true, administrators: true, permissions: true },
    avatars: { users: true, conversations: true },
    messageActions: {
      delete: { own: { supported: true }, others: { supported: true } },
      edit: { mode: 'native' },
      forward: { mode: 'native', preservesAuthor: true },
    },
    reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 20 },
  }

  readonly client: Client
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly proxyDispatcher?: UndiciProxyAgent
  private readonly includeBots: boolean
  private readonly downloadChunkSize: number
  private readonly readStates = new Map<string, ReadState>()
  private readonly handlers = new Map<string, (event: IMEvent<DiscordMediaLocator>) => void | Promise<void>>()
  private readonly originNonces = new Set<string>()
  private loginPromise?: Promise<void>
  private stopped = false

  constructor(
    private readonly config: Config,
    dependencies: DiscordPlatformDependencies = {},
    private readonly logger?: DiscordLogger,
  ) {
    const proxy = normalizeHttpProxy(config.proxy)
    this.client = dependencies.client ?? new Client({
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: false,
      ...(proxy ? {
        http: { agent: { uri: proxy } },
        ws: { agent: createWebSocketProxyAgent(proxy) },
      } : {}),
    })
    if (dependencies.fetch) {
      this.fetchImpl = dependencies.fetch
    } else if (proxy) {
      this.proxyDispatcher = new UndiciProxyAgent(proxy)
      this.fetchImpl = ((input, init) => undiciFetch(input as string | URL, {
        ...(init as import('undici').RequestInit),
        dispatcher: this.proxyDispatcher,
      }) as unknown as Promise<Response>) as typeof globalThis.fetch
    } else {
      this.fetchImpl = globalThis.fetch
    }
    this.includeBots = config.includeBots ?? true
    this.downloadChunkSize = config.downloadChunkSize ?? 256 * 1024
    this.client.on('raw', (packet) => this.handleRaw(packet))
  }

  async getAccount() {
    await this.ensureReady()
    return { credentials: {}, user: mapUser(this.client.user) }
  }

  async subscribe(
    session: PlatformSession,
    handler: (event: IMEvent<DiscordMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    await this.ensureReady()
    this.handlers.set(session.platformSessionId, handler)

    const onMessage = (message: Message) => {
      if (!this.shouldExposeMessage(message)) return
      if (typeof message.nonce === 'string' && this.originNonces.has(message.nonce)) return
      this.dispatch(handler, {
        type: 'message', message: this.mapMessage(message), conversation: this.mapConversation(message.channel as DiscordChannel),
      })
    }
    const onMessageUpdate = async (_old: Message | PartialMessage, updated: Message | PartialMessage) => {
      const message = updated.partial ? await updated.fetch().catch(() => null) : updated
      if (!message || !this.shouldExposeMessage(message)) return
      this.dispatch(handler, {
        type: 'message-edit',
        eventId: `discord:edit:${message.channelId}:${message.id}:${message.editedTimestamp ?? Date.now()}`,
        message: this.mapMessage(message), conversation: this.mapConversation(message.channel),
      })
    }
    const onMessageDelete = (message: Message | PartialMessage) => {
      const channel = this.resolveChannel(message.channelId)
      if (!channel) return
      this.dispatch(handler, {
        type: 'message-delete',
        eventId: `discord:delete:${message.channelId}:${message.id}`,
        conversation: this.mapConversation(channel), messageIds: [message.id],
        timestamp: Math.trunc(Date.now() / 1_000),
      })
    }
    const onMessageDeleteBulk: ClientEvents['messageDeleteBulk'][0] extends never
      ? never
      : (...args: ClientEvents['messageDeleteBulk']) => void = (messages) => {
        const first = messages.first()
        if (!first) return
        const channel = this.resolveChannel(first.channelId)
        if (!channel) return
        this.dispatch(handler, {
          type: 'message-delete',
          eventId: `discord:delete-bulk:${first.channelId}:${[...messages.keys()].sort().join(',')}`,
          conversation: this.mapConversation(channel), messageIds: [...messages.keys()],
          timestamp: Math.trunc(Date.now() / 1_000),
        })
      }
    const onReaction = (action: 'add' | 'remove') => async (reaction: MessageReaction) => {
      const message = reaction.message.partial
        ? await reaction.message.fetch().catch(() => null)
        : reaction.message
      if (!message || !this.shouldExposeMessage(message)) return
      const context = await this.mapReactionContext(message, true)
      const key = reactionKey(reaction)
      this.dispatch(handler, {
        type: 'message-reactions',
        eventId: `discord:reaction-${action}:${message.channelId}:${message.id}:${key}:${Date.now()}`,
        conversation: this.mapConversation(message.channel),
        target: { conversationId: message.channelId, messageId: message.id, targetId: message.id },
        context, timestamp: Math.trunc(Date.now() / 1_000),
      })
    }
    const onConversation = (channel: AnyChannel) => {
      if (!isSupportedChannel(channel) || !this.isVisible(channel)) return
      this.dispatch(handler, { type: 'conversation', conversation: this.mapConversation(channel) })
    }
    const onReactionAdd = onReaction('add')
    const onReactionRemove = onReaction('remove')
    const onChannelUpdate = (_old: AnyChannel, updated: AnyChannel) => onConversation(updated)
    const onThreadUpdate = (_old: ThreadChannel, updated: ThreadChannel) => onConversation(updated)

    this.client.on('messageCreate', onMessage)
    this.client.on('messageUpdate', onMessageUpdate)
    this.client.on('messageDelete', onMessageDelete)
    this.client.on('messageDeleteBulk', onMessageDeleteBulk)
    this.client.on('messageReactionAdd', onReactionAdd)
    this.client.on('messageReactionRemove', onReactionRemove)
    this.client.on('channelCreate', onConversation)
    this.client.on('channelUpdate', onChannelUpdate)
    this.client.on('threadCreate', onConversation)
    this.client.on('threadUpdate', onThreadUpdate)

    return () => {
      this.handlers.delete(session.platformSessionId)
      this.client.off('messageCreate', onMessage)
      this.client.off('messageUpdate', onMessageUpdate)
      this.client.off('messageDelete', onMessageDelete)
      this.client.off('messageDeleteBulk', onMessageDeleteBulk)
      this.client.off('messageReactionAdd', onReactionAdd)
      this.client.off('messageReactionRemove', onReactionRemove)
      this.client.off('channelCreate', onConversation)
      this.client.off('channelUpdate', onChannelUpdate)
      this.client.off('threadCreate', onConversation)
      this.client.off('threadUpdate', onThreadUpdate)
    }
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<DiscordMediaLocator>> {
    await this.ensureReady()
    const channels = [...this.client.channels.cache.values()]
      .filter((channel): channel is DiscordChannel => isSupportedChannel(channel) && this.isVisible(channel))
      .sort(compareChannels)
    const start = pageStart(channels.map((channel) => channel.id), query)
    const limit = clampLimit(query.limit)
    const selected = channels.slice(start, start + limit)
    const dialogs = await Promise.all(selected.map((channel) => this.mapDialog(channel)))
    return {
      dialogs,
      total: channels.length,
      nextCursor: start + selected.length < channels.length ? String(start + selected.length) : undefined,
    }
  }

  async getContacts(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMUserPage<DiscordMediaLocator>> {
    await this.ensureReady()
    await this.client.relationships.fetch().catch(() => undefined)
    const users = [...this.client.relationships.friendCache.values()]
      .filter((user): user is User => Boolean(user))
      .sort((left, right) => compareSnowflakes(left.id, right.id))
    const start = pageStart(users.map((user) => user.id), query)
    const limit = clampLimit(query.limit)
    const page = users.slice(start, start + limit)
    return {
      users: page.map((user) => mapUser(user)),
      nextCursor: start + page.length < users.length ? String(start + page.length) : undefined,
    }
  }

  async getHistory(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<DiscordMediaLocator>> {
    await this.ensureReady()
    const channel = await this.requireChannel(conversation.id)
    const limit = clampLimit(query.limit)
    const messages = await channel.messages.fetch({
      limit,
      before: query.before?.id ?? (!query.after ? query.cursor : undefined),
      after: query.after?.id,
    })
    const ordered = [...messages.values()]
      .sort((left, right) => compareSnowflakes(right.id, left.id))
    const mapped = ordered
      .filter((message) => this.shouldExposeMessage(message))
      .map((message) => this.mapMessage(message))
    return {
      messages: mapped,
      nextCursor: messages.size >= limit ? ordered.at(-1)?.id : undefined,
    }
  }

  async getMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<DiscordMediaLocator> | null> {
    await this.ensureReady()
    const channel = await this.requireChannel(conversation.id)
    const message = await channel.messages.fetch(messageId).catch(() => null)
    return message && this.shouldExposeMessage(message) ? this.mapMessage(message) : null
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser<DiscordMediaLocator> | null> {
    await this.ensureReady()
    const user = await this.client.users.fetch(userId).catch(() => null)
    return user ? mapUser(user) : null
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<DiscordMediaLocator>> {
    await this.ensureReady()
    const channel = await this.requireChannel(conversation.id)
    const members = await this.channelMembers(channel)
    const start = pageStart(members.map((member) => member.user.id), query)
    const limit = clampLimit(query.limit)
    const page = members.slice(start, start + limit)
    return {
      members: page,
      total: members.length,
      nextCursor: start + page.length < members.length ? String(start + page.length) : undefined,
    }
  }

  async getConversationMember(
    _session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<DiscordMediaLocator> | null> {
    await this.ensureReady()
    const channel = await this.requireChannel(conversation.id)
    if (channel.type === 'DM' || channel.type === 'GROUP_DM') {
      const user = channel.type === 'DM'
        ? [channel.recipient, this.client.user].find((item) => item.id === userId)
        : channel.recipients.get(userId)
      return user ? this.mapPrivateMember(channel, user) : null
    }
    const member = await channel.guild.members.fetch(userId).catch(() => null)
    return member ? mapGuildMember(channel, member) : null
  }

  async sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<DiscordMediaLocator>> {
    await this.ensureReady()
    const channel = await this.requireChannel(conversation.id)
    const payload = await this.createPayload(content, options)
    const nonce = randomUUID()
    this.originNonces.add(nonce)
    try {
      const message = await channel.send({ ...payload, nonce })
      return this.mapMessage(message)
    } finally {
      const timer = setTimeout(() => this.originNonces.delete(nonce), 120_000)
      timer.unref()
      void session
    }
  }

  async editMessage(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<DiscordMediaLocator>> {
    await this.ensureReady()
    const channel = await this.requireChannel(target.conversationId)
    const message = await channel.messages.fetch(target.targetId)
    const payload = await this.createPayload(content, options)
    const updated = await message.edit({ ...payload, attachments: [] })
    return this.mapMessage(updated)
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
  ): Promise<void> {
    await this.ensureReady()
    const channel = await this.requireChannel(conversation.id)
    for (const id of messageIds) await channel.messages.delete(id)
  }

  async forwardMessages(
    session: PlatformSession,
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options: import('@mtproto-relay/bridge').IMForwardMessagesOptions = {},
  ): Promise<IMMessage<DiscordMediaLocator>[]> {
    await this.ensureReady()
    const source = await this.requireChannel(from.id)
    const target = await this.requireChannel(to.id)
    const output: IMMessage<DiscordMediaLocator>[] = []
    for (const id of messageIds) {
      const message = await source.messages.fetch(id)
      if (!options.dropAuthor && !options.replyToId) {
        output.push(this.mapMessage(await message.forward(target)))
        continue
      }
      const mapped = this.mapMessage(message)
      const parts: IMMessageInput['parts'] = []
      for (const part of mapped.content.parts) {
        if (part.type === 'text') {
          parts.push({ ...part })
          continue
        }
        if (part.type === 'sticker' || part.type === 'card' || !part.media.locator) continue
        parts.push({
          type: 'media' as const,
          media: {
            kind: part.media.kind, name: part.media.name, mimeType: part.media.mimeType,
            size: part.media.size, width: part.media.width, height: part.media.height,
            source: {
              size: part.media.size,
              stream: ({ signal } = {}) => this.downloadMedia(session, part.media, { signal }),
            },
          },
        })
      }
      output.push(await this.sendMessage(session, to, { parts, replyToId: options.replyToId }))
    }
    return output
  }

  async markRead(_session: PlatformSession, target: IMReadTarget): Promise<void> {
    await this.ensureReady()
    const channel = await this.requireChannel(target.conversationId)
    const message = await channel.messages.fetch(target.messageId)
    await message.markRead()
    this.readStates.set(target.conversationId, { lastMessageId: target.messageId, mentionCount: 0 })
  }

  async getAvailableReactions(
    _session: PlatformSession,
    target: IMReactionTarget,
  ): Promise<IMReactionContext> {
    await this.ensureReady()
    const channel = await this.requireChannel(target.conversationId)
    return { available: this.reactionDefinitions(channel), reactions: [], maxSelected: 20 }
  }

  async getMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
  ): Promise<IMReactionContext> {
    await this.ensureReady()
    const channel = await this.requireChannel(target.conversationId)
    const message = await channel.messages.fetch(target.targetId)
    return this.mapReactionContext(message, true)
  }

  async setMessageReactions(
    _session: PlatformSession,
    target: import('@mtproto-relay/bridge').IMMessageTarget,
    reactionKeys: readonly string[],
  ): Promise<IMReactionContext> {
    await this.ensureReady()
    const channel = await this.requireChannel(target.conversationId)
    const message = await channel.messages.fetch(target.targetId)
    const requested = new Set(reactionKeys)
    for (const reaction of message.reactions.cache.values()) {
      if (reaction.me && !requested.has(reactionKey(reaction))) await reaction.users.remove(this.client.user)
    }
    const selected = new Set([...message.reactions.cache.values()].filter((item) => item.me).map(reactionKey))
    for (const key of requested) {
      if (selected.has(key)) continue
      await message.react(reactionIdentifier(key, channel))
    }
    return this.mapReactionContext(await message.fetch(), true)
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<DiscordMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    if (!media.locator?.url) throw new Error(`Discord media ${media.id} has no URL`)
    let url = media.locator.url
    if (media.locator.refreshable) {
      const refreshed = await this.client.refreshAttachmentURL(url).catch(() => [])
      url = refreshed[0]?.refreshed ?? url
    }
    yield* this.downloadUrl(url, options)
  }

  async *downloadReactionResource(
    _session: PlatformSession,
    resource: IMReactionResource,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const locator = resource.locator
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)
      || typeof locator.url !== 'string') throw new Error('Discord reaction resource has no URL')
    yield* this.downloadUrl(locator.url, options)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.handlers.clear()
    this.client.destroy()
    void this.proxyDispatcher?.close()
  }

  private async ensureReady(): Promise<void> {
    if (this.stopped) throw new Error('Discord platform has stopped')
    if (this.client.isReady()) return
    if (!this.config.token) throw new Error('Discord user token is required')
    this.loginPromise ??= (this.client as Client).login(this.config.token).then(() => undefined).catch((error) => {
      this.loginPromise = undefined
      throw error
    })
    await this.loginPromise
  }

  private handleRaw(packet: { t?: string, d?: any }): void {
    if (packet.t === 'READY') {
      const entries = Array.isArray(packet.d?.read_state?.entries)
        ? packet.d.read_state.entries
        : Array.isArray(packet.d?.read_state) ? packet.d.read_state : []
      for (const entry of entries) this.updateReadState(entry.id ?? entry.channel_id, entry)
      return
    }
    if (packet.t !== 'MESSAGE_ACK') return
    const channelId = packet.d?.channel_id
    const messageId = packet.d?.message_id
    if (typeof channelId !== 'string' || typeof messageId !== 'string') return
    this.updateReadState(channelId, packet.d)
    for (const handler of this.handlers.values()) {
      this.dispatch(handler, { type: 'read', conversationId: channelId, upToMessageId: messageId })
    }
  }

  private updateReadState(channelId: unknown, input: any): void {
    if (typeof channelId !== 'string') return
    const lastMessageId = input.last_message_id ?? input.message_id
    this.readStates.set(channelId, {
      lastMessageId: typeof lastMessageId === 'string' ? lastMessageId : undefined,
      mentionCount: typeof input.mention_count === 'number' ? input.mention_count : 0,
    })
  }

  private dispatch(
    handler: (event: IMEvent<DiscordMediaLocator>) => void | Promise<void>,
    event: IMEvent<DiscordMediaLocator>,
  ): void {
    Promise.resolve().then(() => handler(event)).catch((error) => {
      this.logger?.warn('Discord event handler failed: %s', formatError(error))
    })
  }

  private resolveChannel(id: string): DiscordChannel | undefined {
    const channel = this.client.channels.cache.get(id)
    return channel && isSupportedChannel(channel) ? channel : undefined
  }

  private async requireChannel(id: string): Promise<DiscordChannel> {
    const cached = this.resolveChannel(id)
    if (cached) return cached
    const fetched = await this.client.channels.fetch(id)
    if (!fetched || !isSupportedChannel(fetched)) throw new Error(`Discord text channel not found: ${id}`)
    return fetched
  }

  private isVisible(channel: DiscordChannel): boolean {
    if (channel.type === 'DM' || channel.type === 'GROUP_DM') return true
    return channel.viewable
      && Boolean(channel.permissionsFor(this.client.user)?.has('READ_MESSAGE_HISTORY'))
  }

  private shouldExposeMessage(message: Message): boolean {
    return isSupportedChannel(message.channel)
      && this.isVisible(message.channel)
      && (this.includeBots || !message.author.bot)
  }

  private async mapDialog(channel: DiscordChannel): Promise<IMDialog<DiscordMediaLocator>> {
    const state = this.readStates.get(channel.id)
    const lastId = channel.lastMessageId ?? undefined
    const unread = Boolean(lastId && state?.lastMessageId && compareSnowflakes(lastId, state.lastMessageId) > 0)
    let messages: Message[] = []
    if (unread && state?.lastMessageId) {
      const fetched = await channel.messages.fetch({ after: state.lastMessageId, limit: 100 }).catch(() => null)
      if (fetched) messages = [...fetched.values()].sort((a, b) => compareSnowflakes(b.id, a.id))
    }
    let lastMessage = messages[0]
    if (!lastMessage && lastId) lastMessage = await channel.messages.fetch(lastId).catch(() => undefined)
    const readMessage = state?.lastMessageId
      ? await channel.messages.fetch(state.lastMessageId).catch(() => undefined)
      : undefined
    return {
      conversation: this.mapConversation(channel),
      unreadCount: unread ? Math.max(1, messages.filter((item) => item.author.id !== this.client.user.id).length) : 0,
      lastMessage: lastMessage && this.shouldExposeMessage(lastMessage) ? this.mapMessage(lastMessage) : undefined,
      readInboxMaxMessage: readMessage && this.shouldExposeMessage(readMessage) ? this.mapMessage(readMessage) : undefined,
    }
  }

  private mapConversation(channel: DiscordChannel): IMConversation<DiscordMediaLocator> {
    if (channel.type === 'DM') {
      return {
        id: channel.id, kind: 'direct', title: channel.recipient.displayName,
        avatar: avatarMedia(channel.recipient), metadata: { discordChannelType: channel.type },
      }
    }
    if (channel.type === 'GROUP_DM') {
      const icon = channel.iconURL({ format: 'png', size: 256 })
      return {
        id: channel.id, kind: 'group', title: channel.name ?? [...channel.recipients.values()]
          .filter((user) => user.id !== this.client.user.id).map((user) => user.displayName).join(', '),
        avatar: icon ? urlMedia(`discord:gdm:${channel.id}`, icon, 'image', 'group.png', 'image/png') : undefined,
        metadata: { discordChannelType: channel.type, participantsCount: channel.recipients.size },
      }
    }
    const guild = channel.guild
    const icon = guild.iconURL({ format: 'png', size: 256 })
    return {
      id: channel.id, kind: 'channel', title: channel.name,
      parentId: channel.parentId ?? undefined, spaceId: guild.id,
      avatar: icon ? urlMedia(`discord:guild:${guild.id}`, icon, 'image', 'guild.png', 'image/png') : undefined,
      metadata: {
        discordChannelType: channel.type, discordGuildId: guild.id, discordGuildName: guild.name,
        ...(channel.isThread() && channel.memberCount !== null
          ? { participantsCount: channel.memberCount }
          : {}),
      },
    }
  }

  private mapMessage(message: Message): IMMessage<DiscordMediaLocator> {
    const parts: IMMessage<DiscordMediaLocator>['content']['parts'] = []
    const text = mapDiscordText(message)
    if (text.text) parts.push({ type: 'text', text: text.text, entities: text.entities.length ? text.entities : undefined })
    for (const attachment of message.attachments.values()) parts.push({ type: 'media', media: mapAttachment(attachment) })
    for (const sticker of message.stickers.values()) {
      const url = sticker.url
      const mimeType = sticker.format === 'LOTTIE' ? 'application/json'
        : sticker.format === 'GIF' ? 'image/gif' : 'image/png'
      parts.push({
        type: 'media', media: urlMedia(
          `discord:sticker:${sticker.id}`, url, mimeType.startsWith('image/') ? 'image' : 'file',
          `${sticker.name}.${mimeType === 'image/gif' ? 'gif' : mimeType === 'image/png' ? 'png' : 'json'}`, mimeType,
        ),
      })
    }
    if (!parts.length && message.embeds.length) {
      const summary = message.embeds.flatMap((embed) => [embed.title, embed.description, embed.url]).filter(Boolean).join('\n')
      if (summary) parts.push({ type: 'text', text: summary })
    }
    const reactionContext = this.mapCachedReactionContext(message)
    return {
      id: message.id, conversationId: message.channelId, senderId: message.author.id,
      sender: mapUser(message.author, message.member?.displayName),
      content: {
        parts,
        serviceAction: message.system ? { type: 'custom', text: message.cleanContent || message.type } : undefined,
      },
      timestamp: Math.trunc(message.createdTimestamp / 1_000),
      outgoing: message.author.id === this.client.user.id,
      replyToId: message.reference?.messageId,
      reactionContext,
      metadata: {
        discordMessageType: message.type,
        ...(message.editedTimestamp ? { discordEditedTimestamp: message.editedTimestamp } : {}),
      },
    }
  }

  private async channelMembers(channel: DiscordChannel): Promise<IMConversationMember<DiscordMediaLocator>[]> {
    if (channel.type === 'DM') {
      return [this.mapPrivateMember(channel, this.client.user), this.mapPrivateMember(channel, channel.recipient)]
    }
    if (channel.type === 'GROUP_DM') {
      return [...channel.recipients.values()].map((user) => this.mapPrivateMember(channel, user))
    }
    if (channel.isThread() && channel.isPrivate()) {
      const threadMembers = await channel.members.fetch({ withMember: true }).catch(() => null)
      if (threadMembers) return [...threadMembers.values()]
        .flatMap((member) => member.guildMember ? [mapGuildMember(channel, member.guildMember)] : [])
        .sort((a, b) => compareSnowflakes(a.user.id, b.user.id))
    }
    await channel.guild.members.fetch({ limit: 1_000 }).catch(() => undefined)
    return [...channel.guild.members.cache.values()]
      .filter((member) => Boolean(channel.permissionsFor(member)?.has('VIEW_CHANNEL')))
      .map((member) => mapGuildMember(channel, member))
      .sort((a, b) => compareSnowflakes(a.user.id, b.user.id))
  }

  private mapPrivateMember(
    channel: DMChannel | GroupDMChannel,
    user: User,
  ): IMConversationMember<DiscordMediaLocator> {
    const owner = channel.type === 'GROUP_DM' && channel.ownerId === user.id
    return {
      user: mapUser(user), role: owner ? 'owner' : 'member',
      permissions: privatePermissions(owner),
    }
  }

  private async createPayload(content: IMMessageInput, options: IMTransferOptions) {
    const text = content.parts.filter((part) => part.type === 'text')
      .map((part) => encodeDiscordText(part.text, part.entities ?? [])).join('\n')
    if (text.length > 2_000) throw new Error('Discord messages are limited to 2000 characters')
    const media = content.parts.filter((part) => part.type === 'media')
    if (media.length > 10) throw new Error('Discord messages support at most 10 attachments')
    const files = []
    for (let index = 0; index < media.length; index++) {
      const item = media[index]!.media
      files.push({
        attachment: Buffer.from(await consumeSource(item.source, index, options)),
        name: item.name ?? `upload-${Date.now()}-${index}`,
      })
    }
    if (!text && !files.length) throw new Error('Discord message must contain text or an attachment')
    return {
      content: text || undefined,
      files: files.length ? files : undefined,
      allowedMentions: { parse: [] as [], users: mentionedUserIds(content), repliedUser: false },
      reply: content.replyToId
        ? { messageReference: content.replyToId, failIfNotExists: false }
        : undefined,
    }
  }

  private reactionDefinitions(channel: DiscordChannel): IMReactionDefinition[] {
    const definitions: IMReactionDefinition[] = COMMON_REACTIONS.map((emoji) => ({
      key: `unicode:${emoji}`, title: emoji, presentation: { type: 'emoji', emoticon: emoji },
    }))
    if (channel.type === 'DM' || channel.type === 'GROUP_DM') return definitions
    for (const emoji of channel.guild.emojis.cache.values()) definitions.push(customEmojiDefinition(emoji))
    return definitions
  }

  private mapCachedReactionContext(message: Message): IMReactionContext | undefined {
    if (!message.reactions.cache.size) return undefined
    const current = [...message.reactions.cache.values()]
    return {
      available: mergeDefinitions(this.reactionDefinitions(message.channel as DiscordChannel), current.map(reactionDefinition)),
      reactions: current.map((reaction) => ({
        key: reactionKey(reaction), count: reaction.count, selected: reaction.me,
        recentActors: [...reaction.users.cache.values()].slice(0, 3).map((user) => ({ userId: user.id })),
      })),
      maxSelected: 20,
    }
  }

  private async mapReactionContext(message: Message, fetchActors: boolean): Promise<IMReactionContext> {
    const reactions = []
    for (const reaction of message.reactions.cache.values()) {
      const users = fetchActors
        ? await reaction.users.fetch({ limit: Math.min(reaction.count, 100) }).catch(() => reaction.users.cache)
        : reaction.users.cache
      reactions.push({
        key: reactionKey(reaction), count: reaction.count, selected: reaction.me,
        recentActors: [...users.values()].slice(0, 100).map((user) => ({ userId: user.id })),
      })
    }
    return {
      available: mergeDefinitions(
        this.reactionDefinitions(message.channel as DiscordChannel),
        [...message.reactions.cache.values()].map(reactionDefinition),
      ),
      reactions,
      maxSelected: 20,
    }
  }

  private async *downloadUrl(url: string, options: IMDownloadOptions): AsyncIterable<Uint8Array> {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit))
    if (limit === 0) return
    const headers: Record<string, string> = {}
    if (offset || limit !== undefined) {
      const end = limit === undefined ? '' : String(offset + limit - 1)
      headers.Range = `bytes=${offset}-${end}`
    }
    const response = await this.fetchImpl(url, { headers, signal: options.signal })
    if (!response.ok) throw new Error(`Discord CDN download failed: HTTP ${response.status}`)
    if (!response.body) throw new Error('Discord CDN response has no body')
    let skip = response.status === 206 ? 0 : offset
    let remaining = limit ?? Number.POSITIVE_INFINITY
    let transferred = 0
    const reader = response.body.getReader()
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const source = result.value
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Discord download aborted')
      let chunk = source instanceof Uint8Array ? source : new Uint8Array(source)
      if (skip >= chunk.length) {
        skip -= chunk.length
        continue
      }
      if (skip) {
        chunk = chunk.subarray(skip)
        skip = 0
      }
      if (chunk.length > remaining) chunk = chunk.subarray(0, remaining)
      for (let start = 0; start < chunk.length; start += this.downloadChunkSize) {
        const output = chunk.slice(start, Math.min(chunk.length, start + this.downloadChunkSize))
        remaining -= output.length
        transferred += output.length
        yield output
        await options.onProgress?.({
          phase: 'download', mediaIndex: 0, transferredBytes: transferred, totalBytes: limit,
        })
      }
      if (remaining <= 0) break
    }
  }
}

function normalizeHttpProxy(input?: string): string | undefined {
  if (!input?.trim()) return undefined
  const url = new URL(input.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Discord proxy must use http:// or https://: ${url.protocol}`)
  }
  return url.toString()
}

function createWebSocketProxyAgent(proxy: string) {
  const agent = new HttpsProxyAgent(proxy)
  // discord.js-selfbot-v13 validates these compatibility fields before
  // forwarding the object itself to ws as a standard Node Agent.
  return Object.assign(agent, { httpAgent: agent, httpsAgent: agent })
}

function isSupportedChannel(channel: AnyChannel): channel is DiscordChannel {
  return channel.type === 'DM' || channel.type === 'GROUP_DM'
    || channel.type === 'GUILD_TEXT' || channel.type === 'GUILD_NEWS'
    || channel.type === 'GUILD_PUBLIC_THREAD' || channel.type === 'GUILD_PRIVATE_THREAD'
    || channel.type === 'GUILD_NEWS_THREAD'
}

function mapUser(user: User, displayName?: string): IMUser<DiscordMediaLocator> {
  return {
    id: user.id,
    firstName: displayName ?? user.globalName ?? user.displayName ?? user.username,
    username: user.username,
    avatar: avatarMedia(user),
    metadata: {
      discordUsername: user.username,
      ...(user.globalName ? { discordGlobalName: user.globalName } : {}),
      ...(user.discriminator && user.discriminator !== '0' ? { discordDiscriminator: user.discriminator } : {}),
      ...(user.bot ? { discordBot: true } : {}),
    },
  }
}

function avatarMedia(user: User): IMMedia<DiscordMediaLocator> {
  const url = user.displayAvatarURL({ format: 'png', size: 256 })
  return urlMedia(`discord:avatar:${user.id}:${user.avatar ?? 'default'}`, url, 'image', 'avatar.png', 'image/png')
}

function urlMedia(
  id: string,
  url: string,
  kind: 'image' | 'file',
  name?: string,
  mimeType?: string,
  extra: Partial<IMMedia<DiscordMediaLocator>> = {},
): IMMedia<DiscordMediaLocator> {
  return { id, kind, name, mimeType, locator: { url }, ...extra }
}

function mapAttachment(attachment: MessageAttachment): IMMedia<DiscordMediaLocator> {
  const mimeType = attachment.contentType ?? undefined
  return {
    id: `discord:attachment:${attachment.id}`,
    kind: mimeType?.startsWith('image/') ? 'image' : 'file',
    name: attachment.name ?? undefined,
    mimeType,
    size: attachment.size,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
    duration: attachment.duration ?? undefined,
    locator: { url: attachment.url, refreshable: true },
  }
}

function mapDiscordText(message: Message): {
  text: string
  entities: import('@mtproto-relay/bridge').IMTextEntity[]
} {
  const entities: import('@mtproto-relay/bridge').IMTextEntity[] = []
  const source = message.content
  const pattern = /<(@!?|#|a?:)(\d+)>|<(a?):([\w~]+):(\d+)>/g
  let text = ''
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    text += source.slice(cursor, index)
    const offset = text.length
    if (match[1]?.startsWith('@')) {
      const id = match[2]!
      const user = message.mentions.users.get(id)
      const label = `@${message.mentions.members?.get(id)?.displayName ?? user?.displayName ?? user?.username ?? id}`
      text += label
      entities.push({ type: 'mention', offset, length: label.length, userId: id })
    } else if (match[1] === '#') {
      const id = match[2]!
      const channel = message.mentions.channels.get(id)
      const label = `#${channel
        ? channel.type === 'DM' ? channel.recipient.displayName
          : channel.type === 'GROUP_DM' ? channel.name ?? 'Group DM'
            : 'name' in channel ? channel.name : id
        : id}`
      text += label
      if (channel && isSupportedChannel(channel)) {
        entities.push({ type: 'conversation-link', offset, length: label.length, conversation: mapLinkedConversation(channel) })
      }
    } else {
      const animated = match[3] === 'a'
      const name = match[4]!
      const id = match[5]!
      const label = `:${name}:`
      text += label
      entities.push({
        type: 'custom-emoji', offset, length: label.length,
        definition: customEmojiDefinition({ id, name, animated } as GuildEmoji),
      })
    }
    cursor = index + match[0].length
  }
  text += source.slice(cursor)
  return { text, entities }
}

function mapLinkedConversation(channel: DiscordChannel): IMConversation<DiscordMediaLocator> {
  if (channel.type === 'DM') return { id: channel.id, kind: 'direct', title: channel.recipient.displayName }
  if (channel.type === 'GROUP_DM') return { id: channel.id, kind: 'group', title: channel.name ?? 'Group DM' }
  return {
    id: channel.id, kind: 'channel', title: channel.name,
    parentId: channel.parentId ?? undefined, spaceId: channel.guild.id,
  }
}

function encodeDiscordText(text: string, entities: readonly import('@mtproto-relay/bridge').IMTextEntity[]): string {
  const replacements: Array<{ offset: number, length: number, value: string }> = []
  for (const entity of entities) {
    if (entity.type === 'mention') {
      replacements.push({ offset: entity.offset, length: entity.length, value: `<@${entity.userId}>` })
      continue
    }
    if (entity.type === 'conversation-link') {
      replacements.push({ offset: entity.offset, length: entity.length, value: `<#${entity.conversation.id}>` })
      continue
    }
    const match = /^custom:(\d+)$/.exec(entity.definition.key)
    if (!match) continue
    const alt = entity.definition.presentation.type === 'custom' ? entity.definition.presentation.alt : 'emoji'
    replacements.push({ offset: entity.offset, length: entity.length, value: `<:${alt}:${match[1]}>` })
  }
  replacements.sort((left, right) => right.offset - left.offset)
  let output = text
  for (const replacement of replacements) {
    output = output.slice(0, replacement.offset) + replacement.value
      + output.slice(replacement.offset + replacement.length)
  }
  return output
}

function mentionedUserIds(content: IMMessageInput): string[] {
  return [...new Set(content.parts.flatMap((part) => part.type === 'text'
    ? (part.entities ?? []).flatMap((entity) => entity.type === 'mention' ? [entity.userId] : [])
    : []))]
}

function mapGuildMember(channel: GuildBasedChannel | ThreadChannel, member: GuildMember): IMConversationMember<DiscordMediaLocator> {
  const permissions = channel.permissionsFor(member)
  const role = member.guild.ownerId === member.id ? 'owner'
    : permissions?.has('ADMINISTRATOR') || permissions?.has('MANAGE_GUILD') || permissions?.has('MANAGE_CHANNELS')
      ? 'administrator' : 'member'
  return {
    user: mapUser(member.user, member.displayName),
    role,
    permissions: mapPermissions(permissions),
    joinedAt: member.joinedTimestamp ? Math.trunc(member.joinedTimestamp / 1_000) : undefined,
    title: member.nickname ?? undefined,
    metadata: member.nickname ? { discordNickname: member.nickname } : undefined,
  }
}

function mapPermissions(permissions: Readonly<Permissions> | null): IMConversationPermissions {
  const has = (permission: Parameters<Permissions['has']>[0]) => Boolean(permissions?.has(permission))
  return {
    manageConversation: has('MANAGE_CHANNELS'),
    manageMembers: has('KICK_MEMBERS') || has('BAN_MEMBERS'),
    deleteAnyMessage: has('MANAGE_MESSAGES'),
    editAnyMessage: false,
    pinMessages: has('MANAGE_MESSAGES'),
    inviteMembers: has('CREATE_INSTANT_INVITE'),
  }
}

function privatePermissions(owner: boolean): IMConversationPermissions {
  return {
    manageConversation: owner, manageMembers: owner, deleteAnyMessage: false,
    editAnyMessage: false, pinMessages: false, inviteMembers: owner,
  }
}

function customEmojiDefinition(emoji: Pick<GuildEmoji, 'id' | 'name' | 'animated'>): IMReactionDefinition {
  return {
    key: `custom:${emoji.id}`,
    title: emoji.name ?? `emoji-${emoji.id}`,
    presentation: {
      type: 'custom', alt: emoji.name ?? 'emoji',
      resource: {
        // The bridge contract accepts PNG/WebP or WebM. Requesting PNG also
        // gives animated Discord emoji a stable first-frame representation.
        version: 1, format: 'static', mimeType: 'image/png',
        width: 128, height: 128,
        locator: { url: `https://cdn.discordapp.com/emojis/${emoji.id}.png?size=128&quality=lossless` },
      },
    },
  }
}

function reactionKey(reaction: MessageReaction): string {
  return reaction.emoji.id ? `custom:${reaction.emoji.id}` : `unicode:${reaction.emoji.name ?? ''}`
}

function reactionDefinition(reaction: MessageReaction): IMReactionDefinition {
  return reaction.emoji.id
    ? customEmojiDefinition({ id: reaction.emoji.id, name: reaction.emoji.name, animated: reaction.emoji.animated })
    : {
        key: reactionKey(reaction), title: reaction.emoji.name ?? undefined,
        presentation: { type: 'emoji', emoticon: reaction.emoji.name ?? '�' },
      }
}

function reactionIdentifier(key: string, channel: DiscordChannel): string {
  if (key.startsWith('unicode:')) return key.slice('unicode:'.length)
  const match = /^custom:(\d+)$/.exec(key)
  if (!match) throw new Error(`Unsupported Discord reaction key: ${key}`)
  if (channel.type === 'DM' || channel.type === 'GROUP_DM') return match[1]!
  return channel.guild.emojis.cache.get(match[1]!)?.identifier ?? match[1]!
}

function mergeDefinitions(
  first: readonly IMReactionDefinition[],
  second: readonly IMReactionDefinition[],
): IMReactionDefinition[] {
  const output = new Map(first.map((item) => [item.key, item]))
  for (const item of second) output.set(item.key, item)
  return [...output.values()]
}

async function consumeSource(
  source: import('@mtproto-relay/bridge').IMMediaSource,
  mediaIndex: number,
  options: IMTransferOptions,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const value of source.stream({ signal: options.signal })) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Discord upload aborted')
    const chunk = value.slice()
    chunks.push(chunk)
    size += chunk.length
    await options.onProgress?.({ phase: 'upload', mediaIndex, transferredBytes: size, totalBytes: source.size })
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function compareChannels(left: DiscordChannel, right: DiscordChannel): number {
  const leftId = left.lastMessageId ?? left.id
  const rightId = right.lastMessageId ?? right.id
  return compareSnowflakes(rightId, leftId) || compareSnowflakes(right.id, left.id)
}

function compareSnowflakes(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function pageStart(ids: string[], query: IMPageQuery): number {
  if (query.afterId) {
    const index = ids.indexOf(query.afterId)
    return index < 0 ? 0 : index + 1
  }
  if (!query.cursor) return 0
  const cursor = Number(query.cursor)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`Invalid Discord cursor: ${query.cursor}`)
  return cursor
}

function clampLimit(limit = 50): number {
  if (!Number.isFinite(limit)) return 50
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}
