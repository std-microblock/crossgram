import type { Context } from 'cordis'
import z from 'schemastery'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { SatoriPlatform } from './platform.js'

export interface Config {
  /** Satori Bot SID (`platform:selfId`). Optional only when exactly one Bot exists. */
  bot?: string
}

export const Config = z.object({
  bot: z.string(),
}).i18n({ 'en-US': enUS, 'zh-CN': zhCN })

export const name = 'im-platform-satori'
export const inject = ['http', 'imPlatform', 'satori']

export function apply(ctx: Context, config: Config = {}): void {
  const id = resolvePlatformPluginId(ctx, 'satori')
  const platform = new SatoriPlatform(ctx, config.bot)
  let registered = false
  const register = () => {
    if (registered || !platform.bot) return
    ctx.imPlatform.register(platform, id)
    registered = true
  }
  register()
  ctx.on('login-added', register)
  ctx.on('login-updated', register)
}

export * from './convert.js'
export * from './platform.js'
