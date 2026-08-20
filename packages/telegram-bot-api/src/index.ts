import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import type { Request, Response } from '@cordisjs/plugin-server'
import {
  stableId, type CommittedPlatformEvent, type IMConversation, type IMMessage, type JsonObject, type PlatformSession, type SystemPeerService,
} from '@mtproto-relay/bridge'
import z from 'schemastery'
import { registerBotFather } from './botfather.js'
import { defineBotModels } from './bot-models.js'
import { defineTelegramBotApiModels, type BotApiChatRow, type BotApiStateRow } from './models.js'
import { BotRegistry, type BotIdentity } from './registry.js'
import { postPublicWebhook } from './webhook.js'

export interface Config {
  verifierSecret: string
}

export const Config = z.object({
  verifierSecret: z.string().role('secret').required()
    .description('Secret used to verify tokens issued by the built-in BotFather service.'),
})

export const name = 'telegram-bot-api'
export const inject = ['database', 'model', 'imPlatform', 'server', 'systemPeer']

export { BOT_FATHER_CONVERSATION_ID, botConversationId, validUsername } from './botfather.js'
export { BotRegistry, BotUsernameTakenError } from './registry.js'
export type { BotIdentity, BotOwner, IssuedBot } from './registry.js'

interface TelegramUser { id: number, is_bot: boolean, first_name: string, username?: string }
interface TelegramChat { id: number, type: 'private', first_name?: string, username?: string }
interface TelegramMessage { message_id: number, from: TelegramUser, date: number, chat: TelegramChat, text: string }
interface TelegramUpdate { update_id: number, message: TelegramMessage }
interface WebhookState { url: string, secretToken?: string, lastErrorDate?: number, lastErrorMessage?: string }
export type TelegramApiResponse = { ok: true, result: unknown } | { ok: false, error_code: number, description: string }

class TelegramApiError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

/** Durable state is keyed by bot identity and invalidated when its token generation changes. */
class BotRuntime {
  private readonly _waiters = new Set<() => void>()
  private _webhookDelivery?: Promise<void>
  private _deliveryRequested = false
  private _retryTimer?: ReturnType<typeof setTimeout>
  private _disposed = false
  private _generation = 0
  private _writeTail = Promise.resolve()
  private _bot: BotIdentity

  constructor(
    bot: BotIdentity,
    private readonly _database: Database,
    private readonly _registry: BotRegistry,
    private readonly _peers: SystemPeerService,
  ) { this._bot = bot }

  async handleCommitted(session: PlatformSession, committed: CommittedPlatformEvent, current = this._bot): Promise<void> {
    const bot = current
    if (!(await this._valid(bot))) return
    this._setCurrent(bot)
    if (session.platformSessionId !== bot.ownerPlatformSessionId || committed.event.type !== 'message') return
    const { conversation, message } = committed.event
    const text = plainText(message)
    if (conversation.id !== bot.conversationId || message.outgoing !== true || text === undefined) return
    const created = await this._write(() => this._database.withTransaction(async (database) => {
      const state = await this._ensureState(database, bot)
      const chat = await this._ensureChat(database, state, bot, conversation)
      const projection = await this._projectMessage(database, bot, chat.chatId, message.id)
      if (!projection.created || !allowsMessage(state)) return false
      const update: TelegramUpdate = {
        update_id: state.nextUpdateId,
        message: {
          message_id: projection.messageId,
          from: {
            id: stableId(`telegram-bot-user:${session.platformSessionId}:${session.userId}`),
            is_bot: false,
            first_name: String(session.metadata.firstName ?? session.userId),
          },
          date: Math.max(0, Math.floor(message.timestamp)),
          chat: telegramChat(chat),
          text,
        },
      }
      await database.create('mtproto_bot_api_update', {
        botId: bot.id, updateId: update.update_id, payload: update as unknown as JsonObject, createdAt: new Date(),
      })
      await database.set('mtproto_bot_api_state', { botId: bot.id }, {
        nextUpdateId: update.update_id + 1, updatedAt: new Date(),
      })
      return true
    }))
    if (created) {
      this._notifyWaiters()
      this._deliverWebhook()
    }
  }

