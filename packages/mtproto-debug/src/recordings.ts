import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapturedMtprotoEvent } from './types.js'

/** 文件自带格式标记，下载后可以据此判断是否为可导入的抓包录制。 */
export const RECORDING_FORMAT = 'crossgram.mtproto-capture'
export const RECORDING_VERSION = 1
export const DEFAULT_RECORDINGS_PATH = './data/mtproto-debug-recordings'
export const DEFAULT_RECORDINGS_API_PATH = '/api/mtproto-debug/recordings'
export const MAX_RECORDING_LABEL_LENGTH = 120

const RECORDING_ID = /^mtproto-\d{8}-\d{6}-\d{3}-[0-9a-f]{6}$/
const META_SUFFIX = '.meta.json'
const JSON_SUFFIX = '.json'

export interface CaptureRecording {
  format: typeof RECORDING_FORMAT
  version: number
  createdAt: number
  label?: string
  capturing: boolean
  dropped: number
  maxEvents: number
  events: CapturedMtprotoEvent[]
}

/** 列表/接口只暴露元数据，录制本体按需下载，避免把整段抓包塞进 RPC。 */
export interface RecordingSummary {
  id: string
  label?: string
  createdAt: number
  eventCount: number
  dropped: number
  maxEvents: number
  firstTimestamp?: number
  lastTimestamp?: number
  bytes: number
}

/** 带 HTTP 语义的录制错误；路由层直接映射成状态码。 */
export class RecordingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RecordingError'
  }
}

export interface SaveRecordingInput {
  events: readonly CapturedMtprotoEvent[]
  capturing: boolean
  dropped: number
  maxEvents: number
  label?: unknown
}

/** 基于 `ctx.baseUrl` 解析配置里的相对路径；非文件 URL 退回工作目录。 */
export function resolveConfiguredPath(baseUrl: string | undefined, value: string): string {
  if (isAbsolute(value)) return resolve(value)
  if (baseUrl) {
    try {
      return fileURLToPath(new URL(value, baseUrl))
    } catch {
      // 配置可能来自 HTTP 环境的 baseUrl，此时按工作目录解析。
    }
  }
  return resolve(process.cwd(), value)
}

/** 生成 `mtproto-YYYYMMDD-HHMMSS-ms-XXXXXX`；时间使用 UTC，随机后缀避免同毫秒撞名。 */
export function createRecordingId(
  now = Date.now(),
  random: () => string = () => randomBytes(3).toString('hex'),
): string {
  const iso = new Date(now).toISOString()
  const [date, time] = iso.slice(0, 23).split('T')
  const stamp = `${date.replaceAll('-', '')}-${time.slice(0, 8).replaceAll(':', '')}-${time.slice(9)}`
  const id = `mtproto-${stamp}-${random()}`
  if (!RECORDING_ID.test(id)) throw new Error(`Invalid recording id: ${id}`)
  return id
}

export function isRecordingId(value: unknown): value is string {
  return typeof value === 'string' && RECORDING_ID.test(value)
}

export function normalizeRecordingLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RecordingError(400, 'Recording label must be a string')
  const label = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!label) return undefined
  if (label.length > MAX_RECORDING_LABEL_LENGTH) {
    throw new RecordingError(400, `Recording label must be at most ${MAX_RECORDING_LABEL_LENGTH} characters`)
  }
  return label
}

/** 录制文件的读写与元数据维护；所有可变状态都在磁盘上，重启后仍可列出。 */
export class RecordingStore {
  constructor(
    readonly root: string,
    readonly maxRecordings = 50,
  ) {}

