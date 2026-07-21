import { describe, expect, it, vi } from 'vitest'
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
    ;(ctx.fiber as typeof ctx.fiber & {
      entry?: { id: string, options: { id: string } }
    }).entry = { id: `parent:${id}`, options: { id } }
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
    expect(ctx.imPlatform.require('static-one')).not.toBe(ctx.imPlatform.require('static-two'))

    await first.dispose()
    expect(ctx.imPlatform.ids).toEqual(['static-two'])
    await second.dispose()
    expect(ctx.imPlatform.ids).toEqual([])
    await service.dispose()
  })

  it('does not generate durable demo traffic unless an interval is configured', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const service = ctx.plugin((serviceCtx) => { new IMPlatformService(serviceCtx) })
    const plugin = ctx.plugin(loadedStaticPlugin('static-default'))
    try {
      await Promise.all([service, plugin])
      const events: import('@mtproto-relay/bridge').IMEvent[] = []
      const unsubscribe = await ctx.imPlatform.require('static-default').subscribe(session, (event) => events.push(event))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(events).toEqual([])
      await unsubscribe()
    } finally {
      await plugin.dispose()
      await service.dispose()
      vi.useRealTimers()
    }
  })

  it('exposes direct, group, channel, and subchannel dialogs through bounded pages', async () => {
    const platform = new StaticPlatform()
    expect(platform.capabilities).toMatchObject({
      history: true,
      send: { text: true, images: true, files: true, mixed: true },
      conversations: { groups: true, channels: true, subchannels: true },
    })
    const all: Awaited<ReturnType<StaticPlatform['getDialogs']>>['dialogs'] = []
    let cursor: string | undefined
    do {
      const page = await platform.getDialogs(session, { cursor, limit: 3 })
      expect(page.dialogs.length).toBeLessThanOrEqual(3)
      all.push(...page.dialogs)
      cursor = page.nextCursor
    } while (cursor)
    expect(all).toHaveLength(9)
    expect(all.map((dialog) => dialog.conversation.id)).toEqual([
      'group-a', 'qq-group', 'group-c', 'group-b', 'discord-support',
      'discord-general', 'bob', 'alice', 'group-d',
    ])
    const after = await platform.getDialogs(session, { afterId: 'group-c', limit: 2 })
    expect(after.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['group-b', 'discord-support'])
    expect(all.find((dialog) => dialog.conversation.id === 'discord-support')?.conversation)
      .toMatchObject({ parentId: 'discord-general', spaceId: 'discord-guild' })
  })

  it('runs Group A new, edit, and delete events in order and mutates history', async () => {
    const platform = new StaticPlatform({ now: () => 1_900_000_000, instanceId: 'test-run' })
    const events: import('@mtproto-relay/bridge').IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await platform.tick(session)

    expect(events.map((event) => event.type)).toEqual(['message', 'message-edit', 'message-delete'])
    expect(events[0]).toMatchObject({
      type: 'message', conversation: { id: 'group-a' },
      message: { senderId: 'alice', content: { parts: [{ text: 'Group A live message 1' }] } },
    })
    expect(events[1]).toMatchObject({
      type: 'message-edit', eventId: 'group-a:edit:test-run:1',
      message: { id: 'group-a:seed:3', content: { parts: [{ text: 'Group A edited message 1' }] } },
    })
    expect(events[2]).toMatchObject({
      type: 'message-delete', eventId: 'group-a:delete:test-run:1', messageIds: ['group-a:seed:1'],
    })
    const history = await platform.getHistory(session, { id: 'group-a' }, { limit: 10 })
    expect(history.messages.map((message) => message.id)).toEqual([
      expect.stringContaining('group-a:live:test-run:1'), 'group-a:seed:3', 'group-a:seed:2',
    ])
    expect(history.messages[1].content.parts).toEqual([{ type: 'text', text: 'Group A edited message 1' }])
    await unsubscribe()
  })

  it('names live and sent events independently across reconstructed platform instances', async () => {
    const first = new StaticPlatform({ now: () => 1_900_000_000, instanceId: 'before-hmr' })
    const second = new StaticPlatform({ now: () => 1_900_000_000, instanceId: 'after-hmr' })
    const firstEvents: import('@mtproto-relay/bridge').IMEvent[] = []
    const secondEvents: import('@mtproto-relay/bridge').IMEvent[] = []
    const unsubscribeFirst = await first.subscribe(session, (event) => { firstEvents.push(event) })
    const unsubscribeSecond = await second.subscribe(session, (event) => { secondEvents.push(event) })
    await first.tick(session)
    await second.tick(session)
    const firstSent = await first.sendMessage(session, { id: 'group-b' }, { parts: [{ type: 'text', text: 'one' }] })
    const secondSent = await second.sendMessage(session, { id: 'group-b' }, { parts: [{ type: 'text', text: 'two' }] })

    expect((firstEvents[0] as Extract<typeof firstEvents[number], { type: 'message' }>).message.id)
      .not.toBe((secondEvents[0] as Extract<typeof secondEvents[number], { type: 'message' }>).message.id)
    expect((firstEvents[1] as Extract<typeof firstEvents[number], { type: 'message-edit' }>).eventId)
      .not.toBe((secondEvents[1] as Extract<typeof secondEvents[number], { type: 'message-edit' }>).eventId)
    expect(firstSent.id).not.toBe(secondSent.id)
    await Promise.all([unsubscribeFirst(), unsubscribeSecond()])
  })

  it('ticks Group A every 1000ms while subscribed and stops after unsubscribe', async () => {
    vi.useFakeTimers()
    try {
      const platform = new StaticPlatform({ eventIntervalMs: 1_000, now: () => 1_900_000_000 })
      const events: import('@mtproto-relay/bridge').IMEvent[] = []
      const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(events.map((event) => event.type)).toEqual([
        'message', 'message-edit', 'message-delete',
        'message', 'message-edit', 'message-delete',
      ])
      await unsubscribe()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(events).toHaveLength(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('mirrors messages sent to Group B into Group C as another user', async () => {
    const platform = new StaticPlatform({ now: () => 1_900_000_100 })
    const events: import('@mtproto-relay/bridge').IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    const sent = await platform.sendMessage(session, { id: 'group-b' }, {
      parts: [{ type: 'text', text: 'mirror this' }],
    })

    expect(sent).toMatchObject({ conversationId: 'group-b', senderId: 'self', outgoing: true })
    expect(events).toMatchObject([{
      type: 'message',
      conversation: { id: 'group-c' },
      message: {
        conversationId: 'group-c', senderId: 'mirror-user',
        content: { parts: [{ type: 'text', text: 'mirror this' }] },
        metadata: { mirroredFromConversationId: 'group-b', mirroredFromMessageId: sent.id },
      },
    }])
    const history = await platform.getHistory(session, { id: 'group-c' }, { limit: 1 })
    expect(history.messages[0]).toMatchObject({ senderId: 'mirror-user', content: sent.content })
    await unsubscribe()
  })

  it('serves Group D ten-thousand-message history through bounded deep pages', async () => {
    const platform = new StaticPlatform({ historySize: 10_000 })
    const first = await platform.getHistory(session, { id: 'group-d' }, { limit: 50 })
    expect(first.messages).toHaveLength(50)
    expect(first.messages[0].content.parts).toEqual([{ type: 'text', text: 'Group D history message 10000' }])
    expect(first.nextCursor).toBe('50')
    const second = await platform.getHistory(session, { id: 'group-d' }, { cursor: first.nextCursor, limit: 50 })
    expect(second.messages).toHaveLength(50)
    expect(second.messages[0].content.parts).toEqual([{ type: 'text', text: 'Group D history message 9950' }])
    const deep = await platform.getHistory(session, { id: 'group-d' }, { cursor: '9990', limit: 50 })
    expect(deep.messages).toHaveLength(10)
    expect(deep.messages.at(-1)?.content.parts).toEqual([{ type: 'text', text: 'Group D history message 1' }])
    expect(deep.nextCursor).toBeUndefined()
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