  async invoke(bot: BotIdentity, method: string, params: Record<string, unknown>): Promise<unknown> {
    await this._ensure(bot)
    if (!(await this._valid(bot))) throw new TelegramApiError(401, 'Unauthorized')
    this._setCurrent(bot)
    switch (method.toLowerCase()) {
      case 'getme': rejectUnexpected(params, []); return this._telegramBot(bot)
      case 'sendmessage': return this._sendMessage(bot, params)
      case 'getupdates': return this._getUpdates(bot, params)
      case 'setwebhook': return this._setWebhook(bot, params)
      case 'deletewebhook': return this._deleteWebhook(bot, params)
      case 'getwebhookinfo': rejectUnexpected(params, []); return this._webhookInfo(bot)
      default: throw new TelegramApiError(404, `Not Found: method ${method} is not supported`)
    }
  }

  async invalidate(bot: BotIdentity): Promise<void> {
    this._bot = bot
    this._generation++
    if (this._retryTimer) clearTimeout(this._retryTimer)
    this._retryTimer = undefined
    this._notifyWaiters()
    await this._write(() => this._database.withTransaction((database) => this._clearGeneration(database, bot)))
  }

  async resume(): Promise<void> {
    if (this._disposed) return
    await this._ensure(this._bot)
    this._deliverWebhook()
  }

  dispose(): void {
    this._disposed = true
    this._generation++
    this._deliveryRequested = false
    if (this._retryTimer) clearTimeout(this._retryTimer)
    this._retryTimer = undefined
    this._notifyWaiters()
    this._waiters.clear()
  }

  private async _sendMessage(bot: BotIdentity, params: Record<string, unknown>): Promise<TelegramMessage> {
    rejectUnexpected(params, ['chat_id', 'text'])
    const chatId = requiredString(params, 'chat_id')
    const text = requiredString(params, 'text')
    if (!text) throw new TelegramApiError(400, 'Bad Request: message text is empty')
    const chat = await this._chatById(bot, chatId)
    if (!chat || chat.conversationId !== bot.conversationId) throw new TelegramApiError(400, 'Bad Request: chat not found')
    const session: PlatformSession = {
      platformId: bot.ownerPlatformId, platformSessionId: bot.ownerPlatformSessionId,
      userId: bot.ownerUserId, credentials: {}, metadata: {},
    }
    const peer = await this._peers.resolve(session, chat.conversationId)
    if (!peer) throw new TelegramApiError(400, 'Bad Request: chat not found')
    const message: IMMessage = {
      id: `bot-api:${randomUUID()}`,
      conversationId: chat.conversationId,
      senderId: chat.conversationId,
      sender: { id: chat.conversationId, firstName: bot.name, username: bot.username },
      content: { parts: [{ type: 'text', text }] },
      timestamp: Math.floor(Date.now() / 1_000),
      outgoing: false,
    }
    const projection = await this._write(() => this._database.withTransaction(async (database) => {
      await this._ensureState(database, bot)
      return this._projectMessage(database, bot, chat.chatId, message.id)
    }))
    await this._peers.emit(session, { type: 'message', conversation: peer.peer.conversation, message })
    return {
      message_id: projection.messageId,
      from: this._telegramBot(bot),
      date: message.timestamp,
      chat: telegramChat(chat),
      text,
    }
  }

