import type {
  IMConversation, IMMedia, IMMessage, IMMessageInput, IMMessageInputPart, IMMessagePart, IMTextEntity, IMUser,
} from '@mtproto-relay/bridge'
import { larkSenderOpenId, larkMessageTimestamp, larkMessageType, type LarkChat, type LarkMediaLocator, type LarkMessage, type LarkMention } from './types.js'

/** 单条发送计划项；text/post 的 content 已是 Lark JSON 字符串，媒体项由调用方上传后组包。 */
export type LarkSendPlanItem =
  | { kind: 'text', content: string }
  | { kind: 'post', content: string }
  | { kind: 'image', media: IMMessageInputPart & { type: 'media' } }
  | { kind: 'audio', media: IMMessageInputPart & { type: 'media' } }
  | { kind: 'file', media: IMMessageInputPart & { type: 'media' } }

export function parseLarkMessage(message: LarkMessage): {
  parts: IMMessagePart<LarkMediaLocator>[]
  replyToId?: string
} {
  let body: unknown
  try {
    body = JSON.parse(message.content || '{}')
  } catch {
    body = {}
  }
  const record = body as Record<string, unknown>
  const parts: IMMessagePart<LarkMediaLocator>[] = []
  const messageId = message.message_id
  switch (larkMessageType(message)) {
    case 'text': {
      const text = typeof record.text === 'string' ? record.text : ''
      if (text) parts.push(...mentionTextParts(text, message.mentions ?? []))
      break
    }
    case 'post':
    case 'architecture': {
      parts.push(...postParts(record, messageId))
      break
    }
    case 'image': {
      const imageKey = requiredString(record.image_key)
      if (imageKey) parts.push(imagePart(imageKey, messageId))
      break
    }
    case 'sticker': {
      const stickerKey = requiredString(record.sticker_key)
      if (stickerKey) parts.push(imagePart(stickerKey, messageId))
      break
    }
    case 'file': {
      const fileKey = requiredString(record.file_key)
      if (fileKey) {
        parts.push({
          type: 'media',
          media: fileMedia(fileKey, messageId, typeof record.file_name === 'string' ? record.file_name : undefined),
        })
      }
      break
    }
    case 'audio': {
      const fileKey = requiredString(record.file_key)
      if (fileKey) {
        const media = fileMedia(fileKey, messageId, 'voice.ogg')
        media.voice = true
        if (typeof record.duration === 'number') media.duration = Math.round(record.duration / 1000)
        parts.push({ type: 'media', media })
      }
      break
    }
    case 'media': {
      const fileKey = requiredString(record.file_key)
      if (fileKey) {
        const media = fileMedia(
          fileKey,
          messageId,
          typeof record.file_name === 'string' ? record.file_name : 'video.mp4',
        )
        if (typeof record.duration === 'number') media.duration = Math.round(record.duration / 1000)
        parts.push({ type: 'media', media })
      }
      break
    }
    default:
      parts.push({ type: 'text', text: `[飞书消息:${larkMessageType(message)}]` })
  }
  if (!parts.length) parts.push({ type: 'text', text: `[飞书消息:${larkMessageType(message)}]` })
  const parent = message.parent_id || message.root_id
  return { parts, replyToId: parent || undefined }
}

function mentionTextParts(text: string, mentions: LarkMention[]): IMMessagePart<LarkMediaLocator>[] {
  if (!mentions.length) return [{ type: 'text', text }]
  let replaced = ''
  let consumed = 0
  const entities: IMTextEntity[] = []
  const pattern = /@_user_\d+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const mention = mentions.find((item) => item.key === match![0])
    if (!mention) continue
    const label = `@${mention.name ?? '成员'}`
    const offset = replaced.length + (match.index - consumed)
    replaced += text.slice(consumed, match.index) + label
    consumed = match.index + match[0].length
    const openId = mention.id?.open_id
    if (openId) entities.push({ type: 'mention', offset, length: label.length, userId: openId })
  }
  replaced += text.slice(consumed)
  return [{ type: 'text', text: replaced, ...(entities.length ? { entities } : {}) }]
}

