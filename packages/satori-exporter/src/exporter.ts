import { isIP } from 'node:net'
import { Bot, h, type Universal } from '@satorijs/core'
import type { Context } from 'cordis'
import {
  probeImageDimensions, providerBelongsToAccount, serviceActionText,
  type IMConversation, type IMConversationMember, type IMMediaInput, type IMUser, type IMMessage, type IMMessageInput, type IMMessagePart,
  type IMHistoryQuery, type IMPlatform, type IMSticker, type IMStickerProvider, type IMStickerSendPlan, type IMTextEntity,
  type IngestResult, type JsonValue, type PlatformSession, type StickerProviderContext,
} from '@mtproto-relay/bridge'

export interface SatoriExportConfig {
  platformId: string
  platform?: string
  maxMediaBytes?: number
  userIdSpace?: 'uin' | 'uid'
}

const DEFAULT_MAX_MEDIA_BYTES = 8 * 1024 * 1024
const DEFAULT_MESSAGE_LIST_LIMIT = 50
const MAX_MESSAGE_LIST_LIMIT = 100
const MAX_STICKER_ATTRIBUTE_LENGTH = 256
const MAX_STICKER_REFERENCE_LENGTH = 4 * 1024
const MAX_STICKER_REFERENCE_INPUT_LENGTH = MAX_STICKER_REFERENCE_LENGTH
const MAX_STICKER_REFERENCE_DEPTH = 16
const MAX_STICKER_REFERENCE_KEYS = 128
const STICKER_PROVIDER_ATTRIBUTE = 'data-crossgram-sticker-provider'
const STICKER_ID_ATTRIBUTE = 'data-crossgram-sticker-id'
const STICKER_PACK_ATTRIBUTE = 'data-crossgram-sticker-pack'
const STICKER_NAME_ATTRIBUTE = 'data-crossgram-sticker-name'
const STICKER_REFERENCE_ATTRIBUTE = 'data-crossgram-sticker-reference'
const STICKER_ATTRIBUTES = [
  STICKER_PROVIDER_ATTRIBUTE,
  STICKER_ID_ATTRIBUTE,
  STICKER_PACK_ATTRIBUTE,
  STICKER_NAME_ATTRIBUTE,
  STICKER_REFERENCE_ATTRIBUTE,
] as const

interface Logger {
  warn(format: string, ...args: unknown[]): void
}

export class SatoriExporter {
  private readonly _conversations = new Map<string, IMConversation>()
  private _bot?: SatoriExportBot
  private _platform?: IMPlatform
  private _session?: PlatformSession
  private _generation = 0
  private _queue = Promise.resolve()

  constructor(
    private readonly _ctx: Context,
    private readonly _config: SatoriExportConfig,
    private readonly _logger: Logger,
  ) {}

  start(platform: IMPlatform, session: PlatformSession): void {
    if (session.platformId !== this._config.platformId) return
    if (this._bot && (this._platform !== platform || this._session?.platformSessionId !== session.platformSessionId)) this.stop()
    this._platform = platform
    this._session = session
    if (!this._bot) this._bot = new SatoriExportBot(
      this._ctx, this, ++this._generation, this._config.platform ?? platform.platformKind ?? session.platformId,
    )
    const selfId = this._numericUserIds && typeof session.metadata.qq === 'string' && session.metadata.qq ? session.metadata.qq : session.userId
    this._bot.user = { id: selfId, name: selfId }
    this._bot.online()
  }

  stop(platformId?: string): void {
    if (platformId && this._session?.platformId !== platformId) return
    this._generation++
    try {
      this._bot?.dispose()
    } catch (error) {
      this._logger.warn('Satori exporter bot disposal failed platform=%s error=%s', this._session?.platformId ?? 'unknown', formatError(error))
    }
    this._bot = undefined
    this._platform = undefined
    this._session = undefined
    this._queue = Promise.resolve()
    this._conversations.clear()
  }

  isActive(bot: SatoriExportBot, generation: number): boolean {
    return this._bot?.generation === generation && this._generation === generation
  }

  /** 导出的用户 ID 是否优先使用数字 QQ 号（uin），而非不透明的 NT UID。 */
  private get _numericUserIds(): boolean {
    return this._config.userIdSpace !== 'uid'
  }

