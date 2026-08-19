import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { IMConversation, IMMessage, PlatformSession, SystemPeer, SystemPeerProvider, SystemPeerService } from '@mtproto-relay/bridge'
import { setStickerPackAssignment } from '@mtproto-relay/bridge'
import z from 'schemastery'
import { HostedTelegramBotApi, importShortName } from './api.js'
import { defineTelegramStickerImportModels } from './models.js'
import { TELEGRAM_STICKER_IMPORTER_PROVIDER_ID, TelegramStickerImporterProvider } from './provider.js'

export const TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID = 'bridge:telegram-sticker-importer'
export { HostedTelegramBotApi, TelegramStickerImportError, importShortName, mapStickerSet, parseStickerSetUrl } from './api.js'
export { TELEGRAM_STICKER_IMPORTER_PROVIDER_ID, TelegramStickerImporterProvider } from './provider.js'

export interface Config {
  botToken: string
  apiBase?: string
  maxImportsPerSession?: number
  importCooldownMs?: number
}

export const Config = z.object({
  botToken: z.string().role('secret').required(),
  apiBase: z.string().default('https://api.telegram.org'),
  maxImportsPerSession: z.natural().min(1).max(10_000).default(100),
  importCooldownMs: z.natural().min(0).max(60_000).default(3_000),
})

class ImportCancelledError extends Error {}

export const name = 'telegram-sticker-importer'
export const inject = ['database', 'model', 'imSticker', 'systemPeer']

export function apply(ctx: Context, config: Config): void {
  defineTelegramStickerImportModels(ctx)
  const api = new HostedTelegramBotApi(config.botToken, config.apiBase)
  const provider = new TelegramStickerImporterProvider(ctx.database, api)
  ctx.imSticker.register(provider, TELEGRAM_STICKER_IMPORTER_PROVIDER_ID)
  const peerProvider = new StickerImporterPeerProvider(
    provider,
    api,
    ctx,
    config.maxImportsPerSession ?? 100,
    config.importCooldownMs ?? 3_000,
  )
  const unregister = ctx.systemPeer.register(peerProvider)
  ctx.effect(() => async () => {
    await peerProvider.dispose()
    unregister()
  }, 'telegram-sticker-importer.system-peer')
}

class StickerImporterPeerProvider implements SystemPeerProvider {
  private readonly _lastImportAt = new Map<string, number>()
  private readonly _tails = new Map<string, Promise<void>>()
  private _controller = new AbortController()
  private _generation = 0
  private _active = true

  constructor(
    private readonly _provider: TelegramStickerImporterProvider,
    private readonly _api: HostedTelegramBotApi,
    private readonly _ctx: Context,
    private readonly _maxImportsPerSession: number,
    private readonly _importCooldownMs: number,
  ) {}

  async dispose(): Promise<void> {
    this._active = false
    this._generation++
    this._controller.abort()
    await Promise.allSettled(this._tails.values())
    this._tails.clear()
  }

  async bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void> {
    if (!this._active) return
    const peer = stickerImporterPeer()
    await peers.emit(session, { type: 'conversation', conversation: peer.conversation })
    if (!this._active) return
    await reply(session, peer.conversation,
      'Send an official https://t.me/addstickers/<short_name> link to import a sticker pack. You can also use /import <url>.',
      peers, 'bridge:telegram-sticker-importer:welcome')
  }