function postParts(post: Record<string, unknown>, messageId: string): IMMessagePart<LarkMediaLocator>[] {
  const parts: IMMessagePart<LarkMediaLocator>[] = []
  const paragraphs = Array.isArray(post.content) ? post.content as unknown[][] : []
  let text = typeof post.title === 'string' && post.title ? `${post.title}\n` : ''
  let entities: IMTextEntity[] = []
  const flushText = () => {
    if (text) parts.push({ type: 'text', text, ...(entities.length ? { entities } : {}) })
    text = ''
    entities = []
  }
  for (const paragraph of paragraphs) {
    for (const raw of paragraph ?? []) {
      const node = raw as Record<string, unknown>
      switch (node.tag) {
        case 'text': {
          if (typeof node.text === 'string' && node.text) {
            const base = text.length
            text += node.text
            entities.push(...nodeStyleEntities(node, base))
          }
          break
        }
        case 'a': {
          if (typeof node.text === 'string' && node.text) {
            entities.push({ type: 'text-link', offset: text.length, length: node.text.length, url: String(node.href ?? '') })
            text += node.text
          }
          break
        }
        case 'at': {
          const label = `@${typeof node.user_name === 'string' && node.user_name ? node.user_name : '成员'}`
          if (typeof node.user_id === 'string' && node.user_id) {
            entities.push({ type: 'mention', offset: text.length, length: label.length, userId: node.user_id })
          }
          text += label
          break
        }
        case 'img': {
          flushText()
          const imageKey = requiredString(node.image_key)
          if (imageKey) parts.push(imagePart(imageKey, messageId))
          break
        }
        case 'media': {
          flushText()
          const fileKey = requiredString(node.file_key)
          if (fileKey) parts.push({
            type: 'media',
            media: fileMedia(fileKey, messageId, typeof node.file_name === 'string' ? node.file_name : 'video.mp4'),
          })
          break
        }
        case 'emotion':
          text += '[表情]'
          break
        default:
          break
      }
    }
    text += '\n'
  }
  flushText()
  return parts
}

/** post text 节点的 style 区间（如 {"bold":[0,2]}）转 IMTextEntity。 */
function nodeStyleEntities(node: Record<string, unknown>, base: number): IMTextEntity[] {
  const style = node.style
  if (!style || typeof style !== 'object') return []
  const entities: IMTextEntity[] = []
  const types: Array<[string, IMTextEntity['type']]> = [
    ['bold', 'bold'],
    ['italic', 'italic'],
    ['underline', 'underline'],
    ['strikethrough', 'strikethrough'],
  ]
  for (const [key, type] of types) {
    const range = (style as Record<string, unknown>)[key]
    if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') continue
    entities.push({ type: type as 'bold', offset: base + range[0], length: Math.max(0, range[1] - range[0]) })
  }
  return entities
}

function imagePart(fileKey: string, messageId: string): IMMessagePart<LarkMediaLocator> {
  return { type: 'media', media: imageMedia(fileKey, messageId) }
}

export function imageMedia(fileKey: string, messageId: string): IMMedia<LarkMediaLocator> {
  return { id: fileKey, kind: 'image', locator: { messageId, fileKey, type: 'image' } }
}

function fileMedia(fileKey: string, messageId: string, name?: string): IMMedia<LarkMediaLocator> {
  return {
    id: fileKey,
    kind: 'file',
    ...(name ? { name } : {}),
    locator: { messageId, fileKey, type: 'file' },
  }
}

export function buildSendPlan(input: IMMessageInput): LarkSendPlanItem[] {
  const plan: LarkSendPlanItem[] = []
  let pendingText = ''
  let pendingPostParagraphs: unknown[][] = []
  let pendingHasStyle = false
  const flush = () => {
    if (pendingHasStyle) {
      plan.push({ kind: 'post', content: JSON.stringify({ content: pendingPostParagraphs }) })
    } else if (pendingText) {
      plan.push({ kind: 'text', content: JSON.stringify({ text: pendingText }) })
    }
    pendingText = ''
    pendingPostParagraphs = []
    pendingHasStyle = false
  }
  for (const part of input.parts) {
    if (part.type === 'text') {
      const styled = (part.entities ?? []).some((entity) => entity.type !== 'mention')
      if (styled) {
        // 带样式实体（粗体/链接等）走 post 富文本；mention 之外的纯文本仍走 text 消息
        if (pendingText) pendingPostParagraphs.push([{ tag: 'text', text: pendingText }])
        pendingText = ''
        pendingHasStyle = true
        pendingPostParagraphs.push(postNodes(part.text, part.entities ?? []))
      } else {
        if (pendingText) pendingText += '\n'
        pendingText += renderEntities(part.text, part.entities ?? [])
      }
    } else if (part.type === 'media') {
      flush()
      if (part.media.kind === 'image') plan.push({ kind: 'image', media: part })
      else if (part.media.voice) plan.push({ kind: 'audio', media: part })
      else plan.push({ kind: 'file', media: part })
    } else {
      throw new Error('Lark native stickers are not supported')
    }
  }
  flush()
  return plan
}