  handleMessage(
    session: PlatformSession,
    conversation: IMConversation,
    message: IMMessage,
    result: Pick<IngestResult, 'created'>,
  ): void {
    if (
      session.platformId !== this._config.platformId
      || session.platformSessionId !== this._session?.platformSessionId
      || !result.created || message.outgoing || !this._bot
    ) return
    const bot = this._bot
    const generation = this._generation
    const platform = this._platform!
    const canonical = this._session!
    this._conversations.set(conversation.id, conversation)
    this._queue = this._queue.then(async () => {
      const elements = await this._messageElements(message, conversation, platform, canonical)
      if (!this.isActive(bot, generation) || this._session !== canonical) return
      if (!elements.length) return
      const avatar = await this._avatarUrl(message.sender, platform, canonical)
      if (!this.isActive(bot, generation) || this._session !== canonical) return
      const user = satoriMessageUser(message, avatar, this._numericUserIds)
      const member = conversation.kind === 'direct' ? undefined : satoriMessageMember(message, user)
      bot.dispatch(bot.session({
        type: 'message-created',
        timestamp: message.timestamp * 1_000,
        channel: satoriChannel(conversation),
        ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
        user,
        ...(member ? { member } : {}),
        message: {
          id: message.id,
          content: elements.join(''),
          createdAt: message.timestamp * 1_000,
          channel: satoriChannel(conversation),
          ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
          user,
          ...(member ? { member } : {}),
        },
      }))
    }).catch((error) => {
      this._logger.warn(
        'Satori message dispatch failed platform=%s session=%s conversation=%s message=%s error=%s',
        session.platformId, session.platformSessionId, conversation.id, message.id, formatError(error),
      )
    })
  }
  handleDelete(
    session: PlatformSession,
    conversation: IMConversation,
    messageIds: readonly string[],
    timestamp = Date.now(),
  ): void {
    if (
      session.platformId !== this._config.platformId
      || session.platformSessionId !== this._session?.platformSessionId
      || !this._bot
    ) return
    const bot = this._bot
    this._conversations.set(conversation.id, conversation)
    for (const messageId of messageIds) {
      bot.dispatch(bot.session({
        type: 'message-deleted',
        timestamp,
        channel: satoriChannel(conversation),
        ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
        message: {
          id: messageId,
          channel: satoriChannel(conversation),
          ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
        },
      }))
    }
  }


