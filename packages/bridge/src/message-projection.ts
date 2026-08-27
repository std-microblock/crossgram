import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import type {
  IMConversation, IMMessage, PlatformSession,
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
  conversation: IMConversation
  source: IMMessage
  allocation: 'live' | 'history'
}

export interface LinkedConversationProjectionCandidate {
  conversationId: string
  platformMessageId: string
  tlMessageId: number
  timestamp: number
}

export interface MessageProjectionDraft {
  source: IMMessage
  media?: tl.TypeMessageMedia
  richMessage?: tl.RawRichMessage
  entities?: tl.TypeMessageEntity[]
  chats: tl.TypeChat[]
}

export interface MessageProjectionInput {
  mode: 'history' | 'update'
  session: PlatformSession
  conversation: IMConversation
  tlMessageId: number
  ordinal: number
  draft: MessageProjectionDraft
  /** Loads and persists another conversation without choosing a presentation policy. */
  loadConversation?: (
    conversation: IMConversation,
  ) => Promise<LinkedConversationProjectionCandidate[]>
  /** Makes a selected linked target addressable to later peer/message RPCs. */
  bindConversation?: (
    conversation: IMConversation,
    chatId: number,
    target: LinkedConversationProjectionCandidate,
  ) => void
}

export interface MessageProjectionResult {
  message: tl.TypeMessage
  chats: tl.TypeChat[]
}

/** Stateless Cordis waterfall used by storage planning and all TL rendering paths. */
export class MessageProjectionPipeline {
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
}
