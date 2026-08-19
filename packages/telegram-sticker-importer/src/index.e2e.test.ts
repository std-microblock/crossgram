import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import {
  defineModels, IMPlatformService, IMStickerService, StickerRpc, SystemPeerService, type IMEvent, type PlatformSession,
} from '@mtproto-relay/bridge'
import * as importer from './index.js'

const session: PlatformSession = {
  platformId: 'static', platformSessionId: 'session', userId: 'user', credentials: {}, metadata: {},
}
const fixtures: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(fixtures.splice(0).map((stop) => stop())))

async function telegramStub(): Promise<{ server: Server, base: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    if (url.pathname === '/bottest-token/getStickerSet') {
      response.setHeader('content-type', 'application/json')
      const name = url.searchParams.get('name') ?? 'mixed_legacy-pack'
      response.end(JSON.stringify({ ok: true, result: {
        name, title: name === 'mixed_legacy-pack' ? 'Imported mixed pack' : name, stickers: [
          { file_id: 'static-file', file_unique_id: 'stable-static', width: 512, height: 512 },
          { file_id: 'video-file', file_unique_id: 'stable-video', is_video: true },
        ],
      } }))
      return
    }
    if (url.pathname === '/bottest-token/getFile') {
      const id = url.searchParams.get('file_id')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, result: { file_id: id, file_unique_id: `unique-${id}`, file_path: `stickers/${id}` } }))
      return
    }
    if (url.pathname === '/file/bottest-token/stickers/static-file') {
      const bytes = Buffer.from([1, 2, 3, 4])
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '')
      if (range) {
        response.statusCode = 206
        response.end(bytes.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined))
      } else {
        response.end(bytes)
      }
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function fixture(options: Partial<importer.Config> = {}) {
  const { server, base } = await telegramStub()
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: ':memory:' })
  await Promise.all([database, sqlite])
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  await ctx.database.create('mtproto_platform_session', {
    id: session.platformSessionId, platformId: session.platformId, userId: session.userId,
    credentials: {}, metadata: {}, active: true, createdAt: new Date(),
  })
  const platforms = new IMPlatformService(ctx)
  platforms.activateSession('static', { platformKind: 'static' } as never, session)
  const stickers = new IMStickerService(ctx)
  const peers = new SystemPeerService(ctx)
  const events: IMEvent[] = []
  peers.attach(async (_session, event) => { events.push(event); return {} as never })
  const config = { botToken: 'test-token', apiBase: base, importCooldownMs: 0, ...options }
  let plugin = ctx.plugin(importer, config)
  await plugin
  const disposePlugin = async () => plugin.dispose()
  const reloadPlugin = async () => {
    plugin = ctx.plugin(importer, config)
    await plugin
  }
  fixtures.push(async () => {
    await plugin.dispose()
    await sqlite.dispose()
    await database.dispose()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  return { ctx, stickers, peers, events, disposePlugin, reloadPlugin }
}

function outgoing(text: string) {
  return {
    id: `out:${text}`, conversationId: importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID, senderId: session.userId,
    content: { parts: [{ type: 'text' as const, text }] }, timestamp: 1_700_000_000, outgoing: true,
  }
}

async function read(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const bytes: number[] = []
  for await (const chunk of source) bytes.push(...chunk)
  return bytes
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('Telegram sticker importer E2E', () => {
  it('does not emit a welcome message after disposal while bootstrap is pending', async () => {
    const { peers, events, disposePlugin } = await fixture()
    await settle()
    events.length = 0
    let begin!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { begin = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    peers.attach(async (_session, event) => {
      events.push(event)
      if (event.type === 'conversation') {
        begin()
        await blocked
      }
      return {} as never
    })

    const bootstrap = peers.bootstrap(session)
    await started
    await disposePlugin()
    release()
    await bootstrap

    expect(events.filter((event) => event.type === 'message')).toHaveLength(0)
  })

  it('unregisters its system peer on dispose and reloads with one bootstrap and reply handler', async () => {
    const { peers, events, disposePlugin, reloadPlugin } = await fixture()
    await settle()
    events.length = 0

    await disposePlugin()
    await expect(peers.resolve(session, importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID)).resolves.toBeUndefined()
    await reloadPlugin()
    await settle()
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1)

    events.length = 0
    const peer = await peers.resolve(session, importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID)
    if (!peer) throw new Error('missing reloaded sticker importer peer')
    await peers.receive(session, peer, outgoing('/help'))
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1)
  })

  it('bootstraps the bot, imports a hosted set, installs it, and refreshes a cached catalog', async () => {
    const { ctx, stickers, peers, events } = await fixture()
    await peers.bootstrap(session)
    expect(events.some((event) => event.type === 'message' && event.conversation.id === importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID)).toBe(true)

    const rpc = new StickerRpc(ctx.database, stickers.registry, { platformKind: 'static' } as never, session)
    await expect(rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })).resolves.toMatchObject({ sets: [] })

    const peer = await peers.resolve(session, importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID)
    if (!peer) throw new Error('missing sticker importer peer')
    await peers.receive(session, peer, outgoing('https://t.me/addstickers/mixed_legacy-pack'))

    await expect(ctx.database.get('telegram_sticker_import', { shortName: 'mixed_legacy-pack' }))
      .resolves.toMatchObject([{ title: 'Imported mixed pack', count: 2 }])
    await expect(ctx.database.get('mtproto_sticker_set_install', {
      platformSessionId: session.platformSessionId, providerId: importer.TELEGRAM_STICKER_IMPORTER_PROVIDER_ID,
      providerPackId: 'mixed_legacy-pack',
    })).resolves.toHaveLength(1)

    const catalog = await rpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    expect(catalog).toMatchObject({ _: 'messages.allStickers', sets: [{ title: 'Imported mixed pack' }] })
    const pack = await stickers.require(importer.TELEGRAM_STICKER_IMPORTER_PROVIDER_ID).getPack({ session, platformKind: 'static' }, 'mixed_legacy-pack')
    if (!pack) throw new Error('missing imported pack')
    const asset = await stickers.require(importer.TELEGRAM_STICKER_IMPORTER_PROVIDER_ID).openAsset({ session, platformKind: 'static' }, pack.stickers[0]!)
    await expect(read(asset.source.streamRange!({ offset: 1, limit: 2 }))).resolves.toEqual([2, 3])
  })

  it('serializes concurrent imports so the session pack limit cannot be bypassed', async () => {
    const { ctx, peers, events } = await fixture({ maxImportsPerSession: 1 })
    const peer = await peers.resolve(session, importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID)
    if (!peer) throw new Error('missing sticker importer peer')

    await Promise.all([
      peers.receive(session, peer, outgoing('https://t.me/addstickers/first-pack')),
      peers.receive(session, peer, outgoing('https://t.me/addstickers/second-pack')),
    ])

    await expect(ctx.database.get('telegram_sticker_import', { platformSessionId: session.platformSessionId }))
      .resolves.toMatchObject([{ shortName: 'first-pack' }])
    const texts = events.filter((event): event is Extract<IMEvent, { type: 'message' }> => event.type === 'message')
      .map((event) => (event.message.content.parts[0] as { text?: string }).text)
    expect(texts).toContain('Imported first-pack (2 stickers).')
    expect(texts).toContain('This session has reached its 1-pack import limit.')
  })

  it('does not expose one session imports or invalidate another session catalog cache', async () => {
    const { ctx, stickers, peers } = await fixture()
    const otherSession = { ...session, platformSessionId: 'other-session', userId: 'other' }
    const otherRpc = new StickerRpc(ctx.database, stickers.registry, { platformKind: 'static' } as never, otherSession)
    const provider = stickers.require(importer.TELEGRAM_STICKER_IMPORTER_PROVIDER_ID)
    const listPacks = vi.spyOn(provider, 'listPacks')
    const before = await otherRpc.getAllStickers({ _: 'messages.getAllStickers', hash: Long.ZERO })
    if (before._ !== 'messages.allStickers') throw new Error('expected full empty catalog')

    const peer = await peers.resolve(session, importer.TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID)
    if (!peer) throw new Error('missing sticker importer peer')
    await peers.receive(session, peer, outgoing('https://t.me/addstickers/mixed_legacy-pack'))

    await expect(provider.listPacks({ session: otherSession, platformKind: 'static' })).resolves.toMatchObject({ packs: [] })
    await expect(otherRpc.getAllStickers({ _: 'messages.getAllStickers', hash: before.hash }))
      .resolves.toEqual({ _: 'messages.allStickersNotModified' })
    expect(listPacks).toHaveBeenCalledTimes(2)
  })
})
