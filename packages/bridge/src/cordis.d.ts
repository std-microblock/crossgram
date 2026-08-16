import 'cordis'
import type { IMPlatformService } from './platform-manager.js'
import type { IMStickerService } from './sticker-provider.js'
import type { TelegramResourceService } from './resource-provider.js'
import type { SystemPeerService } from './system-peer.js'

declare module 'cordis' {
  interface Context {
    imPlatform: IMPlatformService
    imSticker: IMStickerService
    telegramResource: TelegramResourceService
    systemPeer: SystemPeerService
  }
}