  async getGuild(
    bot: SatoriExportBot,
    generation: number,
    guildId: string,
  ): Promise<Universal.Guild> {
    const platform = this._platform
    const session = this._session
    if (!platform || !session || !this.isActive(bot, generation)) throw new Error('Satori exporter bot is no longer active')
    let conversation = this._conversations.get(guildId)
    if (conversation?.kind === 'direct') conversation = undefined
    if (!conversation && platform.getConversation) {
      const resolved = await platform.getConversation(session, guildId)
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
        throw new Error('Satori exporter bot is no longer active')
      }
      if (resolved && resolved.kind !== 'direct' && resolved.id === guildId) {
        conversation = resolved
        this._conversations.set(resolved.id, resolved)
      }
    }
    if (!conversation) throw new Error(`Satori exporter cannot resolve guild: ${guildId}`)
    return { id: guildId, name: conversation.title }
  }

  async getGuildMember(
    bot: SatoriExportBot,
    generation: number,
    guildId: string,
    userId: string,
  ): Promise<Universal.GuildMember> {
    const platform = this._platform
    const session = this._session
    if (!platform || !session || !this.isActive(bot, generation)) throw new Error('Satori exporter bot is no longer active')
    if (!platform.getConversationMember) throw new Error('Satori exporter platform does not support guild member lookup')
    const conversation = [...this._conversations.values()]
      .find((item) => item.kind !== 'direct' && (item.spaceId ?? item.id) === guildId)
    const conversationId = conversation?.id ?? (session.platformId === 'qqnt' ? guildId : undefined)
    if (!conversationId) throw new Error(`Satori exporter cannot resolve guild: ${guildId}`)
    const member = await platform.getConversationMember(session, { id: conversationId }, userId)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
      throw new Error('Satori exporter bot is no longer active')
    }
    if (!member) throw new Error(`Satori exporter cannot find guild member: ${guildId}/${userId}`)
    const avatar = await this._avatarUrl(member.user, platform, session)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
      throw new Error('Satori exporter bot is no longer active')
    }
    return satoriGuildMember(member, avatar, this._numericUserIds)
  }

  async sendMessage(
    bot: SatoriExportBot,
    generation: number,
    channelId: string,
    content: h.Fragment,
  ): Promise<Universal.Message[]> {
    const platform = this._platform
    const session = this._session
    if (!platform || !session || !this.isActive(bot, generation)) throw new Error('Satori exporter bot is no longer active')
    const stickerContext = {
      session,
      conversation: { id: channelId },
      platformKind: platform.platformKind ?? session.platformId,
    }
    let input = await satoriInput(this._ctx, content, this._config, stickerContext)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
    if (!hasSendableContent(input)) return []
    let conversation = this._conversations.get(channelId)
    if (!conversation && platform.getConversation) {
      conversation = await platform.getConversation(session, channelId) ?? undefined
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
      if (conversation) this._conversations.set(conversation.id, conversation)
    }
    if (!conversation) throw new Error(`Satori exporter cannot resolve channel: ${channelId}`)
    if (conversation.id !== channelId && input.parts.some((part) => part.type === 'sticker')) {
      input = await satoriInput(this._ctx, content, this._config, { ...stickerContext, conversation: { id: conversation.id } })
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
    }
    const message = await platform.sendMessage(session, { id: channelId }, input)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
    const outgoing = { ...message, conversationId: conversation.id, outgoing: true }
    await this._ctx.imPlatform.ingestLocalMessage(session, conversation, outgoing)
    const elements = (await this._messageElements(outgoing, conversation, platform, session)).join('')
    const user = satoriUser(message.senderId, message.sender, await this._avatarUrl(message.sender, platform, session), this._numericUserIds)
    return [{
      id: outgoing.id,
      content: elements,
      createdAt: outgoing.timestamp * 1_000,
      channel: satoriChannel(conversation),
      ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation), member: satoriMessageMember(outgoing, user) }),
      user,
    }]
  }
  async getMessage(bot: SatoriExportBot, generation: number, channelId: string, messageId: string): Promise<Universal.Message> {
    const platform = this._platform
    const session = this._session
    if (!platform || !session || !this.isActive(bot, generation)) throw new Error('Satori exporter bot is no longer active')
    if (!platform.getMessage) throw new Error('Satori exporter platform does not support message lookup')
    const conversation = await this._resolveConversation(bot, generation, platform, session, channelId)
    const message = await platform.getMessage(session, { id: channelId }, messageId)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
      throw new Error('Satori exporter bot is no longer active')
    }
    if (!message || message.recalled) throw new Error(`Satori exporter cannot find message: ${channelId}/${messageId}`)
    return await this._listedMessage(message, conversation, platform, session)
  }

  /** 分页查询历史消息：游标为平台消息 ID，`before`/`after` 不含锚点本身，`around` 尽量包含锚点。 */
  async getMessageList(
    bot: SatoriExportBot,
    generation: number,
    channelId: string,
    next: string | undefined,
    direction: Universal.Direction = 'before',
    limit: number | undefined,
    order: Universal.Order = 'asc',
  ): Promise<Universal.BidiList<Universal.Message>> {
    const platform = this._platform
    const session = this._session
    if (!platform || !session || !this.isActive(bot, generation)) throw new Error('Satori exporter bot is no longer active')
    if (!platform.getHistory) throw new Error('Satori exporter platform does not support message history')
    const getHistory = platform.getHistory.bind(platform)
    const conversation = await this._resolveConversation(bot, generation, platform, session, channelId)
    const count = Math.min(MAX_MESSAGE_LIST_LIMIT, Math.max(1, Math.floor(limit || DEFAULT_MESSAGE_LIST_LIMIT)))
    const anchor = next ? { id: next, timestamp: 0 } : undefined
    const fetch = async (query: IMHistoryQuery) => {
      const page = await getHistory(session, { id: channelId }, query)
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
        throw new Error('Satori exporter bot is no longer active')
      }
      return page
    }
    // 平台侧会在分页后过滤灰条和撤回消息，且 QQ 首屏可能返回超出请求条数的消息，因此按靠近锚点的方向截断到 `count`。

    let messages: IMMessage[]
    let prev: string | undefined
    let following: string | undefined
    if (!anchor || direction === 'before') {
      const page = await fetch(anchor ? { before: anchor, limit: count } : { latest: true, limit: count })
      messages = chronological(page.messages, anchor?.id).slice(-count)
      prev = following = messages[0]?.id
    } else if (direction === 'after') {
      const page = await fetch({ after: anchor, limit: count })
      messages = chronological(page.messages, anchor.id).slice(0, count)
      prev = following = messages.at(-1)?.id
    } else {
      const side = Math.max(1, Math.floor((count - 1) / 2))
      const [older, newer, center] = await Promise.all([
        fetch({ before: anchor, limit: side }),
        fetch({ after: anchor, limit: side }),
        platform.getMessage?.(session, { id: channelId }, anchor.id).catch(() => null) ?? null,
      ])
      const before = chronological(older.messages, anchor.id).slice(-side)
      const after = chronological(newer.messages, anchor.id).slice(0, side)
      messages = chronological([...before, ...(center ? [center] : []), ...after])
      prev = before[0]?.id
      following = after.at(-1)?.id
    }

    const data: Universal.Message[] = []
    for (const message of messages) {
      if (message.recalled) continue
      data.push(await this._listedMessage(message, conversation, platform, session))
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
        throw new Error('Satori exporter bot is no longer active')
      }
    }
    if (order === 'desc') data.reverse()
    return { data, ...(prev ? { prev } : {}), ...(following ? { next: following } : {}) }
  }

  async deleteMessage(bot: SatoriExportBot, generation: number, channelId: string, messageId: string): Promise<void> {
    const platform = this._platform
    const session = this._session
    if (!platform || !session || !this.isActive(bot, generation)) throw new Error('Satori exporter bot is no longer active')
    if (!platform.deleteMessages) throw new Error('Satori exporter platform does not support message deletion')
    await platform.deleteMessages(session, { id: channelId }, [messageId], { forEveryone: true })
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
      throw new Error('Satori exporter bot is no longer active')
    }
  }


  private async _resolveConversation(
    bot: SatoriExportBot,
    generation: number,
    platform: IMPlatform,
    session: PlatformSession,
    channelId: string,
  ): Promise<IMConversation> {
    let conversation = this._conversations.get(channelId)
    if (!conversation && platform.getConversation) {
      conversation = await platform.getConversation(session, channelId) ?? undefined
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) {
        throw new Error('Satori exporter bot is no longer active')
      }
      if (conversation) this._conversations.set(conversation.id, conversation)
    }
    if (!conversation) throw new Error(`Satori exporter cannot resolve channel: ${channelId}`)
    return conversation
  }

  private async _listedMessage(
    message: IMMessage,
    conversation: IMConversation,
    platform: IMPlatform,
    session: PlatformSession,
  ): Promise<Universal.Message> {
    let elements: h[]
    try {
      elements = await this._messageElements(message, conversation, platform, session)
    } catch (error) {
      this._logger.warn(
        'Satori history message render degraded conversation=%s message=%s error=%s',
        conversation.id, message.id, formatError(error),
      )
      elements = message.content.parts.flatMap((part) => part.type === 'text' ? textElements(part, this._numericUserIds) : [h.text(`[${part.type}]`)])
    }
    const user = satoriMessageUser(message, await this._avatarUrl(message.sender, platform, session), this._numericUserIds)
    const member = conversation.kind === 'direct' ? undefined : satoriMessageMember(message, user)
    return {
      id: message.id,
      content: elements.join(''),
      createdAt: message.timestamp * 1_000,
      channel: satoriChannel(conversation),
      ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
      user,
      ...(member ? { member } : {}),
    }
  }

  private async _avatarUrl(
    user: Pick<IMUser, 'id' | 'avatar'> | undefined,
    platform: IMPlatform,
    session: PlatformSession,
  ): Promise<string | undefined> {
    if (!user?.avatar || !platform.resolveMediaUrl) return
    try {
      return (await platform.resolveMediaUrl(session, user.avatar))?.url
    } catch (error) {
      this._logger.warn('Satori avatar export unavailable user=%s media=%s error=%s', user.id, user.avatar.id, formatError(error))
    }
  }

  private async _messageElements(
    message: IMMessage,
    conversation: IMConversation,
    platform = this._platform,
    session = this._session,
  ): Promise<h[]> {
    if (!platform || !session) throw new Error('Satori exporter platform session is not ready')
    const output: h[] = []
    if (message.replyToId) output.push(h.quote(message.replyToId))
    const serviceText = serviceActionText(message.content.serviceAction)
    if (serviceText) output.push(h.text(serviceText))
    for (const part of message.content.parts) {
      if (part.type === 'text') {
        output.push(...textElements(part, this._numericUserIds))
      } else if (part.type === 'media') {
        const url = await platform.resolveMediaUrl?.(session, part.media)
        if (!url) throw new Error(`Satori exporter cannot resolve media URL: ${part.media.id}`)
        const type = part.media.kind === 'image' ? 'img'
          : part.media.mimeType?.startsWith('audio/') ? 'audio'
            : part.media.mimeType?.startsWith('video/') ? 'video' : 'file'
        output.push(h(type, {
          src: url.url, title: part.media.name, type: part.media.mimeType,
          width: part.media.width, height: part.media.height, size: part.media.size, duration: part.media.duration,
        }))
      } else if (part.type === 'sticker') {
        const provider = this._ctx.imSticker.get(part.sticker.providerId)
        const url = await provider?.resolveAssetUrl?.({
          session, conversation: { id: conversation.id }, platformKind: platform.platformKind ?? session.platformId,
        }, part.sticker)
        if (url) {
          let attributes: Record<string, string> = {}
          try {
            attributes = await stickerImageAttributes(provider, {
              session, conversation: { id: conversation.id }, platformKind: platform.platformKind ?? session.platformId,
            }, part.sticker)
          } catch (error) {
            this._logger.warn('Satori sticker metadata export unavailable provider=%s sticker=%s error=%s', part.sticker.providerId, part.sticker.stickerId, formatError(error))
          }
          output.push(h('img', { src: url.url, title: part.sticker.title ?? part.sticker.stickerId, type: part.sticker.mimeType, ...attributes }))
        } else {
          this._logger.warn('Satori sticker export unavailable provider=%s sticker=%s', part.sticker.providerId, part.sticker.stickerId)
          output.push(h.text(`[sticker: ${part.sticker.title ?? part.sticker.stickerId}]`))
        }
      } else {
        output.push(h.text(`[${part.type}]`))
      }
    }
    return output
  }
}

