import type { Context } from 'cordis'
import type { Request, Response } from '@cordisjs/plugin-server'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import z from 'schemastery'
import { serializeDebugEvent } from './serialize.js'
import {
  appendChunkedEvents, flattenChunks, replaceChunks, resolveChunkSize, trimChunkedEvents, type EventChunks,
} from './chunks.js'
import { CaptureQueryError, parseCaptureQuery, queryCapture } from './capture-api.js'
import {
  DEFAULT_RECORDINGS_API_PATH, DEFAULT_RECORDINGS_PATH, RecordingError, RecordingStore,
  buildRecordingDocument, normalizeRecordingLabel, recordingAttachmentFileName, resolveConfiguredPath,
} from './recordings.js'
import type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export const name = 'mtproto-debug'
export const inject = ['mtproto', 'server', 'webui']

/** 抓包缓冲的下限/上限：页面上的输入框和配置项共用同一对边界。 */
export const MIN_MAX_EVENTS = 100
export const MAX_MAX_EVENTS = 20_000

export interface Config {
  maxEvents?: number
  initiallyPaused?: boolean
  apiPath?: string
  recordingsPath?: string
  recordingsApiPath?: string
  maxRecordings?: number
}

export const Config = z.object({
  maxEvents: z.natural().min(MIN_MAX_EVENTS).max(MAX_MAX_EVENTS).default(2_000),
  initiallyPaused: z.boolean().default(false),
  apiPath: z.string().default('/api/mtproto-debug/events'),
  recordingsPath: z.string().default(DEFAULT_RECORDINGS_PATH),
  recordingsApiPath: z.string().default(DEFAULT_RECORDINGS_API_PATH),
  maxRecordings: z.natural().min(1).max(1_000).default(50),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export function apply(ctx: Context, config: Config = {}): void {
  let maxEvents = config.maxEvents ?? 2_000
  let chunkSize = resolveChunkSize(maxEvents)
  const apiPath = normalizeApiPath(config.apiPath ?? '/api/mtproto-debug/events')
  const recordingsApiPath = normalizeApiPath(config.recordingsApiPath ?? DEFAULT_RECORDINGS_API_PATH)
  const store = new RecordingStore(
    resolveConfiguredPath(ctx.baseUrl, config.recordingsPath ?? DEFAULT_RECORDINGS_PATH),
    config.maxRecordings ?? 50,
  )
  const chunks: EventChunks = {}
  let nextId = 0
  let pending: CapturedMtprotoEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  const data: MtprotoDebugData = {
    capturing: !(config.initiallyPaused ?? false),
    apiPath,
    recordingsApiPath,
    dropped: 0,
    maxEvents,
    revision: 0,
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
        replaceChunks(chunks, [])
        value.dropped = 0
        value.revision += 1
      })
    },
    async setMaxEvents(value: number) {
      const next = normalizeMaxEvents(value)
      // 先把攒在 pending 里的事件冲进缓冲，这样缩小时它们才参与淘汰。
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      flush()
      maxEvents = next
      chunkSize = resolveChunkSize(next)
      entry.mutate((state) => {
        state.maxEvents = next
        state.dropped += trimChunkedEvents(chunks, next)
        state.revision += 1
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
    const dropped = appendChunkedEvents(chunks, batch, maxEvents, chunkSize)
    // Captures stay server-side. Only the revision counter is broadcast; the
    // debug page reacts to it and fetches one summary page over HTTP, so no
    // client ever polls on a timer.
    const nextDropped = data.dropped + dropped
    entry.mutate((value) => {
      value.dropped = nextDropped
      value.revision += 1
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
        events: flattenChunks(chunks),
      }, parseCaptureQuery(req.query)))
    } catch (error) {
      if (!(error instanceof CaptureQueryError)) throw error
      res.status = 400
      res.json({ error: error.message })
    }
  })

  // 录制接口是普通 HTTP 路由而不是 Muon RPC：下载要走附件响应，列表/保存/删除
  // 也能直接被脚本调用，且录制本体永远不会经过 WebSocket。
  ctx.server.get(recordingsApiPath, async (_req, res) => {
    try {
      flush()
      res.headers.set('cache-control', 'no-store')
      res.json({ recordings: await store.list(), directory: store.directory })
    } catch (error) {
      sendRecordingError(res, error)
    }
  })
  ctx.server.post(recordingsApiPath, async (req, res) => {
    try {
      const body = await parseRecordingRequest(req)
      const label = normalizeRecordingLabel(body.label)
      flush()
      const recording = await store.save({
        events: flattenChunks(chunks),
        capturing: data.capturing,
        dropped: data.dropped,
        maxEvents: data.maxEvents,
        label,
      })
      res.status = 201
      res.headers.set('cache-control', 'no-store')
      res.json({ recording })
    } catch (error) {
      sendRecordingError(res, error)
    }
  })
  // 下载当前内存缓冲但不落盘。必须注册在 `/:id` 之前，否则 `current` 会被当成录制 id。
  ctx.server.get(`${recordingsApiPath}/current`, async (req, res) => {
    try {
      const label = normalizeRecordingLabel(req.query.get('label'))
      flush()
      const createdAt = Date.now()
      const document = buildRecordingDocument({
        createdAt,
        label,
        capturing: data.capturing,
        dropped: data.dropped,
        maxEvents: data.maxEvents,
        events: flattenChunks(chunks),
      })
      res.headers.set('content-type', 'application/json; charset=utf-8')
      res.headers.set(
        'content-disposition',
        `attachment; filename="${recordingAttachmentFileName(label, createdAt)}"`,
      )
      res.headers.set('cache-control', 'no-store')
      res.json(document)
    } catch (error) {
      sendRecordingError(res, error)
    }
  })
  ctx.server.get(`${recordingsApiPath}/:id`, async (req, res) => {
    try {
      const { id } = req.params as { id: string }
      const text = await store.readText(id)
      res.headers.set('content-type', 'application/json; charset=utf-8')
      res.headers.set('content-disposition', `attachment; filename="${await store.fileName(id)}"`)
      res.headers.set('cache-control', 'no-store')
      res.text(text)
    } catch (error) {
      sendRecordingError(res, error)
    }
  })
  ctx.server.delete(`${recordingsApiPath}/:id`, async (req, res) => {
    try {
      const { id } = req.params as { id: string }
      await store.remove(id)
      res.headers.set('cache-control', 'no-store')
      res.json({ deleted: id })
    } catch (error) {
      sendRecordingError(res, error)
    }
  })

  const onDebug = (event: MtprotoDebugEvent) => {
    if (!data.capturing) return
    pending.push(serializeDebugEvent(event, ++nextId))
    if (pending.length >= chunkSize) flush()
    scheduleFlush()
  }

  ctx.on('mtproto/debug', onDebug)
  ctx.effect(() => () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    pending = []
  }, 'mtproto-debug.capture')
}

