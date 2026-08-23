import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { QQNTClient, QQNTMessageSendRejectedError } from './client.js'

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

function decodeFramedFiles(body: Buffer): Buffer[] {
  const files: Buffer[] = []
  let offset = 0
  while (offset < body.length) {
    const chunks: Buffer[] = []
    for (;;) {
      const length = body.readUInt32BE(offset)
      offset += 4
      if (!length) break
      chunks.push(body.subarray(offset, offset + length))
      offset += length
    }
    files.push(Buffer.concat(chunks))
  }
  return files
}

describe('QQNTClient streaming transport', () => {
  let server: Server | undefined
  afterEach(async () => {
    vi.restoreAllMocks()
    if (!server) return
    server.close()
    await once(server, 'close')
  })

  it('classifies upload preparation rejection as a permanent message send error', async () => {
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async () => Response.json({
        error: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
      }, { status: 422 })),
    })

    const error = await client.prepareMediaUpload('group', {
      kind: 'file', name: 'full.bin', size: 3,
      md5: '5289df737df57326fcdd22597afb1fac',
      sha1: '7037807198c22a7d2b0807371d763779a84fdfcf',
      file10MMd5: '5289df737df57326fcdd22597afb1fac',
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(QQNTMessageSendRejectedError)
    expect(error).toMatchObject({
      message: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
    })
  })

  it('treats a bridge sticker range past EOF as an empty Telegram chunk', async () => {
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async () => new Response(null, {
        status: 416, headers: { 'content-range': 'bytes */128' },
      })),
    })
    const source = client.stickerSource({
      kind: 'market', packageId: '42', stickerId: 'wave', name: 'wave', key: 'key',
      width: 240, height: 240, animated: true,
    })

    await expect(collect(source.streamRange!({ offset: 128, limit: 32 })))
      .resolves.toEqual(Buffer.alloc(0))
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

  it('reuses QQ-origin media and streams only new inputs through the flash-transfer endpoint', async () => {
    let manifest: Record<string, unknown> | undefined
    let body: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let authorization: string | undefined
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/status') {
        response.end(JSON.stringify({ protocolVersion: 28, ready: true }))
        return
      }
      const encoded = request.headers['x-qqnt-flash-manifest']
      if (typeof encoded === 'string') manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      authorization = request.headers.authorization
      body = await collect(request)
      response.end(JSON.stringify({
        fileSetId: 'fileset-1', shareLink: 'https://qq.example/flash/code', expiresAt: 2_000_000_000_000,
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}`, token: 'secret' })

    await expect(client.createFlashTransfer([{
      kind: 'file', name: 'alpha.txt', size: 5,
      source: { size: 5, async *stream() { throw new Error('QQ-origin bytes must not be read') } },
      origin: {
        id: 'qq-alpha', kind: 'file', name: 'alpha.txt', size: 5,
        locator: {
          messageId: 'm1', elementId: 'e1', chatType: 1, peerUid: 'friend',
          kind: 'file', fileName: 'alpha.txt', filePath: '/qq-cache/alpha.txt', cachedPath: '/relay-cache',
        },
      },
    }, {
      kind: 'file', name: 'beta.bin', size: 3,
      source: { size: 3, async *stream() { yield Uint8Array.of(1, 2, 3) } },
    }], { name: 'Telegram files' })).resolves.toEqual({
      fileSetId: 'fileset-1', shareLink: 'https://qq.example/flash/code', expiresAt: 2_000_000_000_000,
    })
    expect(manifest).toEqual({
      name: 'Telegram files', framing: 'length-prefixed-v1',
      files: [{
        source: 'qq-media', name: 'alpha.txt', size: 5,
        locator: {
          messageId: 'm1', elementId: 'e1', chatType: 1, peerUid: 'friend',
          kind: 'file', fileName: 'alpha.txt', filePath: '/qq-cache/alpha.txt',
        },
      }, { source: 'upload', name: 'beta.bin', size: 3 }],
    })
    expect(decodeFramedFiles(body)).toEqual([Buffer.from([1, 2, 3])])
    expect(authorization).toBe('Bearer secret')
  })

  it('reuses a completed preflight Highway upload without sending its bytes to Flash Transfer again', async () => {
    const bytes = Buffer.from('direct-to-highway')
    const hashes = {
      size: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      file10MMd5: createHash('md5').update(bytes).digest('hex'),
    }
    const highwayBodies: Buffer[] = []
    let manifest: Record<string, unknown> | undefined
    let flashBody: Buffer | undefined
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async (input, init) => {
        const url = String(input)
        if (url.endsWith('/status')) return Response.json({ protocolVersion: 30, ready: true })
        if (url.endsWith('/uploads/prepare')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            conversationId: 'saved-device', media: { kind: 'file', name: 'direct.bin', ...hashes },
          })
          return Response.json({
            prepared: { kind: 'file', fileUuid: 'preflight-file', exists: false, commandId: 95 },
            highway: {
              servers: [{ host: 'highway.invalid', port: 80 }], ticket: 'dGlja2V0', extendInfo: 'ZXh0',
              selfUin: '10000', commandId: 95, sequenceStart: 1, blockSize: 4,
              fileSize: bytes.length, fileMd5: hashes.md5,
            },
          })
        }
        if (url.includes('/cgi-bin/httpconn')) {
          highwayBodies.push(highwayBody(Buffer.from(init?.body as Uint8Array)))
          return new Response(Uint8Array.from(highwayResponse()))
        }
        if (url.endsWith('/flash-transfers')) {
          manifest = JSON.parse(Buffer.from(new Headers(init?.headers).get('x-qqnt-flash-manifest')!, 'base64url').toString())
          flashBody = init?.body
            ? Buffer.from(await new Response(Uint8Array.from(init.body as Uint8Array)).arrayBuffer())
            : Buffer.alloc(0)
          return Response.json({ fileSetId: 'set', shareLink: 'https://qfile.qq.com/q/code' })
        }
        throw new Error(`unexpected URL: ${url}`)
      }),
    })

    const preparation = await client.prepareFlashTransferUpload('saved-device', {
      kind: 'image', name: 'direct.bin', size: bytes.length, hashes,
    })
    expect(preparation?.sink).toBeDefined()
    await preparation!.sink!.write(bytes.subarray(0, 7))
    await preparation!.sink!.write(bytes.subarray(7))
    await preparation!.sink!.complete()
    expect(Buffer.concat(highwayBodies)).toEqual(bytes)

    await client.createFlashTransfer([preparation!.media])

    expect(manifest).toEqual({
      framing: 'length-prefixed-v1',
      files: [{ source: 'uploaded', name: 'direct.bin', size: bytes.length, md5: hashes.md5, sha1: hashes.sha1 }],
    })
    expect(flashBody).toEqual(Buffer.alloc(0))
  })

  it('ignores the obsolete capability flag and uses the protocol flash endpoint', async () => {
    const requests: string[] = []
    const source = vi.fn(async function* () { yield Uint8Array.of(1, 2, 3) })
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async (input) => {
        requests.push(String(input))
        if (String(input).endsWith('/flash-transfers')) {
          return Response.json({ fileSetId: 'set', shareLink: 'https://qfile.qq.com/q/code' })
        }
        return Response.json({
          protocolVersion: 29, ready: true, flashTransferSupported: false,
        })
      }),
    })

    await expect(client.createFlashTransfer([{
      kind: 'file', name: 'alpha.bin', size: 3, source: { size: 3, stream: source },
    }])).resolves.toEqual({ fileSetId: 'set', shareLink: 'https://qfile.qq.com/q/code' })
    expect(requests).toEqual([
      'http://bridge.invalid/v1/status', 'http://bridge.invalid/v1/flash-transfers',
    ])
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('lists and resolves requests through encoded authenticated bridge routes', async () => {
    const requests: Array<{ url: string, method?: string, body?: unknown, authorization?: string }> = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      token: 'secret',
      fetch: vi.fn(async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
          url: String(input), method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          authorization: headers.get('authorization') ?? undefined,
        })
        return Response.json(requests.length === 1 ? { requests: [], nextCursor: '12' } : { requests: [] })
      }),
    })

    const firstPage = await client.getRequests({ kind: 'group-join', cursor: 'opaque+cursor', limit: 25 })
    await client.getRequests({ cursor: firstPage.nextCursor })
    await client.resolveRequest('request/opaque:42', 'accept')

    expect(requests).toEqual([{
      url: 'http://bridge.invalid/v1/requests?kind=group-join&cursor=opaque%2Bcursor&limit=25',
      method: undefined, body: undefined, authorization: 'Bearer secret',
    }, {
      url: 'http://bridge.invalid/v1/requests?cursor=12',
      method: undefined, body: undefined, authorization: 'Bearer secret',
    }, {
      url: 'http://bridge.invalid/v1/requests/request%2Fopaque%3A42/resolve',
      method: 'POST', body: { action: 'accept' }, authorization: 'Bearer secret',
    }])
  })

  it('posts the exact live QQ call reference and operation to the authenticated control route', async () => {
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

    await client.controlCall('qq-call_opaque-42', 'accept')

    expect(requests).toEqual([{
      url: 'http://bridge.invalid/v1/calls/control', method: 'POST',
      body: { callId: 'qq-call_opaque-42', operation: 'accept' },
      authorization: 'Bearer secret',
    }])
  })

  it('does not expose an opaque QQ call reference in control errors', async () => {
    const callRef = 'sensitive-qq-call-reference'
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async () => Response.json({ error: `failed ${callRef}` }, { status: 503 })),
    })

    const error = await client.controlCall(callRef, 'hangup').catch((value: unknown) => value)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toBe('Error: QQNT call control failed')
    expect(String(error)).not.toContain(callRef)
  })

  it('posts native inline keyboard callback identity to the QQNT bridge', async () => {
    const requests: unknown[] = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({ status: 0, promptText: 'ok', promptType: 0, promptIcon: 0 })
      }),
    })
    await expect(client.clickInlineKeyboard({
      conversationId: 'group', messageId: 'message', messageSequence: '7788',
      buttonId: 'confirm', callbackData: 'confirm:42', botAppid: '1024',
    })).resolves.toMatchObject({ promptText: 'ok' })
    expect(requests).toEqual([{
      conversationId: 'group', messageId: 'message', messageSequence: '7788',
      buttonId: 'confirm', callbackData: 'confirm:42', botAppid: '1024',
    }])
  })

  it('sends the stable native sequence with reaction reads and writes', async () => {
    const requests: Array<{ url: string, method?: string, body?: unknown }> = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: vi.fn(async (input, init) => {
        requests.push({
          url: String(input), method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        return Response.json({ reactions: [], maxSelected: 20 })
      }),
    })

    await client.getMessageReactions('group/1', 'account-scoped-id', '571')
    await client.getMessageReactionActors('group/1', 'account-scoped-id', '2:128522', 'opaque+cursor', 25, '571')
    await client.setMessageReactions('group/1', 'account-scoped-id', ['2:128522'], '571')

    expect(requests).toEqual([{
      url: 'http://bridge.invalid/v1/messages/reactions?conversationId=group%2F1&messageId=account-scoped-id&messageSequence=571',
      method: undefined,
      body: undefined,
    }, {
      url: 'http://bridge.invalid/v1/messages/reactions/list?conversationId=group%2F1&messageId=account-scoped-id&reactionKey=2%3A128522&offset=opaque%2Bcursor&limit=25&messageSequence=571',
      method: undefined,
      body: undefined,
    }, {
      url: 'http://bridge.invalid/v1/messages/reactions',
      method: 'POST',
      body: {
        conversationId: 'group/1', messageId: 'account-scoped-id',
        messageSequence: '571', reactionKeys: ['2:128522'],
      },
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

  it('forwards group-file folder pagination', async () => {
    let requestUrl = ''
    server = createServer((request, response) => {
      requestUrl = request.url ?? ''
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ items: [], nextCursor: 'next' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })

    await expect(client.getGroupFiles('group/1', {
      folderId: 'folder a', cursor: 'opaque', limit: 50,
    })).resolves.toEqual({ items: [], nextCursor: 'next' })
    expect(requestUrl).toBe('/conversations/group%2F1/group-files?folderId=folder+a&cursor=opaque&limit=50')
  })

  it('streams media directly to QQ Highway and posts only CDN metadata to the local bridge', async () => {
    const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const thumbnailMd5 = createHash('md5').update(thumbnail).digest('hex')
    const thumbnailSha1 = createHash('sha1').update(thumbnail).digest('hex')
    const highwayFrames: Buffer[] = []
    const localMessageBodies: Buffer[] = []
    let manifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      if (request.url === '/status') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ protocolVersion: 24 }))
        return
      }
      if (request.url === '/uploads/prepare') {
        const body = JSON.parse((await collect(request)).toString())
        expect(body).toMatchObject({ conversationId: '1:uid', media: {
          kind: 'video', name: 'x.mp4', size: 5,
          md5: '7cfdd07889b3295d6a550914ab35e068',
          thumbnail: {
            size: thumbnail.length, md5: thumbnailMd5, sha1: thumbnailSha1,
            width: 320, height: 180,
          },
        } })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: {
            kind: 'video', fileUuid: 'video-uuid',
            msgInfo: Buffer.from('video-msg-info').toString('base64url'),
          },
          highway: {
            servers: [{ host: '127.0.0.1', port: (server!.address() as { port: number }).port }],
            ticket: Buffer.from('ticket').toString('base64url'),
            extendInfo: Buffer.from('extend').toString('base64url'),
            selfUin: '1715311957', commandId: 1001, sequenceStart: 71,
            blockSize: 2, fileSize: 5, fileMd5: '7cfdd07889b3295d6a550914ab35e068',
          },
          auxiliaryHighways: [{
            role: 'thumbnail',
            highway: {
              servers: [{ host: '127.0.0.1', port: (server!.address() as { port: number }).port }],
              ticket: Buffer.from('ticket').toString('base64url'),
              extendInfo: Buffer.from('thumb-extend').toString('base64url'),
              selfUin: '1715311957', commandId: 1002, sequenceStart: 74,
              blockSize: 2, fileSize: thumbnail.length, fileMd5: thumbnailMd5,
            },
          }],
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
    const videoThumbnail = vi.fn(async () => ({ bytes: thumbnail, width: 320, height: 180 }))
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      videoThumbnail,
    })
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
    const progress: number[] = []
    let streamCalls = 0
    const message = await client.sendMessage('1:uid', 'caption', [{
      kind: 'file', name: 'x.mp4', mimeType: 'video/mp4', width: 320, height: 200, duration: 9,
      source: { size: 5, async *stream() { streamCalls++; yield* chunks } },
    }], { onProgress: (item) => { progress.push(item.transferredBytes) } },
    'origin-1', undefined, undefined, 'old-account-view-id', '571')
    expect(message.id).toBe('sent')
    expect(Buffer.concat(highwayFrames.map(highwayBody))).toEqual(Buffer.concat([
      Buffer.from([1, 2, 3, 4, 5]), thumbnail,
    ]))
    expect(highwayFrames.map((frame) => frame.readUInt32BE(5))).toEqual([2, 2, 1, 2, 2])
    expect(progress).toEqual([2, 4, 5])
    expect(streamCalls).toBe(2)
    expect(videoThumbnail).toHaveBeenCalledOnce()
    expect(localMessageBodies).toEqual([Buffer.alloc(0)])
    expect(manifest).toMatchObject({
      conversationId: '1:uid', originRequestId: 'origin-1',
      replyToId: 'old-account-view-id', replyToSequence: '571',
      media: [{
        mimeType: 'video/mp4', width: 320, height: 200, duration: 9, size: 5,
        md5: '7cfdd07889b3295d6a550914ab35e068',
        sha1: '11966ab9c099f8fabefac54c08d5be2bd8c903af',
        file10MMd5: '7cfdd07889b3295d6a550914ab35e068',
        thumbnail: {
          size: thumbnail.length, md5: thumbnailMd5, sha1: thumbnailSha1,
          width: 320, height: 180,
        },
      }],
      uploadedMedia: [{
        kind: 'video', fileUuid: 'video-uuid',
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

  it('reuses a hash lookup plan without opening the media source during send', async () => {
    let prepareCalls = 0
    let messageManifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      if (request.url === '/uploads/prepare') {
        prepareCalls++
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: {
            kind: 'file', fileUuid: 'rapid-uuid', fileHash: 'rapid-hash', exists: true, commandId: 95,
          },
        }))
        return
      }
      const encoded = request.headers['x-qqnt-manifest']
      if (typeof encoded === 'string') messageManifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      await collect(request)
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
    const hashes = {
      size: 4,
      md5: '08d6c05a21512a79a1dfeb9d2a8f262f',
      sha1: '12dada1fff4d4787ade3333147202c3b443e376f',
      file10MMd5: '08d6c05a21512a79a1dfeb9d2a8f262f',
    }
    const preparation = await client.prepareFastUpload('1:uid', {
      kind: 'file', name: 'rapid.bin', mimeType: 'application/octet-stream', size: hashes.size, hashes,
    })
    expect(preparation).toBeDefined()
    const stream = vi.spyOn(preparation!.media.source, 'stream')

    await client.sendMessage('1:uid', undefined, [{
      kind: 'file', name: 'rapid.bin', mimeType: 'application/octet-stream', source: preparation!.media.source,
    }])

    expect(prepareCalls).toBe(1)
    expect(stream).not.toHaveBeenCalled()
    expect(messageManifest).toMatchObject({
      media: [{ name: 'rapid.bin', ...hashes }],
      uploadedMedia: [{ kind: 'file', fileUuid: 'rapid-uuid', exists: true, commandId: 95 }],
    })
  })

  it('downloads UID-scoped, legacy user, and group avatars directly from QQ CDN URLs', async () => {
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
    const uidScoped = await collect(client.downloadFile({
      messageId: 'avatar:user:special', elementId: 'avatar:user:special',
      chatType: 1, peerUid: 'special', kind: 'image', fileName: '472247053.jpg',
      avatarUin: '472247053', avatarUrl: 'https://thirdqq.qlogo.cn/avatar/special/140',
    }, { offset: 1, limit: 4 }))
    const group = await collect(client.downloadFile({
      messageId: 'avatar:group:1058754719', elementId: 'avatar:group:1058754719',
      chatType: 2, peerUid: '1058754719', kind: 'image', fileName: 'group.jpg',
      filePath: 'C:\\qq\\group-avatar',
    }, { offset: 4, limit: 2 }))

    expect(user.toString()).toBe('cde')
    expect(uidScoped.toString()).toBe('bcde')
    expect(group.toString()).toBe('ef')
    expect(requests).toEqual([{
      url: 'https://q1.qlogo.cn/g?b=qq&nk=1715311957&s=640',
      range: 'bytes=2-4', authorization: undefined,
    }, {
      url: 'https://thirdqq.qlogo.cn/avatar/special/140',
      range: 'bytes=1-4', authorization: undefined,
    }, {
      url: 'https://p.qlogo.cn/gh/1058754719/1058754719/640/',
      range: 'bytes=4-5', authorization: undefined,
    }])
  })

  it('downloads bridge-local media paths through the authenticated asset route', async () => {
    const fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe('http://bridge.invalid/v1/files/asset')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer bridge-token')
      expect(new Headers(init?.headers).get('range')).toBe('bytes=1-3')
      expect(JSON.parse(String(init?.body))).toMatchObject({ filePath: 'C:\\qq\\s14.png' })
      return new Response('bcd', { status: 206 })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', token: 'bridge-token', fetch })
    const locator = {
      messageId: 'reaction:C:\\qq\\s14.png', elementId: 'reaction:C:\\qq\\s14.png',
      chatType: 1 as const, peerUid: '', kind: 'image' as const,
      fileName: 's14.png', filePath: 'C:\\qq\\s14.png', fileSize: '5',
    }
    await expect(collect(client.downloadFile(locator, { offset: 1, limit: 3 })))
      .resolves.toEqual(Buffer.from('bcd'))
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('falls back to the QQ direct URL when a bridge-local path is stale', async () => {
    const requests: string[] = []
    let staleResponseCancelled = false
    const fetch = vi.fn(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url === 'http://bridge.invalid/v1/files/asset') {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"media asset not found"}'))
          },
          cancel() {
            staleResponseCancelled = true
          },
        }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({ url: 'https://cdn.invalid/photo.jpg', expiresAt: Date.now() + 60_000 })
      }
      if (url === 'https://cdn.invalid/photo.jpg') return new Response('direct-image')
      return new Response('unexpected request', { status: 500 })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(collect(client.downloadFile({
      messageId: 'message', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'image', fileName: 'photo.jpg', filePath: '/stale/photo.jpg', fileUuid: 'remote-photo',
    }))).resolves.toEqual(Buffer.from('direct-image'))
    expect(requests).toEqual([
      'http://bridge.invalid/v1/files/asset',
      'http://bridge.invalid/v1/files/direct-url',
      'https://cdn.invalid/photo.jpg',
    ])
    expect(staleResponseCancelled).toBe(true)
  })

  it('cancels response bodies that are intentionally ignored', async () => {
    const cancelled: string[] = []
    const fetch = vi.fn(async (input) => {
      const url = String(input)
      const status = url.endsWith('/calls/media-lease') ? 503 : 404
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"ignored"}'))
        },
        cancel() {
          cancelled.push(url)
        },
      }), { status, headers: { 'content-type': 'application/json' } })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(client.getUser('missing')).resolves.toBeNull()
    await expect(client.getMessage('conversation', 'missing')).resolves.toBeNull()
    await expect(client.mediaLease('call')).rejects.toThrow('QQNT media lease request failed')

    expect(cancelled).toEqual([
      'http://bridge.invalid/v1/users/missing',
      'http://bridge.invalid/v1/messages/get',
      'http://bridge.invalid/v1/calls/media-lease',
    ])
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

  it('probes a direct URL once and refuses to advertise a CDN that ignores Range', async () => {
    const requests: Array<{ url: string, range?: string }> = []
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, range: new Headers(init?.headers).get('range') ?? undefined })
      if (url === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({
          url: 'https://cdn.qq.example/no-range', expiresAt: Date.now() + 60_000,
        })
      }
      return new Response('whole-file')
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    const locator = {
      messageId: 'no-range', elementId: 'element', chatType: 2 as const, peerUid: 'group',
      kind: 'image' as const, fileName: 'photo.jpg', fileUuid: 'no-range-file', fileSize: '10',
    }

    await expect(client.resolveFileUrlForDirectDownload(locator)).resolves.toMatchObject({
      url: 'https://cdn.qq.example/no-range', supportsRange: false,
    })
    await expect(client.resolveFileUrlForDirectDownload(locator)).resolves.toMatchObject({ supportsRange: false })
    expect(requests).toEqual([
      { url: 'http://bridge.invalid/v1/files/direct-url', range: undefined },
      { url: 'https://cdn.qq.example/no-range', range: 'bytes=0-1' },
    ])
  })

  it('accepts QQ CDN URLs that reject the degenerate 0-0 probe but serve real ranges', async () => {
    const ranges: Array<string | undefined> = []
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({
          url: 'https://cdn.qq.example/quirky-range', expiresAt: Date.now() + 60_000,
        })
      }
      const range = new Headers(init?.headers).get('range') ?? undefined
      ranges.push(range)
      if (range === 'bytes=0-0') return new Response(null, { status: 200 })
      return new Response('ab', {
        status: 206, headers: { 'content-range': 'bytes 0-1/22871', 'content-length': '2' },
      })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(client.resolveFileUrlForDirectDownload({
      messageId: 'quirky', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'image', fileName: 'photo.png', fileUuid: 'quirky-file', fileSize: '22871',
    })).resolves.toMatchObject({ supportsRange: true })
    expect(ranges).toEqual(['bytes=0-1'])
  })

  it('reuses direct range capability across signed URLs on the same CDN endpoint', async () => {
    let resolutions = 0
    const probes: string[] = []
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://bridge.invalid/v1/files/direct-url') {
        resolutions++
        return Response.json({
          url: `https://multimedia.qq.example/download?token=${resolutions}`,
          expiresAt: Date.now() + 60_000,
        })
      }
      probes.push(url)
      const range = new Headers(init?.headers).get('range')
      return new Response('ab', {
        status: 206,
        headers: { 'content-range': `bytes 0-1/10`, 'content-length': '2', 'x-range': range ?? '' },
      })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    const first = {
      messageId: 'first', elementId: 'element-1', chatType: 2 as const, peerUid: 'group',
      kind: 'file' as const, fileName: 'first.bin', fileUuid: 'first-uuid',
    }
    const second = {
      messageId: 'second', elementId: 'element-2', chatType: 2 as const, peerUid: 'group',
      kind: 'file' as const, fileName: 'second.bin', fileUuid: 'second-uuid',
    }

    await expect(client.resolveFileUrlForDirectDownload(first)).resolves.toMatchObject({ supportsRange: true })
    await expect(client.resolveFileUrlForDirectDownload(second)).resolves.toMatchObject({ supportsRange: true })

    expect(resolutions).toBe(2)
    expect(probes).toEqual(['https://multimedia.qq.example/download?token=1'])
  })

  it('coalesces Telegram chunks into cached one-megabyte direct ranges', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0).map((_, index) => index % 251)
    const ranges: string[] = []
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({
          url: 'https://cdn.qq.example/ranged-file',
          expiresAt: Date.now() + 60_000,
          supportsRange: true,
        })
      }
      const range = new Headers(init?.headers).get('range')!
      ranges.push(range)
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), bytes.length - 1)
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          'content-length': String(end - start + 1),
        },
      })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    const locator = {
      messageId: 'ranged-file', elementId: 'element', chatType: 2 as const, peerUid: 'group',
      kind: 'file' as const, fileName: 'large.bin', fileUuid: 'ranged-file-uuid',
    }
    const chunkSize = 128 * 1024

    const [first, second] = await Promise.all([
      collect(client.downloadFile(locator, { offset: 0, limit: chunkSize })),
      collect(client.downloadFile(locator, { offset: chunkSize, limit: chunkSize })),
    ])
    const third = await collect(client.downloadFile(locator, { offset: chunkSize * 2, limit: chunkSize }))

    expect(first).toEqual(bytes.subarray(0, chunkSize))
    expect(second).toEqual(bytes.subarray(chunkSize, chunkSize * 2))
    expect(third).toEqual(bytes.subarray(chunkSize * 2, chunkSize * 3))
    expect(ranges).toEqual(['bytes=0-1048575'])
  })

  it('treats an unsatisfied direct range at or beyond the known file size as EOF', async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({
          url: 'https://cdn.qq.example/eof', expiresAt: Date.now() + 60_000, supportsRange: true,
        })
      }
      return new Response(null, { status: 416, headers: { 'content-range': 'bytes */1048577' } })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    const locator = {
      messageId: 'eof', elementId: 'element', chatType: 2 as const, peerUid: 'group',
      kind: 'file' as const, fileName: 'partial.bin', fileUuid: 'eof-uuid',
    }

    await expect(collect(client.downloadFile(locator, {
      offset: 2 * 1024 * 1024, limit: 128 * 1024,
    }))).resolves.toEqual(Buffer.alloc(0))
  })

  it('does not hide a 416 response when the requested direct range is still satisfiable', async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({
          url: 'https://cdn.qq.example/premature-416', expiresAt: Date.now() + 60_000, supportsRange: true,
        })
      }
      return new Response('premature', {
        status: 416, headers: { 'content-range': 'bytes */2097152' },
      })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(collect(client.downloadFile({
      messageId: 'premature', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'file', fileName: 'partial.bin', fileUuid: 'premature-uuid',
    }, { offset: 1024 * 1024, limit: 128 * 1024 }))).rejects.toThrow(
      'QQNT native media 416: premature',
    )
  })

  it('does not accept a malformed 416 Content-Range as direct media EOF', async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === 'http://bridge.invalid/v1/files/direct-url') {
        return Response.json({
          url: 'https://cdn.qq.example/malformed-416', expiresAt: Date.now() + 60_000, supportsRange: true,
        })
      }
      return new Response('malformed', {
        status: 416, headers: { 'content-range': 'bytes 0-1/*' },
      })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(collect(client.downloadFile({
      messageId: 'malformed', elementId: 'element', chatType: 2, peerUid: 'group',
      kind: 'file', fileName: 'partial.bin', fileUuid: 'malformed-uuid',
    }, { offset: 2 * 1024 * 1024, limit: 128 * 1024 }))).rejects.toThrow(
      'QQNT native media 416: malformed',
    )
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

  it('stops retrying Range and reuses a whole-file response when the QQ CDN ignores it', async () => {
    const rangeHeaders: Array<string | undefined> = []
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
        rangeHeaders.push(request.headers.range)
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
    const locator = {
      messageId: 'file', elementId: 'element', chatType: 2 as const, peerUid: '1002974327',
      kind: 'file' as const, fileName: 'document.bin', fileUuid: 'group-file-uuid', fileSize: '10',
    }
    const first = await collect(client.downloadFile(locator, { offset: 3, limit: 3 }))
    const second = await collect(client.downloadFile(locator, { offset: 6, limit: 2 }))

    expect(first.toString()).toBe('def')
    expect(second.toString()).toBe('gh')
    expect(rangeHeaders).toEqual(['bytes=3-5'])
  })

  it('spools one unranged HTTP response to disk for sequential 128 KiB getFile chunks', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-unranged-client-test-'))
    const chunkSize = 128 * 1024
    const wholeFile = Buffer.alloc(chunkSize * 2)
    for (let index = 0; index < wholeFile.length; index++) wholeFile[index] = index % 251
    const releaseTail = Promise.withResolvers<void>()
    const firstHalfSent = Promise.withResolvers<void>()
    const cdnRanges: Array<string | undefined> = []
    try {
      server = createServer(async (request, response) => {
        if (request.url === '/files/direct-url') {
          for await (const _chunk of request) { /* drain locator */ }
          const address = server!.address()
          if (!address || typeof address === 'string') throw new Error('missing address')
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            url: `http://127.0.0.1:${address.port}/qq-cdn/large-file`,
            expiresAt: Date.now() + 60_000,
          }))
          return
        }
        if (request.url === '/qq-cdn/large-file') {
          cdnRanges.push(request.headers.range)
          if (request.headers.range) {
            response.end('range ignored')
            return
          }
          response.writeHead(200, { 'content-length': String(wholeFile.length) })
          response.write(wholeFile.subarray(0, chunkSize), () => firstHalfSent.resolve())
          await releaseTail.promise
          response.end(wholeFile.subarray(chunkSize))
          return
        }
        response.writeHead(500).end()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      const client = new QQNTClient({
        endpoint: `http://127.0.0.1:${address.port}`,
        unrangedCachePath: cachePath,
      })
      const locator = {
        messageId: 'large-file', elementId: 'element', chatType: 2 as const, peerUid: 'group',
        kind: 'file' as const, fileName: 'large.bin', fileUuid: 'large-file-uuid',
        // This used to exceed the in-memory fallback limit and trigger one
        // whole-file HTTP request for every Telegram upload.getFile chunk.
        fileSize: String(128 * 1024 * 1024),
      }

      await expect(client.resolveFileUrlForDirectDownload(locator)).resolves.toMatchObject({
        supportsRange: false,
      })
      const first = collect(client.downloadFile(locator, { offset: 0, limit: chunkSize }))
      await firstHalfSent.promise
      await expect(Promise.race([
        first,
        new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('first chunk waited for EOF')), 2_000)),
      ])).resolves.toEqual(wholeFile.subarray(0, chunkSize))

      const second = collect(client.downloadFile(locator, { offset: chunkSize, limit: chunkSize }))
      let secondSettled = false
      void second.finally(() => { secondSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(secondSettled).toBe(false)
      releaseTail.resolve()
      await expect(second).resolves.toEqual(wholeFile.subarray(chunkSize))
      expect(cdnRanges).toEqual(['bytes=0-1', undefined])
    } finally {
      releaseTail.resolve()
      await rm(cachePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
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
      onEventId: async (eventId) => {
        acknowledged.push(`${eventId}:start`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        acknowledged.push(`${eventId}:end`)
      },
    })
    expect(requestUrl).toBe('/custom/events?stream=qqnt&lastEventId=9')
    expect(acknowledged).toEqual(['10:start', '10:end', '11:start', '11:end'])
    expect(order).toEqual([
      'a:10:start', 'a:10:end',
      'b:11:start', 'b:11:end',
    ])
  })

  it('streams a voice request body to a real local HTTP server', async () => {
    let prepared = 0
    let manifest: Record<string, unknown> | undefined
    let body = new Uint8Array()
    server = createServer(async (request, response) => {
      if (request.url === '/status') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ protocolVersion: 21, ready: true }))
        return
      }
      prepared++
      manifest = JSON.parse(Buffer.from(String(request.headers['x-qqnt-manifest']), 'base64url').toString())
      body = new Uint8Array(await collect(request))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'voice', conversationId: 'c', senderId: 's', timestamp: 1, outgoing: true, parts: [] }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}` })
    await client.status()
    await client.sendMessage('c', undefined, [{
      kind: 'file', voice: true, name: 'voice.ogg', source: { async *stream() { yield Uint8Array.of(1, 2); yield Uint8Array.of(3) } },
    }])
    expect(prepared).toBe(1)
    expect([...body]).toEqual([1, 2, 3])
    expect(manifest).toMatchObject({ media: [{ kind: 'voice', name: 'voice.ogg' }] })
  })

  it('rejects voice sends against a v20 bridge before posting bytes', async () => {
    const fetch = vi.fn(async () => Response.json({ protocolVersion: 20, ready: true }))
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    await expect(client.sendMessage('c', undefined, [{
      kind: 'file', voice: true, name: 'voice.ogg', source: { async *stream() { yield Uint8Array.of(1) } },
    }])).rejects.toThrow('protocol 21 is required')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects playable-video sends against a v23 bridge before hashing or posting bytes', async () => {
    const fetch = vi.fn(async () => Response.json({ protocolVersion: 23, ready: true }))
    const stream = vi.fn(async function* () { yield Uint8Array.of(1) })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })
    await expect(client.sendMessage('c', undefined, [{
      kind: 'file', name: 'video.mp4', mimeType: 'video/mp4', source: { stream },
    }])).rejects.toThrow('protocol 24 is required')
    expect(fetch).toHaveBeenCalledOnce()
    expect(stream).not.toHaveBeenCalled()
  })

  it('posts encoded administrator role updates only to protocol 25 bridges', async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/status')) return Response.json({ protocolVersion: 25, ready: true })
      expect(String(input)).toBe('http://bridge.invalid/v1/conversations/2%3Agroup/members/member%2Fopaque/role')
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ role: 'administrator' }) })
      return Response.json({ ok: true })
    })
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await client.setMemberRole('2:group', 'member/opaque', 'administrator')

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects administrator updates against protocol 24 before posting', async () => {
    const fetch = vi.fn(async () => Response.json({ protocolVersion: 24, ready: true }))
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1', fetch })

    await expect(client.setMemberRole('2:group', 'member', 'administrator'))
      .rejects.toThrow('protocol 25 is required')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('revalidates dialogs and history with ETag and reuses only 304 responses', async () => {
    const requests: Array<{ url: string, ifNoneMatch: string | null }> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      const ifNoneMatch = new Headers(init?.headers).get('if-none-match')
      requests.push({ url, ifNoneMatch })
      if (url.includes('/dialogs')) {
        if (ifNoneMatch === '"dialogs-v1"') return new Response(null, { status: 304, headers: { etag: '"dialogs-v1"' } })
        return Response.json({ conversations: [{ id: 'room' }] }, { headers: { etag: '"dialogs-v1"' } })
      }
      if (ifNoneMatch === '"history-v1"') return new Response(null, { status: 304, headers: { etag: '"history-v1"' } })
      return Response.json({ messages: [{ id: 'message-1' }] }, { headers: { etag: '"history-v1"' } })
    })
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1', token: 'secret',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    await expect(client.getDialogs({ limit: 20 })).resolves.toEqual({ conversations: [{ id: 'room' }] })
    await expect(client.getDialogs({ limit: 20 })).resolves.toEqual({ conversations: [{ id: 'room' }] })
    await expect(client.getHistory('room', { limit: 20 })).resolves.toEqual({ messages: [{ id: 'message-1' }] })
    await expect(client.getHistory('room', { limit: 20 })).resolves.toEqual({ messages: [{ id: 'message-1' }] })

    expect(requests.map((request) => request.ifNoneMatch)).toEqual([
      null, '"dialogs-v1"', null, '"history-v1"',
    ])
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer secret')
    }
  })

  it('derives the WebSocket endpoint from the HTTP endpoint when no override is configured', () => {
    expect(new QQNTClient({ endpoint: 'https://bridge.example/v1/' }).webSocketEndpoint)
      .toBe('https://bridge.example/v1/events/ws')
  })
})
