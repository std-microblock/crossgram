import { createHash } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  HighwayRequestHeadSchema, HighwayResponseHeadSchema,
} from './generated/qqnt/highway_pb.js'

const HIGHWAY_APP_ID = 1_600_001_604
const HIGHWAY_FALLBACK_DELAY_MS = 100
const HIGHWAY_ATTEMPT_TIMEOUT_MS = 3_000
const preferredHighwayServers = new Map<string, string>()

export type QQPreparedMedia =
  | { kind: 'image', fileUuid: string, msgInfo: string, compatQMsg?: string }
  | { kind: 'video', fileUuid: string, msgInfo: string }
  | { kind: 'file', fileUuid: string, fileHash?: string, exists: boolean, commandId: 71 | 95 }

export interface QQHighwayUploadPlan {
  servers: Array<{ host: string, port: number }>
  ticket: string
  extendInfo: string
  selfUin: string
  commandId: number
  sequenceStart: number
  blockSize: number
  fileSize: number
  fileMd5: string
}

export interface QQMediaUploadPlan {
  prepared: QQPreparedMedia
  highway?: QQHighwayUploadPlan
  auxiliaryHighways?: Array<{
    role: 'thumbnail'
    bytes?: string
    highway: QQHighwayUploadPlan
  }>
}

/** Incremental QQ Highway writer used while Telegram file parts are still arriving. */
export class QQHighwayUploadWriter {
  private _buffer: Buffer
  private _bufferedLength = 0
  private _received = 0
  private _uploaded = 0
  private _blockIndex = 0
  private _closed = false

  constructor(
    private readonly _plan: QQHighwayUploadPlan,
    private readonly _fetchImpl: typeof globalThis.fetch,
    private readonly _options: {
      signal?: AbortSignal
      onProgress?(transferredBytes: number): void | Promise<void>
    } = {},
  ) {
    validateHighwayPlan(_plan)
    this._buffer = Buffer.allocUnsafe(_plan.blockSize)
  }

  async write(value: Uint8Array): Promise<void> {
    if (this._closed) throw new Error('QQ Highway upload is already closed')
    if (this._options.signal?.aborted) {
      throw this._options.signal.reason ?? new Error('upload aborted')
    }
    const chunk = Buffer.from(value)
    if (!chunk.length) return
    this._received += chunk.length
    if (this._received > this._plan.fileSize) {
      throw new Error(`upload exceeded declared size ${this._plan.fileSize}`)
    }
    let offset = 0
    while (offset < chunk.length) {
      const length = Math.min(this._plan.blockSize - this._bufferedLength, chunk.length - offset)
      chunk.copy(this._buffer, this._bufferedLength, offset, offset + length)
      this._bufferedLength += length
      offset += length
      if (this._bufferedLength === this._plan.blockSize) await this._flush(this._buffer)
    }
  }

  async complete(): Promise<void> {
    if (this._closed) throw new Error('QQ Highway upload is already closed')
    if (this._received !== this._plan.fileSize) {
      throw new Error(`incomplete upload: expected ${this._plan.fileSize} bytes, received ${this._received}`)
    }
    if (this._bufferedLength) await this._flush(this._buffer.subarray(0, this._bufferedLength))
    this._closed = true
  }

  abort(): void {
    this._closed = true
    this._bufferedLength = 0
  }

  private async _flush(block: Buffer): Promise<void> {
    const frame = encodeHighwayFrame(
      this._plan,
      this._plan.sequenceStart + this._blockIndex++,
      this._uploaded,
      block,
    )
    await postHighwayBlock(this._plan, frame, this._fetchImpl, this._options.signal)
    this._uploaded += block.length
    this._buffer = Buffer.allocUnsafe(this._plan.blockSize)
    this._bufferedLength = 0
    await this._options.onProgress?.(this._uploaded)
  }
}

export async function uploadHighway(
  plan: QQHighwayUploadPlan,
  source: AsyncIterable<Uint8Array>,
  fetchImpl: typeof globalThis.fetch,
  options: { signal?: AbortSignal, onProgress?(transferredBytes: number): void | Promise<void> } = {},
): Promise<void> {
  const writer = new QQHighwayUploadWriter(plan, fetchImpl, options)
  for await (const chunk of source) await writer.write(chunk)
  await writer.complete()
}

