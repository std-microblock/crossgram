import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { QQNTClient } from './client.js'

describe('QQNTClient streaming transport', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (!server) return
    server.close()
    await once(server, 'close')
  })

  it('forwards message search filters and opaque cursors', async () => {
    let requestUrl = ''
    server = createServer((request, response) => {
      requestUrl = request.url ?? ''
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ messages: [], nextCursor: 'next' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })

    await expect(client.searchMessages('group/1', {
      q: '测试 key', cursor: 'opaque', limit: 25, fromUserId: 'sender',
      minTimestamp: 10, maxTimestamp: 20, mediaKind: 'image',
    })).resolves.toEqual({ messages: [], nextCursor: 'next' })
    expect(requestUrl).toBe('/conversations/group%2F1/search?q=%E6%B5%8B%E8%AF%95+key&cursor=opaque&limit=25&fromUserId=sender&minTimestamp=10&maxTimestamp=20&mediaKind=image')
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
    const message = await client.sendMessage('1:uid', 'caption', [{
      kind: 'file', name: 'x.mp4', mimeType: 'video/mp4', width: 320, height: 200, duration: 9,
      source: { size: 5, async *stream() { yield* chunks } },
    }], { onProgress: (item) => { progress.push(item.transferredBytes) } }, 'origin-1')
    expect(message.id).toBe('sent')
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(progress).toEqual([2, 5])
    expect(manifest).toMatchObject({
      conversationId: '1:uid', originRequestId: 'origin-1',
      media: [{ mimeType: 'video/mp4', width: 320, height: 200, duration: 9 }],
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
    await expect(client.sendMessage('1:uid', undefined, [{
      kind: 'file', name: 'short.bin',
      source: { size: 10, async *stream() { yield new Uint8Array([1, 2]) } },
    }])).rejects.toThrow(/incomplete media source/)
  })

  it('frames multiple media streams independently and reports per-item progress', async () => {
    const received: Buffer[] = []
    let manifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      const encoded = request.headers['x-qqnt-manifest']
      if (typeof encoded === 'string') manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      for await (const chunk of request) received.push(Buffer.from(chunk))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        id: 'sent', conversationId: '1:uid', senderId: 'self', timestamp: 1, outgoing: true, parts: [],
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const progress: Array<[number, number]> = []

    await client.sendMessage('1:uid', undefined, [{
      kind: 'image', name: 'one.png', source: { async *stream() { yield Uint8Array.of(1, 2) } },
    }, {
      kind: 'image', name: 'two.png', source: { async *stream() { yield Uint8Array.of(3, 4, 5) } },
    }], { onProgress: (item) => { progress.push([item.mediaIndex, item.transferredBytes]) } })

    expect(Buffer.concat(received)).toEqual(Buffer.from([
      0, 0, 0, 2, 1, 2, 0, 0, 0, 0,
      0, 0, 0, 3, 3, 4, 5, 0, 0, 0, 0,
    ]))
    expect(progress).toEqual([[0, 2], [1, 3]])
    expect(manifest).toMatchObject({
      mediaFraming: 'length-prefixed-v1',
      media: [{ name: 'one.png' }, { name: 'two.png' }],
    })
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

  it('requests only the byte range needed for video playback', async () => {
    let range = ''
    let bridgeDownloads = 0
    let resolverAuthorization = ''
    let cdnAuthorization = ''
    server = createServer(async (request, response) => {
      if (request.url === '/files/play-url') {
        resolverAuthorization = request.headers.authorization ?? ''
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ url: `http://127.0.0.1:${address.port}/qq-cdn/video` }))
      } else if (request.url === '/qq-cdn/video') {
        range = request.headers.range ?? ''
        cdnAuthorization = request.headers.authorization ?? ''
        response.writeHead(206, {
          'content-range': 'bytes 4-7/10',
          'content-length': '4',
        })
        response.end('efgh')
      } else {
        bridgeDownloads++
        response.writeHead(500).end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}`, token: 'bridge-token' })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'video', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'file', fileName: 'clip.mp4', videoCodecFormat: 0,
    }, { offset: 4, limit: 4 })) chunks.push(chunk)

    expect(range).toBe('bytes=4-7')
    expect(resolverAuthorization).toBe('Bearer bridge-token')
    expect(cdnAuthorization).toBe('')
    expect(bridgeDownloads).toBe(0)
    expect(Buffer.concat(chunks).toString()).toBe('efgh')
  })

  it('falls back to the bridge when a native video play URL is unavailable', async () => {
    let range = ''
    server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain locator */ }
      if (request.url === '/files/play-url') {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'expired' }))
        return
      }
      range = request.headers.range ?? ''
      response.writeHead(206, { 'content-range': 'bytes 2-4/8', 'content-length': '3' })
      response.end('cde')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'video', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'file', fileName: 'clip.mp4', videoCodecFormat: 0,
    }, { offset: 2, limit: 3 })) chunks.push(chunk)

    expect(range).toBe('bytes=2-4')
    expect(Buffer.concat(chunks).toString()).toBe('cde')
  })

  it('locally slices a whole-file response from an older bridge', async () => {
    server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain locator */ }
      response.end('abcdefghij')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'video', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'file', fileName: 'clip.mp4',
    }, { offset: 3, limit: 3 })) chunks.push(chunk)

    expect(Buffer.concat(chunks).toString()).toBe('def')
  })

  it('uses the independent WebSocket endpoint, parses frames sequentially, and resumes from the acknowledged event', async () => {
    let requestUrl = ''
    server = createServer()
    const webSocketServer = new WebSocketServer({ server })
    webSocketServer.on('connection', (webSocket, request) => {
      requestUrl = request.url ?? ''
      webSocket.send('{"id":"10","event":{"type":"message-delete","eventId":"a","conversation":{"id":"2:g","kind":"group","title":"g","peerUid":"g","peerUin":"g","chatType":2},"messageIds":["1"],"timestamp":1}}')
      webSocket.send('{"id":"11","event":{"type":"message-delete","eventId":"b","conversation":{"id":"2:g","kind":"group","title":"g","peerUid":"g","peerUin":"g","chatType":2},"messageIds":["2"],"timestamp":2}}', () => webSocket.close())
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: 'http://127.0.0.1:1/v1',
      webSocketEndpoint: `ws://127.0.0.1:${address.port}/custom/events?stream=qqnt`,
    })
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
    expect(requestUrl).toBe('/custom/events?stream=qqnt&lastEventId=9')
    expect(order).toEqual(['a:10:start', 'a:10:end', 'b:11:start', 'b:11:end'])
    expect(acknowledged).toEqual(['10', '11'])
  })

  it('derives the WebSocket endpoint from the HTTP endpoint when no override is configured', () => {
    expect(new QQNTClient({ endpoint: 'https://bridge.example/v1/' }).webSocketEndpoint)
      .toBe('https://bridge.example/v1/events/ws')
  })
})
