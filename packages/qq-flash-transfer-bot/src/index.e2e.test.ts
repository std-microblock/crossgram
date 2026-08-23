import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  IMPlatformService, SystemPeerService,
  type IMEvent, type IMMessage, type IMMessageInput, type PlatformSession,
} from '@mtproto-relay/bridge'
import { QQNTPlatform } from '../../platform-crossgram/src/index.js'
import * as bot from './index.js'

const session: PlatformSession = {
  platformId: 'qqnt', platformSessionId: 'qq-e2e', userId: 'self', credentials: {}, metadata: {},
}
let server: Server | undefined
afterEach(async () => {
  if (!server) return
  server.close()
  await once(server, 'close')
  server = undefined
})

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function decodeFiles(body: Buffer): Buffer[] {
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

describe('QQ Flash Transfer bot E2E', () => {
  it('uploads Telegram parts to QQ Highway before the bot creates the fileset', async () => {
    const bytes = Buffer.from('telegram-to-highway')
    const hashes = {
      size: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      file10MMd5: createHash('md5').update(bytes).digest('hex'),
    }
    const highwayBodies: Buffer[] = []
    let flashManifest: Record<string, unknown> | undefined
    let flashBody: Uint8Array = new Uint8Array()
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/status') {
        response.end(JSON.stringify({ protocolVersion: 30, ready: true }))
        return
      }
      if (request.url?.startsWith('/dialogs')) {
        response.end(JSON.stringify({ conversations: [{
          id: 'friend:upload-target', kind: 'direct', title: '上传协商目标',
          peerUid: 'friend-uid', peerUin: '10001', chatType: 1,
        }] }))
        return
      }
      if (request.url === '/uploads/prepare') {
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing server address')
        expect(JSON.parse((await collect(request)).toString())).toMatchObject({
          conversationId: 'friend:upload-target', media: { kind: 'file', name: 'telegram.bin', ...hashes },
        })
        response.end(JSON.stringify({
          prepared: { kind: 'file', fileUuid: 'preflight-file', exists: false, commandId: 95 },
          highway: {
            servers: [{ host: '127.0.0.1', port: address.port }], ticket: 'dGlja2V0', extendInfo: 'ZXh0',
            selfUin: '10000', commandId: 95, sequenceStart: 1, blockSize: 4,
            fileSize: bytes.length, fileMd5: hashes.md5,
          },
        }))
        return
      }
      if (request.url?.startsWith('/cgi-bin/httpconn')) {
        const frame = await collect(request)
        const headLength = frame.readUInt32BE(1)
        const bodyLength = frame.readUInt32BE(5)
        highwayBodies.push(frame.subarray(9 + headLength, 9 + headLength + bodyLength))
        response.end(Buffer.from([0x28, 0, 0, 0, 0, 0, 0, 0, 0, 0x29]))
        return
      }
      if (request.url === '/flash-transfers') {
        flashManifest = JSON.parse(Buffer.from(String(request.headers['x-qqnt-flash-manifest']), 'base64url').toString())
        flashBody = await collect(request)
        response.end(JSON.stringify({ fileSetId: 'native-set', shareLink: 'https://qq.example/native' }))
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')

    const ctx = new Context()
    const platforms = new IMPlatformService(ctx)
    const peers = new SystemPeerService(ctx)
    peers.attach(async () => ({} as never))
    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}` })
    platforms.activateSession('qqnt', platform, session)
    const plugin = ctx.plugin(bot)
    await plugin
    const resolution = await peers.resolve(session, bot.QQ_FLASH_TRANSFER_CONVERSATION_ID)
    if (!resolution) throw new Error('missing QQ Flash Transfer bot')
    const preparation = await peers.prepareMediaUpload(session, resolution, {
      kind: 'file', name: 'telegram.bin', size: bytes.length, hashes,
    })
    if (!preparation?.sink) throw new Error('missing direct upload sink')

    await preparation.sink.write(bytes.subarray(0, 8))
    expect(Buffer.concat(highwayBodies)).toEqual(bytes.subarray(0, 8))
    await preparation.sink.write(bytes.subarray(8))
    await preparation.sink.complete()
    await peers.receive(session, resolution, {
      id: 'out', conversationId: resolution.peer.id, senderId: 'self', timestamp: 1, outgoing: true,
      content: { parts: [] },
    }, { parts: [{ type: 'media', media: preparation.media }] })

    expect(Buffer.concat(highwayBodies)).toEqual(bytes)
    expect(flashManifest).toEqual({
      name: 'telegram.bin', framing: 'length-prefixed-v1',
      files: [{ source: 'uploaded', name: 'telegram.bin', size: bytes.length, md5: hashes.md5, sha1: hashes.sha1 }],
    })
    expect(Buffer.from(flashBody)).toEqual(Buffer.alloc(0))
    await plugin.dispose()
  })

  it('streams a direct Telegram upload through QQNT protocol v28 and replies with the native link', async () => {
    let manifest: Record<string, unknown> | undefined
    let uploaded: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/status') {
        response.end(JSON.stringify({ protocolVersion: 28, ready: true }))
        return
      }
      const encoded = request.headers['x-qqnt-flash-manifest']
      if (typeof encoded === 'string') manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      uploaded = await collect(request)
      response.end(JSON.stringify({ fileSetId: 'native-set', shareLink: 'https://qq.example/native' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')

    const ctx = new Context()
    const platforms = new IMPlatformService(ctx)
    const peers = new SystemPeerService(ctx)
    const events: IMEvent[] = []
    peers.attach(async (_session, event) => { events.push(event); return {} as never })
    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}` })
    platforms.activateSession('qqnt', platform, session)
    const plugin = ctx.plugin(bot)
    await plugin
    const resolution = await peers.resolve(session, bot.QQ_FLASH_TRANSFER_CONVERSATION_ID)
    if (!resolution) throw new Error('missing QQ Flash Transfer bot')
    const input: IMMessageInput = { parts: [{
      type: 'media', media: {
        kind: 'file', name: 'telegram.bin', size: 5,
        source: { size: 5, async *stream() { yield Buffer.from('te'); yield Buffer.from('legram').subarray(0, 3) } },
      },
    }] }
    const outgoing: IMMessage = {
      id: 'out', conversationId: resolution.peer.id, senderId: 'self', timestamp: 1, outgoing: true,
      content: { parts: [] },
    }

    await peers.receive(session, resolution, outgoing, input)

    expect(manifest).toEqual({
      name: 'telegram.bin', framing: 'length-prefixed-v1',
      files: [{ source: 'upload', name: 'telegram.bin', size: 5 }],
    })
    expect(decodeFiles(uploaded)).toEqual([Buffer.from('teleg')])
    const replies = events.filter((event): event is Extract<IMEvent, { type: 'message' }> => event.type === 'message')
    expect(replies.at(-1)?.message.content.parts[0]).toMatchObject({ text: expect.stringContaining('https://qq.example/native') })
    await plugin.dispose()
  })
})
