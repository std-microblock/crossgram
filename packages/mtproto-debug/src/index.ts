import type { Context } from 'cordis'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import z from 'schemastery'
import { serializeDebugEvent } from './serialize.js'
import { appendChunkedEvents, flattenChunks, replaceChunks, resolveChunkSize } from './chunks.js'
import { CaptureQueryError, parseCaptureQuery, queryCapture } from './capture-api.js'
import type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export const name = 'mtproto-debug'
export const inject = ['mtproto', 'server', 'webui']

export interface Config {
  maxEvents?: number
  initiallyPaused?: boolean
  apiPath?: string
}

export const Config = z.object({
  maxEvents: z.natural().min(100).max(20_000).default(2_000),
  initiallyPaused: z.boolean().default(false),
  apiPath: z.string().default('/api/mtproto-debug/events'),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export function apply(ctx: Context, config: Config = {}): void {
  const maxEvents = config.maxEvents ?? 2_000
  const chunkSize = resolveChunkSize(maxEvents)
  const apiPath = normalizeApiPath(config.apiPath ?? '/api/mtproto-debug/events')
  let nextId = 0
  let pending: CapturedMtprotoEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  const data: MtprotoDebugData = {
    capturing: !(config.initiallyPaused ?? false),
    chunks: {},
    dropped: 0,
    maxEvents,
    async start() {
      entry.mutate(value => { value.capturing = true })
    },
    async pause() {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      flush()
      entry.mutate(value => { value.capturing = false })
    },
    async clear() {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      pending = []
      entry.mutate((value) => {
        replaceChunks(value.chunks, [])
        value.dropped = 0
      })
    },
  }

  const entry = ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/mtproto-debug'],
  }, data)

  const flush = () => {
    if (!pending.length) return
    const batch = pending
    pending = []
    entry.mutate((value) => {
      value.dropped += appendChunkedEvents(value.chunks, batch, maxEvents, chunkSize)
    })
  }
  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush()
    }, 50)
  }

  ctx.server.get(apiPath, async (req, res) => {
    try {
      flush()
      res.headers.set('cache-control', 'no-store')
      res.json(queryCapture({
        capturing: data.capturing,
        dropped: data.dropped,
        maxEvents: data.maxEvents,
        events: flattenChunks(data.chunks),
      }, parseCaptureQuery(req.query)))
    } catch (error) {
      if (!(error instanceof CaptureQueryError)) throw error
      res.status = 400
      res.json({ error: error.message })
    }
  })
  const onDebug = (event: MtprotoDebugEvent) => {
    if (!data.capturing) return
    pending.push(serializeDebugEvent(event, ++nextId))
    scheduleFlush()
  }

  ctx.mtproto.onDebug.add(onDebug)
  ctx.effect(() => () => {
    ctx.mtproto.onDebug.remove(onDebug)
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    pending = []
  }, 'mtproto-debug.capture')
}

export type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'
export { serializeDebugEvent, toDebugJson } from './serialize.js'
export {
  appendChunkedEvents, chunkEvents, chunkKeys, countChunkedEvents, flattenChunks,
  MAX_CHUNK_SIZE, replaceChunks, resolveChunkSize, type EventChunks,
} from './chunks.js'
export {
  CaptureQueryError, parseCaptureQuery, queryCapture,
  type CaptureSource, type MtprotoCaptureFilters, type MtprotoCaptureSnapshot,
} from './capture-api.js'

function normalizeApiPath(value: string): string {
  const path = value.trim()
  if (!path.startsWith('/')) throw new Error(`MTProto debug apiPath must start with '/': ${value}`)
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}
