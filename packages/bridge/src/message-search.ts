import type { tl } from '@mtcute/core'
import { withAutoLinkEntities } from './message-entities.js'
import {
  cardUrl, isServiceMessage, messageText,
  type IMConversationKind, type IMMedia, type IMProjectableMessage,
} from './platform.js'

/**
 * 本地消息搜索的写入侧与过滤侧共享的规则。
 *
 * 搜索不建文本索引：`mtproto_im_message.searchText` 保存归一化文本，查询时按会话索引倒序扫描并做
 * 子串匹配，凑够一页即停止；`searchKinds` 是逐条消息的媒体类别位掩码，供共享媒体过滤直接下推到 SQL。
 */
export const SEARCH_KIND = {
  PHOTO: 1,
  VIDEO: 2,
  DOCUMENT: 4,
  URL: 8,
  GIF: 16,
  VOICE: 32,
  MUSIC: 64,
  /** 投影为 MessageService 的系统提示，只在通话记录过滤中出现。 */
  SERVICE: 128,
  /** 群聊中 @ 了自己或回复了自己的消息（Telegram 的「提及」）。 */
  MENTION: 256,
  /** 通话记录系统消息。 */
  PHONE_CALL: 512,
} as const

export interface MessageSearchContext {
  /** 当前账号的平台用户 ID，用于判定提及。 */
  selfUserId?: string
  conversationKind?: IMConversationKind
  /** 回复目标是自己发出的消息。 */
  repliesToSelf?: boolean
}

type SearchMedia = Pick<IMMedia, 'kind' | 'mimeType' | 'voice'>

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

/** 查询切词：归一化后按空白拆分，所有词都需命中（AND）。 */
export function normalizeSearchTerms(query: string): string[] {
  return [...new Set(normalizeSearchText(query).split(/\s+/u).filter(Boolean))]
}

/** 正文、卡片标题与描述、媒体文件名和链接地址，换行连接后归一化。 */
export function messageSearchText(message: IMProjectableMessage<unknown>): string {
  if (isServiceMessage(message)) return ''
  const pieces = [messageText(message)]
  for (const part of message.content.parts) {
    if (part.type === 'media' && part.media.name) pieces.push(part.media.name)
    if (part.type === 'card') {
      pieces.push(part.card.title)
      if (part.card.description) pieces.push(part.card.description)
      if (part.card.url) pieces.push(part.card.url)
    }
    if (part.type === 'text') {
      for (const entity of part.entities ?? []) {
        if (entity.type === 'text-link') pieces.push(entity.url)
      }
    }
  }
  return normalizeSearchText(pieces.filter(Boolean).join('\n'))
}

export function isAnimatedImageMime(mimeType: string | null | undefined): boolean {
  return mimeType === 'image/gif' || mimeType === 'image/apng'
}

/** 单个媒体对应的共享媒体类别，与 Telegram 各 `inputMessagesFilter*` 的含义一致。 */
export function mediaSearchKind(media: SearchMedia | null | undefined): number {
  if (!media) return 0
  const animated = isAnimatedImageMime(media.mimeType)
  if (media.kind === 'image') return animated ? SEARCH_KIND.GIF : SEARCH_KIND.PHOTO
  if (animated) return SEARCH_KIND.GIF
  if (media.voice === true) return SEARCH_KIND.VOICE
  if (media.mimeType?.startsWith('video/')) return SEARCH_KIND.VIDEO
  if (media.mimeType?.startsWith('audio/')) return SEARCH_KIND.MUSIC
  return SEARCH_KIND.DOCUMENT
}

export function messageHasLink(message: IMProjectableMessage<unknown>): boolean {
  return message.content.parts.some((part) => {
    if (part.type === 'card') return Boolean(cardUrl(part.card))
    if (part.type !== 'text') return false
    if (part.entities?.some((entity) =>
      entity.type === 'text-link' || entity.type === 'conversation-link')) return true
    return Boolean(withAutoLinkEntities(part.text)?.some((entity) =>
      entity._ === 'messageEntityUrl' || entity._ === 'messageEntityTextUrl'))
  })
}

