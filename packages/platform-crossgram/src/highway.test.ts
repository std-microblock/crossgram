import { createHash } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { HighwayRequestHeadSchema, HighwayResponseHeadSchema } from './generated/qqnt/highway_pb.js'
import {
  decodeHighwayResponse, encodeHighwayFrame, QQHighwayUploadWriter, uploadHighway,
  type QQHighwayUploadPlan,
} from './highway.js'

const body = Buffer.from('payload')
const plan: QQHighwayUploadPlan = {
  servers: [{ host: '127.0.0.1', port: 8080 }],
  ticket: Buffer.from('ticket').toString('base64url'),
  extendInfo: Buffer.from('extend').toString('base64url'),
  selfUin: '1715311957', commandId: 1003, sequenceStart: 9,
  blockSize: 1024 * 1024, fileSize: body.length,
  fileMd5: createHash('md5').update(body).digest('hex'),
}

describe('QQ Highway protobuf transport', () => {
  it('encodes the QQ frame head with protobuf-es and preserves the streamed body', () => {
    const frame = encodeHighwayFrame(plan, 9, 0, body)
    expect(frame[0]).toBe(0x28)
    expect(frame.at(-1)).toBe(0x29)
    const headLength = frame.readUInt32BE(1)
    expect(frame.readUInt32BE(5)).toBe(body.length)
    expect(frame.subarray(9 + headLength, -1)).toEqual(body)
    const head = fromBinary(HighwayRequestHeadSchema, frame.subarray(9, 9 + headLength))
    expect(head).toMatchObject({
      base: {
        version: 1, selfUin: '1715311957', command: 'PicUp.DataUp', sequence: 9,
        appId: 1_600_001_604, dataFlag: 16, commandId: 1003,
      },
      segment: { fileSize: 7n, offset: 0n, length: 7, ticket: Buffer.from('ticket') },
      extendInfo: Buffer.from('extend'),
      loginSig: { field1: 8, appId: 1_600_001_604 },
    })
    expect(Buffer.from(head.segment!.chunkMd5)).toEqual(createHash('md5').update(body).digest())
  })

  it('decodes protobuf-es response errors and rejects malformed frames', () => {
    expect(() => decodeHighwayResponse(responseFrame())).not.toThrow()
    expect(() => decodeHighwayResponse(responseFrame({ errorCode: 9 }))).toThrow('error=9')
    expect(() => decodeHighwayResponse(responseFrame({ returnCode: 7 }))).toThrow('return=7')
    expect(() => decodeHighwayResponse(Buffer.from([0x28, 0x29]))).toThrow('invalid QQ Highway')
  })

  it('retries the next server and rejects a source shorter than the declared size', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(responseFrame()))) as typeof globalThis.fetch
    const retryPlan = {
      ...plan,
      servers: [{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.2', port: 2 }],
    }
    await uploadHighway(
      retryPlan,
      (async function* () { yield body })(),
      fetch,
      { fallbackDelayMs: 0 },
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain('127.0.0.2:2')

    await expect(uploadHighway(
      { ...plan, fileSize: body.length + 1 },
      (async function* () { yield body })(),
      vi.fn() as typeof globalThis.fetch,
    )).rejects.toThrow('expected 8 bytes, received 7')
  })

  it('hedges a hanging initial server and reuses the fallback winner', async () => {
    const calls: string[] = []
    const fetch = vi.fn((input, init) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('127.0.0.3:3')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }
      return Promise.resolve(new Response(Uint8Array.from(responseFrame())))
    }) as typeof globalThis.fetch
    const racingPlan = {
      ...plan,
      servers: [{ host: '127.0.0.3', port: 3 }, { host: '127.0.0.4', port: 4 }],
    }

    const upload = uploadHighway(
      racingPlan,
      (async function* () { yield body })(),
      fetch,
      { attemptTimeoutMs: 20, fallbackDelayMs: 5 },
    )
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(calls).toHaveLength(1)
    await upload
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('127.0.0.4:4')

    calls.length = 0
    await uploadHighway(
      racingPlan,
      (async function* () { yield body })(),
      fetch,
      { attemptTimeoutMs: 20, fallbackDelayMs: 5 },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('127.0.0.4:4')
  })

  it('does not erase a server preference learned while another selection is failing', async () => {
    const concurrentPlan = {
      ...plan,
      servers: [{ host: '127.0.0.5', port: 5 }, { host: '127.0.0.6', port: 6 }],
    }
    const rejects: Array<(error: Error) => void> = []
    const failingFetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      const fail = (error: Error) => reject(error)
      rejects.push(fail)
      init?.signal?.addEventListener('abort', () => fail(init.signal!.reason), { once: true })
    })) as typeof globalThis.fetch
    const failingUpload = uploadHighway(
      concurrentPlan,
      (async function* () { yield body })(),
      failingFetch,
      { attemptTimeoutMs: 1_000, fallbackDelayMs: 0 },
    )
    await vi.waitFor(() => expect(rejects).toHaveLength(2))

    const learningCalls: string[] = []
    const learningFetch = vi.fn(async (input) => {
      const url = String(input)
      learningCalls.push(url)
      return url.includes('127.0.0.5:5')
        ? new Response('unavailable', { status: 503 })
        : new Response(Uint8Array.from(responseFrame()))
    }) as typeof globalThis.fetch
    await uploadHighway(
      concurrentPlan,
      (async function* () { yield body })(),
      learningFetch,
      { fallbackDelayMs: 0 },
    )
    expect(learningCalls).toHaveLength(2)

    for (const reject of rejects) reject(new Error('concurrent selection failed'))
    await expect(failingUpload).rejects.toThrow('concurrent selection failed')

    const reusedCalls: string[] = []
    const reusedFetch = vi.fn(async (input) => {
      reusedCalls.push(String(input))
      return new Response(Uint8Array.from(responseFrame()))
    }) as typeof globalThis.fetch
    await uploadHighway(concurrentPlan, (async function* () { yield body })(), reusedFetch)
    expect(reusedCalls).toHaveLength(1)
    expect(reusedCalls[0]).toContain('127.0.0.6:6')
  })

  it('flushes complete blocks immediately and retains only the final partial block', async () => {
    const frames: Buffer[] = []
    const fetch = vi.fn(async (_input, init) => {
      frames.push(Buffer.from(init?.body as Uint8Array))
      return new Response(Uint8Array.from(responseFrame()))
    }) as typeof globalThis.fetch
    const writer = new QQHighwayUploadWriter({ ...plan, fileSize: 6, blockSize: 4 }, fetch)

    await writer.write(Buffer.from([1, 2, 3]))
    expect(frames).toHaveLength(0)
    await writer.write(Buffer.from([4, 5]))
    expect(frames).toHaveLength(1)
    expect(highwayBody(frames[0]!)).toEqual(Buffer.from([1, 2, 3, 4]))
    await writer.write(Buffer.from([6]))
    expect(frames).toHaveLength(1)
    await writer.complete()
    expect(frames).toHaveLength(2)
    expect(highwayBody(frames[1]!)).toEqual(Buffer.from([5, 6]))
  })

  it('pipelines later blocks after the first server selection and keeps protocol offsets ordered', async () => {
    const frames: Buffer[] = []
    const releases: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const progress: number[] = []
    const fetch = vi.fn(async (_input, init) => {
      frames.push(Buffer.from(init?.body as Uint8Array))
      if (frames.length === 1) return new Response(Uint8Array.from(responseFrame()))
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
      return new Response(Uint8Array.from(responseFrame()))
    }) as typeof globalThis.fetch
    const writer = new QQHighwayUploadWriter(
      { ...plan, fileSize: 12, blockSize: 4 },
      fetch,
      { onProgress: (uploaded) => { progress.push(uploaded) } },
    )

    await writer.write(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
    expect(frames).toHaveLength(3)
    expect(maxActive).toBe(2)
    expect(frames.map(highwayOffset)).toEqual([0n, 4n, 8n])
    expect(frames.map(highwayBody)).toEqual([
      Buffer.from([1, 2, 3, 4]),
      Buffer.from([5, 6, 7, 8]),
      Buffer.from([9, 10, 11, 12]),
    ])

    const completing = writer.complete()
    releases[1]!()
    await new Promise((resolve) => setImmediate(resolve))
    releases[0]!()
    await completing
    expect(progress).toEqual([4, 8, 12])
  })

  it('bounds the per-upload block pipeline to eight requests', async () => {
    const releases: Array<() => void> = []
    let calls = 0
    let active = 0
    let maxActive = 0
    const fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response(Uint8Array.from(responseFrame()))
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
      return new Response(Uint8Array.from(responseFrame()))
    }) as typeof globalThis.fetch
    const writer = new QQHighwayUploadWriter({ ...plan, fileSize: 40, blockSize: 4 }, fetch)

    const writing = writer.write(Buffer.alloc(40, 0x4d))
    await vi.waitFor(() => expect(calls).toBe(9))
    expect(active).toBe(8)
    expect(maxActive).toBe(8)

    releases.shift()!()
    await vi.waitFor(() => expect(calls).toBe(10))
    expect(active).toBe(8)
    releases.shift()!()
    await writing
    for (const release of releases.splice(0)) release()
    await writer.complete()
    expect(maxActive).toBe(8)
  })
})

function responseFrame(options: { errorCode?: number, returnCode?: number } = {}): Buffer {
  const head = Buffer.from(toBinary(HighwayResponseHeadSchema, create(HighwayResponseHeadSchema, {
    errorCode: options.errorCode ?? 0,
    segment: options.returnCode ? { returnCode: options.returnCode } : undefined,
  })))
  const frame = Buffer.alloc(10 + head.length)
  frame[0] = 0x28
  frame.writeUInt32BE(head.length, 1)
  frame.writeUInt32BE(0, 5)
  head.copy(frame, 9)
  frame[frame.length - 1] = 0x29
  return frame
}

function highwayBody(frame: Buffer): Buffer {
  const headLength = frame.readUInt32BE(1)
  const bodyLength = frame.readUInt32BE(5)
  return frame.subarray(9 + headLength, 9 + headLength + bodyLength)
}

function highwayOffset(frame: Buffer): bigint {
  const headLength = frame.readUInt32BE(1)
  return fromBinary(HighwayRequestHeadSchema, frame.subarray(9, 9 + headLength)).segment!.offset
}