class SatoriExportBot extends Bot {
  constructor(ctx: Context, private readonly _exporter: SatoriExporter, readonly generation: number, platform: string) {
    super(ctx, {}, platform)
  }

  override createMessage(channelId: string, content: h.Fragment): Promise<Universal.Message[]> {
    if (!this._exporter.isActive(this, this.generation)) return Promise.reject(new Error('Satori exporter bot is not ready'))
    return this._exporter.sendMessage(this, this.generation, channelId, content)
  }
  override getMessage(channelId: string, messageId: string): Promise<Universal.Message> {
    if (!this._exporter.isActive(this, this.generation)) return Promise.reject(new Error('Satori exporter bot is not ready'))
    return this._exporter.getMessage(this, this.generation, channelId, messageId)
  }

  override getMessageList(
    channelId: string,
    next?: string,
    direction?: Universal.Direction,
    limit?: number,
    order?: Universal.Order,
  ): Promise<Universal.BidiList<Universal.Message>> {
    if (!this._exporter.isActive(this, this.generation)) return Promise.reject(new Error('Satori exporter bot is not ready'))
    return this._exporter.getMessageList(this, this.generation, channelId, next, direction, limit, order)
  }

  override deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this._exporter.isActive(this, this.generation)) return Promise.reject(new Error('Satori exporter bot is not ready'))
    return this._exporter.deleteMessage(this, this.generation, channelId, messageId)
  }


  override getGuild(guildId: string): Promise<Universal.Guild> {
    if (!this._exporter.isActive(this, this.generation)) return Promise.reject(new Error('Satori exporter bot is not ready'))
    return this._exporter.getGuild(this, this.generation, guildId)
  }

  override getGuildMember(guildId: string, userId: string): Promise<Universal.GuildMember> {
    if (!this._exporter.isActive(this, this.generation)) return Promise.reject(new Error('Satori exporter bot is not ready'))
    return this._exporter.getGuildMember(this, this.generation, guildId, userId)
  }
}