  private async _getUpdates(bot: BotIdentity, params: Record<string, unknown>): Promise<TelegramUpdate[]> {
    rejectUnexpected(params, ['offset', 'limit', 'timeout', 'allowed_updates'])
    const offset = optionalInteger(params, 'offset')
    const limit = optionalInteger(params, 'limit') ?? 100
    const timeout = optionalInteger(params, 'timeout') ?? 0
    if (limit < 1 || limit > 100) throw new TelegramApiError(400, 'Bad Request: limit must be between 1 and 100')
    if (timeout < 0) throw new TelegramApiError(400, 'Bad Request: timeout must not be negative')
    const allowed = optionalStringArray(params, 'allowed_updates')
    const generation = this._generation
    let updates = await this._write(() => this._database.withTransaction(async (database) => {
      const state = await this._ensureState(database, bot)
      if (state.webhookUrl) throw new TelegramApiError(409, "Conflict: can't use getUpdates method while webhook is active")
      if (allowed !== undefined) {
        state.allowedUpdates = allowed as unknown as JsonObject
        await database.set('mtproto_bot_api_state', { botId: bot.id }, { allowedUpdates: state.allowedUpdates, updatedAt: new Date() })
      }
      if (offset !== undefined) {
        if (offset < 0) await this._selectTail(database, bot.id, offset)
        else await database.remove('mtproto_bot_api_update', { botId: bot.id, updateId: { $lt: offset } })
      }
      return this._updates(database, bot.id, limit, state)
    }))
    if (!updates.length && timeout > 0) {
      const waiter = this._waitForUpdates(Math.min(timeout, 50) * 1_000)
      updates = await this._write(() => this._database.withTransaction(async (database) => {
        const state = await this._ensureState(database, bot)
        if (state.webhookUrl) throw new TelegramApiError(409, "Conflict: can't use getUpdates method while webhook is active")
        return this._updates(database, bot.id, limit, state)
      }))
      if (updates.length) waiter.cancel()
      else await waiter.wait
      if (generation !== this._generation || !(await this._valid(bot))) throw new TelegramApiError(401, 'Unauthorized')
      if (!updates.length) {
        updates = await this._write(() => this._database.withTransaction(async (database) => {
          const state = await this._ensureState(database, bot)
          if (state.webhookUrl) throw new TelegramApiError(409, "Conflict: can't use getUpdates method while webhook is active")
          return this._updates(database, bot.id, limit, state)
        }))
      }
    }
    return updates
  }

