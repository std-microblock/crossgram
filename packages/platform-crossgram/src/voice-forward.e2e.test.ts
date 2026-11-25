import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlatformSession } from '../../bridge/src/platform.js'
import { QQNTPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'qqnt-voice-forward-e2e', platformId: 'qqnt',
  userId: 'self', credentials: {}, metadata: {},
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

async function collect(source: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

/**
 * QQ's native forward answers a voice message with the text QQ renders for it
 * ("[语音] 1'20\"") and the recording never reaches the destination. The adapter
 * must therefore upload the source recording again, which is what this test
 * watches from the bridge side.
 */
describe('QQNT voice forward E2E', () => {
  it('re-uploads a forwarded voice as a streaming PTT instead of using QQ forward', async () => {
    const silk = Buffer.from('silk-recording-bytes')
    const forwarded: string[] = []
    const sends: Array<{
      manifest: { media?: Array<{ kind?: string, name?: string, duration?: number }> }
      body: Buffer
    }> = []
    let server: Server | undefined
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/status') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ protocolVersion: 35, ready: true, selfUid: 'u_self', selfUin: '10001' }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages/forward') {
        // Real QQ reports success and leaves the text it renders for a voice
        // message in the destination chat, minus the recording.
        forwarded.push((await collect(request)).toString('utf8'))
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          messages: [{
            id: 'forwarded-text', conversationId: '1:u', senderId: 'self', timestamp: 1_800_000_100,
            outgoing: true, parts: [{ type: 'text', text: '[语音] 1\'20"' }],
          }],
        }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/files/asset') {
        await collect(request)
        response.setHeader('content-type', 'audio/silk')
        response.end(silk)
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages') {
        const encoded = request.headers['x-qqnt-manifest']
        if (typeof encoded !== 'string') throw new Error('missing QQNT manifest')
        const manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
        sends.push({ manifest, body: await collect(request) })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          id: 'resent-voice', conversationId: '1:u', senderId: 'self', timestamp: 1_800_000_100,
          outgoing: true, parts: [{
            type: 'media',
            media: {
              id: 'resent-voice:ptt', kind: 'file', name: 'voice.ogg', mimeType: 'audio/ogg',
              duration: 80, voice: true, size: 128,
              locator: {
                messageId: 'resent-voice', elementId: 'ptt', chatType: 1,
                peerUid: 'u', kind: 'voice', fileName: 'voice.ogg',
              },
            },
          }],
        }))
        return
      }
      response.writeHead(404).end('not found')
    })
    server.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })
    const outputs = await platform.forwardMessages(
      session, { id: '1:peer' }, ['qq-voice-message'], { id: '1:u' },
      {
        sourceMessages: [{
          id: 'stored-voice', conversationId: '1:peer', senderId: 'alice', timestamp: 1_800_000_000,
          content: { parts: [{
            type: 'media' as const,
            media: {
              id: 'stored-voice:ptt', kind: 'file' as const, name: 'voice.silk',
              mimeType: 'audio/silk', size: silk.length, duration: 80, voice: true,
              locator: {
                messageId: 'stored-voice', elementId: 'ptt', chatType: 1 as const,
                peerUid: 'alice', kind: 'voice' as const, fileName: 'voice.silk',
                filePath: '/qq/voice.silk',
              },
            },
          }] },
        }],
      },
    )

    expect(forwarded).toEqual([])
    expect(sends).toHaveLength(1)
    expect(sends[0]!.manifest.media).toMatchObject([{ kind: 'voice', duration: 80 }])
    expect(sends[0]!.body.subarray(0, silk.length).toString()).toBe(silk.toString())
    expect(outputs).toMatchObject([{
      id: 'resent-voice',
      content: { parts: [{ type: 'media', media: { voice: true, duration: 80 } }] },
    }])
  })
})