async function satoriInput(
  ctx: Context,
  content: h.Fragment,
  config: SatoriExportConfig,
  stickerContext: StickerProviderContext,
): Promise<IMMessageInput> {
  const parts: IMMessageInput['parts'] = []
  let text = ''
  let entities: IMTextEntity[] = []
  let replyToId: string | undefined
  const flush = () => {
    if (!text) return
    parts.push({ type: 'text', text, entities: entities.length ? entities : undefined })
    text = ''
    entities = []
  }
  const append = (value: string) => { text += value }
  const visit = async (element: h): Promise<void> => {
    if (element.type === 'text') return append(String(element.attrs.content ?? ''))
    if (element.type === 'br') return append('\n')
    if (element.type === 'quote') { replyToId = stringAttr(element.attrs.id); return }
    if (element.type === 'at') {
      const id = stringAttr(element.attrs.id)
      const name = stringAttr(element.attrs.name) ?? id ?? 'unknown'
      const visible = `@${name}`
      const offset = text.length
      append(visible)
      if (id) entities.push({ type: 'mention', offset, length: visible.length, userId: id })
      return
    }
    if (element.type === 'emoji') {
      const id = stringAttr(element.attrs.id)
      const visible = stringAttr(element.attrs.name) ?? id ?? ''
      const offset = text.length
      append(visible)
      if (id && /^1:\d+$/u.test(id) && visible) {
        entities.push({
          type: 'custom-emoji', offset, length: visible.length,
          definition: { key: id, presentation: { type: 'emoji', emoticon: visible } },
        })
      }
      return
    }
    if (element.type === 'img') {
      const sticker = stickerMetadata(element.attrs)
      if (sticker) {
        flush()
        parts.push({ type: 'sticker', sticker: await restoreNativeSticker(ctx, stickerContext, sticker) })
        return
      }
    }
    if (element.type === 'img' || element.type === 'image' || element.type === 'file' || element.type === 'audio' || element.type === 'video') {
      const src = stringAttr(element.attrs.src)
      if (!src) throw new Error(`Satori ${element.type} has no src`)
      flush()
      const mimeType = stringAttr(element.attrs.type) ?? (element.type === 'audio' ? 'audio/*' : element.type === 'video' ? 'video/*' : undefined)
      const kind = element.type === 'img' || element.type === 'image' ? 'image' : 'file'
      const maxMediaBytes = config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES
      const source = mediaSource(ctx, src, numberAttr(element.attrs.size), maxMediaBytes)
      let width = numberAttr(element.attrs.width)
      let height = numberAttr(element.attrs.height)
      if (kind === 'image') {
        width = positiveNumberAttr(element.attrs.width)
        height = positiveNumberAttr(element.attrs.height)
        if (width === undefined || height === undefined) {
          try {
            const dimensions = await probeImageDimensions(source, maxMediaBytes)
            width ??= dimensions?.width
            height ??= dimensions?.height
          } catch {}
        }
      }
      parts.push({ type: 'media', media: {
        kind, name: stringAttr(element.attrs.title) ?? stringAttr(element.attrs.filename),
        mimeType, size: numberAttr(element.attrs.size), width, height,
        duration: numberAttr(element.attrs.duration), source,
      } satisfies IMMediaInput })
      return
    }
    const paragraph = element.type === 'p'
    for (const child of element.children) await visit(child)
    if (paragraph && text && !text.endsWith('\n')) append('\n')
  }
  for (const element of h.normalize(content)) await visit(element)
  text = text.replace(/\n$/u, '')
  flush()
  return { parts: parts.length ? parts : [{ type: 'text', text: '' }], replyToId }
}

