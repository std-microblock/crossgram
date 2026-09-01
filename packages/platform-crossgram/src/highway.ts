import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import {
  HighwayRequestHeadSchema, HighwayResponseHeadSchema,
} from './generated/qqnt/highway_pb.js'

const HIGHWAY_APP_ID = 1_600_001_604
const HIGHWAY_CONNECT_TIMEOUT_MS = 3_000
const HIGHWAY_RESPONSE_TIMEOUT_MS = 30_000
const HIGHWAY_ATTEMPT_TIMEOUT_MS = 60_000
const HIGHWAY_FALLBACK_DELAY_MS = 500
const HIGHWAY_MAX_IN_FLIGHT_BLOCKS = 8
const HIGHWAY_SELECTION_BLOCK_BYTES = 128 * 1024
const HIGHWAY_TCP_SELECTION_TIMEOUT_MS = 60_000
const HIGHWAY_TCP_UPLOAD_TIMEOUT_MS = 20 * 60_000
const preferredHighwayServers = new Map<string, { server: string }>()
const preferredHighwayTcpServers = new Map<string, { server: string }>()
const highwayDispatcher = new Agent({
  connectTimeout: HIGHWAY_CONNECT_TIMEOUT_MS,
  headersTimeout: HIGHWAY_RESPONSE_TIMEOUT_MS,
  bodyTimeout: HIGHWAY_RESPONSE_TIMEOUT_MS,
})

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
  private _scheduled = 0
  private _uploaded = 0
  private _blockIndex = 0
  private _closed = false
  private _failure?: unknown
  private _tcp?: QQHighwayTcpConnection
  private readonly _controller = new AbortController()
  private readonly _inFlight = new Set<Promise<void>>()

  constructor(
    private readonly _plan: QQHighwayUploadPlan,
    private readonly _fetchImpl: typeof globalThis.fetch,
    private readonly _options: {
      signal?: AbortSignal
      attemptTimeoutMs?: number
      fallbackDelayMs?: number
      transport?: 'auto' | 'http' | 'tcp'
      onProgress?(transferredBytes: number): void | Promise<void>
    } = {},
  ) {
    validateHighwayPlan(_plan)
    const selectionBlockSize = shouldUseHighwayTcp(_plan, _fetchImpl, _options.transport)
      ? _plan.blockSize
      : Math.min(_plan.blockSize, HIGHWAY_SELECTION_BLOCK_BYTES)
    this._buffer = Buffer.allocUnsafe(Math.min(
      _plan.fileSize,
      selectionBlockSize,
    ))
  }

  async write(value: Uint8Array): Promise<void> {
    if (this._closed) throw new Error('QQ Highway upload is already closed')
    this._throwIfFailed()
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
      const length = Math.min(this._buffer.length - this._bufferedLength, chunk.length - offset)
      chunk.copy(this._buffer, this._bufferedLength, offset, offset + length)
      this._bufferedLength += length
      offset += length
      if (this._bufferedLength === this._buffer.length) await this._flush(this._buffer)
    }
  }

  async complete(): Promise<void> {
    if (this._closed) throw new Error('QQ Highway upload is already closed')
    this._throwIfFailed()
    if (this._received !== this._plan.fileSize) {
      throw new Error(`incomplete upload: expected ${this._plan.fileSize} bytes, received ${this._received}`)
    }
    try {
      if (this._bufferedLength) await this._flush(this._buffer.subarray(0, this._bufferedLength))
      await this._tcp?.complete()
      await Promise.all([...this._inFlight])
      this._throwIfFailed()
      this._closed = true
    } catch (error) {
      this.abort(error)
      throw error
    }
  }

  abort(reason: unknown = new Error('QQ Highway upload aborted')): void {
    this._closed = true
    this._bufferedLength = 0
    this._tcp?.close(reason)
    if (!this._controller.signal.aborted) this._controller.abort(reason)
  }

  private async _flush(block: Buffer): Promise<void> {
    const blockIndex = this._blockIndex++
    const offset = this._scheduled
    this._scheduled += block.length
    const httpFrame = encodeHighwayFrame(
      this._plan,
      this._plan.sequenceStart + blockIndex,
      offset,
      block,
    )
    this._buffer = Buffer.allocUnsafe(this._plan.blockSize)
    this._bufferedLength = 0
    const signal = AbortSignal.any([
      this._controller.signal,
      ...(this._options.signal ? [this._options.signal] : []),
    ])
    if (blockIndex === 0 && shouldUseHighwayTcp(this._plan, this._fetchImpl, this._options.transport)) {
      const tcpFrame = encodeHighwayFrame(this._plan, 0, offset, block)
      try {
        this._tcp = await selectHighwayTcp(
          this._plan,
          tcpFrame,
          signal,
          (uploaded) => this._reportProgress(uploaded),
          this._options.fallbackDelayMs,
        )
        return
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        // HTTP is QQ's documented fallback when every persistent TCP candidate fails.
      }
    } else if (this._tcp) {
      await this._tcp.send(encodeHighwayFrame(this._plan, 0, offset, block))
      return
    }
    const upload = async () => {
      await postHighwayBlock(
        this._plan,
        httpFrame,
        this._fetchImpl,
        signal,
        this._options.attemptTimeoutMs,
        this._options.fallbackDelayMs,
        blockIndex === 0,
      )
      await this._reportProgress(this._uploaded + block.length)
    }
    if (blockIndex === 0) {
      await upload()
      return
    }
    const task = upload()
    this._inFlight.add(task)
    void task.then(
      () => this._inFlight.delete(task),
      (error) => {
        this._inFlight.delete(task)
        this._failure ??= error
        if (!this._controller.signal.aborted) this._controller.abort(error)
      },
    )
    if (this._inFlight.size >= HIGHWAY_MAX_IN_FLIGHT_BLOCKS) {
      await Promise.race(this._inFlight)
      this._throwIfFailed()
    }
  }

  private _throwIfFailed(): void {
    if (this._failure) throw this._failure
  }

  private async _reportProgress(uploaded: number): Promise<void> {
    if (uploaded <= this._uploaded) return
    this._uploaded = uploaded
    await this._options.onProgress?.(uploaded)
  }
}

