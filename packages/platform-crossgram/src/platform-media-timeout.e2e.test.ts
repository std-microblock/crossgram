import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { IMMediaUnavailableError, type PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'
import type { QQMediaLocator } from './protocol.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

/** 消费整条下载流：超时必须在这一步抛出，而不是被吞成空数据或 EOF。 */
async function drain(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  return `http://127.0.0.1:${address.port}`
}

function stalledLocator(overrides: Partial<QQMediaLocator> = {}): QQMediaLocator {
  return {
    messageId: 'stalled', elementId: 'element', chatType: 2, peerUid: 'group',
    kind: 'image', fileName: 'photo.jpg', filePath: '/cache/photo.jpg',
    ...overrides,
  }
}

describe('QQNT media upstream timeouts', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.close()
    server.closeAllConnections()
    await once(server, 'close')
    server = undefined
  })

  /** 一个既不回响应头也不断开的 bridge / CDN：线上卡死的一张图就是这个形态。 */
  async function startStalledUpstream(): Promise<string> {
    server = createServer(() => { /* 永不回包 */ })
    return await listen(server)
  }

  it('fails a stalled media download instead of hanging the getFile request', async () => {
    const endpoint = await startStalledUpstream()
    const platform = new QQNTPlatform({ endpoint, timeouts: { bridgeMs: 150 } })
    const media = { id: 'stalled-image', kind: 'image' as const, name: 'photo.jpg', size: 10, locator: stalledLocator() }

    const error = await drain(platform.downloadMedia(session, media)).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('QQNT bridge request timed out after 150ms')
    // 超时是暂时性故障，不能被标成「媒体已失效」，否则客户端会把这张图永久记成坏文件。
    expect(error).not.toBeInstanceOf(IMMediaUnavailableError)
  })

  it('never treats an upstream timeout at a non-zero offset as media EOF', async () => {
    const endpoint = await startStalledUpstream()
    const platform = new QQNTPlatform({ endpoint, timeouts: { bridgeMs: 150 } })
    const media = { id: 'stalled-image', kind: 'image' as const, name: 'photo.jpg', size: 262_144, locator: stalledLocator() }

    // offset > 0 时 `downloadMedia` 会把越界 Range 当成 EOF 静默结束；超时绝不能走进那条分支。
    await expect(drain(platform.downloadMedia(session, media, { offset: 131_072, limit: 131_072 })))
      .rejects.toThrow('QQNT bridge request timed out after 150ms')
  })

  it('propagates a stalled direct-URL resolution from resolveMediaUrl', async () => {
    const endpoint = await startStalledUpstream()
    const platform = new QQNTPlatform({ endpoint, timeouts: { bridgeMs: 150 } })
    const media = {
      id: 'stalled-image', kind: 'image' as const, name: 'photo.jpg', size: 10,
      // 没有本地缓存路径，只能向 bridge 要 QQ 直链。
      locator: stalledLocator({ filePath: undefined, fileUuid: 'stalled-uuid' }),
    }

    // getFileUrl 链路在这里拿到超时错误后降级成 MEDIA_DIRECT_URL_UNAVAILABLE，客户端改走中转。
    await expect(platform.resolveMediaUrl(session, media)).rejects.toThrow('QQNT bridge request timed out after 150ms')
  })
})
