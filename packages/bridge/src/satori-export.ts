import { Bot, h, type Universal } from '@satorijs/core'
import type { Context } from 'cordis'
import type { IngestResult } from './message-store.js'
import type { IMConversation, IMMediaInput, IMMessage, IMMessageInput, IMMessagePart, IMPlatform, IMTextEntity, PlatformSession } from './platform.js'

export interface SatoriExportConfig {
  platformId: string
  platform?: string
  /** Maximum bytes read for each outbound Satori media stream. */
  maxMediaBytes?: number
}

const DEFAULT_MAX_MEDIA_BYTES = 8 * 1024 * 1024

interface Logger {
  warn(format: string, ...args: unknown[]): void
}

/** Exposes one provisioned bridge platform session as a Satori Bot. */
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
    this._bot.user = { id: session.userId, name: session.userId }
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
      bot.dispatch(bot.session({
        type: 'message-created',
        timestamp: message.timestamp * 1_000,
        channel: satoriChannel(conversation),
        ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
        user: satoriUser(message.senderId, message.sender),
        message: {
          id: message.id,
          content: elements.join(''),
          createdAt: message.timestamp * 1_000,
          channel: satoriChannel(conversation),
          ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
          user: satoriUser(message.senderId, message.sender),
        },
      }))
    }).catch((error) => {
      this._logger.warn(
        'Satori message dispatch failed platform=%s session=%s conversation=%s message=%s error=%s',
        session.platformId, session.platformSessionId, conversation.id, message.id, formatError(error),
      )
    })
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
    let conversation = this._conversations.get(channelId)
    if (!conversation && platform.getConversation) {
      conversation = await platform.getConversation(session, channelId) ?? undefined
      if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
      if (conversation) this._conversations.set(conversation.id, conversation)
    }
    if (!conversation) throw new Error(`Satori exporter cannot resolve channel: ${channelId}`)
    const input = satoriInput(this._ctx, content, this._config)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
    const message = await platform.sendMessage(session, { id: channelId }, input)
    if (!this.isActive(bot, generation) || this._platform !== platform || this._session !== session) throw new Error('Satori exporter bot is no longer active')
    return [{
      id: message.id,
      content: (await this._messageElements(message, conversation, platform, session)).join(''),
      createdAt: message.timestamp * 1_000,
      channel: satoriChannel(conversation),
      ...(conversation.kind === 'direct' ? {} : { guild: satoriGuild(conversation) }),
      user: satoriUser(message.senderId, message.sender),
    }]
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
    for (const part of message.content.parts) {
      if (part.type === 'text') {
        output.push(...textElements(part))
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
        if (url) output.push(h.img(url.url, { title: part.sticker.title, type: part.sticker.mimeType }))
        else {
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
}

function satoriInput(ctx: Context, content: h.Fragment, config: SatoriExportConfig): IMMessageInput {
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
  const visit = (element: h) => {
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
    // Satori has no portable native-sticker input element; image markup remains ordinary media.
    if (element.type === 'img' || element.type === 'image' || element.type === 'file' || element.type === 'audio' || element.type === 'video') {
      const src = stringAttr(element.attrs.src)
      if (!src) throw new Error(`Satori ${element.type} has no src`)
      flush()
      const mimeType = stringAttr(element.attrs.type) ?? (element.type === 'audio' ? 'audio/*' : element.type === 'video' ? 'video/*' : undefined)
      parts.push({ type: 'media', media: {
        kind: element.type === 'img' || element.type === 'image' ? 'image' : 'file', name: stringAttr(element.attrs.title) ?? stringAttr(element.attrs.filename),
        mimeType, size: numberAttr(element.attrs.size), width: numberAttr(element.attrs.width), height: numberAttr(element.attrs.height),
        duration: numberAttr(element.attrs.duration), source: mediaSource(
          ctx, src, numberAttr(element.attrs.size), config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
        ),
      } satisfies IMMediaInput })
      return
    }
    const paragraph = element.type === 'p'
    for (const child of element.children) visit(child)
    if (paragraph && text && !text.endsWith('\n')) append('\n')
  }
  for (const element of h.normalize(content)) visit(element)
  text = text.replace(/\n$/u, '')
  flush()
  return { parts: parts.length ? parts : [{ type: 'text', text: '' }], replyToId }
}

function mediaSource(ctx: Context, src: string, size: number | undefined, maxBytes: number) {
  return {
    size,
    async *stream() {
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
      throw new Error('unsupported media source')
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

function textElements(part: Extract<IMMessagePart, { type: 'text' }>): h[] {
  const output: h[] = []
  let offset = 0
  for (const entity of [...(part.entities ?? [])].sort((left, right) => left.offset - right.offset)) {
    if (entity.offset < offset || entity.offset > part.text.length) continue
    if (entity.offset > offset) output.push(h.text(part.text.slice(offset, entity.offset)))
    const value = part.text.slice(entity.offset, entity.offset + entity.length)
    if (entity.type === 'mention') output.push(h.at(entity.userId, { name: value.replace(/^@/u, '') }))
    else if (entity.type === 'custom-emoji') output.push(h.emoji(entity.definition.key, { name: value }))
    else output.push(h.text(value))
    offset = entity.offset + entity.length
  }
  if (offset < part.text.length) output.push(h.text(part.text.slice(offset)))
  return output.length ? output : [h.text(part.text)]
}

function satoriChannel(conversation: IMConversation): Universal.Channel {
  return { id: conversation.id, type: conversation.kind === 'direct' ? 1 : 0, name: conversation.title }
}

function satoriGuild(conversation: IMConversation): Universal.Guild {
  return { id: conversation.spaceId ?? conversation.id, name: conversation.title }
}

function satoriUser(id: string, user: IMMessage['sender']): Universal.User {
  return { id, name: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || id : id }
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberAttr(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.stack ?? `${error.name}: ${error.message}`
}