export async function uploadHighway(
  plan: QQHighwayUploadPlan,
  source: AsyncIterable<Uint8Array>,
  fetchImpl: typeof globalThis.fetch,
  options: {
    signal?: AbortSignal
    attemptTimeoutMs?: number
    fallbackDelayMs?: number
    transport?: 'auto' | 'http' | 'tcp'
    onProgress?(transferredBytes: number): void | Promise<void>
  } = {},
): Promise<void> {
  const writer = new QQHighwayUploadWriter(plan, fetchImpl, options)
  try {
    for await (const chunk of source) await writer.write(chunk)
    await writer.complete()
  } catch (error) {
    writer.abort(error)
    throw error
  }
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

export function decodeHighwayResponse(payload: Uint8Array): { offset: number, length: number } {
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
  return {
    offset: Number(head.segment?.offset ?? 0n),
    length: head.segment?.length ?? 0,
  }
}

class QQHighwayTcpConnection {
  private readonly _socket: Socket
  private readonly _ready = deferred<void>()
  private readonly _firstAck = deferred<void>()
  private readonly _completed = deferred<void>()
  private readonly _failed = deferred<void>()
  private readonly _acknowledged = new Set<string>()
  private _acknowledgedBytes = 0
  private _buffer = Buffer.alloc(0)
  private _failure?: unknown
  private _closed = false
  private _progressTail = Promise.resolve()

  constructor(
    readonly server: { host: string, port: number },
    private readonly _plan: QQHighwayUploadPlan,
    signal: AbortSignal,
    private readonly _onProgress: (uploaded: number) => void | Promise<void>,
  ) {
    this._socket = connect(server.port, server.host)
    this._socket.setNoDelay(true)
    this._socket.once('connect', () => this._ready.resolve())
    this._socket.on('data', (chunk) => this._onData(Buffer.from(chunk)))
    this._socket.once('error', (error) => this._fail(error))
    this._socket.once('close', () => {
      if (!this._closed && this._acknowledgedBytes < this._plan.fileSize) {
        this._fail(new Error('QQ Highway TCP connection closed before upload completion'))
      }
    })
    const onAbort = () => this.close(signal.reason ?? new Error('upload aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  async send(frame: Buffer): Promise<void> {
    await this._ready.promise
    this._throwIfFailed()
    if (this._socket.write(frame)) return
    await Promise.race([once(this._socket, 'drain').then(() => undefined), this._failed.promise])
    this._throwIfFailed()
  }

  firstAck(): Promise<void> {
    return this._firstAck.promise
  }

  async complete(): Promise<void> {
    if (this._acknowledgedBytes < this._plan.fileSize) {
      await Promise.race([
        this._completed.promise,
        timeout(HIGHWAY_TCP_UPLOAD_TIMEOUT_MS, 'QQ Highway TCP upload timed out'),
      ])
    }
    await this._progressTail
    this._closed = true
    this._socket.end()
  }

  close(reason: unknown = new Error('QQ Highway TCP connection closed')): void {
    if (this._closed) return
    this._closed = true
    if (this._acknowledgedBytes < this._plan.fileSize) this._fail(reason)
    this._socket.destroy(reason instanceof Error ? reason : new Error(String(reason)))
  }

  private _onData(chunk: Buffer): void {
    if (this._closed) return
    this._buffer = Buffer.concat([this._buffer, chunk])
    try {
      while (this._buffer.length >= 10) {
        if (this._buffer[0] !== 0x28) throw new Error('invalid QQ Highway TCP response frame')
        const frameLength = 9 + this._buffer.readUInt32BE(1) + this._buffer.readUInt32BE(5) + 1
        if (this._buffer.length < frameLength) return
        const result = decodeHighwayResponse(this._buffer.subarray(0, frameLength))
        this._buffer = this._buffer.subarray(frameLength)
        const key = `${result.offset}:${result.length}`
        if (!this._acknowledged.has(key)) {
          this._acknowledged.add(key)
          this._acknowledgedBytes += result.length
          const uploaded = this._acknowledgedBytes
          this._progressTail = this._progressTail.then(() => this._onProgress(uploaded))
        }
        this._firstAck.resolve()
        if (this._acknowledgedBytes >= this._plan.fileSize) this._completed.resolve()
      }
    } catch (error) {
      this._fail(error)
    }
  }

  private _fail(error: unknown): void {
    if (this._failure) return
    this._failure = error
    this._ready.reject(error)
    this._firstAck.reject(error)
    this._completed.reject(error)
    this._failed.reject(error)
    if (!this._socket.destroyed) {
      this._socket.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private _throwIfFailed(): void {
    if (this._failure) throw this._failure
  }
}

async function selectHighwayTcp(
  plan: QQHighwayUploadPlan,
  firstFrame: Buffer,
  signal: AbortSignal,
  onProgress: (uploaded: number) => void | Promise<void>,
  fallbackDelayMs = HIGHWAY_FALLBACK_DELAY_MS,
): Promise<QQHighwayTcpConnection> {
  const serverKey = plan.servers.map(highwayServerKey).sort().join(',')
  const preferred = preferredHighwayTcpServers.get(serverKey)
  const ordered = [...plan.servers].sort((left, right) =>
    Number(highwayServerKey(right) === preferred?.server)
      - Number(highwayServerKey(left) === preferred?.server))
  // QQNT clients prefer the final server returned by HttpConn when no prior
  // successful endpoint exists. Preserve that order before staggering races.
  if (!preferred) ordered.reverse()
  const selectionController = new AbortController()
  const selectionSignal = AbortSignal.any([selectionController.signal, signal])
  const connections = ordered.map((server) =>
    new QQHighwayTcpConnection(server, plan, signal, onProgress))
  try {
    const winner = await Promise.race([
      Promise.any(connections.map(async (connection, index) => {
        if (index) await abortableDelay(index * fallbackDelayMs, selectionSignal)
        await connection.send(firstFrame)
        await connection.firstAck()
        return connection
      })),
      timeout(HIGHWAY_TCP_SELECTION_TIMEOUT_MS, 'QQ Highway TCP server selection timed out'),
    ])
    preferredHighwayTcpServers.set(serverKey, { server: highwayServerKey(winner.server) })
    for (const connection of connections) {
      if (connection !== winner) connection.close(new Error('QQ Highway TCP fallback lost selection race'))
    }
    return winner
  } catch (error) {
    if (preferredHighwayTcpServers.get(serverKey) === preferred) preferredHighwayTcpServers.delete(serverKey)
    for (const connection of connections) connection.close(error)
    throw error
  } finally {
    selectionController.abort()
  }
}

function shouldUseHighwayTcp(
  plan: QQHighwayUploadPlan,
  fetchImpl: typeof globalThis.fetch,
  transport: 'auto' | 'http' | 'tcp' = 'auto',
): boolean {
  if (transport === 'tcp') return true
  if (transport === 'http' || fetchImpl !== globalThis.fetch) return false
  return plan.servers.some((server) => !isLoopbackHost(server.host))
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value?: T | PromiseLike<T>): void
  reject(reason?: unknown): void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void
    reject = rejectPromise
  })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
  })
}

