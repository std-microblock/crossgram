import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import type {
  IMConversation, IMMedia, IMMessage, IMPlatform, IMProjectableMessage, PlatformSession,
} from './platform.js'

export interface MessageProjectionPartPlan {
  /** Source content part containing the media represented by this Telegram message. */
  mediaPartIndex?: number
}

export interface MessageProjectionPlan {
  parts: MessageProjectionPartPlan[]
  grouped: boolean
}

export interface MessageProjectionPlanInput {
  session: PlatformSession
  target: {
    peer?: tl.TypePeer
    conversation?: IMConversation
    title?: string
  }
  source: IMProjectableMessage
  allocation: 'live' | 'history' | 'bundle'
}

export interface MessageProjectionDraft {
  source: IMProjectableMessage
  media?: tl.TypeMessageMedia
  richMessage?: tl.RawRichMessage
  entities?: tl.TypeMessageEntity[]
  chats: tl.TypeChat[]
}

export interface MessageProjectionInput {
  mode: 'history' | 'update' | 'bundle'
  platform: IMPlatform
  session: PlatformSession
  target: {
    peer: tl.TypePeer
    /** Present only for an ordinary platform conversation. */
    conversation?: IMConversation
    title?: string
  }
  tlMessageId: number
  ordinal: number
  draft: MessageProjectionDraft
}

export interface MessageProjectionResult {
  message: tl.TypeMessage
  chats: tl.TypeChat[]
}

/** Cordis projection waterfall plus a bounded non-durable media registry. */
export class MessageProjectionPipeline {
  private readonly _media = new Map<string, { media: IMMedia, timestamp: number }>()

  constructor(private readonly _ctx: Context) {}

  plan(
    input: MessageProjectionPlanInput,
    fallback: () => MessageProjectionPlan | Promise<MessageProjectionPlan>,
  ): Promise<MessageProjectionPlan> {
    return Promise.resolve(this._ctx.waterfall(
      this._ctx,
      'bridge/message/project-plan',
      input,
      fallback,
    ))
  }

  project(
    input: MessageProjectionInput,
    fallback: () => MessageProjectionResult | Promise<MessageProjectionResult>,
  ): Promise<MessageProjectionResult> {
    return Promise.resolve(this._ctx.waterfall(
      this._ctx,
      'bridge/message/project',
      input,
      fallback,
    ))
  }

  /** Register non-durable media owned by a virtual projection. */
  rememberMedia(
    session: PlatformSession,
    id: number,
    media: IMMedia,
    timestamp: number,
  ): void {
    const key = `${session.platformSessionId}\u0000${id}`
    this._media.delete(key)
    this._media.set(key, { media, timestamp })
    while (this._media.size > 8_192) this._media.delete(this._media.keys().next().value!)
  }

  resolveMedia(
    session: PlatformSession,
    id: number,
  ): { media: IMMedia, timestamp: number } | undefined {
    return this._media.get(`${session.platformSessionId}\u0000${id}`)
  }
}
