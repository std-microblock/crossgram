import { performance } from 'node:perf_hooks'
import type { Context } from 'cordis'
import type { MtprotoClientInfo, RpcResult } from '@mtproto-relay/mtproto'
import z from 'schemastery'
import { StatisticsCollector } from './collector.js'
import { RuntimeMonitor } from './runtime.js'
import type { MtprotoStatisticsData, StatisticsPoint, StatisticsSeries } from './types.js'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export const name = 'mtproto-statistics'
export const inject = ['mtproto', 'webui']

export interface Config {
  sampleIntervalMs?: number
  slowThresholdMs?: number
  historySeconds?: number
  topMethods?: number
  topIps?: number
}

export const Config = z.object({
  sampleIntervalMs: z.natural().min(500).max(60_000).default(1_000),
  slowThresholdMs: z.natural().min(1).max(300_000).default(1_000),
  historySeconds: z.natural().min(60).max(3_600).default(900),
  topMethods: z.natural().min(5).max(200).default(40),
  topIps: z.natural().min(5).max(500).default(100),
}).i18n({ 'en-US': enUS, 'zh-CN': zhCN })

export function apply(ctx: Context, config: Config = {}): void {
  const sampleIntervalMs = config.sampleIntervalMs ?? 1_000
  const collector = new StatisticsCollector({
    slowThresholdMs: config.slowThresholdMs ?? 1_000,
    topMethods: config.topMethods ?? 40,
    topIps: config.topIps ?? 100,
    secondRetention: config.historySeconds ?? 900,
  })
  const runtime = new RuntimeMonitor()
  let lastSampleAt = performance.now()

  const data: MtprotoStatisticsData = {
    snapshot: collector.snapshot(),
    series: { seconds: [], minutes: [], hours: [] },
    async reset() {
      collector.reset()
      entry.mutate((value) => {
        value.snapshot = collector.snapshot()
        value.series.seconds.length = 0
        value.series.minutes.length = 0
        value.series.hours.length = 0
      })
    },
  }
  const entry = ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/mtproto-statistics'],
  }, data)

  ctx.on('mtproto/connection', (connection, state) => {
    collector.recordConnection(connection, state)
  })
  ctx.on('mtproto/traffic', (sample) => {
    collector.recordTraffic(sample)
  })
  ctx.on('mtproto/packet', async function (packet, next) {
    const started = performance.now()
    try {
      await next()
    } finally {
      collector.recordPacket(performance.now() - started, packet.data.length)
    }
  }, { prepend: true })
  ctx.on('mtproto/rpc', async function (request, next) {
    const started = performance.now()
    let result: RpcResult | undefined
    let failed = false
    let errorCode: number | undefined
    let errorMessage: string | undefined
    try {
      result = await next()
      failed = isRpcError(result)
      if (failed) {
        errorCode = (result as { errorCode?: number }).errorCode
        errorMessage = (result as { errorMessage?: string }).errorMessage
      }
      return result
    } catch (error) {
      failed = true
      errorCode = 500
      errorMessage = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      collector.recordRpc({
        method: request._,
        durationMs: performance.now() - started,
        connectionId: this.mtprotoConnection.id,
        remoteAddress: this.mtprotoConnection.remoteAddress,
        error: failed,
        errorCode,
        errorMessage,
        requestSummary: summarizeRpcRequest(request as unknown as Record<string, unknown>),
      })
      if (!failed) {
        const route = fileRouteObservation(
          request as unknown as Record<string, unknown>,
          result as unknown as Record<string, unknown> | undefined,
        )
        if (route) {
          collector.recordFileRoute({
            ...route,
            transferOwner: transferOwnerKey(this.authKeyId, this.mtprotoConnection.id),
            device: fileRouteDevice(this.clientInfo ?? this.mtprotoConnection.clientInfo),
          })
        }
      }
    }
  }, { prepend: true })

  const timer = setInterval(() => {
    const now = performance.now()
    const intervalSeconds = (now - lastSampleAt) / 1_000
    lastSampleAt = now
    const snapshot = collector.sample(runtime.sample(), intervalSeconds)
    entry.mutate((value) => {
      value.snapshot = snapshot
      syncSeries(value.series, collector.series)
    })
  }, sampleIntervalMs)
  timer.unref?.()
  ctx.effect(() => () => {
    clearInterval(timer)
    runtime.dispose()
  }, 'mtproto-statistics.sampler')
}