async function postHighwayBlock(
  plan: QQHighwayUploadPlan,
  frame: Buffer,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
  attemptTimeoutMs = HIGHWAY_ATTEMPT_TIMEOUT_MS,
  fallbackDelayMs = HIGHWAY_FALLBACK_DELAY_MS,
  hedge = true,
): Promise<void> {
  const serverKey = plan.servers.map(highwayServerKey).sort().join(',')
  const post = fetchImpl === globalThis.fetch ? defaultHighwayFetch : fetchImpl
  const preferred = preferredHighwayServers.get(serverKey)
  const ordered = [...plan.servers].sort((left, right) =>
    Number(highwayServerKey(right) === preferred?.server)
      - Number(highwayServerKey(left) === preferred?.server))
  const preferredServer = preferred
    ? ordered.find((server) => highwayServerKey(server) === preferred.server)
    : undefined
  let preferredError: unknown
  if (!hedge && preferredServer) {
    try {
      await postHighwayServer(plan, frame, preferredServer, post, signal, attemptTimeoutMs)
      preferredHighwayServers.set(serverKey, { server: preferred.server })
      return
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      preferredError = error
      if (preferredHighwayServers.get(serverKey) === preferred) preferredHighwayServers.delete(serverKey)
    }
  }
  const servers = !hedge && preferredServer
    ? ordered.filter((server) => server !== preferredServer)
    : ordered
  const controllers = servers.map(() => new AbortController())
  try {
    const winner = await Promise.any(servers.map(async (server, index) => {
      const candidateSignal = AbortSignal.any([
        controllers[index]!.signal,
        ...(signal ? [signal] : []),
      ])
      if (index) await abortableDelay(index * fallbackDelayMs, candidateSignal)
      await postHighwayServer(plan, frame, server, post, candidateSignal, attemptTimeoutMs)
      return highwayServerKey(server)
    }))
    preferredHighwayServers.set(serverKey, { server: winner })
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (preferredHighwayServers.get(serverKey) === preferred) preferredHighwayServers.delete(serverKey)
    const errors = error instanceof AggregateError ? error.errors : [error]
    throw new Error(`all QQ Highway upload servers failed: ${errorMessage(errors.at(-1) ?? preferredError)}`)
  } finally {
    for (const controller of controllers) controller.abort()
  }
}

async function postHighwayServer(
  plan: QQHighwayUploadPlan,
  frame: Buffer,
  server: { host: string, port: number },
  post: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
  attemptTimeoutMs: number,
): Promise<void> {
  const attemptSignal = AbortSignal.any([
    AbortSignal.timeout(attemptTimeoutMs),
    ...(signal ? [signal] : []),
  ])
  const response = await post(
    `http://${server.host}:${server.port}/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${encodeURIComponent(plan.selfUin)}`,
    {
      method: 'POST', body: Uint8Array.from(frame), signal: attemptSignal,
      headers: { connection: 'keep-alive', 'content-type': 'application/octet-stream' },
    },
  )
  if (!response.ok) throw new Error(`QQ Highway HTTP ${response.status}: ${await response.text()}`)
  decodeHighwayResponse(new Uint8Array(await response.arrayBuffer()))
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

const defaultHighwayFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  undiciFetch(input as string | URL, {
    ...(init as UndiciRequestInit),
    dispatcher: highwayDispatcher,
  }) as unknown as Promise<Response>) as typeof globalThis.fetch
