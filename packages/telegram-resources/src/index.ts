import type { Context } from 'cordis'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TelegramResources } from './store.js'

export {
  TelegramResources,
  createTelegramResources,
} from './store.js'
export type {
  AssetRef,
  StickerKind,
} from './store.js'

export const name = 'telegram-resources'
export const inject = ['telegramResource']

export interface Config {
  /** 包含 index.json 和各资源目录的路径。默认使用包内 assets。 */
  assetsPath?: string
  /** 注册 ID；需要同时挂载多个资源集时用于区分。 */
  providerId?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const assetsBase = config.assetsPath
    ? new URL('./', pathToFileURL(resolve(config.assetsPath, 'index.json')))
    : undefined
  ctx.telegramResource.register(
    new TelegramResources(assetsBase),
    config.providerId ?? 'telegram-official',
  )
}
