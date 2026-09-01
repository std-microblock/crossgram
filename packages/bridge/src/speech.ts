import { Service, type Context } from 'cordis'
import type {
  IMConversation, IMMedia, IMMediaInput, IMMessage, IMPlatform, PlatformSession,
} from './platform.js'

/** Input passed to speech-to-text providers through the Cordis waterfall. */
export interface SpeechTranscriptionInput<TMediaLocator = unknown> {
  platform: IMPlatform<TMediaLocator>
  session: PlatformSession
  conversation?: IMConversation<TMediaLocator>
  /** Source message when transcription was requested for an existing voice note. */
  message?: IMMessage<TMediaLocator>
  media: IMMedia<TMediaLocator>
  /** Optional BCP-47 language hint (for example `zh-CN` or `en-US`). */
  language?: string
  /** True when this request was generated automatically for an incoming message. */
  automatic?: boolean
  signal?: AbortSignal
}

/** Provider result. Returning `undefined` from the waterfall means unsupported. */
export interface SpeechTranscriptionResult {
  text: string
  language?: string
  confidence?: number
  /** Provider identifier, useful for diagnostics and Telegram feedback. */
  provider?: string
}

/** Input passed to text-to-speech providers through the Cordis waterfall. */
export interface SpeechSynthesisInput<TMediaLocator = unknown> {
  platform: IMPlatform<TMediaLocator>
  session: PlatformSession
  conversation?: IMConversation<TMediaLocator>
  text: string
  language?: string
  /** Voice name/model requested by the caller, if any. */
  voice?: string
  signal?: AbortSignal
}

/** Provider result containing a platform-ready voice media input. */
export interface SpeechSynthesisResult {
  media: IMMediaInput
  provider?: string
}

/**
 * Cordis speech provider waterfalls. Plugins may implement either operation
 * independently (for example QQNT native STT and a remote TTS plugin).
 */
export class SpeechPipeline extends Service {
  constructor(ctx: Context) {
    super(ctx, 'speech')
  }

  transcribe<TMediaLocator = unknown>(
    input: SpeechTranscriptionInput<TMediaLocator>,
    fallback: () => SpeechTranscriptionResult | undefined | Promise<SpeechTranscriptionResult | undefined> = () => undefined,
  ): Promise<SpeechTranscriptionResult | undefined> {
    return Promise.resolve(this.ctx.waterfall(
      this.ctx,
      'bridge/speech/transcribe',
      input,
      fallback,
    ))
  }

  synthesize<TMediaLocator = unknown>(
    input: SpeechSynthesisInput<TMediaLocator>,
    fallback: () => SpeechSynthesisResult | undefined | Promise<SpeechSynthesisResult | undefined> = () => undefined,
  ): Promise<SpeechSynthesisResult | undefined> {
    return Promise.resolve(this.ctx.waterfall(
      this.ctx,
      'bridge/speech/synthesize',
      input,
      fallback,
    ))
  }
}
