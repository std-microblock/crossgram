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
