import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Http from '@cordisjs/plugin-http'
import Server from '@cordisjs/plugin-server'
import Satori, { h, Universal, type Session } from '@satorijs/core'
import SatoriServer from '@satorijs/plugin-server'
import WebSocket from 'ws'
import { Readable } from 'node:stream'
import { SatoriExporter, type SatoriExportConfig } from './satori-export.js'
import type { IMConversation, IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities, PlatformSession, Unsubscribe } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

const replacementSession: PlatformSession = {
  ...session, platformSessionId: 'qq-session-replacement',
}

const capabilities: PlatformCapabilities = {
  history: false,
  send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4_096, maxMedia: 0 },
  conversations: { groups: true, channels: false, subchannels: false },
}

const disposals: Array<{ dispose(): unknown }> = []

afterEach(async () => {
  for (const fiber of disposals.splice(0).reverse()) await Promise.resolve(fiber.dispose())
  vi.restoreAllMocks()
})

class TestPlatform implements IMPlatform {
  readonly capabilities = capabilities
  readonly subscribe = vi.fn(async (): Promise<Unsubscribe> => () => {})
  readonly getConversation = vi.fn(async (_session: PlatformSession, id: string) => ({
    id, kind: id.startsWith('direct:') ? 'direct' as const : 'group' as const, title: id,
  }))
  readonly resolveMediaUrl = vi.fn(async () => ({
    url: 'https://media.test/file', expiresAt: Date.now() + 60_000, supportsRange: true,
  }))
  readonly sendMessage = vi.fn(async (
    _session: PlatformSession,
    conversation: { id: string },
    content: IMMessageInput,
  ): Promise<IMMessage> => ({
    id: 'sent:1', conversationId: conversation.id, senderId: 'self', timestamp: 1_700_000_001,
    outgoing: true, content: content as IMMessage['content'],
  }))
}

async function createExporter(satori: Partial<SatoriExportConfig> = {}) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Http), ctx.plugin(Satori)]
  disposals.push(...fibers)
  await Promise.all(fibers)
  const warnings = vi.fn()
  const exporter = new SatoriExporter(ctx, { platformId: 'qqnt', platform: 'qq', ...satori }, { warn: warnings })
  const platform = new TestPlatform()
  exporter.start(platform, session)
  return { ctx, exporter, platform, warnings }
}

async function openSocket(url: URL): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function closedSocket(url: URL, identify: unknown): Promise<{ code: number, reason: string }> {
  const socket = await openSocket(url)
  return await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.send(JSON.stringify(identify))
  })
}

async function sourceBytes(source: { stream(): AsyncIterable<Uint8Array> }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source.stream()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function createSatoriServer(token?: string, limits: { maxRequestBodyBytes?: number, maxWebSocketPayload?: number } = {}) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Http),
    ctx.plugin(Server, { host: '127.0.0.1', port: 0, maxWebSocketPayload: limits.maxWebSocketPayload }),
    ctx.plugin(Satori),
  ]
  disposals.push(...fibers)
  await Promise.all(fibers)
  const server = ctx.plugin(SatoriServer, {
    path: '/satori', token, webhooks: [], maxRequestBodyBytes: limits.maxRequestBodyBytes,
  })
  disposals.push(server)
  await server
  const exporter = new SatoriExporter(ctx, { platformId: 'qqnt', platform: 'qq' }, { warn: vi.fn() })
  exporter.start(new TestPlatform(), session)
  return { ctx, events: new URL('/satori/v1/events', ctx.server.baseUrl) }
}

function message(id: string, conversationId: string, outgoing = false): IMMessage {
  return {
    id, conversationId, senderId: outgoing ? 'self' : 'alice', timestamp: 1_700_000_000,
    outgoing,
    sender: { id: outgoing ? 'self' : 'alice', firstName: outgoing ? 'Self' : 'Alice' },
    content: { parts: [{ type: 'text', text: `message ${id}` }] },
  }
}