  private async _setWebhook(bot: BotIdentity, params: Record<string, unknown>): Promise<true> {
    rejectUnexpected(params, ['url', 'secret_token', 'drop_pending_updates', 'allowed_updates'])
    const url = requiredString(params, 'url')
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new TelegramApiError(400, 'Bad Request: webhook url is invalid') }
    if (parsed.protocol !== 'https:') throw new TelegramApiError(400, 'Bad Request: webhook url must use HTTPS')
    const secretToken = optionalString(params, 'secret_token')
    if (secretToken && !/^[A-Za-z0-9_-]{1,256}$/u.test(secretToken)) throw new TelegramApiError(400, 'Bad Request: secret_token contains unsupported characters')
    const allowed = optionalStringArray(params, 'allowed_updates')
    await this._write(() => this._database.withTransaction(async (database) => {
      const state = await this._ensureState(database, bot)
      state.webhookUrl = url
      state.webhookSecretToken = secretToken ?? null
      state.lastErrorDate = null
      state.lastErrorMessage = null
      state.retryDelayMs = 1_000
      if (allowed !== undefined) state.allowedUpdates = allowed as unknown as JsonObject
      if (optionalBoolean(params, 'drop_pending_updates')) await database.remove('mtproto_bot_api_update', { botId: bot.id })
      await database.set('mtproto_bot_api_state', { botId: bot.id }, stateValues(state))
    }))
    this._deliverWebhook()
    return true
  }

  private async _deleteWebhook(bot: BotIdentity, params: Record<string, unknown>): Promise<true> {
    rejectUnexpected(params, ['drop_pending_updates'])
    if (this._retryTimer) clearTimeout(this._retryTimer)
    this._retryTimer = undefined
    await this._write(() => this._database.withTransaction(async (database) => {
      const state = await this._ensureState(database, bot)
      state.webhookUrl = null
      state.webhookSecretToken = null
      state.retryDelayMs = 1_000
      if (optionalBoolean(params, 'drop_pending_updates')) await database.remove('mtproto_bot_api_update', { botId: bot.id })
      await database.set('mtproto_bot_api_state', { botId: bot.id }, stateValues(state))
    }))
    return true
  }

  private async _webhookInfo(bot: BotIdentity): Promise<Record<string, unknown>> {
    return this._write(() => this._database.withTransaction(async (database) => {
      const state = await this._ensureState(database, bot)
      const pending = await database.get('mtproto_bot_api_update', { botId: bot.id })
      return {
        url: state.webhookUrl ?? '', has_custom_certificate: false, pending_update_count: pending.length,
        ...(state.lastErrorDate === null ? {} : { last_error_date: state.lastErrorDate }),
        ...(state.lastErrorMessage === null ? {} : { last_error_message: state.lastErrorMessage }),
        ...(state.allowedUpdates === null ? {} : { allowed_updates: state.allowedUpdates }),
      }
    }))
  }

  private _deliverWebhook(): void {
    if (this._disposed) return
    this._deliveryRequested = true
    if (this._webhookDelivery) return
    this._deliveryRequested = false
    const delivery = this._deliverNextWebhook()
    this._webhookDelivery = delivery
    void delivery.finally(async () => {
      if (this._webhookDelivery !== delivery) return
      this._webhookDelivery = undefined
      if (!this._disposed && (this._deliveryRequested || await this._hasPendingWebhook())) this._deliverWebhook()
    })
  }

  private async _deliverNextWebhook(): Promise<void> {
    const bot = this._bot
    if (!(await this._valid(bot))) return
    const delivery = await this._write(() => this._database.withTransaction(async (database) => {
      const state = await this._ensureState(database, bot)
      if (!state.webhookUrl) return
      const [update] = await database.select('mtproto_bot_api_update', { botId: bot.id }).orderBy('updateId').limit(1).execute()
      if (!update) return
      return { state, updateId: update.updateId, payload: update.payload }
    }))
    if (!delivery?.state.webhookUrl || !(await this._valid(bot))) return
    const webhook: WebhookState = {
      url: delivery.state.webhookUrl,
      ...(delivery.state.webhookSecretToken ? { secretToken: delivery.state.webhookSecretToken } : {}),
    }
    try {
      await postPublicWebhook(new URL(webhook.url), JSON.stringify(delivery.payload), webhook.secretToken)
      await this._write(() => this._database.withTransaction(async (database) => {
        const [state] = await database.get('mtproto_bot_api_state', { botId: bot.id })
        if (!state || state.tokenVersion !== bot.tokenVersion || state.webhookUrl !== webhook.url || state.webhookSecretToken !== (webhook.secretToken ?? null)) return
        await database.remove('mtproto_bot_api_update', { botId: bot.id, updateId: delivery.updateId })
        await database.set('mtproto_bot_api_state', { botId: bot.id }, {
          retryDelayMs: 1_000, lastErrorDate: null, lastErrorMessage: null, updatedAt: new Date(),
        })
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const delay = await this._write(() => this._database.withTransaction(async (database) => {
        const [state] = await database.get('mtproto_bot_api_state', { botId: bot.id })
        if (!state || state.tokenVersion !== bot.tokenVersion || state.webhookUrl !== webhook.url || state.webhookSecretToken !== (webhook.secretToken ?? null)) return
        const retryDelayMs = Math.min(Math.max(1_000, state.retryDelayMs) * 2, 60_000)
        await database.set('mtproto_bot_api_state', { botId: bot.id }, {
          lastErrorDate: Math.floor(Date.now() / 1_000), lastErrorMessage: message, retryDelayMs, updatedAt: new Date(),
        })
        return Math.max(1_000, state.retryDelayMs)
      }))
      if (delay !== undefined) this._scheduleRetry(delay)
    }
  }

  private _scheduleRetry(delay: number): void {
    if (this._retryTimer) return
    this._retryTimer = setTimeout(() => { this._retryTimer = undefined; this._deliverWebhook() }, delay)
    this._retryTimer.unref?.()
  }

  private async _hasPendingWebhook(): Promise<boolean> {
    if (!(await this._valid(this._bot))) return false
    const [state] = await this._database.get('mtproto_bot_api_state', { botId: this._bot.id })
    if (!state?.webhookUrl || this._retryTimer) return false
    const [pending] = await this._database.select('mtproto_bot_api_update', { botId: this._bot.id }).limit(1).execute()
    return Boolean(pending)
  }

  private async _ensure(bot: BotIdentity): Promise<void> {
    await this._write(() => this._database.withTransaction((database) => this._ensureState(database, bot)))
  }

  private async _ensureState(database: Database, bot: BotIdentity): Promise<BotApiStateRow> {
    const [state] = await database.get('mtproto_bot_api_state', { botId: bot.id })
    if (!state) {
      const created = initialState(bot)
      await database.create('mtproto_bot_api_state', created)
      return created
    }
    if (state.tokenVersion > bot.tokenVersion) throw new TelegramApiError(401, 'Unauthorized')
    if (state.tokenVersion < bot.tokenVersion) return this._clearGeneration(database, bot, state)
    return state
  }

  private async _clearGeneration(database: Database, bot: BotIdentity, previous?: BotApiStateRow): Promise<BotApiStateRow> {
    const current = previous ?? (await database.get('mtproto_bot_api_state', { botId: bot.id }))[0]
    await Promise.all([
      database.remove('mtproto_bot_api_update', { botId: bot.id }),
      database.remove('mtproto_bot_api_chat', { botId: bot.id }),
      database.remove('mtproto_bot_api_message_projection', { botId: bot.id }),
      database.remove('mtproto_bot_api_message_counter', { botId: bot.id }),
    ])
    const state: BotApiStateRow = {
      ...initialState(bot),
      nextUpdateId: current?.nextUpdateId ?? 1,
      tokenVersion: bot.tokenVersion,
    }
    await database.upsert('mtproto_bot_api_state', [state])
    return state
  }

  private async _ensureChat(database: Database, state: BotApiStateRow, bot: BotIdentity, conversation: IMConversation): Promise<BotApiChatRow> {
    const [existing] = await database.get('mtproto_bot_api_chat', { botId: bot.id, conversationId: conversation.id })
    const now = new Date()
    if (existing) {
      if (existing.title !== conversation.title || existing.username !== bot.username) {
        await database.set('mtproto_bot_api_chat', { id: existing.id }, { title: conversation.title, username: bot.username, updatedAt: now })
        return { ...existing, title: conversation.title, username: bot.username, updatedAt: now }
      }
      return existing
    }
    const chat = {
      botId: bot.id, chatId: state.nextChatId, conversationId: conversation.id,
      title: conversation.title, username: bot.username, createdAt: now, updatedAt: now,
    }
    await database.create('mtproto_bot_api_chat', chat)
    await database.set('mtproto_bot_api_state', { botId: bot.id }, { nextChatId: chat.chatId + 1, updatedAt: now })
    state.nextChatId++
    const [stored] = await database.get('mtproto_bot_api_chat', { botId: bot.id, chatId: chat.chatId })
    if (!stored) throw new Error('failed to persist Bot API chat projection')
    return stored
  }

  private async _chatById(bot: BotIdentity, chatId: string): Promise<BotApiChatRow | undefined> {
    if (!/^\d+$/u.test(chatId)) return
    const numeric = Number(chatId)
    if (!Number.isSafeInteger(numeric)) return
    const [chat] = await this._database.get('mtproto_bot_api_chat', { botId: bot.id, chatId: numeric })
    return chat
  }

  private async _projectMessage(database: Database, bot: BotIdentity, chatId: number, canonicalMessageId: string): Promise<{ messageId: number, created: boolean }> {
    const [existing] = await database.get('mtproto_bot_api_message_projection', { botId: bot.id, canonicalMessageId })
    if (existing) return { messageId: existing.messageId, created: false }
    const counterId = `${bot.id}:${chatId}`
    const [counter] = await database.get('mtproto_bot_api_message_counter', { id: counterId })
    const messageId = counter?.nextMessageId ?? 1
    await database.upsert('mtproto_bot_api_message_counter', [{
      id: counterId, botId: bot.id, chatId, nextMessageId: messageId + 1,
    }])
    await database.create('mtproto_bot_api_message_projection', {
      botId: bot.id, chatId, canonicalMessageId, messageId, createdAt: new Date(),
    })
    return { messageId, created: true }
  }

  private async _selectTail(database: Database, botId: string, offset: number): Promise<void> {
    const rows = await database.select('mtproto_bot_api_update', { botId }).orderBy('updateId').execute()
    const keep = new Set(rows.slice(Math.max(0, rows.length + offset)).map((row) => row.id))
    await Promise.all(rows.filter((row) => !keep.has(row.id)).map((row) => database.remove('mtproto_bot_api_update', { id: row.id })))
  }

  private async _updates(database: Database, botId: string, limit: number, _state: BotApiStateRow): Promise<TelegramUpdate[]> {
    const rows = await database.select('mtproto_bot_api_update', { botId }).orderBy('updateId').limit(limit).execute()
    return rows.map((row) => row.payload as unknown as TelegramUpdate)
  }

  private async _valid(bot: BotIdentity): Promise<boolean> {
    const current = await this._registry.get(bot.id)
    return Boolean(current?.enabled && current.tokenVersion === bot.tokenVersion)
  }

  private _setCurrent(bot: BotIdentity): void {
    if (bot.tokenVersion >= this._bot.tokenVersion) this._bot = bot
  }

  private _telegramBot(bot = this._bot): TelegramUser {
    return { id: Number(bot.id), is_bot: true, first_name: bot.name, username: bot.username }
  }

  private _waitForUpdates(timeoutMs: number): { wait: Promise<void>, cancel: () => void } {
    let wake!: () => void
    const wait = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      wake = () => { clearTimeout(timer); this._waiters.delete(wake); resolve() }
      timer = setTimeout(wake, timeoutMs)
      timer.unref?.()
      this._waiters.add(wake)
    })
    return { wait, cancel: wake }
  }

  private _notifyWaiters(): void { for (const wake of [...this._waiters]) wake() }

  private async _write<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this._writeTail
    let release!: () => void
    this._writeTail = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => {})
    try { return await callback() } finally { release() }
  }
}

