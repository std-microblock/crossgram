import 'cordis'
import type { IMPlatformService } from './platform-manager.js'

declare module 'cordis' {
  interface Context {
    imPlatform: IMPlatformService
  }
}
