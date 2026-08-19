import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IMMediaInput, IMMediaSource } from './platform.js'

export interface UploadedFile {
  platformSessionId: string
  fileId: string
  source: IMMediaSource
  cleanup(): Promise<void>
}

export interface StagedMedia {
  media: IMMediaInput
  upload: UploadedFile
  timestamp: number
}

/** Disk-backed Telegram upload parts. Files are streamed to adapters without reassembly in memory. */
export class UploadManager {
  private readonly _staged = new Map<string, StagedMedia>()

  constructor(private readonly _root: string) {}

  async savePart(
    platformSessionId: string,
    fileId: string,
    part: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!Number.isSafeInteger(part) || part < 0) throw new RangeError('file part must be a non-negative integer')
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
    this._staged.delete(this._stageKey(platformSessionId, fileId))
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
      cleanup: async () => {},
    }
    const staged = { media, upload, timestamp: Date.now() }
    this.stage(staged)
    return staged
  }

  getStaged(platformSessionId: string, fileId: string): StagedMedia | undefined {
    return this._staged.get(this._stageKey(platformSessionId, fileId))
  }

  async complete(upload: UploadedFile): Promise<void> {
    const key = this._stageKey(upload.platformSessionId, upload.fileId)
    if (this._staged.get(key)?.upload === upload) this._staged.delete(key)
    await upload.cleanup()
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