export function encodeHighwayFrame(
  plan: QQHighwayUploadPlan,
  sequence: number,
  offset: number,
  body: Uint8Array,
): Buffer {
  const ticket = Buffer.from(plan.ticket, 'base64url')
  const extendInfo = Buffer.from(plan.extendInfo, 'base64url')
  const fileMd5 = hex(plan.fileMd5, 'QQ Highway file MD5', 32)
  if (!ticket.length || !extendInfo.length) throw new Error('QQ Highway plan has incomplete metadata')
  const head = Buffer.from(toBinary(HighwayRequestHeadSchema, create(HighwayRequestHeadSchema, {
    base: {
      version: 1, selfUin: plan.selfUin, command: 'PicUp.DataUp', sequence,
      appId: HIGHWAY_APP_ID, dataFlag: 16, commandId: plan.commandId,
    },
    segment: {
      fileSize: BigInt(plan.fileSize), offset: BigInt(offset), length: body.length,
      ticket, chunkMd5: createHash('md5').update(body).digest(), fileMd5,
    },
    extendInfo,
    field4: 0,
    loginSig: { field1: 8, appId: HIGHWAY_APP_ID },
  })))
  const frame = Buffer.allocUnsafe(10 + head.length + body.length)
  frame[0] = 0x28
  frame.writeUInt32BE(head.length, 1)
  frame.writeUInt32BE(body.length, 5)
  head.copy(frame, 9)
  Buffer.from(body).copy(frame, 9 + head.length)
  frame[frame.length - 1] = 0x29
  return frame
}

export function decodeHighwayResponse(payload: Uint8Array): void {
  const buffer = Buffer.from(payload)
  if (buffer.length < 10 || buffer[0] !== 0x28 || buffer[buffer.length - 1] !== 0x29) {
    throw new Error('invalid QQ Highway response frame')
  }
  const headLength = buffer.readUInt32BE(1)
  const bodyLength = buffer.readUInt32BE(5)
  if (9 + headLength + bodyLength + 1 !== buffer.length) {
    throw new Error('truncated QQ Highway response frame')
  }
  const head = fromBinary(HighwayResponseHeadSchema, buffer.subarray(9, 9 + headLength))
  const returnCode = head.segment?.returnCode ?? 0
  if (head.errorCode || returnCode) {
    throw new Error(`QQ Highway rejected block: error=${head.errorCode} return=${returnCode}`)
  }
}

async function postHighwayBlock(
  plan: QQHighwayUploadPlan,
  frame: Buffer,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<void> {
  const serverKey = plan.servers.map(highwayServerKey).sort().join(',')
  const preferred = preferredHighwayServers.get(serverKey)
  const servers = [...plan.servers].sort((left, right) =>
    Number(highwayServerKey(right) === preferred) - Number(highwayServerKey(left) === preferred))
  const controllers = servers.map(() => new AbortController())
  try {
    const winner = await Promise.any(servers.map(async (server, index) => {
      const controller = controllers[index]!
      const attemptSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(HIGHWAY_ATTEMPT_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ])
      if (index) await abortableDelay(index * HIGHWAY_FALLBACK_DELAY_MS, attemptSignal)
      const response = await fetchImpl(
        `http://${server.host}:${server.port}/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${encodeURIComponent(plan.selfUin)}`,
        {
          method: 'POST', body: Uint8Array.from(frame), signal: attemptSignal,
          headers: { connection: 'keep-alive', 'content-type': 'application/octet-stream' },
        },
      )
      if (!response.ok) throw new Error(`QQ Highway HTTP ${response.status}: ${await response.text()}`)
      decodeHighwayResponse(new Uint8Array(await response.arrayBuffer()))
      return highwayServerKey(server)
    }))
    preferredHighwayServers.set(serverKey, winner)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    const errors = error instanceof AggregateError ? error.errors : [error]
    throw new Error(`all QQ Highway upload servers failed: ${errorMessage(errors.at(-1))}`)
  } finally {
    for (const controller of controllers) controller.abort()
  }
}

function highwayServerKey(server: { host: string, port: number }): string {
  return `${server.host}:${server.port}`
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('operation aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done(signal.reason ?? new Error('operation aborted'))
    function done(error?: unknown) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function validateHighwayPlan(plan: QQHighwayUploadPlan): void {
  if (!plan.servers.length) throw new Error('QQ Highway plan has no upload server')
  if (!Number.isSafeInteger(plan.blockSize) || plan.blockSize <= 0) {
    throw new Error('QQ Highway plan has an invalid block size')
  }
  if (!Number.isSafeInteger(plan.fileSize) || plan.fileSize <= 0) {
    throw new Error('QQ Highway plan has an invalid file size')
  }
}

function hex(value: string, name: string, length: number): Buffer {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)) {
    throw new Error(`${name} must be ${length} hexadecimal characters`)
  }
  return Buffer.from(value, 'hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
