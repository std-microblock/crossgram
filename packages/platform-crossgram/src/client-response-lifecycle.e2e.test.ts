import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { QQNTClient } from './client.js'

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('QQNTClient response lifecycle', () => {
  let server: Server | undefined
  const sockets = new Set<Socket>()

  afterEach(async () => {
    if (!server) return
    server.close()
    server.closeAllConnections()
    await once(server, 'close')
    server = undefined
    sockets.clear()
  })

  it('does not accumulate abandoned bridge sockets while stale media falls back to the QQ CDN', async () => {
    let activeStaleResponses = 0
    let maximumActiveStaleResponses = 0
    let closedStaleResponses = 0
    server = createServer(async (request, response) => {
      if (request.url === '/v1/files/asset') {
        for await (const _chunk of request) { /* drain locator */ }
        activeStaleResponses++
        maximumActiveStaleResponses = Math.max(maximumActiveStaleResponses, activeStaleResponses)
        response.once('close', () => {
          activeStaleResponses--
          closedStaleResponses++
        })
        response.writeHead(404, { 'content-type': 'application/json' })
        response.write('{"error":"stale local path"}')
        return
      }
      if (request.url === '/v1/files/direct-url') {
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ url: `http://127.0.0.1:${address.port}/cdn/photo.jpg` }))
        return
      }
      if (request.url === '/cdn/photo.jpg') {
        response.end('x')
        return
      }
      response.writeHead(500).end('unexpected request')
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const locator = {
      messageId: 'message', elementId: 'element', chatType: 2 as const, peerUid: 'group',
      kind: 'image' as const, fileName: 'photo.jpg', filePath: '/stale/photo.jpg', fileUuid: 'remote-photo',
    }

    for (let index = 0; index < 32; index++) {
      await expect(collect(client.downloadFile(locator))).resolves.toEqual(Buffer.from('x'))
    }
    await waitFor(() => closedStaleResponses === 32 && activeStaleResponses === 0)

    expect(maximumActiveStaleResponses).toBeLessThanOrEqual(2)
    expect(sockets.size).toBeLessThanOrEqual(3)
  })

  it('requests sticker ranges and cancels a bridge response that ignores the range', async () => {
    let activeResponses = 0
    let closedResponses = 0
    let receivedRange: string | undefined
    server = createServer(async (request, response) => {
      if (request.url !== '/v1/stickers/asset') {
        response.writeHead(500).end('unexpected request')
        return
      }
      for await (const _chunk of request) { /* drain reference */ }
      receivedRange = request.headers.range
      activeResponses++
      const interval = setInterval(() => response.write('abcdefgh'), 10)
      response.once('close', () => {
        clearInterval(interval)
        activeResponses--
        closedResponses++
      })
      response.writeHead(200, { 'content-type': 'image/png' })
      response.write('abcdefgh')
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const source = client.stickerSource({
      kind: 'favorite', resId: 'saved', path: '/saved/sticker.png', name: 'sticker.png', animated: false,
    })

    await expect(collect(source.streamRange!({ offset: 4, limit: 4 })))
      .resolves.toEqual(Buffer.from('efgh'))
    await waitFor(() => closedResponses === 1 && activeResponses === 0)

    expect(receivedRange).toBe('bytes=4-7')
    expect(sockets.size).toBeLessThanOrEqual(1)
  })
})
