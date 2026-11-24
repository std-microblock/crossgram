import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc, stableId } from './dialogs.js'
import { LinkPreviewService } from './link-preview.js'
import type { IMEvent, IMHistoryPage, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'link-preview-session',
  platformId: 'link-preview-test',
  userId: 'me',
  credentials: { token: 'test' },
  metadata: { firstName: 'Current' },
  virtualPhone: '888123456789012',
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function serveThumbnail(): Promise<string> {
  const server: Server = createServer((request, response) => {
    if (request.url === '/cover.png') {
      response.setHeader('content-type', 'image/png')
      response.end(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ))
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<html><head><meta property="og:title" content="Bridged article">'
      + '<meta property="og:image" content="/cover.png"></head></html>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test server address')
  disposals.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  return `http://127.0.0.1:${address.port}`
}

async function cacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'link-preview-projection-'))
  disposals.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

class LinkPlatform implements IMPlatform {
  readonly conversations: Array<{ id: string, kind: 'direct', title: string }> = [
    { id: 'alice', kind: 'direct', title: 'Alice' },
  ]
  readonly messages: IMMessage[] = []

  readonly capabilities = {
    history: true,
    readState: { markRead: true, events: false },
    send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
    conversations: { groups: false, channels: false, subchannels: false },
  }

  async subscribe() { return () => {} }

  async sendMessage(): Promise<IMMessage> {
    throw new Error('the link preview test never sends')
  }

  async getDialogs() {
    return {
      dialogs: this.conversations.map((conversation) => ({
        conversation, unreadCount: 0, lastMessage: this.messages.at(-1),
      })),
    }
  }

  async getHistory(_session: PlatformSession, conversation: { id: string }): Promise<IMHistoryPage> {
    return {
      messages: this.messages.filter((message) => message.conversationId === conversation.id),
    }
  }
}

describe('link preview projection', () => {
  it('publishes the plain link first and republishes the same message with the fetched card', async () => {
    const base = await serveThumbnail()
    const platform = new LinkPlatform()
    platform.messages.push({
      id: 'm1', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_000,
      content: { parts: [{ type: 'text', text: `看看这个 ${base}/article 有意思` }] },
    })
    const events: IMEvent[] = []
    const linkPreviews = new LinkPreviewService({
      cachePath: await cacheDir(),
      allowPrivateHosts: true,
      timeoutMs: 5_000,
    })
    const rpc = new DialogRpc(platform, session, undefined, {
      dcId: 1,
      linkPreviews,
      onLocalEvent: async (_session, event) => {
        events.push(event)
        return undefined
      },
    })
    const peerId = stableId(`peer:${session.platformSessionId}:alice`)
    const peer = { _: 'inputPeerUser' as const, userId: peerId, accessHash: Long.ZERO }

    await rpc.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const first = await rpc.getHistory({
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    // 抓取是后台任务：首次投影只有普通链接。
    expect((first.messages[0] as tl.RawMessage).media).toBeUndefined()
    expect((first.messages[0] as tl.RawMessage).entities).toEqual([
      expect.objectContaining({ _: 'messageEntityUrl' }),
    ])

    const edit = await waitFor(() => events.find((event) => event.type === 'message-edit'))
    expect(edit).toMatchObject({
      type: 'message-edit',
      eventId: `link-preview:${encodeURIComponent('alice')}:${encodeURIComponent('m1')}`,
      conversation: { id: 'alice' },
      message: { id: 'm1' },
    })

    const second = await rpc.getHistory({
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0,
      addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    expect((second.messages[0] as tl.RawMessage).media).toMatchObject({
      _: 'messageMediaWebPage',
      manual: true,
      webpage: { title: 'Bridged article', photo: { _: 'photo' } },
    })
  })
})

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return probe()
}
