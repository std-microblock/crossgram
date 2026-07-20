import 'cordis'
import type { Mtproto } from './service.js'

declare module 'cordis' {
  interface Context {
    mtproto: Mtproto
  }
}
