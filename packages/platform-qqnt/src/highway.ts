import { createHash } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  HighwayRequestHeadSchema, HighwayResponseHeadSchema,
} from './generated/qqnt/highway_pb.js'

const HIGHWAY_APP_ID = 1_600_001_604

export type QQPreparedMedia =
  | { kind: 'image', fileUuid: string, msgInfo: string, compatQMsg?: string }
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
}

export async function uploadHighway(
  plan: QQHighwayUploadPlan,
  source: AsyncIterable<Uint8Array>,
  fetchImpl: typeof globalThis.fetch,
  options: { signal?: AbortSignal, onProgress?(transferredBytes: number): void | Promise<void> } = {},
): Promise<void> {
  if (!plan.servers.length) throw new Error('QQ Highway plan has no upload server')
  if (!Number.isSafeInteger(plan.blockSize) || plan.blockSize <= 0) {
    throw new Error('QQ Highway plan has an invalid block size')
  }
  let offset = 0
  let blockIndex = 0
  for await (const block of exactBlocks(source, plan.fileSize, plan.blockSize, options.signal)) {
    const frame = encodeHighwayFrame(plan, plan.sequenceStart + blockIndex++, offset, block)
    await postHighwayBlock(plan, frame, fetchImpl, options.signal)
    offset += block.length
    await options.onProgress?.(offset)
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
  let lastError: unknown
  for (const server of plan.servers) {
    try {
      const response = await fetchImpl(
        `http://${server.host}:${server.port}/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${encodeURIComponent(plan.selfUin)}`,
        {
          method: 'POST', body: Uint8Array.from(frame), signal,
          headers: { connection: 'keep-alive', 'content-type': 'application/octet-stream' },
        },
      )
      if (!response.ok) throw new Error(`QQ Highway HTTP ${response.status}: ${await response.text()}`)
      decodeHighwayResponse(new Uint8Array(await response.arrayBuffer()))
      return
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      lastError = error
    }
  }
  throw new Error(`all QQ Highway upload servers failed: ${errorMessage(lastError)}`)
}

async function* exactBlocks(
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
  blockSize: number,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  let buffered = Buffer.allocUnsafe(blockSize)
  let bufferedLength = 0
  let received = 0
  for await (const value of source) {
    if (signal?.aborted) throw signal.reason ?? new Error('upload aborted')
    const chunk = Buffer.from(value)
    if (!chunk.length) continue
    received += chunk.length
    if (received > expectedSize) throw new Error(`upload exceeded declared size ${expectedSize}`)
    let offset = 0
    while (offset < chunk.length) {
      const length = Math.min(blockSize - bufferedLength, chunk.length - offset)
      chunk.copy(buffered, bufferedLength, offset, offset + length)
      bufferedLength += length
      offset += length
      if (bufferedLength === blockSize) {
        yield buffered
        buffered = Buffer.allocUnsafe(blockSize)
        bufferedLength = 0
      }
    }
  }
  if (received !== expectedSize) {
    throw new Error(`incomplete upload: expected ${expectedSize} bytes, received ${received}`)
  }
  if (bufferedLength) yield buffered.subarray(0, bufferedLength)
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
