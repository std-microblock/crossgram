import type { Context } from 'cordis'
import type { CommittedPlatformEvent } from '@mtproto-relay/bridge'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { SatoriExporter, type SatoriExportConfig } from './exporter.js'

export type Config = SatoriExportConfig

export const Config = z.object({
  platformId: z.string().required(),
  platform: z.string(),
  maxMediaBytes: z.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
}).i18n({ 'en-US': enUS, 'zh-CN': zhCN })

export const name = 'satori-exporter'
export const inject = ['imPlatform', 'imSticker']

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('satori-exporter')
  ctx.inject(['satori', 'http'], (scope) => {
    const exporter = new SatoriExporter(scope, config, logger)
    for (const binding of scope.imPlatform.sessions) {
      exporter.start(binding.platform, binding.session)
    }
    scope.imPlatform.onSessionChange((event, binding) => {
      if (event === 'activate') exporter.start(binding.platform, binding.session)
      else exporter.stop(binding.registrationId)
    })
    scope.imPlatform.onCommittedEvent((session, committed) => {
      if (committed.event.type !== 'message') return
      const message = committed as Extract<CommittedPlatformEvent, { event: { type: 'message' } }>
      exporter.handleMessage(session, message.event.conversation, message.event.message, message.result)
    })
    return () => exporter.stop()
  })
}

export * from './exporter.js'