function hasSendableContent(input: IMMessageInput): boolean {
  return input.parts.some((part) => {
    switch (part.type) {
      case 'text': return !!part.text
      case 'media':
      case 'sticker': return true
    }
  })
}

function mediaSource(ctx: Context, src: string, size: number | undefined, maxBytes: number) {
  return {
    size,
    async *stream(options?: { signal?: AbortSignal }) {
      if (src.startsWith('internal:')) {
        const file = await ctx.http.file(src)
        const bytes = new Uint8Array(file.data)
        if (bytes.byteLength > maxBytes) throw new Error('Satori media exceeds size limit')
        yield bytes.slice()
        return
      }
      if (src.startsWith('data:')) {
        yield dataMediaBytes(src, maxBytes)
        return
      }
      let url: URL
      try {
        url = new URL(src)
      } catch {
        throw new Error('unsupported media source')
      }
      // 拒绝 IP 字面量主机名以防 SSRF / NAT64 回环绕过。
      if (url.protocol !== 'https:' || isIP(url.hostname.replace(/^\[|\]$/gu, ''))) {
        throw new Error('unsupported media source')
      }
      const stream = await ctx.http.get(src, { responseType: 'stream', signal: options?.signal })
      let transferredBytes = 0
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        transferredBytes += bytes.byteLength
        if (transferredBytes > maxBytes) throw new Error('Satori media exceeds size limit')
        yield bytes
      }
      return
    },
  }
}

