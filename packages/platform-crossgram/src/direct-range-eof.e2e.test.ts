import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { QQNTClient } from './client.js'

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('QQNT direct-range EOF transport', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.close()
    await once(server, 'close')
    server = undefined
  })

  it('serves the final partial block and an immediate EOF chunk without a bridge error', async () => {
    const file = Buffer.alloc(1024 * 1024 + 17, 0x5a)
    const requestedRanges: string[] = []
    server = createServer(async (request, response) => {
      if (request.url === '/v1/files/direct-url') {
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/cdn/file`,
          expiresAt: Date.now() + 60_000,
          supportsRange: true,
        }))
        return
      }
      if (request.url === '/cdn/file') {
        const range = request.headers.range ?? ''
        requestedRanges.push(range)
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)
        if (!match) return void response.writeHead(400).end()
        const start = Number(match[1])
        const requestedEnd = Number(match[2])
        if (start >= file.length) {
          response.writeHead(416, { 'content-range': `bytes */${file.length}` }).end()
          return
        }
        const end = Math.min(requestedEnd, file.length - 1)
        response.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${file.length}`,
          'content-length': String(end - start + 1),
        })
        response.end(file.subarray(start, end + 1))
        return
      }
      response.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const locator = {
      messageId: 'eof-e2e', elementId: 'element', chatType: 2 as const, peerUid: 'group',
      kind: 'file' as const, fileName: 'partial.bin', fileUuid: 'eof-e2e-uuid',
    }

    const tail = await collect(client.downloadFile(locator, { offset: 1024 * 1024, limit: 128 * 1024 }))
    const eof = await collect(client.downloadFile(locator, {
      offset: 2 * 1024 * 1024,
      limit: 128 * 1024,
    }))

    expect(tail).toEqual(file.subarray(1024 * 1024))
    expect(eof).toEqual(Buffer.alloc(0))
    expect(requestedRanges).toEqual([
      'bytes=1048576-2097151',
      'bytes=2097152-3145727',
    ])
  })
})
