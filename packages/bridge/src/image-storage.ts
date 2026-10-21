import { $, type Database, type Query } from '@cordisjs/plugin-database'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ImageStorageFilter, ImageStorageQuery, ImageStorageResult } from './dashboard-types.js'
import type { ImageStorageRow } from './models.js'
import type { IMConversation, IMMedia, IMMessage, IMPlatform, JsonValue, PlatformSession } from './platform.js'

const TABLE = 'mtproto_image_storage'
const DOWNLOAD_CONCURRENCY = 2
const DOWNLOAD_TIMEOUT_MS = 120_000

/** 文件身份独立于可重建的媒体行；删除后保留墓碑，重复推送不能重新归档。 */
export class ImageStorage {
  readonly enabled: boolean
  private readonly _root: string
  private readonly _sessions = new Map<string, { session: PlatformSession, platform: IMPlatform }>()
  private readonly _downloads = new Map<string, { sessionId: string, abort: AbortController, done: Promise<void> }>()
  // ponytail: 仅串行化元数据与原子提交，下载不持锁；吞吐受限时再改为按账号锁。
  private _tail: Promise<unknown> = Promise.resolve()
  private _pumping = false
  private _pumpAgain = false
  private _closed = false

  constructor(
    private readonly _database: Database,
    config: { enabled?: boolean, path?: string } = {},
    private readonly _onError: (error: unknown) => void = () => {},
  ) {
    this.enabled = config.enabled ?? false
    const path = config.path ?? 'data/bridge-images'
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('图片存储目录无效。')
    this._root = resolve(path)
  }

  async activate(session: PlatformSession, platform: IMPlatform): Promise<void> {
    if (!this.enabled || this._closed) return
    this._sessions.set(session.platformSessionId, { session, platform })
    await this._exclusive(() => this._database.set(TABLE, {
      platformId: session.platformId, platformSessionId: session.platformSessionId, state: 'failed',
    }, { state: 'pending' }))
    this._kick()
  }

  deactivate(session: PlatformSession): void {
    this._sessions.delete(session.platformSessionId)
    for (const job of this._downloads.values()) {
      if (job.sessionId === session.platformSessionId) job.abort.abort('deactivated')
    }
  }

