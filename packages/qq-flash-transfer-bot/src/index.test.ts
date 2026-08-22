import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import {
  IMPlatformService, SystemPeerService,
  type IMEvent, type IMMessage, type IMMessageInput, type IMPlatform, type PlatformSession,
} from '@mtproto-relay/bridge'
import * as bot from './index.js'

const session: PlatformSession = {
  platformId: 'qqnt', platformSessionId: 'qq-session', userId: 'self', credentials: {}, metadata: {},
}

function outgoing(): IMMessage {
  return {
    id: 'outgoing', conversationId: bot.QQ_FLASH_TRANSFER_CONVERSATION_ID,
    senderId: session.userId, timestamp: 1, outgoing: true, content: { parts: [] },
  }
}

async function fixture(config: bot.Config = {}, options: { flashTransfer?: boolean } = {}) {
  const ctx = new Context()
  const platforms = new IMPlatformService(ctx)
  const peers = new SystemPeerService(ctx)
  const events: IMEvent[] = []
  peers.attach(async (_session, event) => { events.push(event); return {} as never })
  const create = vi.fn(async () => ({
    fileSetId: 'fileset-1', shareLink: 'https://qq.example/flash/code', expiresAt: 2_000_000_000_000,
  }))
  const platform: IMPlatform = {
    platformKind: 'qq',
    capabilities: {
      history: true,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
      conversations: { groups: true, channels: false, subchannels: false },
    },
    ...(options.flashTransfer === false ? {} : { flashTransfer: { create } }),
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('not used') },
  }
  platforms.activateSession('qqnt', platform, session)
  const plugin = ctx.plugin(bot, config)
  await plugin
  const resolution = await peers.resolve(session, bot.QQ_FLASH_TRANSFER_CONVERSATION_ID)
  if (!resolution) throw new Error('missing QQ Flash Transfer bot')
  return { plugin, peers, events, create, resolution }
}

describe('QQ Flash Transfer bot', () => {
  it('uses the caption as the set name and returns a clickable share link', async () => {
    const { plugin, peers, events, create, resolution } = await fixture()
    events.length = 0
    const input: IMMessageInput = { parts: [{ type: 'text', text: 'Release files' }, {
      type: 'media', media: {
        kind: 'file', name: 'release.zip', size: 4,
        source: { size: 4, async *stream() { yield Uint8Array.of(1, 2, 3, 4) } },
      },
    }] }
    const file = input.parts[1]
    if (!file || file.type !== 'media') throw new Error('missing file input')

    await peers.receive(session, resolution, outgoing(), input)

    expect(create).toHaveBeenCalledWith(session, [file.media], expect.objectContaining({
      name: 'Release files', signal: expect.any(AbortSignal),
    }))
    const messages = events.filter((event): event is Extract<IMEvent, { type: 'message' }> => event.type === 'message')
    expect(messages).toHaveLength(2)
    expect(messages[0]!.message.content.parts[0]).toMatchObject({
      text: expect.stringContaining('上传 1 个新文件'),
    })
    expect(messages[1]!.message.content.parts[0]).toMatchObject({
      text: expect.stringContaining('https://qq.example/flash/code'),
      entities: [{ type: 'text-link', url: 'https://qq.example/flash/code' }],
    })
    await plugin.dispose()
  })

  it('is unavailable for non-QQ platform sessions even when they expose a similarly named provider', async () => {
    const ctx = new Context()
    const platforms = new IMPlatformService(ctx)
    const peers = new SystemPeerService(ctx)
    const platform: IMPlatform = {
      platformKind: 'discord',
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      flashTransfer: { async create() { throw new Error('must not be called') } },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('not used') },
    }
    platforms.activateSession('discord', platform, { ...session, platformId: 'discord' })
    const plugin = ctx.plugin(bot)
    await plugin

    await expect(peers.resolve(
      { ...session, platformId: 'discord' }, bot.QQ_FLASH_TRANSFER_CONVERSATION_ID,
    )).resolves.toBeUndefined()
    await plugin.dispose()
  })

  it('enforces the configured file-count limit before calling the platform', async () => {
    const { plugin, peers, events, create, resolution } = await fixture({ maxFiles: 1 })
    events.length = 0
    const media = (name: string): IMMessageInput['parts'][number] => ({
      type: 'media', media: { kind: 'file', name, size: 1, source: { size: 1, async *stream() { yield Uint8Array.of(1) } } },
    })

    await peers.receive(session, resolution, outgoing(), { parts: [media('a'), media('b')] })

    expect(create).not.toHaveBeenCalled()
    expect(events).toMatchObject([{ type: 'message', message: { content: { parts: [{ text: expect.stringContaining('最多') }] } } }])
    await plugin.dispose()
  })

  it('explains that an uncached forwarded QQ file must be downloaded in QQ first', async () => {
    const { plugin, peers, events, create, resolution } = await fixture()
    events.length = 0
    create.mockRejectedValueOnce(new Error(
      'QQNT bridge 502: QQ media is not available in the local cache: archived.zip',
    ))
    await peers.receive(session, resolution, outgoing(), { parts: [{
      type: 'media',
      media: {
        kind: 'file', name: 'archived.zip', size: 10,
        source: { size: 10, async *stream() { throw new Error('must not stream') } },
        origin: {
          id: 'qq-file', kind: 'file', name: 'archived.zip', size: 10,
          locator: { messageId: 'm1', elementId: 'e1', chatType: 1, peerUid: 'friend' },
        },
      },
    }] })

    const messages = events.filter((event): event is Extract<IMEvent, { type: 'message' }> => event.type === 'message')
    expect(messages.at(-1)?.message.content.parts[0]).toMatchObject({
      text: expect.stringContaining('请先在 QQ 中下载'),
    })
    await plugin.dispose()
  })

  it('keeps stale bot dialogs resolvable and explains that Linux QQ is unsupported', async () => {
    const { plugin, peers, events, create, resolution } = await fixture({}, { flashTransfer: false })
    events.length = 0
    await peers.receive(session, resolution, outgoing(), { parts: [{
      type: 'media',
      media: {
        kind: 'file', name: 'alpha.bin', size: 3,
        source: { size: 3, async *stream() { throw new Error('must not stream') } },
      },
    }] })

    expect(create).not.toHaveBeenCalled()
    expect(events).toMatchObject([{
      type: 'message', message: { content: { parts: [{
        text: expect.stringContaining('Linux QQ 未实现此能力'),
      }] } },
    }])
    await plugin.dispose()
  })
})
