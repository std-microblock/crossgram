import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  IMMediaInput, IMMediaSource, IMMediaUploadHashes, IMMediaUploadPreparation, IMMediaUploadSink,
} from './platform.js'

const FILE_10M_BYTES = 10 * 1024 * 1024
const MAX_PREPARED_OUT_OF_ORDER_PARTS = 32
const MAX_PREPARED_OUT_OF_ORDER_BYTES = 16 * 1024 * 1024

export interface UploadedFile {
  platformSessionId: string
  fileId: string
  source: IMMediaSource
  native?: boolean
  cleanup(): Promise<void>
}

export interface StagedMedia {
  media: IMMediaInput
  upload: UploadedFile
  timestamp: number
}

interface PreparedUpload {
  platformSessionId: string
  fileId: string
  media: IMMediaInput
  sink: IMMediaUploadSink
  hashes: IMMediaUploadHashes
  parts: Map<number, Buffer>
  bufferedBytes: number
  nextPart: number
  receivedBytes: number
  md5: ReturnType<typeof createHash>
  sha1: ReturnType<typeof createHash>
  file10MMd5: ReturnType<typeof createHash>
  file10MBytes: number
  tail: Promise<void>
  failed?: unknown
}

/** Telegram uploads: prepared native sinks stay in memory; legacy clients use disk-backed parts. */
export class UploadManager {
  private readonly _staged = new Map<string, StagedMedia>()
  private readonly _prepared = new Map<string, PreparedUpload>()

  constructor(private readonly _root: string) {}