export function apply(ctx: Context, config: Config): void {
  defineBotModels(ctx)
  defineTelegramBotApiModels(ctx)
  const registry = new BotRegistry(ctx, config.verifierSecret)
  const unregister = registerBotFather(ctx, registry)
  const runtimes = new Map<string, BotRuntime>()
  const runtime = (bot: BotIdentity) => {
    let current = runtimes.get(bot.id)
    if (!current) {
      current = new BotRuntime(bot, ctx.database, ctx.botRegistry, ctx.systemPeer)
      runtimes.set(bot.id, current)
    }
    return current
  }
  const report = (scope: string, error: unknown) => ctx.logger('telegram-bot-api').warn('%s: %s', scope, String(error))
  const stopCommitted = ctx.imPlatform.onCommittedEvent((session, event) => {
    const committed = event.event
    if (committed.type !== 'message' || committed.message.outgoing !== true) return
    void ctx.botRegistry.byConversation(session.platformSessionId, committed.conversation.id)
      .then((bot) => bot?.enabled ? runtime(bot).handleCommitted(session, event, bot) : undefined)
      .catch((error) => report('bot lookup failed', error))
  })
  const stopChanged = ctx.botRegistry.onChanged((bot) => {
    const current = runtimes.get(bot.id)
    if (current) void current.invalidate(bot).catch((error) => report('generation invalidation failed', error))
  })
  const stopSession = ctx.imPlatform.onSessionChange((event, binding) => {
    if (event !== 'activate') return
    void ctx.database.get('mtproto_bot_api_state', {}).then(async (states) => {
      for (const state of states) {
        const bot = await ctx.botRegistry.get(state.botId)
        if (bot?.ownerPlatformSessionId === binding.session.platformSessionId) await runtime(bot).resume()
      }
    }).catch((error) => report('webhook activation recovery failed', error))
  })
  const route = async (req: Request & { params: { token: string, method: string } }, res: Response) => {
    try {
      const preliminary = await ctx.botRegistry.authenticate(req.params.token)
      if (!preliminary) throw new TelegramApiError(401, 'Unauthorized')
      const params = await requestParameters(req)
      const method = req.params.method.toLowerCase()
      if (method === 'getupdates') {
        const bot = await ctx.botRegistry.authenticate(req.params.token)
        if (!bot) throw new TelegramApiError(401, 'Unauthorized')
        const result = await runtime(bot).invoke(bot, req.params.method, params)
        res.status = 200; res.json({ ok: true, result } satisfies TelegramApiResponse)
        return
      }
      let authorized = false
      const result = await ctx.botRegistry.withToken(req.params.token, async (bot) => {
        authorized = true
        return runtime(bot).invoke(bot, req.params.method, params)
      })
      if (!authorized) throw new TelegramApiError(401, 'Unauthorized')
      res.status = 200; res.json({ ok: true, result } satisfies TelegramApiResponse)
    } catch (error) {
      const failure = error instanceof TelegramApiError ? error : new TelegramApiError(500, 'Internal Server Error')
      res.status = failure.code; res.json({ ok: false, error_code: failure.code, description: failure.message } satisfies TelegramApiResponse)
    }
  }
  const get = ctx.server.get('/bot:token/:method', route)
  const post = ctx.server.post('/bot:token/:method', route)
  void ctx.database.prepared().then(async () => {
    const states = await ctx.database.get('mtproto_bot_api_state', {})
    for (const state of states) {
      if (!state.webhookUrl) continue
      const bot = await ctx.botRegistry.get(state.botId)
      if (bot) await runtime(bot).resume()
    }
  }).catch((error) => report('webhook recovery failed', error))
  ctx.effect(() => () => {
    get.dispose(); post.dispose(); stopCommitted(); stopChanged(); stopSession(); unregister()
    for (const current of runtimes.values()) current.dispose()
  }, 'telegram-bot-api')
}

