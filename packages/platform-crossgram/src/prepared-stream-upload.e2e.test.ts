import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UploadManager } from '../../bridge/src/upload-manager.js'
import { QQNTClient } from './client.js'

const HIGHWAY_BLOCK_BYTES = 1024 * 1024
const HIGHWAY_SELECTION_BYTES = 128 * 1024
const TELEGRAM_PART_BYTES = 512 * 1024

describe('prepared Telegram-to-QQ Highway streaming E2E', () => {
  let server: Server | undefined
  const directories: string[] = []

  afterEach(async () => {
    if (server) {
      server.close()
      await once(server, 'close')
      server = undefined
    }
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })))
  })

  it('retains a cache-miss plan, selects with a small block, and posts only the prepared QQ result', async () => {
    const bytes = Buffer.alloc(2 * HIGHWAY_BLOCK_BYTES + TELEGRAM_PART_BYTES / 2, 0x5a)
    const hashes = {
      size: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      file10MMd5: createHash('md5').update(bytes).digest('hex'),
    }
    const frames: Buffer[] = []
    let prepareCalls = 0
    let sentManifest: Record<string, any> | undefined
    let sentBody: Buffer<ArrayBufferLike> = Buffer.alloc(0)

    server = createServer(async (request, response) => {
      if (request.url === '/v1/uploads/prepare') {
        prepareCalls++
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing test server address')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: {
            kind: 'file', fileUuid: 'prepared-file', fileHash: hashes.md5,
            exists: false, commandId: 95,
          },
          highway: {
            servers: [{ host: '127.0.0.1', port: address.port }],
            ticket: Buffer.from('ticket').toString('base64url'),
            extendInfo: Buffer.from('extend').toString('base64url'),
            selfUin: '1715311957', commandId: 71, sequenceStart: 100,
            blockSize: HIGHWAY_BLOCK_BYTES, fileSize: bytes.length, fileMd5: hashes.md5,
          },
        }))
        return
      }
      if (request.url?.startsWith('/cgi-bin/httpconn?')) {
        frames.push(await collect(request))
        response.end(highwayResponse())
        return
      }
      if (request.url === '/v1/messages') {
        const encoded = request.headers['x-qqnt-manifest']
        if (typeof encoded === 'string') {
          sentManifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
        }
        sentBody = await collect(request)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          id: 'sent-prepared', conversationId: '2:group', senderId: 'self', timestamp: 1,
          outgoing: true, parts: [{
            type: 'media', media: { id: 'remote-file', kind: 'file', name: 'streamed.bin' },
          }],
        }))
        return
      }
      response.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')

    const client = new QQNTClient({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const preparation = await client.prepareFastUpload('2:group', {
      kind: 'file', name: 'streamed.bin', mimeType: 'application/octet-stream',
      size: bytes.length, hashes,
    })
    if (!preparation?.sink) throw new Error('expected a streaming upload preparation')
    const sourceStream = vi.spyOn(preparation.media.source, 'stream')
    const uploadRoot = await mkdtemp(join(tmpdir(), 'prepared-highway-e2e-'))
    directories.push(uploadRoot)
    const uploads = new UploadManager(uploadRoot)
    await expect(uploads.prepare('session', '700', hashes, preparation)).resolves.toBe('stream')

    const parts = Array.from({ length: Math.ceil(bytes.length / TELEGRAM_PART_BYTES) }, (_, part) =>
      bytes.subarray(part * TELEGRAM_PART_BYTES, (part + 1) * TELEGRAM_PART_BYTES))
    await uploads.savePart('session', '700', 1, parts[1]!)
    expect(frames).toHaveLength(0)
    await uploads.savePart('session', '700', 0, parts[0]!)
    expect(frames.map(highwayBody).map((body) => body.length)).toEqual([HIGHWAY_SELECTION_BYTES])
    await uploads.savePart('session', '700', 3, parts[3]!)
    expect(frames).toHaveLength(1)
    await uploads.savePart('session', '700', 2, parts[2]!)
    await vi.waitFor(() => expect(frames.map(highwayBody).map((body) => body.length)).toEqual([
      HIGHWAY_SELECTION_BYTES, HIGHWAY_BLOCK_BYTES,
    ]))
    await uploads.savePart('session', '700', 4, parts[4]!)

    expect(Buffer.concat(frames.map(highwayBody)).equals(bytes)).toBe(true)
    expect(frames.map(highwayBody).map((body) => body.length)).toEqual([
      HIGHWAY_SELECTION_BYTES, HIGHWAY_BLOCK_BYTES, HIGHWAY_BLOCK_BYTES, HIGHWAY_SELECTION_BYTES,
    ])
    expect(await readdir(uploadRoot)).toEqual([])
    const staged = uploads.getStaged('session', '700')
    expect(staged).toBeDefined()

    await client.sendMessage('2:group', undefined, [{
      kind: 'file', name: 'streamed.bin', mimeType: 'application/octet-stream',
      source: staged!.media.source,
    }])

    expect(prepareCalls).toBe(1)
    expect(sourceStream).not.toHaveBeenCalled()
    expect(sentBody).toEqual(Buffer.alloc(0))
    expect(sentManifest).toMatchObject({
      conversationId: '2:group',
      media: [{ kind: 'file', name: 'streamed.bin', ...hashes }],
      uploadedMedia: [{ kind: 'file', fileUuid: 'prepared-file', exists: false, commandId: 95 }],
    })
  })
})

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