function dataMediaBytes(src: string, maxBytes: number): Uint8Array {
  const comma = src.indexOf(',')
  const metadata = src.slice(5, comma)
  const payload = src.slice(comma + 1)
  if (comma < 5 || !/(?:^|;)base64$/iu.test(metadata) || payload.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) {
    throw new Error('unsupported media source')
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  if (payload.length / 4 * 3 - padding > maxBytes) throw new Error('Satori media exceeds size limit')
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
  if (bytes.byteLength > maxBytes) throw new Error('Satori media exceeds size limit')
  return bytes
}

interface SatoriStickerMetadata {
  providerId: string
  stickerId: string
  packId?: string
  name: string
  reference: JsonValue
}

async function stickerImageAttributes(
  provider: IMStickerProvider | undefined,
  context: StickerProviderContext,
  sticker: IMSticker,
): Promise<Record<string, string>> {
  if (!provider || !providerBelongsToAccount(provider, context.session.platformId, context.platformKind)) return {}
  const plan = await provider.prepareSend?.(context, sticker)
  if (!plan || plan.type !== 'native' || plan.providerId !== sticker.providerId || plan.stickerId !== sticker.stickerId) return {}
  const packId = plan.packId ?? ''
  const name = sticker.title ?? sticker.stickerId
  if (!isStickerAttributeValue(plan.providerId) || !isStickerAttributeValue(plan.stickerId)
    || !isStickerAttributeValue(packId, true) || !isStickerAttributeValue(name) || !isStickerReference(plan.reference)) {
    throw new Error('Satori sticker metadata is invalid')
  }
  return {
    [STICKER_PROVIDER_ATTRIBUTE]: plan.providerId,
    [STICKER_ID_ATTRIBUTE]: plan.stickerId,
    [STICKER_PACK_ATTRIBUTE]: packId,
    [STICKER_NAME_ATTRIBUTE]: name,
    [STICKER_REFERENCE_ATTRIBUTE]: encodeStickerReference(plan.reference),
  }
}

function stickerMetadata(attributes: Record<string, unknown>): SatoriStickerMetadata | undefined {
  const metadata = new Map<string, unknown>()
  for (const [key, value] of Object.entries(attributes)) {
    const normalizedKey = key.toLowerCase()
    const attribute = STICKER_ATTRIBUTES.find((name) => normalizedKey === name || normalizedKey === satoriAttributeName(name).toLowerCase())
    if (!attribute) {
      if (normalizedKey.startsWith('data-crossgram-sticker-') || normalizedKey.startsWith('datacrossgramsticker')) {
        throw new Error('Satori sticker metadata is incomplete')
      }
      continue
    }
    if (metadata.has(attribute)) throw new Error('Satori sticker metadata is invalid')
    metadata.set(attribute, value)
  }
  if (!metadata.size) return
  if (metadata.size !== STICKER_ATTRIBUTES.length) throw new Error('Satori sticker metadata is incomplete')
  const providerId = stickerAttribute(metadata, STICKER_PROVIDER_ATTRIBUTE)
  const stickerId = stickerAttribute(metadata, STICKER_ID_ATTRIBUTE)
  const packId = stickerAttribute(metadata, STICKER_PACK_ATTRIBUTE, true)
  const name = stickerAttribute(metadata, STICKER_NAME_ATTRIBUTE)
  const reference = decodeStickerReference(stickerAttribute(metadata, STICKER_REFERENCE_ATTRIBUTE, false, MAX_STICKER_REFERENCE_LENGTH))
  return { providerId, stickerId, packId: packId || undefined, name, reference }
}

async function restoreNativeSticker(
  ctx: Context,
  context: StickerProviderContext,
  metadata: SatoriStickerMetadata,
): Promise<IMStickerSendPlan> {
  const provider = ctx.imSticker.get(metadata.providerId)
  if (!provider || !providerBelongsToAccount(provider, context.session.platformId, context.platformKind)) {
    throw new Error('Satori sticker provider is unavailable for this account')
  }
  const sticker = await provider.getSticker(context, metadata.stickerId)
  if (!sticker || sticker.providerId !== metadata.providerId || sticker.stickerId !== metadata.stickerId) {
    throw new Error('Satori sticker is unavailable')
  }
  const plan = await provider.prepareSend?.(context, sticker)
  if (!plan || plan.type !== 'native'
    || plan.providerId !== metadata.providerId
    || plan.stickerId !== metadata.stickerId
    || plan.packId !== metadata.packId
    || !isStickerReference(plan.reference)
    || stableJsonStringify(plan.reference) !== stableJsonStringify(metadata.reference)) {
    throw new Error('Satori sticker metadata does not match the provider')
  }
  return plan
}

function satoriAttributeName(name: string): string {
  return name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
}

function stickerAttribute(attributes: ReadonlyMap<string, unknown>, name: string, allowEmpty = false, maxLength = MAX_STICKER_ATTRIBUTE_LENGTH): string {
  const value = attributes.get(name)
  if (!isStickerAttributeValue(value, allowEmpty, maxLength)) throw new Error('Satori sticker metadata is invalid')
  return value
}

function isStickerAttributeValue(value: unknown, allowEmpty = false, maxLength = MAX_STICKER_ATTRIBUTE_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || !!value)
}

function encodeStickerReference(reference: JsonValue): string {
  if (!isStickerReference(reference)) throw new Error('Satori sticker reference is invalid')
  const encoded = Buffer.from(stableJsonStringify(reference), 'utf8').toString('base64url')
  if (encoded.length > MAX_STICKER_REFERENCE_LENGTH) throw new Error('Satori sticker reference exceeds size limit')
  return encoded
}

function decodeStickerReference(value: string): JsonValue {
  if (value.length > MAX_STICKER_REFERENCE_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error('Satori sticker reference is invalid')
  }
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('Satori sticker reference is invalid')
  let reference: unknown
  try {
    reference = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('Satori sticker reference is invalid')
  }
  if (!isStickerReference(reference)) throw new Error('Satori sticker reference is invalid')
  return reference
}