async function parseRecordingRequest(req: Request): Promise<{ label?: unknown }> {
  const text = await req.text()
  if (!text.trim()) return {}
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new RecordingError(400, 'Invalid recording request body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RecordingError(400, 'Invalid recording request body')
  }
  return body as { label?: unknown }
}

function sendRecordingError(res: Response, error: unknown): void {
  if (!(error instanceof RecordingError)) throw error
  res.status = error.status
  res.headers.set('cache-control', 'no-store')
  res.json({ error: error.message })
}

export type { CapturedMtprotoEvent, MtprotoDebugData } from './types.js'
export { serializeDebugEvent, toDebugJson } from './serialize.js'
export {
  appendChunkedEvents, chunkEvents, chunkKeys, countChunkedEvents, flattenChunks,
  MAX_CHUNK_SIZE, replaceChunks, resolveChunkSize, trimChunkedEvents, type EventChunks,
} from './chunks.js'
export {
  CaptureQueryError, parseCaptureQuery, queryCapture,
  type CaptureSource, type MtprotoCaptureFilters, type MtprotoCaptureSnapshot,
} from './capture-api.js'
export {
  buildRecordingDocument, createRecordingId, DEFAULT_RECORDINGS_API_PATH, DEFAULT_RECORDINGS_PATH,
  isRecordingId, MAX_RECORDING_LABEL_LENGTH, MAX_RECORDING_SLUG_LENGTH, normalizeRecordingLabel,
  RECORDING_FORMAT, RECORDING_VERSION, recordingAttachmentFileName, recordingFileName,
  RecordingError, RecordingStore, resolveConfiguredPath, slugifyRecordingLabel,
  type BuildRecordingDocumentInput, type CaptureRecording, type RecordingSummary,
  type SaveRecordingInput,
} from './recordings.js'

/** 页面改缓冲上限时走这里：只接受整数，范围和配置项一致。 */
export function normalizeMaxEvents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Capture buffer size must be a whole number')
  if (value < MIN_MAX_EVENTS || value > MAX_MAX_EVENTS)
    throw new Error(`Capture buffer size must be between ${MIN_MAX_EVENTS} and ${MAX_MAX_EVENTS}`)
  return value
}

function normalizeApiPath(value: string): string {
  const path = value.trim()
  if (!path.startsWith('/')) throw new Error(`MTProto debug apiPath must start with '/': ${value}`)
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}