  async enqueue(session: PlatformSession, conversation: IMConversation, message: IMMessage, messageId: number): Promise<void> {
    if (!this.enabled || this._closed) return
    const images = message.content.parts.flatMap(part => part.type === 'media' && part.media.kind === 'image'
      ? [part.media] : [])
    if (!images.length) return
    if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) throw new Error('图片消息时间无效。')
    const date = new Date(message.timestamp * 1000).toISOString().slice(0, 10)
    await this._exclusive(async () => {
      for (const media of images) {
        const [original] = await this._database.get(TABLE, {
          id: this._key(session.platformSessionId, messageId, media.id),
        })
        if (original?.state === 'deleted' || original?.state === 'deleting') continue
        const variants = [{ isPreview: false, item: media }]
        if (media.preview?.locator != null) variants.push({ isPreview: true, item: {
          id: `${media.id}:preview`, kind: 'image', mimeType: media.preview.mimeType,
          size: media.preview.size, width: media.preview.width, height: media.preview.height,
          locator: media.preview.locator,
        } })
        for (const { isPreview, item } of variants) {
          const id = this._key(session.platformSessionId, messageId, media.id, isPreview)
          const [existing] = await this._database.get(TABLE, { id })
          if (existing) continue
          await this._database.create(TABLE, {
            id, platformId: session.platformId, platformSessionId: session.platformSessionId,
            messageId, platformMediaId: media.id, isPreview, conversationId: conversation.id,
            conversationTitle: conversation.title, date, timestamp: message.timestamp,
            media: JSON.parse(JSON.stringify(item)) as JsonValue, state: 'pending', bytes: 0,
          })
        }
      }
    })
    this._kick()
  }

  async read(session: PlatformSession, messageId: number, media: IMMedia, offset: number, limit: number, isPreview = false): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1024 * 1024) {
      throw new Error('图片读取范围无效。')
    }
    const row = await this._ready(session, messageId, media, isPreview)
    if (!row) return
    let file
    try {
      file = await open(this._path(row), 'r')
      const info = await file.stat()
      if (!info.isFile() || info.size !== row.bytes) throw new Error('图片副本不完整。')
      const bytes = new Uint8Array(Math.min(limit, Math.max(0, info.size - offset)))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
      return bytes.subarray(0, bytesRead)
    } catch (error) {
      await this._exclusive(() => this._database.set(TABLE, { id: row.id, state: 'ready' }, {
        state: 'failed', bytes: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : row.bytes,
      }))
      this._onError(error)
      return
    } finally {
      await file?.close()
    }
  }

  async has(session: PlatformSession, messageId: number, media: IMMedia, isPreview = false): Promise<boolean> {
    return (await this.read(session, messageId, media, 0, 1, isPreview)) !== undefined
  }

  async query(input: ImageStorageQuery): Promise<ImageStorageResult> {
    const filter = this._filter(input)
    const page = input.page ?? 1
    const pageSize = input.pageSize ?? 50
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
      || (input.groupBy !== undefined && input.groupBy !== 'date' && input.groupBy !== 'conversation')) {
      throw new Error('图片存储分页或分组参数无效。')
    }
    const field = input.groupBy === 'date' ? 'date' : 'conversationId'
    const aggregate = () => this._database.select(TABLE, filter).groupBy(['platformSessionId', field], row => ({
      conversationTitle: $.max(row.conversationTitle),
      count: $.sum($.if($.and($.gt(row.bytes, 0), $.eq(row.isPreview, false)), 1, 0)), bytes: $.sum(row.bytes),
    }))
    const [totals, totalGroups, rows] = await Promise.all([
      this._database.select(TABLE, filter).groupBy([], row => ({
        count: $.sum($.if($.and($.gt(row.bytes, 0), $.eq(row.isPreview, false)), 1, 0)), bytes: $.sum(row.bytes),
        pendingCount: $.sum($.if($.in(row.state, ['pending', 'failed']), 1, 0)),
      })).execute(),
      aggregate().execute(row => $.sum(1)),
      aggregate().orderBy('platformSessionId').orderBy(field).offset((page - 1) * pageSize).limit(pageSize).execute(),
    ])
    return {
      count: Number(totals[0]?.count ?? 0), bytes: Number(totals[0]?.bytes ?? 0),
      pendingCount: Number(totals[0]?.pendingCount ?? 0), totalGroups: Number(totalGroups ?? 0), page, pageSize,
      groups: rows.map(row => ({
        platformSessionId: row.platformSessionId,
        ...(field === 'date' ? { date: row.date } : { conversationId: row.conversationId, conversationTitle: row.conversationTitle }),
        count: Number(row.count), bytes: Number(row.bytes),
      })),
    }
  }

  async delete(input: ImageStorageFilter): Promise<{ count: number, bytes: number }> {
    const filter = this._filter(input)
    return this._exclusive(async () => {
      let count = 0
      let bytes = 0
      // 逐批删，不把整个归档目录清单读进内存。
      while (true) {
        const rows = await this._database.select(TABLE, filter).orderBy('id').limit(100).execute()
        if (!rows.length) return { count, bytes }
        for (const row of rows) {
          await this._database.set(TABLE, { id: row.id }, { state: 'deleting' })
          this._downloads.get(row.id)?.abort.abort()
          await rm(this._path(row), { force: true })
          await rm(`${this._path(row)}.part`, { force: true })
          await this._database.set(TABLE, { id: row.id }, { state: 'deleted', bytes: 0 })
          if (row.bytes > 0 && !row.isPreview) count++
          bytes += row.bytes
        }
      }
    })
  }

  async close(): Promise<void> {
    this._closed = true
    for (const job of this._downloads.values()) job.abort.abort()
    await Promise.all([...this._downloads.values()].map(job => job.done))
    await this._tail
  }

  private _filter(input: ImageStorageFilter): Query<ImageStorageRow> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('图片存储筛选参数无效。')
    const filter: Query<ImageStorageRow> = { state: { $ne: 'deleted' } }
    for (const field of ['platformSessionId', 'conversationId'] as const) {
      const value = input[field]
      if (value === undefined) continue
      if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('图片存储账号或会话无效。')
      filter[field] = value
    }
    for (const field of ['startDate', 'endDate'] as const) {
      const value = input[field]
      if (value === undefined) continue
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new Error('日期必须是有效的 YYYY-MM-DD（UTC）。')
      }
    }
    if (input.startDate && input.endDate && input.startDate > input.endDate) throw new Error('起始日期不能晚于结束日期。')
    if (input.startDate || input.endDate) filter.date = {
      ...(input.startDate ? { $gte: input.startDate } : {}), ...(input.endDate ? { $lte: input.endDate } : {}),
    }
    return filter
  }

  private _key(sessionId: string, messageId: number, mediaId: string, isPreview = false): string {
    const identity = isPreview ? [sessionId, messageId, mediaId, 'preview'] : [sessionId, messageId, mediaId]
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  }

  private _path(row: ImageStorageRow): string {
    if (!/^[a-f0-9]{64}$/.test(row.id)) throw new Error('图片存储文件标识无效。')
    const account = createHash('sha256').update(row.platformSessionId).digest('hex')
    return resolve(this._root, account, row.id)
  }

  private async _ready(session: PlatformSession, messageId: number, media: IMMedia, isPreview: boolean): Promise<ImageStorageRow | undefined> {
    if (media.kind !== 'image') return
    const [row] = await this._database.get(TABLE, {
      id: this._key(session.platformSessionId, messageId, media.id, isPreview),
      platformSessionId: session.platformSessionId, platformId: session.platformId, state: 'ready',
    })
    return row
  }

  private _exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const next = this._tail.then(callback)
    this._tail = next.catch(() => {})
    return next
  }

  private _kick(): void {
    if (this._closed || !this.enabled) return
    if (this._pumping) {
      this._pumpAgain = true
      return
    }
    this._pumping = true
    void this._pump().catch(this._onError).finally(() => {
      this._pumping = false
      if (this._pumpAgain) {
        this._pumpAgain = false
        this._kick()
      }
    })
  }

  private async _pump(): Promise<void> {
    for (const { session, platform } of this._sessions.values()) {
      const slots = DOWNLOAD_CONCURRENCY - this._downloads.size
      if (slots <= 0 || this._closed) return
      if (!platform.downloadMedia) continue
      const rows = await this._database.select(TABLE, {
        platformId: session.platformId, platformSessionId: session.platformSessionId,
        state: 'pending', id: { $nin: [...this._downloads.keys()] },
      }).orderBy('id').limit(slots).execute()
      for (const row of rows) {
        if (this._closed) return
        const active = this._sessions.get(session.platformSessionId)
        if (active?.session !== session || active.platform !== platform) break
        const abort = new AbortController()
        const done = this._download(row, session, platform, abort).catch(this._onError).finally(() => {
          this._downloads.delete(row.id)
          this._kick()
        })
        this._downloads.set(row.id, { sessionId: session.platformSessionId, abort, done })
      }
    }
  }

  private async _download(row: ImageStorageRow, session: PlatformSession, platform: IMPlatform, abort: AbortController): Promise<void> {
    const path = this._path(row)
    const temp = `${path}.part`
    let renamed = false
    const timer = setTimeout(() => abort.abort(new Error('图片下载超时。')), DOWNLOAD_TIMEOUT_MS)
    timer.unref?.()
    try {
      await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
      await rm(temp, { force: true })
      // 原子改名后、元数据提交前崩溃的文件已经完整，可直接恢复，无需再次回源。
      const recovered = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (recovered?.isFile() && recovered.size > 0 && (!row.bytes || recovered.size === row.bytes)) {
        await this._exclusive(async () => {
          if (!abort.signal.aborted && !this._closed) await this._database.set(TABLE, {
            id: row.id, state: 'pending',
          }, { state: 'ready', bytes: recovered.size })
        })
        return
      }
      await pipeline(
        Readable.from(platform.downloadMedia!(session, row.media as unknown as IMMedia, { signal: abort.signal })),
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: abort.signal },
      )
      const { size } = await stat(temp)
      if (!size) throw new Error('图片下载结果为空。')
      await this._exclusive(async () => {
        const [current] = await this._database.get(TABLE, { id: row.id, state: 'pending' })
        if (!current || abort.signal.aborted || this._closed) return
        await rename(temp, path)
        renamed = true
        await this._database.set(TABLE, { id: row.id, state: 'pending' }, { state: 'ready', bytes: size })
        renamed = false
      })
    } catch (error) {
      if (renamed) await rm(path, { force: true })
      if (!this._closed) {
        await this._exclusive(() => this._database.set(TABLE, { id: row.id, state: 'pending' }, {
          state: abort.signal.reason === 'deactivated' ? 'pending' : 'failed',
        }))
        if (abort.signal.reason !== 'deactivated') this._onError(error)
      }
    } finally {
      clearTimeout(timer)
      await rm(temp, { force: true })
    }
  }
}
