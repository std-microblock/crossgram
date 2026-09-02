import type { tl } from '@mtcute/core'
import {
  makeTlCardPreview,
  makeTlTransientMessageMedia,
  projectTlMessage,
} from './dialogs.js'
import { cardUrl, messagePartText, type IMPlatform, type IMProjectableMessage, type IMTextEntity, type PlatformSession } from './platform.js'
import type { MessageProjectionDraft, MessageProjectionPipeline, MessageProjectionPlan } from './message-projection.js'
import type { StickerRpc } from './sticker-rpc.js'
import { isLegacyRecallStrikethrough } from './recalled-message.js'

export interface DetachedMessageProjectionInput {
  pipeline: MessageProjectionPipeline
  platform: IMPlatform
  session: PlatformSession
  stickers?: Pick<StickerRpc, 'makeMessageMedia'>
  source: IMProjectableMessage
  target: { peer: tl.TypePeer, title?: string }
  messageId(ordinal: number): number
  mediaId(partIndex: number): number
  userId(platformUserId: string): number
  replyToMessageId?: number
  groupedId?: string
}

export interface DetachedMessageProjectionResult {
  messages: tl.TypeMessage[]
  chats: tl.TypeChat[]
}

/**
 * Shared non-durable message -> Telegram projection used by finite virtual
 * content features. Every rendered part still traverses the Cordis plan and
 * project waterfalls; no conversation or MessageStore row is manufactured.
 */
export async function projectDetachedMessage(
  input: DetachedMessageProjectionInput,
): Promise<DetachedMessageProjectionResult> {
  const plan = await input.pipeline.plan({
    session: input.session,
    target: input.target,
    source: input.source,
    allocation: 'bundle',
  }, () => defaultDetachedPlan(input.source))
  if (!plan.parts.length) throw new Error('detached message projection plan must contain at least one part')

  const messages: tl.TypeMessage[] = []
  const chats: tl.TypeChat[] = []
  for (const [ordinal, partPlan] of plan.parts.entries()) {
    const tlMessageId = input.messageId(ordinal)
    const draft: MessageProjectionDraft = { source: input.source, chats: [] }
    const fallback = () => {
      const source = draft.source
      const sticker = source.content.parts.find((part) => part.type === 'sticker')
      const card = source.content.parts.find((part) => part.type === 'card')
      const mediaPart = partPlan.mediaPartIndex === undefined
        ? undefined
        : source.content.parts[partPlan.mediaPartIndex]
      let media = draft.media
      if (!media && mediaPart?.type === 'media') {
        const id = input.mediaId(partPlan.mediaPartIndex!)
        input.pipeline.rememberMedia(input.session, id, mediaPart.media, source.timestamp)
        media = makeTlTransientMessageMedia(mediaPart.media, id, source.timestamp)
      } else if (!media && sticker?.type === 'sticker') {
        media = input.stickers?.makeMessageMedia(sticker.sticker)
      } else if (!media && card?.type === 'card') {
        media = makeTlCardPreview(card.card)
      }
      return {
        message: projectTlMessage({
          source,
          tlId: tlMessageId,
          ordinal,
          fromId: { _: 'peerUser', userId: input.userId(source.senderId) },
          peerId: input.target.peer,
          groupedId: plan.grouped ? input.groupedId : undefined,
          media,
          entities: draft.entities ?? (ordinal === 0
            ? makeDetachedMessageEntities(source, input.userId)
            : undefined),
          replyToTlId: ordinal === 0 ? input.replyToMessageId : undefined,
          recalled: source.recalled,
          recalledVisible: source.recalled,
        }),
        chats: draft.chats,
      }
    }
    const rendered = await input.pipeline.project({
      mode: 'bundle',
      platform: input.platform,
      session: input.session,
      target: input.target,
      tlMessageId,
      ordinal,
      draft,
    }, fallback)
    messages.push(rendered.message)
    chats.push(...rendered.chats)
  }
  return { messages, chats }
}

export function defaultDetachedPlan(source: IMProjectableMessage): MessageProjectionPlan {
  const media = source.content.parts.flatMap((part, index) => part.type === 'media'
    ? [{ index, kind: part.media.kind }]
    : [])
  return {
    parts: media.length ? media.map((item) => ({ mediaPartIndex: item.index })) : [{}],
    grouped: media.length > 1 && new Set(media.map((item) => item.kind)).size === 1,
  }
}

function makeDetachedMessageEntities(
  source: IMProjectableMessage,
  userId: (platformUserId: string) => number,
): tl.TypeMessageEntity[] | undefined {
  const output: tl.TypeMessageEntity[] = []
  const rendered = source.content.parts.flatMap((part) => {
    const text = messagePartText(part)
    return text ? [{ part, text }] : []
  })
  let base = 0
  for (const [index, { part, text }] of rendered.entries()) {
    for (const entity of part.type === 'text' ? part.entities ?? [] : []) {
      if (part.type === 'text' && isLegacyRecallStrikethrough(source, part, entity)) continue
      const mapped = mapEntity(entity, base, text, userId)
      if (mapped) output.push(mapped)
    }
    if (part.type === 'card') {
      const url = cardUrl(part.card)
      if (url) output.push({ _: 'messageEntityTextUrl', offset: base, length: text.length, url })
    }
    base += text.length + (index + 1 < rendered.length ? 1 : 0)
  }
  return output.length ? output : undefined
}

function mapEntity(
  entity: IMTextEntity,
  base: number,
  text: string,
  userId: (platformUserId: string) => number,
): tl.TypeMessageEntity | undefined {
  if (entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > text.length) return
  const offset = base + entity.offset
  if (entity.type === 'mention') return {
    _: 'messageEntityMentionName', offset, length: entity.length, userId: userId(entity.userId),
  }
  if (entity.type === 'text-link') return {
    _: 'messageEntityTextUrl', offset, length: entity.length, url: entity.url,
  }
  if (entity.type === 'bold') return { _: 'messageEntityBold', offset, length: entity.length }
  if (entity.type === 'italic') return { _: 'messageEntityItalic', offset, length: entity.length }
  if (entity.type === 'underline') return { _: 'messageEntityUnderline', offset, length: entity.length }
  if (entity.type === 'strikethrough') return { _: 'messageEntityStrike', offset, length: entity.length }
  if (entity.type === 'code') return { _: 'messageEntityCode', offset, length: entity.length }
  if (entity.type === 'pre') return {
    _: 'messageEntityPre', offset, length: entity.length, language: entity.language ?? '',
  }
  if (entity.type === 'blockquote') return { _: 'messageEntityBlockquote', offset, length: entity.length }
}