export function messageSearchKinds(
  message: IMProjectableMessage<unknown>,
  context: MessageSearchContext = {},
): number {
  if (isServiceMessage(message)) {
    return message.content.serviceAction?.type === 'phone-call'
      ? SEARCH_KIND.SERVICE | SEARCH_KIND.PHONE_CALL
      : SEARCH_KIND.SERVICE
  }
  let kinds = messageHasLink(message) ? SEARCH_KIND.URL : 0
  if (
    context.conversationKind !== undefined && context.conversationKind !== 'direct'
    && !message.outgoing
    && (context.repliesToSelf || (context.selfUserId !== undefined && mentionsUser(message, context.selfUserId)))
  ) kinds |= SEARCH_KIND.MENTION
  for (const part of message.content.parts) {
    if (part.type === 'media') kinds |= mediaSearchKind(part.media)
  }
  return kinds
}

/**
 * Telegram 过滤器到位掩码：`0` 表示不过滤，`null` 表示本地无法提供该类结果（直接返回空）。
 */
export function filterSearchKinds(filter: tl.TypeMessagesFilter): number | null {
  switch (filter._) {
    case 'inputMessagesFilterEmpty': return 0
    case 'inputMessagesFilterPhotos': return SEARCH_KIND.PHOTO
    case 'inputMessagesFilterVideo': return SEARCH_KIND.VIDEO
    case 'inputMessagesFilterPhotoVideo': return SEARCH_KIND.PHOTO | SEARCH_KIND.VIDEO
    case 'inputMessagesFilterDocument': return SEARCH_KIND.DOCUMENT
    case 'inputMessagesFilterUrl': return SEARCH_KIND.URL
    case 'inputMessagesFilterGif': return SEARCH_KIND.GIF
    case 'inputMessagesFilterVoice': return SEARCH_KIND.VOICE
    case 'inputMessagesFilterRoundVoice': return SEARCH_KIND.VOICE
    case 'inputMessagesFilterMusic': return SEARCH_KIND.MUSIC
    case 'inputMessagesFilterMyMentions': return SEARCH_KIND.MENTION
    case 'inputMessagesFilterPhoneCalls': return SEARCH_KIND.PHONE_CALL
    default: return null
  }
}

function mentionsUser(message: IMProjectableMessage<unknown>, userId: string): boolean {
  return message.content.parts.some((part) =>
    part.type === 'text'
    && part.entities?.some((entity) => entity.type === 'mention' && entity.userId === userId))
}

/** 按消息整体判定、只挂在首个分片上的类别。 */
const MESSAGE_LEVEL_KINDS = SEARCH_KIND.URL | SEARCH_KIND.MENTION | SEARCH_KIND.PHONE_CALL

/**
 * 分片级精确过滤：相册等多分片消息只有满足条件的分片才算命中。
 * 媒体类别看分片自己的媒体；链接、提及、通话这类消息级类别只算在首个分片上。
 */
export function partMatchesSearchKinds(
  messageKinds: number,
  part: { ordinal: number, media?: SearchMedia | null },
  kinds: number,
): boolean {
  return partKindsMatchSearchKinds(messageKinds, part.ordinal, mediaSearchKind(part.media), kinds)
}

/**
 * 与 `partMatchesSearchKinds` 等价，但分片类别由调用方预先算好。
 * 共享媒体索引一次扫描要把同一批分片喂给多个过滤器，先把 `mediaSearchKind` 缓存下来可以少算几遍。
 */
export function partKindsMatchSearchKinds(
  messageKinds: number,
  ordinal: number,
  partKind: number,
  kinds: number,
): boolean {
  if (!kinds) return true
  if (kinds & partKind) return true
  return ordinal === 0 && Boolean(kinds & messageKinds & MESSAGE_LEVEL_KINDS)
}

/**
 * 将词转为只含字面量的正则源，用于 `$regex` 子串匹配。
 * 只对非字母数字字符加反斜杠，这在 JS RegExp（SQLite / 内存驱动）与 PostgreSQL ARE 中都表示字面量。
 */
export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/-]/gu, (char) => `\\${char}`)
}