function initialState(bot: BotIdentity): BotApiStateRow {
  return {
    botId: bot.id, tokenVersion: bot.tokenVersion, nextUpdateId: 1, nextChatId: 1,
    webhookUrl: null, webhookSecretToken: null, allowedUpdates: null,
    lastErrorDate: null, lastErrorMessage: null, retryDelayMs: 1_000, updatedAt: new Date(),
  }
}

function stateValues(state: BotApiStateRow): Omit<BotApiStateRow, 'botId'> {
  const { botId: _botId, ...values } = state
  return values
}

function telegramChat(chat: BotApiChatRow): TelegramChat {
  return { id: chat.chatId, type: 'private', first_name: chat.title, ...(chat.username ? { username: chat.username } : {}) }
}

function allowsMessage(state: BotApiStateRow): boolean {
  const allowed = state.allowedUpdates as unknown
  return !Array.isArray(allowed) || !allowed.length || allowed.includes('message')
}

async function requestParameters(req: Request): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {}; for (const [key, value] of req.query) params[key] = value
  if (req.method.toUpperCase() !== 'POST') return params
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType) return params
  const body = await readRequestBody(req)
  if (contentType === 'application/json') {
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new TelegramApiError(400, 'Bad Request: invalid JSON body') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TelegramApiError(400, 'Bad Request: JSON body must be an object')
    return { ...params, ...(parsed as Record<string, unknown>) }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    for (const [key, value] of new URLSearchParams(body)) params[key] = value
    return params
  }
  throw new TelegramApiError(415, 'Unsupported Media Type: only JSON and form-encoded bodies are supported')
}

