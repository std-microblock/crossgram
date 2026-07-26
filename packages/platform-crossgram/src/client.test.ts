import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { QQNTClient } from './client.js'

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
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

describe('QQNTClient streaming transport', () => {
  let server: Server | undefined
  afterEach(async () => {
    vi.restoreAllMocks()
    if (!server) return
    server.close()
    await once(server, 'close')
  })

  it('posts opaque read boundaries to the QQNT bridge', async () => {
    const requests: Array<{ url: string, method?: string, body: unknown, authorization?: string }> = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      token: 'secret',
      fetch: vi.fn(async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
          url: String(input), method: init?.method,
          body: JSON.parse(String(init?.body)),
          authorization: headers.get('authorization') ?? undefined,
        })
        return Response.json({ ok: true })
      }),
    })

    await client.markRead('2:group/opaque', 'msg/opaque:42')

    expect(requests).toEqual([{
      url: 'http://bridge.invalid/v1/messages/read', method: 'POST',
      body: { conversationId: '2:group/opaque', messageId: 'msg/opaque:42' },
      authorization: 'Bearer secret',
    }])
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

  it('streams media directly to QQ Highway and posts only CDN metadata to the local bridge', async () => {
    const highwayFrames: Buffer[] = []
    const localMessageBodies: Buffer[] = []
    let manifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      if (request.url === '/uploads/prepare') {
        const body = JSON.parse((await collect(request)).toString())
        expect(body).toMatchObject({ conversationId: '1:uid', media: {
          kind: 'file', name: 'x.mp4', size: 5,
          md5: '7cfdd07889b3295d6a550914ab35e068',
        } })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: { kind: 'file', fileUuid: 'file-uuid', fileHash: 'file-hash', exists: false, commandId: 95 },
          highway: {
            servers: [{ host: '127.0.0.1', port: (server!.address() as { port: number }).port }],
            ticket: Buffer.from('ticket').toString('base64url'),
            extendInfo: Buffer.from('extend').toString('base64url'),
            selfUin: '1715311957', commandId: 95, sequenceStart: 71,
            blockSize: 2, fileSize: 5, fileMd5: '7cfdd07889b3295d6a550914ab35e068',
          },
        }))
        return
      }
      if (request.url?.startsWith('/cgi-bin/httpconn?')) {
        highwayFrames.push(await collect(request))
        response.end(highwayResponse())
        return
      }
      const encoded = request.headers['x-qqnt-manifest']
      if (typeof encoded === 'string') manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      localMessageBodies.push(await collect(request))
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
    let streamCalls = 0
    const message = await client.sendMessage('1:uid', 'caption', [{
      kind: 'file', name: 'x.mp4', mimeType: 'video/mp4', width: 320, height: 200, duration: 9,
      source: { size: 5, async *stream() { streamCalls++; yield* chunks } },
    }], { onProgress: (item) => { progress.push(item.transferredBytes) } }, 'origin-1')
    expect(message.id).toBe('sent')
    expect(Buffer.concat(highwayFrames.map(highwayBody))).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(highwayFrames.map((frame) => frame.readUInt32BE(5))).toEqual([2, 2, 1])
    expect(progress).toEqual([2, 4, 5])
    expect(streamCalls).toBe(2)
    expect(localMessageBodies).toEqual([Buffer.alloc(0)])
    expect(manifest).toMatchObject({
      conversationId: '1:uid', originRequestId: 'origin-1',
      media: [{
        mimeType: 'video/mp4', width: 320, height: 200, duration: 9, size: 5,
        md5: '7cfdd07889b3295d6a550914ab35e068',
        sha1: '11966ab9c099f8fabefac54c08d5be2bd8c903af',
        file10MMd5: '7cfdd07889b3295d6a550914ab35e068',
      }],
      uploadedMedia: [{
        kind: 'file', fileUuid: 'file-uuid', fileHash: 'file-hash', exists: false, commandId: 95,
      }],
    })
    expect(manifest).not.toHaveProperty('mediaFraming')
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

  it('uses fast-upload metadata for multiple media without reopening or posting their bytes', async () => {
    const localBodies: Buffer[] = []
    let manifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      if (request.url === '/uploads/prepare') {
        const body = JSON.parse((await collect(request)).toString()) as { media: { name: string } }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: {
            kind: 'image', fileUuid: `${body.media.name}-uuid`,
            msgInfo: Buffer.from(`${body.media.name}-msg-info`).toString('base64url'),
          },
        }))
        return
      }
      const encoded = request.headers['x-qqnt-manifest']
      if (typeof encoded === 'string') manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      localBodies.push(await collect(request))
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
    const streamCalls = [0, 0]

    await client.sendMessage('1:uid', undefined, [{
      kind: 'image', name: 'one.png', source: { async *stream() { streamCalls[0]++; yield Uint8Array.of(1, 2) } },
    }, {
      kind: 'image', name: 'two.png', source: { async *stream() { streamCalls[1]++; yield Uint8Array.of(3, 4, 5) } },
    }], { onProgress: (item) => { progress.push([item.mediaIndex, item.transferredBytes]) } })

    expect(localBodies).toEqual([Buffer.alloc(0)])
    expect(progress).toEqual([[0, 2], [1, 3]])
    expect(streamCalls).toEqual([1, 1])
    expect(manifest).toMatchObject({
      media: [{ name: 'one.png' }, { name: 'two.png' }],
      uploadedMedia: [
        { kind: 'image', fileUuid: 'one.png-uuid' },
        { kind: 'image', fileUuid: 'two.png-uuid' },
      ],
    })
    expect(manifest).not.toHaveProperty('mediaFraming')
  })

  it('downloads user and group avatars from platform-constructed qlogo URLs', async () => {
    const requests: Array<{ url: string, range?: string, authorization?: string }> = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      token: 'bridge-token',
      fetch: vi.fn(async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
          url: String(input), range: headers.get('range') ?? undefined,
          authorization: headers.get('authorization') ?? undefined,
        })
        return new Response('abcdefghij')
      }),
    })
    const user = await collect(client.downloadFile({
      messageId: 'avatar:user:opaque', elementId: 'avatar:user:opaque',
      chatType: 1, peerUid: 'opaque', kind: 'image', fileName: '1715311957.jpg',
      avatarUin: '1715311957',
    }, { offset: 2, limit: 3 }))
    const group = await collect(client.downloadFile({
      messageId: 'avatar:group:1058754719', elementId: 'avatar:group:1058754719',
      chatType: 2, peerUid: '1058754719', kind: 'image', fileName: 'group.jpg',
      filePath: 'C:\\qq\\group-avatar',
    }, { offset: 4, limit: 2 }))

    expect(user.toString()).toBe('cde')
    expect(group.toString()).toBe('ef')
    expect(requests).toEqual([{
      url: 'https://q1.qlogo.cn/g?b=qq&nk=1715311957&s=640',
      range: 'bytes=2-4', authorization: undefined,
    }, {
      url: 'https://p.qlogo.cn/gh/1058754719/1058754719/640/',
      range: 'bytes=4-5', authorization: undefined,
    }])
  })

  it('rejects bridge-local file paths without issuing a download request', async () => {
    const fetch = vi.fn()
    const client = new QQNTClient({ fetch })
    const locator = {
      messageId: 'reaction:C:\\qq\\s14.png', elementId: 'reaction:C:\\qq\\s14.png',
      chatType: 1 as const, peerUid: '', kind: 'image' as const,
      fileName: 's14.png', filePath: 'C:\\qq\\s14.png', fileSize: '5',
    }
    await expect(collect(client.downloadFile(locator, { offset: 1, limit: 3 })))
      .rejects.toThrow('no remote direct-link identity')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('downloads catalog-keyed reaction ranges through the dedicated authenticated route', async () => {
    const requests: Array<{ url: string, body: unknown, range?: string, authorization?: string }> = []
    const progress: number[] = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      token: 'bridge-token',
      fetch: vi.fn(async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
          url: String(input), body: JSON.parse(String(init?.body)),
          range: headers.get('range') ?? undefined,
          authorization: headers.get('authorization') ?? undefined,
        })
        return new Response('bcd', { status: 206 })
      }),
    })

    const bytes = await collect(client.downloadReactionResource('1:14', {
      offset: 1, limit: 3, onChunk: (size) => { progress.push(size) },
    }))

    expect(bytes.toString()).toBe('bcd')
    expect(progress).toEqual([3])
    expect(requests).toEqual([{
      url: 'http://bridge.invalid/v1/reactions/asset',
      body: { reactionKey: '1:14' },
      range: 'bytes=1-3', authorization: 'Bearer bridge-token',
    }])
  })

  it('slices a full reaction response locally and propagates bridge errors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('abcdefghij'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'reaction resource not found' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }))
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(collect(client.downloadReactionResource('1:265', { offset: 4, limit: 3 })))
      .resolves.toEqual(Buffer.from('efg'))
    await expect(collect(client.downloadReactionResource('missing')))
      .rejects.toThrow('reaction resource not found')
  })

  it('rejects an ambiguous locator instead of silently falling back for native media', async () => {
    const fetch = vi.fn()
    const client = new QQNTClient({ fetch })
    const download = collect(client.downloadFile({
      messageId: 'native-image', elementId: 'element', chatType: 2,
      peerUid: 'group', kind: 'image', fileName: 'photo.jpg',
    }))

    await expect(download).rejects.toThrow('no remote direct-link identity')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('always resolves and downloads the native media URL', async () => {
    const requestUrls: string[] = []
    server = createServer(async (request, response) => {
      requestUrls.push(request.url ?? '')
      if (request.url === '/files/direct-url') {
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ url: `http://127.0.0.1:${address.port}/native-file` }))
      } else if (request.url === '/native-file') {
        response.end('complete-file')
      } else {
        response.writeHead(500).end('non-native path must not be called')
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'm', elementId: 'e', chatType: 1, peerUid: 'u',
      kind: 'image', fileName: 'x.jpg', originImageUrl: 'https://qq.example/expired',
    })) chunks.push(chunk)

    expect(requestUrls).toEqual(['/files/direct-url', '/native-file'])
    expect(Buffer.concat(chunks).toString()).toBe('complete-file')
  })

  it('single-flights concurrent private-file URL resolution and sends only requested CDN ranges', async () => {
    const ranges: string[] = []
    let bridgeDownloads = 0
    let resolverRequests = 0
    let resolverBody: Record<string, unknown> | undefined
    let resolverAuthorization = ''
    const cdnAuthorizations: string[] = []
    server = createServer(async (request, response) => {
      if (request.url === '/files/direct-url') {
        resolverRequests++
        resolverAuthorization = request.headers.authorization ?? ''
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        resolverBody = JSON.parse(Buffer.concat(chunks).toString())
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/qq-cdn/file`, expiresAt: Date.now() + 60_000,
        }))
      } else if (request.url === '/qq-cdn/file') {
        const range = request.headers.range ?? ''
        ranges.push(range)
        cdnAuthorizations.push(request.headers.authorization ?? '')
        const start = range === 'bytes=0-3' ? 0 : 4
        response.writeHead(206, {
          'content-range': `bytes ${start}-${start + 3}/10`,
          'content-length': '4',
        })
        response.end(start === 0 ? 'abcd' : 'efgh')
      } else {
        bridgeDownloads++
        response.writeHead(500).end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}`, token: 'bridge-token',
    })
    const locator = {
      messageId: 'private-file', elementId: 'element', chatType: 1 as const, peerUid: 'friend-uid',
      kind: 'file' as const, fileName: 'document.bin', fileUuid: 'private-file-uuid',
      file10MMd5: 'first-10m-md5',
    }
    const [first, second] = await Promise.all([
      collect(client.downloadFile(locator, { offset: 0, limit: 4 })),
      collect(client.downloadFile(locator, { offset: 4, limit: 4 })),
    ])

    expect(resolverRequests).toBe(1)
    expect(resolverBody).toMatchObject({
      fileUuid: 'private-file-uuid', file10MMd5: 'first-10m-md5',
    })
    expect(resolverBody).not.toHaveProperty('filePath')
    expect(ranges.sort()).toEqual(['bytes=0-3', 'bytes=4-7'])
    expect(resolverAuthorization).toBe('Bearer bridge-token')
    expect(cdnAuthorizations).toEqual(['', ''])
    expect(bridgeDownloads).toBe(0)
    expect(first.toString()).toBe('abcd')
    expect(second.toString()).toBe('efgh')
  })

  it('reuses a file direct URL until the bridge-provided expiry and then refreshes it', async () => {
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let resolutions = 0
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === 'http://bridge.invalid/v1/files/direct-url') {
        resolutions++
        return new Response(JSON.stringify({
          url: 'https://cdn.qq.example/group-file', expiresAt: now + 100,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (String(input) === 'https://cdn.qq.example/group-file') return new Response('x')
      return new Response('unexpected', { status: 500 })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    const locator = {
      messageId: 'group-file', elementId: 'element', chatType: 2 as const, peerUid: '1002974327',
      kind: 'file' as const, fileName: 'document.bin', fileUuid: 'group-file-uuid',
    }

    await collect(client.downloadFile(locator))
    now += 99
    await collect(client.downloadFile(locator))
    expect(resolutions).toBe(1)
    now += 2
    await collect(client.downloadFile(locator))
    expect(resolutions).toBe(2)
  })

  it('downloads an image from its packet-refreshed direct URL without leaking bridge authorization', async () => {
    const requests: Array<{ url: string, range?: string, authorization?: string }> = []
    server = createServer(async (request, response) => {
      requests.push({
        url: request.url ?? '', range: request.headers.range, authorization: request.headers.authorization,
      })
      if (request.url === '/files/direct-url') {
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ url: `http://127.0.0.1:${address.port}/qq-cdn/image` }))
        return
      }
      if (request.url === '/qq-cdn/image') {
        response.writeHead(206, { 'content-range': 'bytes 1-3/5', 'content-length': '3' })
        response.end('bcd')
        return
      }
      response.writeHead(500).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}`, token: 'bridge-token',
    })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'image', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'image', fileName: 'photo.jpg',
      originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
    }, { offset: 1, limit: 3 })) chunks.push(chunk)

    expect(requests).toEqual([
      { url: '/files/direct-url', range: undefined, authorization: 'Bearer bridge-token' },
      { url: '/qq-cdn/image', range: 'bytes=1-3', authorization: undefined },
    ])
    expect(Buffer.concat(chunks).toString()).toBe('bcd')
  })

  it('reports a native video resolver failure without calling the non-native bridge path', async () => {
    const resolverUrls: string[] = []
    server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain locator */ }
      if (request.url === '/files/direct-url') {
        resolverUrls.push(request.url)
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'expired' }))
        return
      }
      response.writeHead(500).end('non-native path must not be called')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}`,
    })
    const download = collect(client.downloadFile({
      messageId: 'video', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'file', fileName: 'clip.mp4', fileUuid: 'video-uuid', videoCodecFormat: 0,
    }, { offset: 2, limit: 3 }))

    await expect(download).rejects.toThrow('QQNT bridge 500: expired')
    expect(resolverUrls).toEqual(['/files/direct-url'])
  })

  it('reports an image CDN failure without calling the non-native bridge path', async () => {
    const requestUrls: string[] = []
    server = createServer(async (request, response) => {
      requestUrls.push(request.url ?? '')
      if (request.url === '/files/direct-url') {
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ url: `http://127.0.0.1:${address.port}/expired-image` }))
      } else if (request.url === '/expired-image') {
        response.writeHead(403).end('expired')
      } else {
        response.writeHead(500).end('non-native path must not be called')
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}`,
    })
    const download = collect(client.downloadFile({
      messageId: 'image', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'image', fileName: 'photo.jpg',
      originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
    }, { offset: 2, limit: 3 }))

    await expect(download).rejects.toThrow('QQNT native media 403: expired')
    expect(requestUrls).toEqual(['/files/direct-url', '/expired-image'])
  })

  it('locally slices a whole-file response when the QQ CDN ignores Range', async () => {
    server = createServer(async (request, response) => {
      if (request.url === '/files/direct-url') {
        for await (const _chunk of request) { /* drain locator */ }
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${address.port}/qq-cdn/file`, expiresAt: Date.now() + 60_000,
        }))
      } else if (request.url === '/qq-cdn/file') {
        response.end('abcdefghij')
      } else {
        response.writeHead(500).end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.downloadFile({
      messageId: 'file', elementId: 'element', chatType: 2, peerUid: '1002974327',
      kind: 'file', fileName: 'document.bin', fileUuid: 'group-file-uuid',
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