  async resolve(_session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined> {
    return this._active && conversationId === TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID ? stickerImporterPeer() : undefined
  }

  async receive(session: PlatformSession, peer: SystemPeer, message: IMMessage, peers: SystemPeerService): Promise<void> {
    if (!this._active || peer.id !== TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID || !message.outgoing) return
    const text = plainText(message)
    if (text === undefined) return
    if (text === '/start' || text === '/help') {
      await reply(session, peer.conversation,
        'Paste an official https://t.me/addstickers/<short_name> link, or use /import <url>.', peers)
      return
    }
    const shortName = importShortName(text)
    if (!shortName) {
      await reply(session, peer.conversation,
        'Please send an official https://t.me/addstickers/<short_name> link or /import <url>.', peers)
      return
    }
    return this._enqueue(session.platformSessionId, () => this._import(session, peer.conversation, shortName, peers))
  }

  private async _import(session: PlatformSession, conversation: IMConversation, shortName: string, peers: SystemPeerService): Promise<void> {
    const generation = this._generation
    if (!this._active) return
    const now = Date.now()
    const lastImportAt = this._lastImportAt.get(session.platformSessionId) ?? 0
    const remainingCooldown = this._importCooldownMs - (now - lastImportAt)
    if (remainingCooldown > 0) {
      await reply(session, conversation,
        `Please wait ${Math.ceil(remainingCooldown / 1_000)} seconds before importing another sticker pack.`, peers)
      return
    }
    const exists = await this._provider.hasPack(session.platformSessionId, shortName)
    if (!exists && await this._provider.countPacks(session.platformSessionId) >= this._maxImportsPerSession) {
      await reply(session, conversation,
        `This session has reached its ${this._maxImportsPerSession}-pack import limit.`, peers)
      return
    }
    this._lastImportAt.set(session.platformSessionId, now)
    try {
      const set = await this._api.getStickerSet(shortName, this._controller.signal)
      if (!this._active || generation !== this._generation) return
      await this._ctx.database.withTransaction(async (database) => {
        if (!this._active || generation !== this._generation) return
        await this._provider.upsert(session.platformSessionId, set, database)
        if (!this._active || generation !== this._generation) throw new ImportCancelledError()
        await setStickerPackAssignment(
          database,
          session.platformSessionId,
          TELEGRAM_STICKER_IMPORTER_PROVIDER_ID,
          set.shortName,
          true,
        )
        if (!this._active || generation !== this._generation) throw new ImportCancelledError()
      })
      if (!this._active || generation !== this._generation) return
      this._ctx.imSticker.touch(TELEGRAM_STICKER_IMPORTER_PROVIDER_ID, session.platformSessionId)
      if (this._active) await reply(session, conversation, `Imported ${set.title} (${set.count} stickers).`, peers)
    } catch (error) {
      if (error instanceof ImportCancelledError) return
      this._ctx.logger('telegram-sticker-importer').warn('Sticker import failed: %s', safeError(error))
      if (this._active) await reply(session, conversation, `Could not import that sticker pack: ${safeError(error)}`, peers)
    }
  }

  private _enqueue(platformSessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this._tails.get(platformSessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this._tails.set(platformSessionId, current)
    const cleanup = () => {
      if (this._tails.get(platformSessionId) === current) this._tails.delete(platformSessionId)
    }
    void current.then(cleanup, cleanup)
    return current
  }
}

function stickerImporterPeer(): SystemPeer {
  return {
    id: TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID,
    conversation: {
      id: TELEGRAM_STICKER_IMPORTER_CONVERSATION_ID,
      kind: 'direct',
      title: 'Sticker Importer',
      metadata: {
        bridgeOwned: true,
        localOnly: true,
        systemPeer: 'telegram-sticker-importer',
        bot: true,
        username: 'StickerImporterBot',
      },
    },
  }
}

async function reply(
  session: PlatformSession,
  conversation: IMConversation,
  text: string,
  peers: SystemPeerService,
  id = `bridge:telegram-sticker-importer:${randomUUID()}`,
): Promise<void> {
  await peers.emit(session, {
    type: 'message',
    conversation,
    message: {
      id,
      conversationId: conversation.id,
      senderId: conversation.id,
      sender: {
        id: conversation.id,
        firstName: conversation.title,
        username: typeof conversation.metadata?.username === 'string' ? conversation.metadata.username : undefined,
        metadata: conversation.metadata,
      },
      content: { parts: [{ type: 'text', text }] },
      timestamp: Math.floor(Date.now() / 1_000),
      outgoing: false,
    },
  })
}

function plainText(message: IMMessage): string | undefined {
  if (!message.content.parts.length || message.content.parts.some((part) => part.type !== 'text' || part.entities?.length)) return
  return message.content.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected error.'
  return message.replace(/bot[^/\s]+/giu, 'bot<redacted>')
}
