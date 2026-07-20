import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { IMPlatformService } from '@mtproto-relay/bridge'
import type {
  IMConversation, IMMediaInput, IMMessage, IMMessageInput, IMTransferProgress, PlatformSession,
} from '@mtproto-relay/bridge'
import { StaticPlatform } from '@mtproto-relay/platform-static'
import * as staticPlatformPlugin from '@mtproto-relay/platform-static'

const session: PlatformSession = {
  platformSessionId: 'static-session', platformId: 'static', userId: 'self', credentials: {}, metadata: {},
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of source) {
    chunks.push(chunk)
    size += chunk.length
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function mediaInput(kind: 'image' | 'file', chunks: number[][], name: string): IMMediaInput {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  return {
    kind, name, mimeType: kind === 'image' ? 'image/png' : 'application/octet-stream', size,
    source: {
      size,
      async *stream(options) {
        for (const values of chunks) {
          if (options?.signal?.aborted) throw options.signal.reason
          yield new Uint8Array(values)
        }
      },
    },
  }
}

function loadedStaticPlugin(id: string, config: staticPlatformPlugin.Config = {}) {
  const plugin = (ctx: Context) => {
    ;(ctx.fiber as typeof ctx.fiber & { entry?: { id: string } }).entry = { id }
    staticPlatformPlugin.apply(ctx, config)
  }
  plugin.inject = ['imPlatform']
  return plugin
}

describe('StaticPlatform', () => {
  it('registers multiple Cordis plugin instances and disposes them independently', async () => {
    const ctx = new Context()
    const service = ctx.plugin((serviceCtx) => { new IMPlatformService(serviceCtx) })
    const first = ctx.plugin(loadedStaticPlugin('static-one'))
    const second = ctx.plugin(loadedStaticPlugin('static-two', { transferChunkSize: 4 }))
    await Promise.all([service, first, second])

    expect(ctx.imPlatform.ids).toEqual(['static-one', 'static-two'])
    expect(ctx.imPlatform.require('static-one')).toBeInstanceOf(StaticPlatform)
    expect(ctx.imPlatform.require('static-two')).toBeInstanceOf(StaticPlatform)
    expect(ctx.imPlatform.require('static-one').id).toBe('static-one')
    expect(ctx.imPlatform.require('static-two').id).toBe('static-two')

    await first.dispose()
    expect(ctx.imPlatform.ids).toEqual(['static-two'])
    await second.dispose()
    expect(ctx.imPlatform.ids).toEqual([])
    await service.dispose()
  })

  it('exposes direct, group, channel, and subchannel dialogs through bounded pages', async () => {
    const platform = new StaticPlatform()
    expect(platform.capabilities).toMatchObject({
      history: true,
      send: { text: true, images: true, files: true, mixed: true },
      conversations: { groups: true, channels: true, subchannels: true },
    })
    const first = await platform.getDialogs(session, { limit: 2 })
    expect(first.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['qq-group', 'discord-support'])
    expect(first.nextCursor).toBe('2')
    const second = await platform.getDialogs(session, { cursor: first.nextCursor, limit: 2 })
    expect(second.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['discord-general', 'bob'])
    const after = await platform.getDialogs(session, { afterId: 'discord-support', limit: 2 })
    expect(after.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['discord-general', 'bob'])

    const all = [
      ...first.dialogs,
      ...second.dialogs,
      ...(await platform.getDialogs(session, { cursor: second.nextCursor, limit: 2 })).dialogs,
    ]
    expect(all.map((dialog) => dialog.conversation.kind)).toEqual([
      'group', 'channel', 'channel', 'direct', 'direct',
    ])
    expect(all.find((dialog) => dialog.conversation.id === 'discord-support')?.conversation)
      .toMatchObject({ parentId: 'discord-general', spaceId: 'discord-guild' })
  })

  it('paginates group history with cursor, before, and after anchors without returning the full list', async () => {
    const platform = new StaticPlatform()
    const first = await platform.getHistory(session, { id: 'qq-group' }, { limit: 2 })
    expect(first.messages.map((message) => message.id)).toEqual(['group:album', 'group:2'])
    expect(first.nextCursor).toBe('2')
    const cursorPage = await platform.getHistory(session, { id: 'qq-group' }, { cursor: '2', limit: 1 })
    expect(cursorPage.messages.map((message) => message.id)).toEqual(['group:1'])
    const before = await platform.getHistory(session, { id: 'qq-group' }, {
      before: { id: 'group:2', timestamp: 1_700_000_400 }, limit: 10,
    })
    expect(before.messages.map((message) => message.id)).toEqual(['group:1'])
    const after = await platform.getHistory(session, { id: 'qq-group' }, {
      after: { id: 'group:2', timestamp: 1_700_000_400 }, limit: 10,
    })
    expect(after.messages.map((message) => message.id)).toEqual(['group:album'])
    expect(first.messages[0].content.parts.map((part) => part.type === 'media' ? part.media.kind : part.type))
      .toEqual(['text', 'image', 'file'])
  })

  it('sends text, images, and files in one call while consuming and reporting each chunk', async () => {
    const platform = new StaticPlatform({ now: () => 1_900_000_000 })
    const progress: IMTransferProgress[] = []
    const content: IMMessageInput = {
      parts: [
        { type: 'text', text: 'mixed content' },
        { type: 'media', media: mediaInput('image', [[1, 2], [3]], 'photo.png') },
        { type: 'media', media: mediaInput('file', [[4], [5, 6]], 'file.bin') },
      ],
    }
    const sent = await platform.sendMessage(session, { id: 'qq-group' }, content, {
      onProgress: (event) => { progress.push(event) },
    })

    expect(sent).toMatchObject({
      conversationId: 'qq-group', senderId: 'self', outgoing: true, timestamp: 1_900_000_000,
      groupId: expect.any(String), sourceIds: [expect.any(String), expect.any(String)],
    })
    expect(sent.id.length).toBeGreaterThan(256)
    expect(progress).toEqual([
      { phase: 'upload', mediaIndex: 0, transferredBytes: 2, totalBytes: 3 },
      { phase: 'upload', mediaIndex: 0, transferredBytes: 3, totalBytes: 3 },
      { phase: 'upload', mediaIndex: 1, transferredBytes: 1, totalBytes: 3 },
      { phase: 'upload', mediaIndex: 1, transferredBytes: 3, totalBytes: 3 },
    ])
    const history = await platform.getHistory(session, { id: 'qq-group' }, { limit: 1 })
    expect(history.messages[0]).toEqual(sent)
    const medias = sent.content.parts.flatMap((part) => part.type === 'media' ? [part.media] : [])
    expect(platform.mediaBytes(medias[0].id)).toEqual(new Uint8Array([1, 2, 3]))
    expect(platform.mediaBytes(medias[1].id)).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('downloads seeded and sent media by range with progressive chunks', async () => {
    const platform = new StaticPlatform({ transferChunkSize: 4 })
    const [album] = (await platform.getHistory(session, { id: 'qq-group' }, { limit: 1 })).messages
    const file = album.content.parts.find((part) => part.type === 'media' && part.media.kind === 'file')
    if (!file || file.type !== 'media') throw new Error('seeded file missing')
    const progress: IMTransferProgress[] = []
    const bytes = await collect(platform.downloadMedia(session, file.media, {
      offset: 7, limit: 6, onProgress: (event) => { progress.push(event) },
    }))
    expect(new TextDecoder().decode(bytes)).toBe('seeded')
    expect(progress).toEqual([
      { phase: 'download', mediaIndex: 0, transferredBytes: 4, totalBytes: 6 },
      { phase: 'download', mediaIndex: 0, transferredBytes: 6, totalBytes: 6 },
    ])
  })

  it('waits for subscribe handlers, stores incoming group messages, deduplicates, and unsubscribes', async () => {
    const platform = new StaticPlatform()
    const order: string[] = []
    const unsubscribe = await platform.subscribe(session, async (event) => {
      order.push(`start:${event.type}`)
      await Promise.resolve()
      order.push(`end:${event.type}`)
    })
    const conversation: IMConversation = { id: 'new-group', kind: 'group', title: 'New Group' }
    const message: IMMessage = {
      id: `incoming:${'i'.repeat(8_192)}`, conversationId: conversation.id, senderId: 'alice', timestamp: 2_000_000_000,
      content: { parts: [{ type: 'text', text: 'incoming' }] },
    }
    await platform.emitMessage(session, conversation, message)
    await platform.emitMessage(session, conversation, message)
    expect(order).toEqual(['start:message', 'end:message', 'start:message', 'end:message'])
    expect((await platform.getHistory(session, { id: conversation.id }, { limit: 10 })).messages).toEqual([message])
    await unsubscribe()
    await platform.emitMessage(session, conversation, { ...message, id: 'after-unsubscribe', timestamp: 2_000_000_001 })
    expect(order).toHaveLength(4)
  })

  it('validates cursors, targets, empty messages, missing media, and cancellation', async () => {
    const platform = new StaticPlatform()
    await expect(platform.getDialogs(session, { cursor: 'bad' })).rejects.toThrow('invalid static cursor')
    await expect(platform.getHistory(session, { id: 'missing' })).rejects.toThrow('conversation not found')
    await expect(platform.sendMessage(session, { id: 'alice' }, { parts: [] })).rejects.toThrow('message is empty')
    const missing: import('@mtproto-relay/bridge').IMMedia = {
      id: 'missing', kind: 'file', locator: { mediaId: 'missing' },
    }
    await expect(collect(platform.downloadMedia(session, missing))).rejects.toThrow('media not found')

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(platform.sendMessage(session, { id: 'alice' }, {
      parts: [{ type: 'media', media: mediaInput('file', [[1]], 'cancel.bin') }],
    }, { signal: controller.signal })).rejects.toThrow('cancelled')
  })
})