function isStickerReference(value: unknown, depth = 0, budget = { entries: 0, characters: 0 }): value is JsonValue {
  if (depth > MAX_STICKER_REFERENCE_DEPTH) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return addReferenceCharacters(value, budget)
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    budget.entries += value.length
    return budget.entries <= MAX_STICKER_REFERENCE_KEYS && value.every((item) => isStickerReference(item, depth + 1, budget))
  }
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return false
  const entries = Object.entries(value)
  if (entries.some(([key]) => key === '__proto__' || key === 'constructor' || key === 'prototype')) return false
  budget.entries += entries.length
  return budget.entries <= MAX_STICKER_REFERENCE_KEYS
    && entries.every(([key, item]) => addReferenceCharacters(key, budget) && isStickerReference(item, depth + 1, budget))
}

function addReferenceCharacters(value: string, budget: { entries: number, characters: number }): boolean {
  budget.characters += value.length
  return budget.characters <= MAX_STICKER_REFERENCE_INPUT_LENGTH
}

function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key]!)}`).join(',')}}`
}

function textElements(part: Extract<IMMessagePart, { type: 'text' }>, numeric = true): h[] {
  const output: h[] = []
  let offset = 0
  for (const entity of [...(part.entities ?? [])].sort((left, right) => left.offset - right.offset)) {
    if (entity.offset < offset || entity.offset > part.text.length) continue
    if (entity.offset > offset) output.push(h.text(part.text.slice(offset, entity.offset)))
    const value = part.text.slice(entity.offset, entity.offset + entity.length)
    if (entity.type === 'mention') output.push(h.at(numeric ? entity.numericId ?? entity.userId : entity.userId, { name: value.replace(/^@/u, '') }))
    else if (entity.type === 'custom-emoji') output.push(h.emoji(entity.definition.key, { name: value }))
    else output.push(h.text(value))
    offset = entity.offset + entity.length
  }
  if (offset < part.text.length) output.push(h.text(part.text.slice(offset)))
  return output.length ? output : [h.text(part.text)]
}

function chronological(messages: readonly IMMessage[], excludeId?: string): IMMessage[] {
  const unique = new Map<string, IMMessage>()
  for (const message of messages) if (message.id !== excludeId) unique.set(message.id, message)
  return [...unique.values()].sort((left, right) =>
    left.timestamp - right.timestamp
    || (left.nativeOrderKey && right.nativeOrderKey ? left.nativeOrderKey.localeCompare(right.nativeOrderKey) : 0)
    || left.id.localeCompare(right.id))
}

function satoriChannel(conversation: IMConversation): Universal.Channel {
  return { id: conversation.id, type: conversation.kind === 'direct' ? 1 : 0, name: conversation.title }
}

function satoriGuild(conversation: IMConversation): Universal.Guild {
  return { id: conversation.spaceId ?? conversation.id, name: conversation.title }
}

/** 优先使用数字 QQ 号（`user.metadata.qq`）作为用户 ID，而非不透明的 NT UID。 */
function satoriUser(id: string, user: IMMessage['sender'], avatar?: string, numeric = true): Universal.User {
  const numericId = typeof user?.metadata?.qq === 'string' && user.metadata.qq ? user.metadata.qq : undefined
  const userId = numeric ? numericId ?? id : id
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || userId : userId
  return { id: userId, name, nick: name, ...(avatar ? { avatar } : {}), ...(user?.metadata?.bot === true ? { isBot: true } : {}) }
}

function satoriMessageUser(message: IMMessage, avatar?: string, numeric = true): Universal.User {
  if (message.content.serviceAction && (!message.senderId || message.senderId === '0')) {
    return { id: message.senderId || '0', name: '系统消息', nick: '系统消息' }
  }
  return satoriUser(message.senderId, message.sender, avatar, numeric)
}

function satoriMessageMember(message: IMMessage, user: Universal.User): Universal.GuildMember {
  const name = message.senderTitle?.trim() || user.nick || user.name || user.id
  return { name, nick: name, ...(user.avatar ? { avatar: user.avatar } : {}) }
}

function satoriGuildMember(member: IMConversationMember, avatar?: string, numeric = true): Universal.GuildMember {
  const user = satoriUser(member.user.id, member.user, avatar, numeric)
  const name = member.title?.trim() || user.nick!
  return {
    user,
    name,
    nick: name,
    ...(avatar ? { avatar } : {}),
    title: member.title,
    joinedAt: member.joinedAt === undefined ? undefined : member.joinedAt * 1_000,
  }
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberAttr(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function positiveNumberAttr(value: unknown): number | undefined {
  const number = numberAttr(value)
  return number !== undefined && number > 0 ? number : undefined
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.stack ?? `${error.name}: ${error.message}`
}
