import 'cordis'
import type { IMPlatformService } from './platform-manager.js'
import type { IMStickerService } from './sticker-provider.js'

declare module 'cordis' {
  interface Context {
    imPlatform: IMPlatformService
    imSticker: IMStickerService
  }
}
