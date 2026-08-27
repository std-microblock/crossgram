import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { defineModels } from '../../bridge/src/models.js'
import { UploadManager } from '../../bridge/src/upload-manager.js'
import type { PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-multi-file-e2e', platformId: 'qqnt',
  userId: 'self', credentials: {}, metadata: {},
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).reverse().map((dispose) => dispose()))
})

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('QQNT multiple file send E2E', () => {
  it('turns one Telegram sendMultiMedia request into individual QQ file messages', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const preparedNames: string[] = []
    const messageManifests: Array<{
      originRequestId?: string
      media?: Array<{ kind: string, name: string }>
      uploadedMedia?: Array<{ kind: string, fileUuid: string }>
    }> = []
    const physicalMessages: Array<{
      id: string
      conversationId: string
      senderId: string
      timestamp: number
      outgoing: boolean
      originRequestId?: string
      parts: Array<Record<string, unknown>>
    }> = []
    let messageSequence = 0
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/uploads/prepare') {
        const body = JSON.parse((await collect(request)).toString('utf8')) as {
          media: { name: string }
        }
        preparedNames.push(body.media.name)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: {
            kind: 'file', fileUuid: `${body.media.name}-uuid`, fileHash: `${body.media.name}-hash`,
            exists: true, commandId: 95,
          },
        }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages') {
        const encoded = request.headers['x-qqnt-manifest']
        if (typeof encoded !== 'string') throw new Error('missing QQNT manifest')
        const manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as typeof messageManifests[number]
        messageManifests.push(manifest)
        await collect(request)
        const media = manifest.media?.[0]
        if (!media || manifest.media?.length !== 1) throw new Error('expected exactly one QQ file')
        const id = `physical-${++messageSequence}`
        const message = {
          id, conversationId: '1:u', senderId: 'self', timestamp: 1_800_000_000 + messageSequence,
          outgoing: true, originRequestId: manifest.originRequestId,
          parts: [{
            type: 'media',
            media: {
              id: `${id}-file`, kind: 'file', name: media.name, size: media.name === 'one.bin' ? 2 : 3,
              locator: {
                messageId: id, elementId: `${id}-file`, chatType: 1,
                peerUid: 'u', kind: 'file', fileName: media.name,
              },
            },
          }],
        }
        physicalMessages.push(message)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(message))
        return
      }
      if (request.method === 'GET' && request.url?.startsWith('/v1/conversations/1%3Au/history')) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ messages: [...physicalMessages].reverse() }))
        return
      }
      response.writeHead(404).end('not found')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      if (!server?.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
      server.closeAllConnections()
      await closed
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: '1:u', kind: 'direct' as const, title: 'Peer', peerUid: 'u', peerUin: '10001', chatType: 1 as const,
    }] }))
    const store = new MessageStore(ctx.database)
    const peer = await store.upsertUser(session, { id: '1:u', firstName: 'Peer' })
    const uploadPath = await mkdtemp(join(tmpdir(), 'qqnt-multi-file-e2e-'))
    disposals.push(() => rm(uploadPath, { recursive: true, force: true }))
    const uploads = new UploadManager(uploadPath)
    await uploads.savePart(session.platformSessionId, '101', 0, Uint8Array.of(1, 2))
    await uploads.savePart(session.platformSessionId, '102', 0, Uint8Array.of(3, 4, 5))
    const rpc = new DialogRpc(platform, session, store, uploads)

    const result = await rpc.sendMultiMedia({
      _: 'messages.sendMultiMedia',
      peer: { _: 'inputPeerUser', userId: peer.id, accessHash: Long.ZERO },
      multiMedia: [{
        _: 'inputSingleMedia', randomId: Long.fromNumber(101), message: '',
        media: {
          _: 'inputMediaUploadedDocument',
          file: { _: 'inputFile', id: Long.fromNumber(101), parts: 1, name: 'one.bin', md5Checksum: '' },
          mimeType: 'application/octet-stream', attributes: [],
        },
      }, {
        _: 'inputSingleMedia', randomId: Long.fromNumber(102), message: '',
        media: {
          _: 'inputMediaUploadedDocument',
          file: { _: 'inputFile', id: Long.fromNumber(102), parts: 1, name: 'two.txt', md5Checksum: '' },
          mimeType: 'text/plain', attributes: [],
        },
      }],
    })

    expect(preparedNames).toEqual(['one.bin', 'two.txt'])
    expect(messageManifests).toHaveLength(2)
    expect(messageManifests.map((manifest) => manifest.media?.map((media) => media.name))).toEqual([
      ['one.bin'], ['two.txt'],
    ])
    expect(messageManifests.map((manifest) => manifest.uploadedMedia?.[0]?.fileUuid)).toEqual([
      'one.bin-uuid', 'two.txt-uuid',
    ])
    expect(new Set(messageManifests.map((manifest) => manifest.originRequestId)).size).toBe(1)
    expect(result._).toBe('updates')
    expect((result as { updates: Array<{ _: string, randomId?: Long }> }).updates
      .filter((update) => update._ === 'updateMessageID')
      .map((update) => update.randomId?.toNumber())).toEqual([101, 102])
    expect(await store.readHistory(session.platformSessionId, '1:u', { limit: 10 })).toMatchObject([{
      id: 'physical-1', sourceIds: ['physical-1', 'physical-2'],
      content: { parts: [
        { type: 'media', media: { name: 'one.bin' } },
        { type: 'media', media: { name: 'two.txt' } },
      ] },
    }])
    const refreshed = await platform.getHistory(session, { id: '1:u' })
    expect(refreshed.messages).toHaveLength(1)
    expect(refreshed.messages[0]).toMatchObject({
      id: 'physical-1', sourceIds: ['physical-1', 'physical-2'],
      content: { parts: [
        { type: 'media', media: { name: 'one.bin' } },
        { type: 'media', media: { name: 'two.txt' } },
      ] },
    })
    await store.ingestMany(session, { id: '1:u', kind: 'direct', title: 'Peer' }, refreshed.messages, {
      allocation: 'history',
    })
    expect(await store.readHistory(session.platformSessionId, '1:u', { limit: 10 })).toMatchObject([{
      id: 'physical-1', sourceIds: ['physical-1', 'physical-2'],
      content: { parts: [
        { type: 'media', media: { name: 'one.bin' } },
        { type: 'media', media: { name: 'two.txt' } },
      ] },
    }])
    await expect(uploads.open(session.platformSessionId, '101', 1)).rejects.toThrow('part is missing')
    await expect(uploads.open(session.platformSessionId, '102', 1)).rejects.toThrow('part is missing')
  })
})
