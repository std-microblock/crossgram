import type { Context } from 'cordis'
import type {} from 'cordis-webui-react'
import type {} from '@mtproto-relay/bridge'
import z from 'schemastery'
import { HistoryBackfillWorker } from './worker.js'
import type { HistoryBackfillData } from './types.js'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export * from './coverage.js'
export * from './worker.js'
export * from './types.js'

export const name = 'history-backfill'
export const inject = ['historySync', 'webui']

export interface Config {
  enabled?: boolean
  idleAfterMs?: number
  intervalMs?: number
  pageSize?: number
  dailyRequestCap?: number
  maxAgeDays?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  idleAfterMs: z.natural().role('ms').min(1_000).default(60_000),
  intervalMs: z.natural().role('ms').min(200).default(3_000),
  pageSize: z.natural().min(1).max(200).default(50),
  dailyRequestCap: z.natural().min(1).default(3_000),
  maxAgeDays: z.natural().default(180),
}).i18n({ 'en-US': enUS, 'zh-CN': zhCN })

const DEFAULTS = {
  enabled: true,
  idleAfterMs: 60_000,
  intervalMs: 3_000,
  pageSize: 50,
  dailyRequestCap: 3_000,
  maxAgeDays: 180,
} as const

/**
 * 空闲回填插件：账号一段时间没有客户端操作时，按 msgSeq 空洞或最早锚点慢慢回读各会话历史，
 * 只写入本地投影库，不向客户端推送 update。全部进度只保存在内存里，在 WebUI 展示并提供开关。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const logger = ctx.logger('history-backfill')
  const worker = new HistoryBackfillWorker(ctx.historySync, {
    enabled: config.enabled ?? DEFAULTS.enabled,
    idleAfterMs: config.idleAfterMs ?? DEFAULTS.idleAfterMs,
    intervalMs: config.intervalMs ?? DEFAULTS.intervalMs,
    pageSize: config.pageSize ?? DEFAULTS.pageSize,
    dailyRequestCap: config.dailyRequestCap ?? DEFAULTS.dailyRequestCap,
    maxAgeDays: config.maxAgeDays ?? DEFAULTS.maxAgeDays,
    log: (level, format, ...args) => logger[level](format, ...args),
  })

  const publish = () => entry.mutate((value) => { value.snapshot = worker.snapshot() })
  const data: HistoryBackfillData = {
    snapshot: worker.snapshot(),
    async setEnabled(enabled) {
      worker.enabled = Boolean(enabled)
      logger.info('history backfill %s from WebUI', worker.enabled ? 'enabled' : 'disabled')
      publish()
      if (worker.enabled) schedule(0)
    },
    async resetConversation(platformSessionId, conversationId) {
      worker.resetConversation(platformSessionId, conversationId)
      publish()
    },
  }
  const entry = ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/history-backfill'],
  }, data)

  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const schedule = (delay: number) => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, delay)
    timer.unref?.()
  }
  const run = async () => {
    timer = undefined
    try {
      await worker.tick()
    } catch (error) {
      logger.warn('history backfill tick failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
    }
    publish()
    schedule(worker.nextDelay())
  }

  ctx.effect(() => {
    schedule(worker.nextDelay())
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, 'history-backfill.loop')
}
