import { describe, expect, it, vi } from 'vitest'
import { h, type Bot } from '@satorijs/core'
import { mapSatoriConversation, mapSatoriMessage, toSatoriElements } from './convert.js'

describe('Satori conversion', () => {
  it('maps guild channels, member aliases, mentions, replies, and media without losing opaque IDs', () => {
    const conversation = mapSatoriConversation(
      { id: 'channel/opaque', type: 0, name: 'general', parentId: 'category' },
      { id: 'guild:one', name: 'Workspace', avatar: 'https://cdn.test/guild.png' },
    )
    const message = mapSatoriMessage({
      id: 'message/opaque',
      channel: { id: 'channel/opaque', type: 0, name: 'general', parentId: 'category' },
      guild: { id: 'guild:one', name: 'Workspace' },
      user: { id: 'user:alice', name: 'alice', avatar: 'https://cdn.test/alice.png' },
      member: { user: { id: 'user:alice', name: 'alice' }, nick: 'Alice in Workspace' },
      elements: [
        h.text('hello '),
        h.at('user:bob', { name: 'Bob' }),
        h('br'),
        h('img', { src: 'https://cdn.test/image.png', title: 'photo.png', width: '640', height: 480 }),
        h('file', { src: 'internal:mock/self/file', title: 'notes.txt', type: 'text/plain' }),
      ],
      timestamp: 1_700_000_000_123,
      quote: { id: 'reply:opaque' },
    }, conversation, 'self')

    expect(conversation).toMatchObject({
      id: 'channel/opaque', kind: 'channel', title: 'general', parentId: 'category', spaceId: 'guild:one',
    })
    expect(message).toMatchObject({
      id: 'message/opaque', conversationId: 'channel/opaque', senderId: 'user:alice',
      sender: { firstName: 'Alice in Workspace', username: 'alice' },
      timestamp: 1_700_000_000, replyToId: 'reply:opaque', outgoing: false,
      content: { parts: [
        { type: 'text', text: 'hello @Bob\n', entities: [
          { type: 'mention', offset: 6, length: 4, userId: 'user:bob' },
        ] },
        { type: 'media', media: {
          kind: 'image', name: 'photo.png', width: 640, height: 480,
          locator: { url: 'https://cdn.test/image.png' },
        } },
        { type: 'media', media: {
          kind: 'file', name: 'notes.txt', mimeType: 'text/plain',
          locator: { url: 'internal:mock/self/file' },
        } },
      ] },
    })
    expect(message.content.parts[1]?.type === 'media' && message.content.parts[1].media.id)
      .toMatch(/^satori:[0-9a-f]{24}$/)
  })

  it('uploads input streams once, reports progress, and recreates quotes and mention elements', async () => {
    const createUpload = vi.fn(async (upload: { type: string, filename?: string, data: ArrayBuffer }) => {
      expect(upload.type).toBe('image/png')
      expect(upload.filename).toBe('photo.png')
      expect([...new Uint8Array(upload.data)]).toEqual([1, 2, 3, 4])
      return ['internal:mock/self/upload']
    })
    const progress = vi.fn()
    const elements = await toSatoriElements({ createUpload } as unknown as Bot, {
      replyToId: 'reply-id',
      parts: [{
        type: 'text', text: 'hi @Bob!',
        entities: [{ type: 'mention', offset: 3, length: 4, userId: 'bob' }],
      }, {
        type: 'media', media: {
          kind: 'image', name: 'photo.png', mimeType: 'image/png',
          source: {
            size: 4,
            async *stream() { yield Uint8Array.of(1, 2); yield Uint8Array.of(3, 4) },
          },
        },
      }],
    }, { onProgress: progress })

    expect(elements.map((element) => element.type)).toEqual(['quote', 'text', 'at', 'text', 'img'])
    expect(elements[0].attrs.id).toBe('reply-id')
    expect(elements[2].attrs).toMatchObject({ id: 'bob', name: 'Bob' })
    expect(elements[4].attrs).toMatchObject({ src: 'internal:mock/self/upload', title: 'photo.png' })
    expect(createUpload).toHaveBeenCalledOnce()
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { phase: 'upload', mediaIndex: 0, transferredBytes: 2, totalBytes: 4 },
      { phase: 'upload', mediaIndex: 0, transferredBytes: 4, totalBytes: 4 },
    ])
  })
})