  async save(input: SaveRecordingInput, now = Date.now()): Promise<RecordingSummary> {
    if (!input.events.length) throw new RecordingError(409, 'No captured events to save')
    const id = createRecordingId(now)
    const label = normalizeRecordingLabel(input.label)
    const recording: CaptureRecording = {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      createdAt: now,
      ...(label ? { label } : {}),
      capturing: input.capturing,
      dropped: input.dropped,
      maxEvents: input.maxEvents,
      events: [...input.events],
    }
    const text = JSON.stringify(recording)
    const summary: RecordingSummary = {
      id,
      ...(label ? { label } : {}),
      createdAt: now,
      eventCount: input.events.length,
      dropped: input.dropped,
      maxEvents: input.maxEvents,
      firstTimestamp: input.events[0]?.timestamp,
      lastTimestamp: input.events.at(-1)?.timestamp,
      bytes: Buffer.byteLength(text),
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const filename = this.dataPath(id)
    await atomicWrite(filename, text)
    try {
      await atomicWrite(this.metaPath(id), JSON.stringify(summary))
    } catch (error) {
      // 元数据写失败时不留一个列表里看不见的孤儿录制文件。
      await rm(filename, { force: true })
      throw error
    }
    await this.prune()
    return summary
  }

  async list(): Promise<RecordingSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const summaries: RecordingSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith(META_SUFFIX)) continue
      const id = entry.slice(0, -META_SUFFIX.length)
      if (!isRecordingId(id)) continue
      try {
        const value: unknown = JSON.parse(await readFile(join(this.root, entry), 'utf8'))
        if (!isRecordingSummary(value) || value.id !== id) continue
        summaries.push(value)
      } catch {
        // 单个损坏的元数据不应让整个列表不可用；录制本体仍可单独下载。
      }
    }
    return summaries.sort((left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id),
    )
  }

  async readText(id: string): Promise<string> {
    this.assertId(id)
    try {
      return await readFile(this.dataPath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RecordingError(404, `Recording ${id} not found`)
      }
      throw error
    }
  }

  async read(id: string): Promise<CaptureRecording> {
    const text = await this.readText(id)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new RecordingError(500, `Recording ${id} is not valid JSON`)
    }
    if (!isCaptureRecording(value)) {
      throw new RecordingError(500, `Recording ${id} has an unsupported format`)
    }
    return value
  }

  async remove(id: string): Promise<void> {
    this.assertId(id)
    try {
      await stat(this.dataPath(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RecordingError(404, `Recording ${id} not found`)
      }
      throw error
    }
    await rm(this.dataPath(id), { force: true })
    await rm(this.metaPath(id), { force: true })
  }

  private dataPath(id: string): string {
    return join(this.root, id + JSON_SUFFIX)
  }

  private metaPath(id: string): string {
    return join(this.root, id + META_SUFFIX)
  }

  private assertId(id: string): void {
    if (!isRecordingId(id)) throw new RecordingError(400, `Invalid recording id: ${id}`)
  }

  /** 保存后按最旧优先淘汰，保持目录大小有界。 */
  private async prune(): Promise<void> {
    if (this.maxRecordings < 1) return
    const recordings = await this.list()
    for (const item of recordings.slice(this.maxRecordings)) await this.remove(item.id)
  }
}

function isCaptureRecording(value: unknown): value is CaptureRecording {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const recording = value as Partial<CaptureRecording>
  return recording.format === RECORDING_FORMAT
    && recording.version === RECORDING_VERSION
    && typeof recording.createdAt === 'number'
    && typeof recording.capturing === 'boolean'
    && typeof recording.dropped === 'number'
    && typeof recording.maxEvents === 'number'
    && Array.isArray(recording.events)
}

function isRecordingSummary(value: unknown): value is RecordingSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<RecordingSummary>
  return isRecordingId(summary.id)
    && typeof summary.createdAt === 'number'
    && typeof summary.eventCount === 'number'
    && typeof summary.dropped === 'number'
    && typeof summary.maxEvents === 'number'
    && typeof summary.bytes === 'number'
    && (summary.label === undefined || typeof summary.label === 'string')
    && (summary.firstTimestamp === undefined || typeof summary.firstTimestamp === 'number')
    && (summary.lastTimestamp === undefined || typeof summary.lastTimestamp === 'number')
}

async function atomicWrite(filename: string, text: string): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true })
  }
}