export { StatisticsCollector } from './collector.js'
export { LatencyHistogram } from './histogram.js'
export { RuntimeMonitor } from './runtime.js'
export type * from './types.js'

function isRpcError(result: RpcResult | undefined): boolean {
  return (result as { _?: string } | undefined)?._ === 'mt_rpc_error'
}

function syncSeries(target: StatisticsSeries, source: StatisticsSeries): void {
  syncPoints(target.seconds, source.seconds)
  syncPoints(target.minutes, source.minutes)
  syncPoints(target.hours, source.hours)
}

function syncPoints(target: StatisticsPoint[], source: StatisticsPoint[]): void {
  if (!source.length) {
    target.length = 0
    return
  }
  const lastAt = target.at(-1)?.at ?? 0
  const additions = source.filter(point => point.at > lastAt)
  if (!additions.length) return
  target.push(...additions)
  if (target.length > source.length) target.splice(0, target.length - source.length)
}

function summarizeRpcRequest(request: Record<string, unknown>): string | undefined {
  if (request._ === 'upload.getFile') {
    const location = objectValue(request.location)
    return [
      `location=${stringValue(location?._) ?? 'unknown'}`,
      valuePart('id', location?.id),
      valuePart('thumb', location?.thumbSize),
      valuePart('offset', request.offset),
      valuePart('limit', request.limit),
    ].filter(Boolean).join(', ')
  }
  if (request._ === 'messages.faveSticker') {
    const document = objectValue(request.id)
    return [
      `document=${stringValue(document?._) ?? 'unknown'}`,
      valuePart('id', document?.id),
      `unfave=${Boolean(request.unfave)}`,
    ].filter(Boolean).join(', ')
  }
}

function fileRouteObservation(
  request: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): { route: 'direct' | 'relay', fileKey: string } | undefined {
  const location = objectValue(request.location)
  if (!location) return
  const fileKey = fileLocationKey(location)
  if (request._ === 'crossgram.getFileUrl' && result?._ === 'dataJSON') {
    return { route: 'direct', fileKey }
  }
  if (request._ === 'upload.getFile' && (result?._ === 'upload.file' || result?._ === 'upload.fileCdnRedirect')) {
    return { route: 'relay', fileKey }
  }
}

function fileLocationKey(location: Record<string, unknown>): string {
  return [
    stringValue(location._) ?? 'unknown',
    valueKey(location.id),
    valueKey(location.volumeId),
    valueKey(location.localId),
    valueKey(location.secret),
    valueKey(location.photoId),
    valueKey(location.accessHash),
    valueKey(location.thumbSize),
    valueKey(location.fileReference),
  ].join('|')
}

function fileRouteDevice(client: MtprotoClientInfo | undefined): {
  key: string
  deviceModel: string
  systemVersion: string
  appVersion: string
  langPack: string
  apiId: number
} {
  const device = {
    deviceModel: deviceText(client?.deviceModel, '未知设备'),
    systemVersion: deviceText(client?.systemVersion, '未知系统'),
    appVersion: deviceText(client?.appVersion, '未知版本'),
    langPack: deviceText(client?.langPack, 'unknown'),
    apiId: client?.apiId ?? 0,
  }
  return { ...device, key: Object.values(device).join('\u0000') }
}

function transferOwnerKey(authKeyId: Uint8Array | null, connectionId: string): string {
  if (!authKeyId?.length) return `connection:${connectionId}`
  return `auth:${bytesKey(authKeyId)}`
}

function deviceText(value: string | undefined, fallback: string): string {
  const text = value?.trim()
  return text ? text.slice(0, 128) : fallback
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function valuePart(label: string, value: unknown): string | undefined {
  const text = stringValue(value)
  return text === undefined || text === '' ? undefined : `${label}=${text}`
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof (value as { toString?: unknown }).toString === 'function') return String(value)
}

function valueKey(value: unknown): string {
  if (value instanceof Uint8Array) return bytesKey(value)
  return stringValue(value) ?? ''
}

function bytesKey(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}
