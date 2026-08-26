import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { uploadHighway, type QQHighwayUploadPlan } from './highway.js'

describe('QQ Highway server selection E2E', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      server.close()
      server.closeAllConnections()
      await once(server, 'close')
    }))
  })

  it('waits for a slow healthy server instead of uploading the same block to every fallback', async () => {
    const body = Buffer.alloc(256 * 1024, 0x5a)
    const received = [0, 0]
    const primary = await listen(createServer(async (request, response) => {
      received[0] += (await collect(request)).length
      await new Promise((resolve) => setTimeout(resolve, 200))
      response.setHeader('connection', 'close')
      response.end(highwayResponse())
    }))
    const fallback = await listen(createServer(async (request, response) => {
      received[1] += (await collect(request)).length
      response.setHeader('connection', 'close')
      response.end(highwayResponse())
    }))
    servers.push(primary.server, fallback.server)

    const plan: QQHighwayUploadPlan = {
      servers: [primary.address, fallback.address],
      ticket: Buffer.from('ticket').toString('base64url'),
      extendInfo: Buffer.from('extend').toString('base64url'),
      selfUin: '1715311957', commandId: 1003, sequenceStart: 9,
      blockSize: body.length, fileSize: body.length,
      fileMd5: createHash('md5').update(body).digest('hex'),
    }

    await uploadHighway(plan, (async function* () { yield body })(), globalThis.fetch)

    expect(received[0]).toBeGreaterThan(body.length)
    expect(received[1]).toBe(0)
  })

  it('hedges a response-hung server once, then pins the healthy server for every later block', async () => {
    const body = Buffer.alloc(512 * 1024, 0x6b)
    const received: Buffer[][] = [[], []]
    const primary = await listen(createServer(async (request) => {
      received[0].push(await collect(request))
      // Deliberately leave the response open. A real bad Highway node observed
      // in production accepted the request body but never returned headers.
    }))
    const fallback = await listen(createServer(async (request, response) => {
      received[1].push(await collect(request))
      response.setHeader('connection', 'close')
      response.end(highwayResponse())
    }))
    servers.push(primary.server, fallback.server)

    const plan: QQHighwayUploadPlan = {
      servers: [primary.address, fallback.address],
      ticket: Buffer.from('ticket').toString('base64url'),
      extendInfo: Buffer.from('extend').toString('base64url'),
      selfUin: '1715311957', commandId: 1003, sequenceStart: 9,
      blockSize: body.length / 2, fileSize: body.length,
      fileMd5: createHash('md5').update(body).digest('hex'),
    }

    const startedAt = performance.now()
    await uploadHighway(
      plan,
      (async function* () { yield body })(),
      globalThis.fetch,
      { attemptTimeoutMs: 5_000, fallbackDelayMs: 50 },
    )
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    await uploadHighway(plan, (async function* () { yield body })(), globalThis.fetch)

    expect(received[0]).toHaveLength(1)
    expect(received[1]).toHaveLength(6)
    expect(Buffer.concat(received[1].map(highwayBody))).toEqual(Buffer.concat([body, body]))
  })

  it('sends later blocks concurrently after the first block selects a server', async () => {
    const body = Buffer.alloc(3 * 128 * 1024, 0x7c)
    let requests = 0
    let releaseLater!: () => void
    const laterArrived = new Promise<void>((resolve) => { releaseLater = resolve })
    const server = await listen(createServer(async (request, response) => {
      await collect(request)
      requests++
      if (requests === 1) {
        response.end(highwayResponse())
        return
      }
      if (requests === 3) releaseLater()
      await laterArrived
      response.end(highwayResponse())
    }))
    servers.push(server.server)
    const plan: QQHighwayUploadPlan = {
      servers: [server.address],
      ticket: Buffer.from('ticket').toString('base64url'),
      extendInfo: Buffer.from('extend').toString('base64url'),
      selfUin: '1715311957', commandId: 1003, sequenceStart: 9,
      blockSize: body.length / 3, fileSize: body.length,
      fileMd5: createHash('md5').update(body).digest('hex'),
    }

    await uploadHighway(
      plan,
      (async function* () { yield body })(),
      globalThis.fetch,
      { attemptTimeoutMs: 2_000 },
    )
    expect(requests).toBe(3)
  })
})

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

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function highwayResponse(): Buffer {
  return Buffer.from([0x28, 0, 0, 0, 0, 0, 0, 0, 0, 0x29])
}

function highwayBody(frame: Buffer): Buffer {
  const headLength = frame.readUInt32BE(1)
  const bodyLength = frame.readUInt32BE(5)
  return frame.subarray(9 + headLength, 9 + headLength + bodyLength)
}