async function readRequestBody(req: Request): Promise<string> {
  const limit = 1_048_576; const declaredLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new TelegramApiError(413, 'Request Entity Too Large')
  const reader = req.body?.getReader(); if (!reader) return ''
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); throw new TelegramApiError(413, 'Request Entity Too Large') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function plainText(message: IMMessage): string | undefined {
  return message.content.parts.length && message.content.parts.every((part) => part.type === 'text' && !part.entities?.length)
    ? message.content.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
    : undefined
}
function rejectUnexpected(params: Record<string, unknown>, allowed: string[]): void { const key = Object.keys(params).find((key) => !allowed.includes(key)); if (key) throw new TelegramApiError(400, `Bad Request: parameter ${key} is not supported`) }
function requiredString(params: Record<string, unknown>, key: string): string { const value = optionalString(params, key); if (value === undefined) throw new TelegramApiError(400, `Bad Request: ${key} is required`); return value }
function optionalString(params: Record<string, unknown>, key: string): string | undefined { const value = params[key]; if (value === undefined) return; if (typeof value === 'string' || typeof value === 'number') return String(value); throw new TelegramApiError(400, `Bad Request: ${key} must be a string`) }
function optionalInteger(params: Record<string, unknown>, key: string): number | undefined { const value = params[key]; if (value === undefined) return; const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : NaN; if (!Number.isSafeInteger(parsed)) throw new TelegramApiError(400, `Bad Request: ${key} must be an integer`); return parsed }
function optionalBoolean(params: Record<string, unknown>, key: string): boolean { const value = params[key]; if (value === undefined) return false; if (value === true || value === 'true') return true; if (value === false || value === 'false') return false; throw new TelegramApiError(400, `Bad Request: ${key} must be a boolean`) }
function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined { const value = params[key]; if (value === undefined) return; let parsed: unknown = value; if (typeof value === 'string') try { parsed = JSON.parse(value) } catch { throw new TelegramApiError(400, `Bad Request: ${key} must be a JSON array`) }; if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new TelegramApiError(400, `Bad Request: ${key} must be an array of strings`); return [...new Set(parsed)] }
