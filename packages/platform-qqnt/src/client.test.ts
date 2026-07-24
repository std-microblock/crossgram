import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { QQNTClient } from './client.js'

describe('QQNTClient streaming transport', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (!server) return
    server.close()
    await once(server, 'close')
  })

  it('streams upload chunks and reports monotonic progress', async () => {
    const received: Buffer[] = []
    let manifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      const encoded = request.headers['x-qqnt-manifest']
      if (typeof encoded === 'string') manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      try {
        for await (const chunk of request) received.push(Buffer.from(chunk))
      } catch {
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        id: 'sent', conversationId: '1:uid', senderId: 'self', timestamp: 1, outgoing: true,
        parts: [{ type: 'text', text: 'caption' }],
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
    const progress: number[] = []
    const message = await client.sendMessage('1:uid', 'caption', {
      kind: 'file', name: 'x.bin', width: 320, height: 200,
      source: { size: 5, async *stream() { yield* chunks } },
    }, { onProgress: (item) => { progress.push(item.transferredBytes) } }, 'origin-1')
    expect(message.id).toBe('sent')
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(progress).toEqual([2, 5])
    expect(manifest).toMatchObject({
      conversationId: '1:uid', originRequestId: 'origin-1',
      media: [{ width: 320, height: 200 }],
    })
  })

  it('does not silently accept a short media source', async () => {
    server = createServer(async (request, response) => {
      try {
        for await (const _chunk of request) { /* drain */ }
      } catch {
        return
      }
      response.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    await expect(client.sendMessage('1:uid', undefined, {
      kind: 'file', name: 'short.bin',
      source: { size: 10, async *stream() { yield new Uint8Array([1, 2]) } },
    })).rejects.toThrow(/incomplete media source/)
  })

  it('downloads a complete file without sending range controls', async () => {
    let requestUrl = ''
    let requestHeaders: import('node:http').IncomingHttpHeaders = {}
    server = createServer(async (request, response) => {
      requestUrl = request.url ?? ''
      requestHeaders = request.headers
      for await (const _chunk of request) { /* drain locator */ }
      response.end('complete-file')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'm', elementId: 'e', chatType: 1, peerUid: 'u',
      kind: 'file', fileName: 'x.bin',
    })) chunks.push(chunk)

    expect(requestUrl).toBe('/files/download')
    expect(requestHeaders['x-qqnt-offset']).toBeUndefined()
    expect(requestHeaders['x-qqnt-limit']).toBeUndefined()
    expect(Buffer.concat(chunks).toString()).toBe('complete-file')
  })

  it('parses SSE frames sequentially so handler completion provides backpressure', async () => {
    let resumeHeader: string | string[] | undefined
    server = createServer((request, response) => {
      resumeHeader = request.headers['last-event-id']
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('id: 10\ndata: {"type":"message-delete","eventId":"a","conversation":{"id":"2:g","kind":"group","title":"g","peerUid":"g","peerUin":"g","chatType":2},"messageIds":["1"],"timestamp":1}\n\n')
      response.end('id: 11\ndata: {"type":"message-delete","eventId":"b","conversation":{"id":"2:g","kind":"group","title":"g","peerUid":"g","peerUin":"g","chatType":2},"messageIds":["2"],"timestamp":2}\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const order: string[] = []
    const acknowledged: string[] = []
    await client.subscribe(async (event, eventId) => {
      order.push(`${event.type === 'message-delete' ? event.eventId : '?'}:${eventId}:start`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${event.type === 'message-delete' ? event.eventId : '?'}:${eventId}:end`)
    }, new AbortController().signal, {
      lastEventId: '9',
      onEventId: (eventId) => acknowledged.push(eventId),
    })
    expect(resumeHeader).toBe('9')
    expect(order).toEqual(['a:10:start', 'a:10:end', 'b:11:start', 'b:11:end'])
    expect(acknowledged).toEqual(['10', '11'])
  })
})