  async savePart(
    platformSessionId: string,
    fileId: string,
    part: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!Number.isSafeInteger(part) || part < 0) throw new RangeError('file part must be a non-negative integer')
    const key = this._stageKey(platformSessionId, fileId)
    const prepared = this._prepared.get(key)
    if (prepared) return this._savePreparedPart(prepared, part, bytes)
    if (this._staged.get(key)?.upload.native) return
    const directory = this._directory(platformSessionId, fileId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, partName(part)), bytes)
  }

  async open(platformSessionId: string, fileId: string, parts: number): Promise<UploadedFile> {
    if (!Number.isSafeInteger(parts) || parts <= 0) throw new RangeError('file parts must be a positive integer')
    const directory = this._directory(platformSessionId, fileId)
    const entries = await readdir(directory).catch(() => [])
    const expected = Array.from({ length: parts }, (_, part) => partName(part))
    const available = new Set(entries)
    const missing = expected.find((name) => !available.has(name))
    if (missing) throw new Error(`uploaded file part is missing: ${Number(missing)}`)
    const sizes = await Promise.all(expected.map((name) => stat(join(directory, name)).then((item) => item.size)))
    const size = sizes.reduce((sum, value) => sum + value, 0)
    return {
      platformSessionId,
      fileId,
      source: {
        size,
        async *stream(options = {}) {
          for (const name of expected) {
            if (options.signal?.aborted) throw options.signal.reason ?? new Error('upload aborted')
            for await (const chunk of createReadStream(join(directory, name), { signal: options.signal })) {
              yield chunk
            }
          }
        },
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  }

  async remove(platformSessionId: string, fileId: string): Promise<void> {
    const key = this._stageKey(platformSessionId, fileId)
    this._staged.delete(key)
    const prepared = this._prepared.get(key)
    if (prepared) {
      this._prepared.delete(key)
      await prepared.sink.abort(new Error('upload removed'))
    }
    await rm(this._directory(platformSessionId, fileId), { recursive: true, force: true })
  }

  stage(staged: StagedMedia): void {
    this._staged.set(this._stageKey(staged.upload.platformSessionId, staged.upload.fileId), staged)
  }

  stagePrepared(platformSessionId: string, fileId: string, media: IMMediaInput): StagedMedia {
    const upload: UploadedFile = {
      platformSessionId,
      fileId,
      source: media.source,
      native: true,
      cleanup: async () => {},
    }
    const staged = { media, upload, timestamp: Date.now() }
    this.stage(staged)
    return staged
  }

  async prepare(
    platformSessionId: string,
    fileId: string,
    hashes: IMMediaUploadHashes,
    preparation: IMMediaUploadPreparation,
  ): Promise<'ready' | 'stream'> {
    const key = this._stageKey(platformSessionId, fileId)
    const previous = this._prepared.get(key)
    if (previous) await previous.sink.abort(new Error('upload preparation replaced'))
    this._prepared.delete(key)
    this._staged.delete(key)
    await rm(this._directory(platformSessionId, fileId), { recursive: true, force: true })
    if (!preparation.sink) {
      this.stagePrepared(platformSessionId, fileId, preparation.media)
      return 'ready'
    }
    if (preparation.media.source.size !== undefined && preparation.media.source.size !== hashes.size) {
      await preparation.sink.abort(new Error('prepared upload source size mismatch'))
      throw new Error('prepared upload source size mismatch')
    }
    const prepared: PreparedUpload = {
      platformSessionId,
      fileId,
      media: preparation.media,
      sink: preparation.sink,
      hashes,
      parts: new Map(),
      bufferedBytes: 0,
      nextPart: 0,
      receivedBytes: 0,
      md5: createHash('md5'),
      sha1: createHash('sha1'),
      file10MMd5: createHash('md5'),
      file10MBytes: 0,
      tail: Promise.resolve(),
    }
    this._prepared.set(key, prepared)
    return 'stream'
  }

  getStaged(platformSessionId: string, fileId: string): StagedMedia | undefined {
    return this._staged.get(this._stageKey(platformSessionId, fileId))
  }

  async complete(upload: UploadedFile): Promise<void> {
    const key = this._stageKey(upload.platformSessionId, upload.fileId)
    if (this._staged.get(key)?.upload === upload) this._staged.delete(key)
    await upload.cleanup()
  }

  private async _savePreparedPart(prepared: PreparedUpload, part: number, bytes: Uint8Array): Promise<void> {
    const run = prepared.tail.then(async () => {
      if (prepared.failed) throw prepared.failed
      if (part < prepared.nextPart) return
      const value = Buffer.from(bytes)
      const duplicate = prepared.parts.get(part)
      if (duplicate) {
        if (!duplicate.equals(value)) throw new Error(`uploaded file part changed during retry: ${part}`)
        return
      }
      if (
        part !== prepared.nextPart
        && (prepared.parts.size >= MAX_PREPARED_OUT_OF_ORDER_PARTS
          || prepared.bufferedBytes + value.length > MAX_PREPARED_OUT_OF_ORDER_BYTES)
      ) {
        throw new Error('prepared upload out-of-order window exceeded')
      }
      prepared.parts.set(part, value)
      prepared.bufferedBytes += value.length
      await this._drainPrepared(prepared)
    })
    prepared.tail = run.catch(async (error) => {
      if (!prepared.failed) {
        prepared.failed = error
        const key = this._stageKey(prepared.platformSessionId, prepared.fileId)
        if (this._prepared.get(key) === prepared) this._prepared.delete(key)
        await prepared.sink.abort(error)
      }
      throw error
    })
    return prepared.tail
  }

  private async _drainPrepared(prepared: PreparedUpload): Promise<void> {
    while (true) {
      const chunk = prepared.parts.get(prepared.nextPart)
      if (!chunk) return
      if (prepared.receivedBytes + chunk.length > prepared.hashes.size) {
        throw new Error(`upload exceeded declared size ${prepared.hashes.size}`)
      }
      prepared.parts.delete(prepared.nextPart++)
      prepared.bufferedBytes -= chunk.length
      prepared.receivedBytes += chunk.length
      prepared.md5.update(chunk)
      prepared.sha1.update(chunk)
      if (prepared.file10MBytes < FILE_10M_BYTES) {
        const length = Math.min(FILE_10M_BYTES - prepared.file10MBytes, chunk.length)
        prepared.file10MMd5.update(chunk.subarray(0, length))
        prepared.file10MBytes += length
      }
      await prepared.sink.write(chunk)
      if (prepared.receivedBytes !== prepared.hashes.size) continue
      this._verifyPreparedHashes(prepared)
      await prepared.sink.complete()
      const key = this._stageKey(prepared.platformSessionId, prepared.fileId)
      if (this._prepared.get(key) === prepared) this._prepared.delete(key)
      this.stagePrepared(prepared.platformSessionId, prepared.fileId, prepared.media)
      return
    }
  }

  private _verifyPreparedHashes(prepared: PreparedUpload): void {
    const actual = {
      md5: prepared.md5.digest('hex'),
      sha1: prepared.sha1.digest('hex'),
      file10MMd5: prepared.file10MMd5.digest('hex'),
    }
    for (const name of ['md5', 'sha1', 'file10MMd5'] as const) {
      if (actual[name] !== prepared.hashes[name].toLowerCase()) {
        throw new Error(`prepared upload ${name} mismatch`)
      }
    }
  }

  private _directory(platformSessionId: string, fileId: string): string {
    return join(this._root, digest(platformSessionId), digest(fileId))
  }

  private _stageKey(platformSessionId: string, fileId: string): string {
    return `${platformSessionId}\u0000${fileId}`
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function partName(part: number): string {
  return String(part).padStart(10, '0')
}