/** 把文本+实体切成飞书 post 节点序列（样式节点、链接、@）。 */
function postNodes(text: string, entities: IMTextEntity[]): unknown[] {
  const sorted = [...entities].sort((left, right) => left.offset - right.offset)
  const nodes: unknown[] = []
  let consumed = 0
  const pushPlain = (piece: string) => {
    if (!piece) return
    const last = nodes[nodes.length - 1] as { tag: string, text?: string } | undefined
    if (last?.tag === 'text' && !('style' in last)) last.text += piece
    else nodes.push({ tag: 'text', text: piece })
  }
  for (const entity of sorted) {
    if (entity.type === 'mention') continue
    const start = Math.max(consumed, entity.offset)
    const end = Math.min(text.length, entity.offset + entity.length)
    if (start >= end) continue
    pushPlain(text.slice(consumed, start))
    const piece = text.slice(start, end)
    if (entity.type === 'text-link') {
      nodes.push({ tag: 'a', text: piece, href: entity.url })
    } else {
      nodes.push({ tag: 'text', text: piece, style: { [entity.type]: [0, piece.length] } })
    }
    consumed = end
  }
  pushPlain(text.slice(consumed))
  return nodes
}

/** 把 mention 实体渲染为 Lark 文本语法 <at user_id="..."/>，其余实体原样保留文本。 */
function renderEntities(text: string, entities: IMTextEntity[]): string {
  if (!entities.length) return text
  const sorted = [...entities].sort((left, right) => left.offset - right.offset)
  let out = ''
  let consumed = 0
  for (const entity of sorted) {
    const start = Math.max(consumed, entity.offset)
    const end = Math.min(text.length, entity.offset + entity.length)
    if (start >= end) continue
    out += text.slice(consumed, start)
    if (entity.type === 'mention') {
      out += `<at user_id="${entity.userId}"></at>`
    } else {
      out += text.slice(start, end)
    }
    consumed = end
  }
  return out + text.slice(consumed)
}

export function toConversation(
  chat: LarkChat | null,
  chatId: string,
  fallback: { kind: 'direct' | 'group', title?: string },
): IMConversation<LarkMediaLocator> {
  if (!chat) {
    return {
      id: chatId,
      kind: fallback.kind,
      title: fallback.title?.trim() || chatId,
      ...(fallback.kind === 'group' ? { selfRole: 'member' } : {}),
    }
  }
  const kind = chat.chat_type === 'p2p' || fallback.kind === 'direct' ? 'direct' : 'group'
  return {
    id: chatId,
    kind,
    title: chat.name?.trim() || fallback.title?.trim() || chatId,
    ...(kind === 'group'
      ? {
        selfRole: 'member' as const,
        metadata: { memberCount: chat.member_count, external: chat.external },
      }
      : {}),
    ...(chat.avatar ? { avatar: avatarMedia(chat.avatar, chatId) } : {}),
  }
}

/** 群头像：CDN 签名 URL，走 downloadMedia 的 url 分支。 */
export function avatarMedia(url: string, id: string): IMMedia<LarkMediaLocator> {
  return { id, kind: 'image', mimeType: 'image/jpeg', locator: { url } }
}

export function toSenderUser(message: LarkMessage, fallbackName?: string): IMUser<LarkMediaLocator> | undefined {
  const openId = larkSenderOpenId(message.sender)
  if (!openId) return undefined
  return { id: openId, firstName: fallbackName ?? openId }
}

/** 事件与轮询共用的消息投影；deleted/空内容返回 null。 */
export function toIncomingMessage(message: LarkMessage, selfId: string): IMMessage<LarkMediaLocator> | null {
  if (message.deleted) return null
  const senderOpenId = larkSenderOpenId(message.sender)
  const { parts, replyToId } = parseLarkMessage(message)
  if (!parts.length) return null
  return {
    id: message.message_id,
    conversationId: message.chat_id,
    senderId: senderOpenId ?? 'unknown',
    content: { parts },
    timestamp: larkMessageTimestamp(message),
    outgoing: senderOpenId === selfId,
    ...(replyToId ? { replyToId } : {}),
  }
}

export function messageTimestamp(message: LarkMessage): number {
  return larkMessageTimestamp(message)
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
