import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HighwayRequestHeadSchema, HighwayResponseHeadSchema } from './generated/qqnt/highway_pb.js'
import { uploadHighway, type QQHighwayUploadPlan } from './highway.js'

interface ReceivedFrame {
  body: Buffer
  offset: number
  length: number
  sequence: number
}

describe('QQ Highway persistent TCP E2E', () => {
  const servers: Server[] = []
  const sockets = new Set<Socket>()

  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await Promise.all(servers.splice(0).map(async (server) => {
      server.close()
      await once(server, 'close')
    }))
  })

  it('streams later blocks on one connection before their acknowledgements arrive', async () => {
    const body = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1))
    const received: ReceivedFrame[] = []
    let connections = 0
    const server = await listen(createServer((socket) => {
      sockets.add(socket)
      connections++
      parseFrames(socket, async (frame) => {
        received.push(frame)
        if (received.length === 1) {
          // Split the selection acknowledgement to exercise partial response parsing.
          const response = responseFrame(frame.offset, frame.length)
          socket.write(response.subarray(0, 7))
          await new Promise((resolve) => setImmediate(resolve))
          socket.write(response.subarray(7))
          return
        }
        if (received.length === 4) {
          // The client must have written all later blocks without waiting for block 2.
          const responses = Buffer.concat(received.slice(1).map((item) =>
            responseFrame(item.offset, item.length)))
          // Coalesce multiple responses, then split across an arbitrary boundary.
          socket.write(responses.subarray(0, responses.length - 3))
          socket.write(responses.subarray(responses.length - 3))
        }
      })
    }))
    servers.push(server.server)
    const progress: number[] = []

    await uploadHighway(
      highwayPlan(body, [server.address], 4),
      (async function* () {
        yield body.subarray(0, 5)
        yield body.subarray(5)
      })(),
      globalThis.fetch,
      { transport: 'tcp', onProgress: (uploaded) => { progress.push(uploaded) } },
    )

    expect(connections).toBe(1)
    expect(received.map(({ offset }) => offset)).toEqual([0, 4, 8, 12])
    expect(received.map(({ sequence }) => sequence)).toEqual([9, 10, 11, 12])
    expect(Buffer.concat(received.map(({ body: block }) => block))).toEqual(body)
    expect(progress).toEqual([4, 8, 12, 16])
  })

  it('keeps the first TCP segment at the negotiated block size', async () => {
    const blockSize = 256 * 1024
    const body = Buffer.alloc(blockSize + 7, 0x4c)
    const received: ReceivedFrame[] = []
    const server = await listen(createServer((socket) => {
      sockets.add(socket)
      parseFrames(socket, (frame) => {
        received.push(frame)
        socket.write(responseFrame(frame.offset, frame.length))
      })
    }))
    servers.push(server.server)

    await uploadHighway(
      highwayPlan(body, [server.address], blockSize),
      (async function* () { yield body })(),
      globalThis.fetch,
      { transport: 'tcp' },
    )

    expect(received.map(({ offset, length }) => ({ offset, length }))).toEqual([
      { offset: 0, length: blockSize },
      { offset: blockSize, length: 7 },
    ])
  })

  it('races a hung endpoint, closes the loser, and keeps later frames on the winner', async () => {
    const body = Buffer.alloc(12, 0x5a)
    const hungFrames: ReceivedFrame[] = []
    const winnerFrames: ReceivedFrame[] = []
    let loserClosed = false
    const hung = await listen(createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => { loserClosed = true })
      parseFrames(socket, (frame) => { hungFrames.push(frame) })
    }))
    const healthy = await listen(createServer((socket) => {
      sockets.add(socket)
      parseFrames(socket, (frame) => {
        winnerFrames.push(frame)
        socket.write(responseFrame(frame.offset, frame.length))
      })
    }))
    servers.push(hung.server, healthy.server)

    // The implementation tries the last unpinned QQ endpoint first.
    await uploadHighway(
      highwayPlan(body, [healthy.address, hung.address], 4),
      (async function* () { yield body })(),
      globalThis.fetch,
      { transport: 'tcp', fallbackDelayMs: 10 },
    )

    expect(hungFrames).toHaveLength(1)
    expect(winnerFrames).toHaveLength(3)
    expect(Buffer.concat(winnerFrames.map(({ body: block }) => block))).toEqual(body)
    await vi.waitFor(() => expect(loserClosed).toBe(true))
  })

  it('destroys a selected socket when the upload is aborted', async () => {
    const body = Buffer.alloc(8, 0x6b)
    let selectedClosed = false
    const firstAck = Promise.withResolvers<void>()
    const server = await listen(createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => { selectedClosed = true })
      parseFrames(socket, (frame) => {
        if (frame.offset === 0) {
          socket.write(responseFrame(frame.offset, frame.length))
          firstAck.resolve()
        }
      })
    }))
    servers.push(server.server)
    const controller = new AbortController()
    const upload = uploadHighway(
      highwayPlan(body, [server.address], 4),
      (async function* () {
        yield body
        await firstAck.promise
        controller.abort(new Error('test abort'))
      })(),
      globalThis.fetch,
      { transport: 'tcp', signal: controller.signal },
    )

    await expect(upload).rejects.toThrow('test abort')
    await vi.waitFor(() => expect(selectedClosed).toBe(true))
  })
})

function highwayPlan(
  body: Buffer,
  servers: Array<{ host: string, port: number }>,
  blockSize: number,
): QQHighwayUploadPlan {
  return {
    servers,
    ticket: Buffer.from('ticket').toString('base64url'),
    extendInfo: Buffer.from('extend').toString('base64url'),
    selfUin: '1715311957', commandId: 1005, sequenceStart: 9,
    blockSize, fileSize: body.length,
    fileMd5: createHash('md5').update(body).digest('hex'),
  }
}

async function listen(server: Server): Promise<{
  server: Server
  address: { host: string, port: number }
}> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test server address')
  return { server, address: { host: '127.0.0.1', port: address.port } }
}

function parseFrames(socket: Socket, onFrame: (frame: ReceivedFrame) => void | Promise<void>): void {
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)])
    while (buffered.length >= 10) {
      const headLength = buffered.readUInt32BE(1)
      const bodyLength = buffered.readUInt32BE(5)
      const frameLength = 10 + headLength + bodyLength
      if (buffered.length < frameLength) return
      const frame = buffered.subarray(0, frameLength)
      buffered = buffered.subarray(frameLength)
      const head = fromBinary(HighwayRequestHeadSchema, frame.subarray(9, 9 + headLength))
      void onFrame({
        body: frame.subarray(9 + headLength, 9 + headLength + bodyLength),
        offset: Number(head.segment!.offset),
        length: head.segment!.length,
        sequence: head.base!.sequence,
      })
    }
  })
}

function responseFrame(offset: number, length: number): Buffer {
  const head = Buffer.from(toBinary(HighwayResponseHeadSchema, create(HighwayResponseHeadSchema, {
    segment: { offset: BigInt(offset), length, returnCode: 0 },
  })))
  const frame = Buffer.alloc(10 + head.length)
  frame[0] = 0x28
  frame.writeUInt32BE(head.length, 1)
  frame.writeUInt32BE(0, 5)
  head.copy(frame, 9)
  frame[frame.length - 1] = 0x29
  return frame
}
