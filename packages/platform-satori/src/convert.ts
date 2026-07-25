import { createHash } from 'node:crypto'
import { h, type Bot, type Universal } from '@satorijs/core'
import type {
  IMConversation, IMConversationMember, IMMedia, IMMessage, IMMessageInput, IMMessagePart,
  IMTransferOptions, IMUser,
} from '@mtproto-relay/bridge'

export interface SatoriMediaLocator {
  url: string
}

export function mapSatoriUser(
  user: Universal.User | undefined,
  member?: Universal.GuildMember,
): IMUser<SatoriMediaLocator> {
  const id = user?.id ?? member?.user?.id
  if (!id) throw new Error('Satori user has no ID')
  const displayName = member?.nick ?? member?.name ?? user?.nick ?? user?.name ?? id
  const avatar = member?.avatar ?? user?.avatar
  return {
    id,
    firstName: displayName,
    username: user?.name,
    avatar: avatar ? mediaFromUrl(avatar, 'image', `avatar:${id}`) : undefined,
    metadata: {
      ...(user?.discriminator ? { satoriDiscriminator: user.discriminator } : {}),
      ...(user?.isBot === undefined ? {} : { satoriIsBot: user.isBot }),
    },
  }
}

export function mapSatoriConversation(
  channel: Universal.Channel,
  guild?: Universal.Guild,
): IMConversation<SatoriMediaLocator> {
  const direct = channel.type === 1
  return {
    id: channel.id,
    kind: direct ? 'direct' : guild ? 'channel' : 'group',
    title: channel.name ?? guild?.name ?? channel.id,
    parentId: channel.parentId,
    spaceId: guild?.id,
    avatar: guild?.avatar ? mediaFromUrl(guild.avatar, 'image', `guild:${guild.id}`) : undefined,
    metadata: {
      satoriChannelType: channel.type,
      ...(guild?.id ? { satoriGuildId: guild.id } : {}),
    },
  }
}

export function mapSatoriMessage(
  message: Universal.Message,
  fallbackConversation: IMConversation<SatoriMediaLocator>,
  selfId: string,
): IMMessage<SatoriMediaLocator> {
  const id = message.id ?? message.messageId
  if (!id) throw new Error('Satori message has no ID')
  const conversation = message.channel
    ? mapSatoriConversation(message.channel, message.guild)
    : fallbackConversation
  const user = message.user ?? message.member?.user
  const senderId = user?.id ?? (message as { userId?: string }).userId ?? selfId
  const elements = message.elements ?? h.parse(message.content ?? '')
  return {
    id,
    conversationId: conversation.id,
    senderId,
    sender: user ? mapSatoriUser(user, message.member) : undefined,
    content: { parts: mapSatoriElements(elements, id) },
    timestamp: unixSeconds(message.timestamp ?? message.createdAt ?? Date.now()),
    outgoing: senderId === selfId,
    replyToId: message.quote?.id ?? message.quote?.messageId,
    metadata: message.updatedAt ? { satoriUpdatedAt: message.updatedAt } : undefined,
  }
}

export function mapSatoriElements(
  elements: h[],
  messageId = 'message',
): IMMessagePart<SatoriMediaLocator>[] {
  const parts: IMMessagePart<SatoriMediaLocator>[] = []
  let text = ''
  let entities: Extract<IMMessagePart, { type: 'text' }>['entities'] = []
  let mediaIndex = 0

  const flush = () => {
    if (!text) return
    parts.push({ type: 'text', text, entities: entities?.length ? entities : undefined })
    text = ''
    entities = []
  }
  const append = (value: string) => { text += value }
  const visit = (element: h) => {
    if (element.type === 'text') {
      append(String(element.attrs.content ?? ''))
      return
    }
    if (element.type === 'at') {
      const id = String(element.attrs.id ?? '')
      const label = `@${String((element.attrs.name ?? id) || 'unknown')}`
      const offset = text.length
      append(label)
      if (id) entities!.push({ type: 'mention', offset, length: label.length, userId: id })
      return
    }
    if (element.type === 'br') {
      append('\n')
      return
    }
    if (element.type === 'img' || element.type === 'image' || element.type === 'audio'
      || element.type === 'video' || element.type === 'file') {
      const url = String(element.attrs.src ?? '')
      if (!url) return
      flush()
      const kind = element.type === 'img' || element.type === 'image' ? 'image' : 'file'
      const mimeType = stringAttr(element.attrs.type)
        ?? (element.type === 'audio' ? 'audio/*' : element.type === 'video' ? 'video/*' : undefined)
      parts.push({
        type: 'media',
        media: {
          ...mediaFromUrl(url, kind, `${messageId}:${mediaIndex++}`),
          name: stringAttr(element.attrs.title) ?? stringAttr(element.attrs.filename),
          mimeType,
          width: numberAttr(element.attrs.width),
          height: numberAttr(element.attrs.height),
          duration: numberAttr(element.attrs.duration),
        },
      })
      return
    }
    for (const child of element.children) visit(child)
    if (element.type === 'p') append('\n')
  }

  for (const element of elements) visit(element)
  flush()
  return parts.length ? parts : [{ type: 'text', text: '' }]
}

