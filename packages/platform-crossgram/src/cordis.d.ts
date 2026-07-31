import 'cordis'
import type { QQVoiceMedia } from './voice-media.js'

declare module 'cordis' {
  interface Context {
    qqntVoiceMedia: QQVoiceMedia
  }
}