describe('SatoriExporter', () => {
  it('dispatches only newly created incoming messages with QQ direct and group channel IDs', async () => {
    const { ctx, exporter, platform } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const group: IMConversation = { id: 'group:42', kind: 'group', spaceId: 'guild:7', title: 'QQ Group' }
    const direct: IMConversation = { id: 'direct:7', kind: 'direct', title: 'Alice' }

    exporter.handleMessage(session, group, message('replayed', group.id), { created: false })
    exporter.handleMessage(session, group, message('outgoing', group.id, true), { created: true })
    exporter.handleMessage(session, group, message('incoming', group.id), { created: true })
    exporter.handleMessage(session, direct, message('direct', direct.id), { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.map((event) => event.event)).toMatchObject([
      {
        channel: { id: group.id, type: 0, name: group.title },
        guild: { id: group.spaceId, name: group.title },
        user: { id: 'alice', name: 'Alice' },
        message: { id: 'incoming', content: 'message incoming' },
      },
      {
        channel: { id: direct.id, type: 1, name: direct.title },
        user: { id: 'alice', name: 'Alice' },
        message: { id: 'direct', content: 'message direct' },
      },
    ])
    expect(events[1]?.event.guild).toBeUndefined()
    expect(platform.subscribe).not.toHaveBeenCalled()
  })

  it('sends pure text through the provisioned canonical platform session', async () => {
    const { ctx, platform } = await createExporter()

    await expect(ctx.bots[0]!.createMessage('group:42', [h.text('hello')]))
      .resolves.toMatchObject([{ id: 'sent:1', channel: { id: 'group:42' } }])
    expect(platform.sendMessage).toHaveBeenCalledWith(
      session,
      { id: 'group:42' },
      { parts: [{ type: 'text', text: 'hello' }] },
    )
    expect(platform.getConversation).toHaveBeenCalledWith(session, 'group:42')
    expect(platform.subscribe).not.toHaveBeenCalled()
  })

  it('resolves a direct conversation before its first outbound message', async () => {
    const { ctx, platform } = await createExporter()

    await ctx.bots[0]!.createMessage('direct:7', [h.text('hello')])

    expect(platform.getConversation).toHaveBeenCalledWith(session, 'direct:7')
    expect(platform.sendMessage).toHaveBeenCalledWith(session, { id: 'direct:7' }, { parts: [{ type: 'text', text: 'hello' }] })
  })

  it('maps Satori mentions, quotes, emoji, images, and files to canonical input', async () => {
    const { ctx, platform } = await createExporter()

    await ctx.bots[0]!.createMessage('group:42', [
      h.at('bob', { name: 'Bob' }), h('br'), h.emoji('1:14', { name: '[smile]' }), h.quote('reply:1'),
      h('img', { src: 'https://example.test/image.png', title: 'image.png', type: 'image/png' }),
      h('file', { src: 'https://example.test/file.txt', title: 'file.txt', type: 'text/plain' }),
    ])
    const input = platform.sendMessage.mock.calls[0]?.[2]!
    expect(input).toMatchObject({
      replyToId: 'reply:1',
      parts: [
        { type: 'text', text: '@Bob\n[smile]', entities: [
          { type: 'mention', userId: 'bob', offset: 0, length: 4 },
          { type: 'custom-emoji', definition: { key: '1:14' } },
        ] },
        { type: 'media', media: { kind: 'image', name: 'image.png', mimeType: 'image/png' } },
        { type: 'media', media: { kind: 'file', name: 'file.txt', mimeType: 'text/plain' } },
      ],
    })
  })

  it.each([
    'http://outside.test/asset',
    'https://outside.test/asset',
    'http://localhost/asset',
    'https://[64:ff9b::7f00:1]/asset',
    'file:///etc/passwd',
  ])('rejects unsupported external media before opening a connection: %s', async (url) => {
    const { ctx, platform } = await createExporter()
    const get = vi.spyOn(ctx.http, 'get')

    await ctx.bots[0]!.createMessage('group:42', [h.img(url)])
    const source = (platform.sendMessage.mock.calls[0]![2].parts[0] as Extract<IMMessageInput['parts'][number], { type: 'media' }>).media.source!

    await expect(sourceBytes(source)).rejects.toThrow('unsupported media source')
    expect(get).not.toHaveBeenCalled()
  })

  it('reopens base64 data media for each stream consumption', async () => {
    const { ctx, platform } = await createExporter()
    const get = vi.spyOn(ctx.http, 'get')

    await ctx.bots[0]!.createMessage('group:42', [h.img('data:application/octet-stream;base64,BAUG')])
    const source = (platform.sendMessage.mock.calls[0]![2].parts[0] as Extract<IMMessageInput['parts'][number], { type: 'media' }>).media.source!

    expect(Array.from(await sourceBytes(source))).toEqual([4, 5, 6])
    expect(Array.from(await sourceBytes(source))).toEqual([4, 5, 6])
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects base64 data media exceeding the configured byte limit', async () => {
    const { ctx, platform } = await createExporter({ maxMediaBytes: 2 })

    await ctx.bots[0]!.createMessage('group:42', [h.img('data:application/octet-stream;base64,AQID')])
    const source = (platform.sendMessage.mock.calls[0]![2].parts[0] as Extract<IMMessageInput['parts'][number], { type: 'media' }>).media.source!

    await expect(sourceBytes(source)).rejects.toThrow('Satori media exceeds size limit')
  })

  it('copies internal media bytes for each stream consumption', async () => {
    const { ctx, platform } = await createExporter()
    vi.spyOn(ctx.http, 'file').mockResolvedValue({ data: Uint8Array.of(4, 5, 6) } as never)

    await ctx.bots[0]!.createMessage('group:42', [h.img('internal:qq/self/asset.png')])
    const source = (platform.sendMessage.mock.calls[0]![2].parts[0] as Extract<IMMessageInput['parts'][number], { type: 'media' }>).media.source!

    expect(Array.from(await sourceBytes(source))).toEqual([4, 5, 6])
    expect(Array.from(await sourceBytes(source))).toEqual([4, 5, 6])
    expect(ctx.http.file).toHaveBeenCalledTimes(2)
  })

  it('rejects internal media exceeding the configured byte limit', async () => {
    const { ctx, platform } = await createExporter({ maxMediaBytes: 2 })
    vi.spyOn(ctx.http, 'file').mockResolvedValue({ data: Uint8Array.of(4, 5, 6) } as never)

    await ctx.bots[0]!.createMessage('group:42', [h.img('internal:qq/self/asset.png')])
    const source = (platform.sendMessage.mock.calls[0]![2].parts[0] as Extract<IMMessageInput['parts'][number], { type: 'media' }>).media.source!

    await expect(sourceBytes(source)).rejects.toThrow('Satori media exceeds size limit')
  })

  it('maps canonical mention entities to Satori at elements without changing surrounding text', async () => {
    const { ctx, exporter } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('mention', conversation.id)
    incoming.content = { parts: [{
      type: 'text', text: 'before @Alice after',
      entities: [{ type: 'mention', userId: 'alice', offset: 7, length: 6 }],
    }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.event.message!.content).toBe('before <at id="alice" name="Alice"/> after')
  })

  it('maps canonical image media to an exact Satori img element', async () => {
    const { ctx, exporter, platform } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    platform.resolveMediaUrl.mockResolvedValueOnce({ url: 'https://media.test/photo.png', expiresAt: Date.now(), supportsRange: true })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('image', conversation.id)
    incoming.content = { parts: [{ type: 'media', media: {
      id: 'photo', kind: 'image', name: 'photo.png', mimeType: 'image/png', width: 20, height: 10,
    } }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.event.message!.content).toBe('<img src="https://media.test/photo.png" title="photo.png" type="image/png" width="20" height="10"/>')
  })

  it('maps canonical file media to an exact Satori file element', async () => {
    const { ctx, exporter, platform } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    platform.resolveMediaUrl.mockResolvedValueOnce({ url: 'https://media.test/report.pdf', expiresAt: Date.now(), supportsRange: true })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('file', conversation.id)
    incoming.content = { parts: [{ type: 'media', media: {
      id: 'report', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', size: 12,
    } }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.event.message!.content).toBe('<file src="https://media.test/report.pdf" title="report.pdf" type="application/pdf" size="12"/>')
  })

  it('maps Satori img input to ordinary image media rather than a native sticker', async () => {
    const { ctx, platform } = await createExporter()

    await ctx.bots[0]!.createMessage('group:42', [h.img('https://media.test/portable.png', { title: 'portable.png', type: 'image/png' })])

    expect(platform.sendMessage).toHaveBeenCalledWith(session, { id: 'group:42' }, {
      parts: [{ type: 'media', media: expect.objectContaining({ kind: 'image', name: 'portable.png', mimeType: 'image/png' }) }],
    })
    expect(platform.sendMessage.mock.calls[0]![2].parts[0]).not.toHaveProperty('sticker')
  })

  it('maps QQ custom emoji entities to Satori emoji elements', async () => {
    const { ctx, exporter } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('emoji', conversation.id)
    incoming.content = { parts: [{
      type: 'text', text: '[smile]', entities: [{
        type: 'custom-emoji', offset: 0, length: 7,
        definition: { key: '1:14', presentation: { type: 'emoji', emoticon: '[smile]' } },
      }],
    }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.event.message!.content).toContain('<emoji id="1:14" name="[smile]"/>')
  })

  it('maps inbound replies to Satori quote elements', async () => {
    const { ctx, exporter } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('reply', conversation.id)
    incoming.replyToId = 'original:1'

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.event.message!.content).toContain('<quote id="original:1"/>')
  })

  it('exports a resolved sticker as a Satori image', async () => {
    const { ctx, exporter } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const resolveAssetUrl = vi.fn(async () => ({ url: 'https://media.test/sticker.png' }))
    Object.assign(ctx, { imSticker: { get: () => ({ resolveAssetUrl }) } })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('sticker', conversation.id)
    incoming.content = { parts: [{ type: 'sticker', sticker: {
      providerId: 'qq', stickerId: 's1', title: 'Smile', format: 'static', mimeType: 'image/png',
    } }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(resolveAssetUrl).toHaveBeenCalledOnce()
    expect(events[0]!.event.message!.content).toMatch(/<img\b[^>]*\bsrc="https:\/\/media\.test\/sticker\.png"[^>]*>/u)
  })

  it('round-trips a native sticker through standard Satori img metadata', async () => {
    const { ctx, exporter, platform } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const reference = { asset: 'a', kind: 'sysface' }
    const sticker = {
      providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', title: 'Smile', format: 'static' as const, mimeType: 'image/png',
    }
    const plan = { type: 'native' as const, providerId: sticker.providerId, stickerId: sticker.stickerId, packId: sticker.packId, reference }
    const getSticker = vi.fn(async () => sticker)
    const prepareSend = vi.fn(async () => plan)
    Object.assign(ctx, { imSticker: {
      get: vi.fn(() => ({
        capabilities: { ownerPlatformId: 'qqnt' }, getSticker, prepareSend,
        resolveAssetUrl: async () => ({ url: 'https://media.test/sticker.png' }),
      })),
    } })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('sticker', conversation.id)
    incoming.content = { parts: [{ type: 'sticker', sticker }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    const content = events[0]!.event.message!.content!
    expect(content).toBe('<img src="https://media.test/sticker.png" title="Smile" type="image/png" data-crossgram-sticker-provider="qq-native" data-crossgram-sticker-id="s1" data-crossgram-sticker-pack="pack:1" data-crossgram-sticker-name="Smile" data-crossgram-sticker-reference="eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9"/>')
    const parsed = h.parse(content)
    expect(parsed[0]!.attrs).toMatchObject({
      dataCrossgramStickerProvider: 'qq-native',
      dataCrossgramStickerId: 's1',
      dataCrossgramStickerPack: 'pack:1',
      dataCrossgramStickerName: 'Smile',
      dataCrossgramStickerReference: 'eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9',
    })
    expect(parsed.join('')).toBe(content)

    await ctx.bots[0]!.createMessage('group:42', parsed)

    expect(getSticker).toHaveBeenCalledWith(expect.objectContaining({ session, conversation: { id: 'group:42' } }), 's1')
    expect(platform.sendMessage).toHaveBeenLastCalledWith(session, { id: 'group:42' }, { parts: [{ type: 'sticker', sticker: plan }] })
  })

  it('restores a valid native reference beyond the generic attribute limit', async () => {
    const { ctx, platform } = await createExporter()
    const reference = 'x'.repeat(192)
    const encodedReference = Buffer.from(JSON.stringify(reference)).toString('base64url')
    expect(encodedReference.length).toBeGreaterThan(256)
    const sticker = {
      providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', format: 'static' as const, mimeType: 'image/png',
    }
    const plan = { type: 'native' as const, providerId: sticker.providerId, stickerId: sticker.stickerId, packId: sticker.packId, reference }
    Object.assign(ctx, { imSticker: {
      get: () => ({ capabilities: { ownerPlatformId: 'qqnt' }, getSticker: async () => sticker, prepareSend: async () => plan }),
    } })

    await ctx.bots[0]!.createMessage('group:42', [h('img', {
      src: 'internal:qq/self/sticker.png',
      'data-crossgram-sticker-provider': sticker.providerId, 'data-crossgram-sticker-id': sticker.stickerId,
      'data-crossgram-sticker-pack': sticker.packId, 'data-crossgram-sticker-name': 'Smile',
      'data-crossgram-sticker-reference': encodedReference,
    })])

    expect(platform.sendMessage).toHaveBeenCalledWith(session, { id: 'group:42' }, { parts: [{ type: 'sticker', sticker: plan }] })
  })

  it('rejects mixed-case CrossGram metadata rather than treating it as ordinary media', async () => {
    const { ctx, platform } = await createExporter()
    const image = h('img', { src: 'internal:qq/self/sticker.png' })
    image.attrs['DATA-CROSSGRAM-STICKER-PROVIDER'] = 'qq-native'

    await expect(ctx.bots[0]!.createMessage('group:42', [image])).rejects.toThrow('Satori sticker')

    expect(platform.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['partial metadata', { 'data-crossgram-sticker-provider': 'qq-native' }],
    ['malformed reference', {
      'data-crossgram-sticker-provider': 'qq-native', 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile', 'data-crossgram-sticker-reference': 'a',
    }],
    ['oversized reference', {
      'data-crossgram-sticker-provider': 'qq-native', 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile', 'data-crossgram-sticker-reference': 'a'.repeat(4_097),
    }],
    ['oversized provider', {
      'data-crossgram-sticker-provider': 'q'.repeat(257), 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile',
      'data-crossgram-sticker-reference': 'eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9',
    }],
    ['non-string provider', {
      'data-crossgram-sticker-provider': 1, 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile',
      'data-crossgram-sticker-reference': 'eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9',
    }],
  ])('rejects %s instead of treating the image as ordinary media', async (_name, attributes) => {
    const { ctx, platform } = await createExporter()

    await expect(ctx.bots[0]!.createMessage('group:42', [h('img', {
      src: 'internal:qq/self/sticker.png', ...attributes,
    })])).rejects.toThrow('Satori sticker')

    expect(platform.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects native sticker metadata from a provider outside the current account', async () => {
    const { ctx, platform } = await createExporter()
    const getSticker = vi.fn()
    Object.assign(ctx, { imSticker: {
      get: vi.fn(() => ({ capabilities: { ownerPlatformId: 'another-account' }, getSticker })),
    } })

    await expect(ctx.bots[0]!.createMessage('group:42', [h('img', {
      src: 'internal:qq/self/sticker.png',
      'data-crossgram-sticker-provider': 'qq-native', 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile',
      'data-crossgram-sticker-reference': 'eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9',
    })])).rejects.toThrow('unavailable for this account')

    expect(getSticker).not.toHaveBeenCalled()
    expect(platform.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-native send plan', {
      sticker: { providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', format: 'static' as const, mimeType: 'image/png' },
      plan: { type: 'upload' as const },
    }],
    ['a sticker from a different provider', {
      sticker: { providerId: 'other-provider', stickerId: 's1', packId: 'pack:1', format: 'static' as const, mimeType: 'image/png' },
      plan: { type: 'native' as const, providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', reference: { asset: 'a', kind: 'sysface' } },
    }],
    ['a send plan from a different provider', {
      sticker: { providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', format: 'static' as const, mimeType: 'image/png' },
      plan: { type: 'native' as const, providerId: 'other-provider', stickerId: 's1', packId: 'pack:1', reference: { asset: 'a', kind: 'sysface' } },
    }],
  ])('rejects metadata when the provider returns %s', async (_name, { sticker, plan }) => {
    const { ctx, platform } = await createExporter()
    const getSticker = vi.fn(async () => sticker)
    const prepareSend = vi.fn(async () => plan)
    Object.assign(ctx, { imSticker: {
      get: vi.fn(() => ({ capabilities: { ownerPlatformId: 'qqnt' }, getSticker, prepareSend })),
    } })

    await expect(ctx.bots[0]!.createMessage('group:42', [h('img', {
      src: 'internal:qq/self/sticker.png',
      'data-crossgram-sticker-provider': 'qq-native', 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile',
      'data-crossgram-sticker-reference': 'eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9',
    })])).rejects.toThrow(/Satori sticker/u)

    expect(platform.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects native sticker metadata that does not match the current provider plan', async () => {
    const { ctx, platform } = await createExporter()
    const getSticker = vi.fn(async () => ({
      providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', format: 'static' as const, mimeType: 'image/png',
    }))
    Object.assign(ctx, { imSticker: {
      get: vi.fn(() => ({
        capabilities: { ownerPlatformId: 'qqnt' }, getSticker,
        prepareSend: async () => ({
          type: 'native' as const, providerId: 'qq-native', stickerId: 's1', packId: 'pack:1', reference: { asset: 'different' },
        }),
      })),
    } })

    await expect(ctx.bots[0]!.createMessage('group:42', [h('img', {
      src: 'internal:qq/self/sticker.png',
      'data-crossgram-sticker-provider': 'qq-native', 'data-crossgram-sticker-id': 's1',
      'data-crossgram-sticker-pack': 'pack:1', 'data-crossgram-sticker-name': 'Smile',
      'data-crossgram-sticker-reference': 'eyJhc3NldCI6ImEiLCJraW5kIjoic3lzZmFjZSJ9',
    })])).rejects.toThrow('does not match the provider')

    expect(getSticker).toHaveBeenCalledOnce()
    expect(platform.sendMessage).not.toHaveBeenCalled()
  })

  it('uses a text placeholder and warning for an unresolved sticker', async () => {
    const { ctx, exporter, warnings } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    Object.assign(ctx, { imSticker: { get: () => ({ resolveAssetUrl: async () => undefined }) } })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('sticker', conversation.id)
    incoming.content = { parts: [{ type: 'sticker', sticker: {
      providerId: 'qq', stickerId: 's1', title: 'Smile', format: 'static', mimeType: 'image/png',
    } }] }

    exporter.handleMessage(session, conversation, incoming, { created: true })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.event.message!.content).toBe('[sticker: Smile]')
    expect(warnings).toHaveBeenCalledWith('Satori sticker export unavailable provider=%s sticker=%s', 'qq', 's1')
  })

  it('rejects outbound messages after the exporter session stops', async () => {
    const { ctx, exporter } = await createExporter()
    const bot = ctx.bots[0]!

    exporter.stop('qqnt')

    expect(ctx.bots).toHaveLength(0)
    await expect(bot.createMessage('group:42', [h.text('offline')])).rejects.toThrow('not ready')
  })

  it('drops an in-flight session A media event after session B replaces it', async () => {
    const { ctx, exporter, platform } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    let resolveMedia!: (value: { url: string, expiresAt: number, supportsRange: boolean }) => void
    const media = new Promise<{ url: string, expiresAt: number, supportsRange: boolean }>((resolve) => { resolveMedia = resolve })
    platform.resolveMediaUrl.mockReturnValueOnce(media)
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }
    const incoming = message('in-flight', conversation.id)
    incoming.content = { parts: [{ type: 'media', media: { id: 'photo', kind: 'image', name: 'photo.png' } }] }
    const oldBot = ctx.bots[0]!

    exporter.handleMessage(session, conversation, incoming, { created: true })
    await vi.waitFor(() => expect(platform.resolveMediaUrl).toHaveBeenCalledWith(session, expect.objectContaining({ id: 'photo', kind: 'image' })))
    exporter.stop('qqnt')
    exporter.start(platform, replacementSession)
    resolveMedia({ url: 'https://media.test/a.png', expiresAt: Date.now(), supportsRange: true })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(events).toHaveLength(0)
    expect(platform.resolveMediaUrl).toHaveBeenCalledTimes(1)
    await expect(oldBot.createMessage('group:42', [h.text('stale')])).rejects.toThrow('not ready')
    expect(platform.sendMessage).not.toHaveBeenCalled()
  })

  it('ignores events from another session of the exported platform', async () => {
    const { ctx, exporter } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }

    exporter.handleMessage(replacementSession, conversation, message('wrong-session', conversation.id), { created: true })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(events).toHaveLength(0)
  })

  it('logs failed dispatches without blocking a later bridge callback', async () => {
    const { ctx, exporter, warnings } = await createExporter()
    const events: Session[] = []
    ctx.on('message-created', (event) => { events.push(event) })
    const bot = ctx.bots[0]!
    vi.spyOn(bot, 'dispatch').mockImplementationOnce(() => { throw new Error('listener failed') })
    const conversation: IMConversation = { id: 'group:42', kind: 'group', title: 'QQ Group' }

    exporter.handleMessage(session, conversation, message('broken', conversation.id), { created: true })
    exporter.handleMessage(session, conversation, message('later', conversation.id), { created: true })

    await vi.waitFor(() => expect(warnings).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.event.message?.id).toBe('later')
  })

  it('rejects WebSocket identify when server token configuration is absent', async () => {
    const { events } = await createSatoriServer()

    await expect(closedSocket(events, { op: Universal.Opcode.IDENTIFY, body: {} })).resolves.toMatchObject({
      code: 4004, reason: 'invalid token',
    })
  })

  it('rejects WebSocket identify without the configured token', async () => {
    const { events } = await createSatoriServer('test-token')

    await expect(closedSocket(events, { op: Universal.Opcode.IDENTIFY, body: {} })).resolves.toMatchObject({
      code: 4004, reason: 'invalid token',
    })
  })

  it('rejects WebSocket identify with an invalid configured token', async () => {
    const { events } = await createSatoriServer('test-token')

    await expect(closedSocket(events, {
      op: Universal.Opcode.IDENTIFY, body: { token: 'wrong-token' },
    })).resolves.toMatchObject({ code: 4004, reason: 'invalid token' })
  })

  it('closes the socket before Satori identify parsing when a frame exceeds the configured cap', async () => {
    const { events } = await createSatoriServer('test-token', { maxWebSocketPayload: 64 })
    const socket = await openSocket(events)
    const outcome = await new Promise<{ code?: number, error?: Error }>((resolve) => {
      socket.once('close', (code) => resolve({ code }))
      socket.once('error', (error) => resolve({ error }))
      socket.send('x'.repeat(128))
    })

    expect(outcome.code === 1009 || outcome.error).toBeTruthy()
  })

  it('sends READY and META through the real authenticated events socket', async () => {
    const { ctx, events } = await createSatoriServer('test-token', { maxWebSocketPayload: 64 })
    const socket = await openSocket(events)
    const payloads: Array<{ op: Universal.Opcode, body: Record<string, unknown> }> = []
    socket.on('message', (data) => payloads.push(JSON.parse(data.toString())))
    socket.send(JSON.stringify({ op: Universal.Opcode.IDENTIFY, body: { token: 'test-token' } }))

    await vi.waitFor(() => expect(payloads).toHaveLength(1))
    expect(payloads[0]).toMatchObject({ op: Universal.Opcode.READY, body: { logins: [{ platform: 'qq', self_id: 'self' }] } })
    ctx.emit('satori/meta')
    await vi.waitFor(() => expect(payloads).toHaveLength(2))
    expect(payloads[1]).toMatchObject({ op: Universal.Opcode.META, body: { proxy_urls: [] } })
    socket.close()
  })

  it('does not register the unsupported public proxy route', async () => {
    const { ctx } = await createSatoriServer('test-token')

    const response = await fetch(new URL('/satori/v1/proxy/http://upstream.test/file', ctx.server.baseUrl), {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(404)
  })

  it('forwards JSON raw body once to an internal Satori handler', async () => {
    const { ctx } = await createSatoriServer('test-token')
    const expected = Buffer.from('{"message":"你好"}')
    let received: Buffer | undefined
    ctx.bots[0]!.defineInternalRoute('/capture', async ({ body }) => {
      received = Buffer.from(body)
      return { status: 200, body }
    })

    const response = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: expected,
    })

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected)
    expect(received).toEqual(expected)
  })

  it('forwards multipart raw body once to an internal Satori handler', async () => {
    const { ctx } = await createSatoriServer('test-token')
    const expected = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"\r\n\r\npayload\r\n--boundary--\r\n')
    let received: Buffer | undefined
    ctx.bots[0]!.defineInternalRoute('/capture', async ({ body }) => {
      received = Buffer.from(body)
      return { status: 200, body }
    })

    const response = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'multipart/form-data; boundary=boundary' }, body: expected,
    })

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected)
    expect(received).toEqual(expected)
  })

  it('returns 413 for oversized JSON and multipart requests before parsing them', async () => {
    const { ctx } = await createSatoriServer('test-token', { maxRequestBodyBytes: 32 })
    const headers = { authorization: 'Bearer test-token' }
    const json = await fetch(new URL('/satori/v1/message.create', ctx.server.baseUrl), {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(64) }),
    })
    const form = new FormData()
    form.append('file', new Blob([Buffer.alloc(64)]), 'large.bin')
    const multipart = await fetch(new URL('/satori/v1/message.create', ctx.server.baseUrl), {
      method: 'POST', headers, body: form,
    })

    expect(json.status).toBe(413)
    expect(multipart.status).toBe(413)
  })

  it('returns 413 for an oversized chunked internal body without invoking its handler', async () => {
    const { ctx } = await createSatoriServer('test-token', { maxRequestBodyBytes: 8 })
    const handler = vi.fn(async () => ({ status: 200 }))
    ctx.bots[0]!.defineInternalRoute('/capture', handler)
    const body = Readable.from([Buffer.alloc(5), Buffer.alloc(5)])

    const response = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/octet-stream' },
      body: body as never,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    expect(response.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('accepts an internal body exactly at the configured limit', async () => {
    const { ctx } = await createSatoriServer('test-token', { maxRequestBodyBytes: 8 })
    const expected = Buffer.alloc(8, 1)
    let received: Buffer | undefined
    ctx.bots[0]!.defineInternalRoute('/capture', async ({ body }) => {
      received = Buffer.from(body)
      return { status: 200 }
    })

    const response = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST', headers: { authorization: 'Bearer test-token' }, body: expected,
    })

    expect(response.status).toBe(200)
    expect(received).toEqual(expected)
  })

  it('rejects an unauthorized oversized body before consuming it', async () => {
    const { ctx } = await createSatoriServer('test-token', { maxRequestBodyBytes: 8 })

    const response = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64),
    })

    expect(response.status).toBe(403)
  })

  it('forwards binary raw body and content type to an internal Satori handler', async () => {
    const { ctx } = await createSatoriServer('test-token')
    const expected = Buffer.from([0, 255, 1, 128])
    let received: Buffer | undefined
    let contentType: string | null
    ctx.bots[0]!.defineInternalRoute('/capture', async ({ body, headers }) => {
      received = Buffer.from(body)
      contentType = new Headers(headers).get('content-type')
      return { status: 200, body }
    })

    const response = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/octet-stream' }, body: expected,
    })

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected)
    expect(received).toEqual(expected)
    expect(contentType!).toBe('application/octet-stream')
  })

  it('rejects unauthenticated internal traffic before reaching its handler', async () => {
    const { ctx } = await createSatoriServer('test-token')
    const handler = vi.fn(async () => ({ status: 200 }))
    ctx.bots[0]!.defineInternalRoute('/capture', handler)

    const missing = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), { method: 'POST', body: 'body' })
    const invalid = await fetch(new URL('/satori/v1/internal/qq/self/capture', ctx.server.baseUrl), {
      method: 'POST', headers: { authorization: 'Bearer wrong' }, body: 'body',
    })

    expect(missing.status).toBe(403)
    expect(invalid.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('serves Satori meta and message.create through the patched server plugin', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Http),
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(Satori),
    ]
    disposals.push(...fibers)
    await Promise.all(fibers)
    const satoriServer = ctx.plugin(SatoriServer, { path: '/satori', token: 'test-token', webhooks: [] })
    disposals.push(satoriServer)
    await satoriServer
    await new Promise((resolve) => setTimeout(resolve, 50))
    const platform = new TestPlatform()
    const exporter = new SatoriExporter(ctx, { platformId: 'qqnt', platform: 'qq' }, { warn: vi.fn() })
    exporter.start(platform, session)

    const endpoint = new URL('/satori/v1/meta', ctx.server.baseUrl)
    await expect(fetch(endpoint, { method: 'POST' })).resolves.toMatchObject({ status: 403 })
    await expect(fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong' } }))
      .resolves.toMatchObject({ status: 403 })
    const meta = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer test-token' } })
    expect(meta.status).toBe(200)
    await expect(meta.json()).resolves.toMatchObject({
      logins: [{ platform: 'qq', self_id: 'self' }],
    })

    const created = await fetch(new URL('/satori/v1/message.create', ctx.server.baseUrl), {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'satori-platform': 'qq',
        'satori-user-id': 'self',
      },
      body: JSON.stringify({ channel_id: 'group:42', content: 'hello from Koishi' }),
    })
    expect(created.status).toBe(200)
    await expect(created.json()).resolves.toMatchObject([{ id: 'sent:1', channel: { id: 'group:42' } }])
    expect(platform.sendMessage).toHaveBeenCalledWith(
      session, { id: 'group:42' }, { parts: [{ type: 'text', text: 'hello from Koishi' }] },
    )
  })
})