export async function toSatoriElements(
  bot: Bot,
  input: IMMessageInput,
  options: IMTransferOptions = {},
): Promise<h[]> {
  const output: h[] = []
  let mediaIndex = 0
  for (const part of input.parts) {
    if (part.type === 'text') {
      output.push(...textElements(part.text, part.entities ?? []))
      continue
    }
    if (part.type === 'sticker') {
      throw new Error('Satori adapters do not expose a portable sticker upload API')
    }
    const bytes = await consume(part.media.source, mediaIndex, options)
    const mimeType = part.media.mimeType ?? (part.media.kind === 'image' ? 'image/png' : 'application/octet-stream')
    const [url] = await bot.createUpload({
      type: mimeType,
      filename: part.media.name,
      data: bytes.slice().buffer as ArrayBuffer,
    })
    if (!url) throw new Error('Satori adapter did not return an upload URL')
    const type = part.media.kind === 'image' ? 'img'
      : mimeType.startsWith('audio/') ? 'audio'
        : mimeType.startsWith('video/') ? 'video' : 'file'
    output.push(h(type, {
      src: url,
      title: part.media.name,
      width: part.media.width,
      height: part.media.height,
      duration: part.media.duration,
    }))
    mediaIndex++
  }
  if (input.replyToId) output.unshift(h('quote', { id: input.replyToId }))
  return output
}

export function mapSatoriMember(member: Universal.GuildMember): IMConversationMember<SatoriMediaLocator> {
  const user = mapSatoriUser(member.user, member)
  const roleNames = member.roles?.map((role) => role.name?.toLowerCase() ?? '') ?? []
  const owner = roleNames.some((role) => role === 'owner')
  const administrator = owner || roleNames.some((role) => role.includes('admin'))
  return {
    user,
    role: owner ? 'owner' : administrator ? 'administrator' : 'member',
    permissions: {
      manageConversation: administrator,
      manageMembers: administrator,
      deleteAnyMessage: administrator,
      editAnyMessage: administrator,
      pinMessages: administrator,
      inviteMembers: true,
    },
    joinedAt: member.joinedAt ? unixSeconds(member.joinedAt) : undefined,
    title: member.title,
  }
}

function textElements(text: string, entities: NonNullable<Extract<IMMessagePart, { type: 'text' }>['entities']>): h[] {
  const mentions = entities.filter((entity) => entity.type === 'mention')
    .slice().sort((left, right) => left.offset - right.offset)
  const output: h[] = []
  let offset = 0
  for (const mention of mentions) {
    if (mention.offset < offset || mention.offset > text.length) continue
    if (mention.offset > offset) output.push(h.text(text.slice(offset, mention.offset)))
    output.push(h.at(mention.userId, { name: text.slice(mention.offset + 1, mention.offset + mention.length) }))
    offset = mention.offset + mention.length
  }
  if (offset < text.length) output.push(h.text(text.slice(offset)))
  return output.length ? output : [h.text(text)]
}

async function consume(
  source: import('@mtproto-relay/bridge').IMMediaSource,
  mediaIndex: number,
  options: IMTransferOptions,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of source.stream({ signal: options.signal })) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('upload aborted')
    const copy = chunk.slice()
    chunks.push(copy)
    size += copy.length
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

function mediaFromUrl(url: string, kind: IMMedia['kind'], seed: string): IMMedia<SatoriMediaLocator> {
  return {
    id: `satori:${createHash('sha256').update(`${seed}\0${url}`).digest('hex').slice(0, 24)}`,
    kind,
    locator: { url },
  }
}

function unixSeconds(value: number): number {
  return Math.trunc(value > 10_000_000_000 ? value / 1000 : value)
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberAttr(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}
