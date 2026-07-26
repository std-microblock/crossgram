import { createHash } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { HighwayRequestHeadSchema, HighwayResponseHeadSchema } from './generated/qqnt/highway_pb.js'
import {
  decodeHighwayResponse, encodeHighwayFrame, uploadHighway, type QQHighwayUploadPlan,
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
    await uploadHighway(retryPlan, (async function* () { yield body })(), fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain('127.0.0.2:2')

    await expect(uploadHighway(
      { ...plan, fileSize: body.length + 1 },
      (async function* () { yield body })(),
      vi.fn() as typeof globalThis.fetch,
    )).rejects.toThrow('expected 8 bytes, received 7')
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
