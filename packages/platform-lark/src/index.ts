import { randomUUID } from 'node:crypto'
import type { Database } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'
import z from 'schemastery'
import type {
  IMConversation, IMConversationRef, IMDialogPage, IMDownloadOptions, IMEvent, IMHistoryPage,
  IMHistoryQuery, IMMedia, IMMessage, IMMessageInput, IMPageQuery, IMPlatform, IMPlatformAccount,
  IMTransferOptions, JsonObject, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import { LarkClient } from './client.js'
import { buildSendPlan, parseLarkMessage, toConversation, toIncomingMessage, toSenderUser } from './convert.js'
import { LarkEventPump, type LarkReceiveEventData, type LarkRecalledEventData } from './events.js'
import { LarkPoller } from './poller.js'
import { TokenStore, type LarkCredentialBackend } from './token-store.js'
import type { LarkMediaLocator, LarkMessage } from './types.js'
import { larkSenderOpenId, larkMessageTimestamp } from './types.js'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export interface Config {
  appId: string
  appSecret: string
  baseUrl: string
  /** bot：应用身份收发（WS 事件 + tenant token）；user：用户身份收发（轮询 + user_access_token）。 */
  mode: 'bot' | 'user'
  /** OAuth 回调的公网基地址；缺省用内置 server 的 baseUrl。 */
  publicUrl?: string
  /** user 模式轮询间隔（毫秒）。 */
  pollIntervalMs: number
  proxy?: string
  requestTimeoutMs?: number
  /** Test-only HTTP transport injection. */
  fetch?: typeof globalThis.fetch
  /** Test-only WS client injection. */
  createWsClient?: ConstructorParameters<typeof LarkEventPump>[1]['createWsClient']
  /** Test-only event dispatcher injection. */
  createEventDispatcher?: ConstructorParameters<typeof LarkEventPump>[1]['createEventDispatcher']
}

export const Config = z.object({
  appId: z.string().required(),
  appSecret: z.string().role('secret').required(),
  baseUrl: z.string().default('https://open.feishu.cn'),
  mode: z.union(['bot', 'user']).default('bot'),
  publicUrl: z.string(),
  pollIntervalMs: z.natural().min(5_000).default(60_000),
  proxy: z.string().role('secret'),
  requestTimeoutMs: z.natural().min(1).default(30_000),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export const name = 'im-platform-lark'
export const inject = ['imPlatform', 'server', 'database', 'model']

interface OAuthPending {
  state: string
  redirectUri: string
  expiresAt: number
}

/** 凭据存取 bridge 数据库 `mtproto_platform_session.credentials`，随 cordis.db 一起备份。 */
class DatabaseCredentialBackend implements LarkCredentialBackend {
  constructor(
    private readonly database: Database,
    private readonly platformId: string,
  ) {}

  async load(): Promise<JsonObject | undefined> {
    await this.database.prepared()
    const [row] = await this.database.get('mtproto_platform_session', { platformId: this.platformId })
    return row?.credentials as JsonObject | undefined
  }

  async persist(credentials: JsonObject): Promise<void> {
    await this.database.prepared()
    // OAuth 首次授权时 session 行尚不存在，set 不匹配则由随后的 provision 写入完整快照
    await this.database.set('mtproto_platform_session', { platformId: this.platformId }, { credentials })
  }
}

export function apply(ctx: Context, config: Config): void {
  const id = resolvePlatformPluginId(ctx, 'lark')
  const logger = ctx.logger('platform-lark')
  const client = new LarkClient({
    baseUrl: config.baseUrl,
    appId: config.appId,
    appSecret: config.appSecret,
    proxy: config.proxy,
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  })

  let unregister: (() => void) | undefined
  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    unregister?.()
    void client.close()
  })

  const registerLark = (tokens?: TokenStore) => {
    if (stopped || unregister) return
    const platform = new LarkPlatform(client, {
      mode: config.mode,
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: config.baseUrl,
      pollIntervalMs: config.pollIntervalMs,
      ...(config.proxy ? { proxy: config.proxy } : {}),
      getToken: tokens ? () => tokens.getFreshUserToken() : () => client.getTenantAccessToken(),
      ...(tokens ? { tokens } : {}),
      ...(config.createWsClient ? { createWsClient: config.createWsClient } : {}),
      ...(config.createEventDispatcher ? { createEventDispatcher: config.createEventDispatcher } : {}),
    }, logger)
    unregister = ctx.imPlatform.register(platform, id)
  }

  if (config.mode === 'bot') {
    registerLark()
    return
  }

  // ---- user 模式：OAuth 授权流程 ----
  const tokens = new TokenStore(new DatabaseCredentialBackend(ctx.database, id), { client, logger })
  const redirectUri = `${(config.publicUrl ?? ctx.server.baseUrl).replace(/\/+$/, '')}/lark/${id}/oauth/callback`
  const pending = new Map<string, OAuthPending>()

  const authorizeUrl = () => {
    const state = randomUUID()
    pending.set(state, { state, redirectUri, expiresAt: Date.now() + 10 * 60_000 })
    return client.buildAuthorizeUrl(redirectUri, state)
  }

  const logAuthorizeHint = (reason?: string) => {
    for (const [state, entry] of pending) {
      if (entry.expiresAt < Date.now()) pending.delete(state)
    }
    if (reason) logger.warn('%s', reason)
    logger.info('Lark 账号未授权，请在浏览器打开并授权：\n%s', authorizeUrl())
  }

  ctx.server.get(`/lark/${id}/oauth/callback`, async (req, res) => {
    const code = req.query.get('code')
    const state = req.query.get('state')
    const entry = state ? pending.get(state) : undefined
    if (!code || !entry || entry.expiresAt < Date.now()) {
      res.status = 400
      res.json({ error: 'invalid or expired OAuth state' })
      return
    }
    pending.delete(state!)
    try {
      const exchange = await client.exchangeCode(code, redirectUri)
      const info = await client.getUserInfo(exchange.access_token)
      await tokens.adopt(exchange, info.open_id, info.name)
      registerLark(tokens)
      res.headers.set('content-type', 'text/html; charset=utf-8')
      res.body = '<!doctype html><meta charset="utf-8"><p>授权成功，返回 CrossGram 即可。</p>'
      logger.info('Lark 账号授权成功：%s', info.name ?? info.open_id)
    } catch (error) {
      logger.warn('Lark OAuth 授权失败: %s', String(error))
      res.status = 502
      res.json({ error: String(error) })
    }
  })

  void tokens.restore().then((state) => {
    if (state) registerLark(tokens)
    else logAuthorizeHint()
  }).catch((error: unknown) => {
    logAuthorizeHint(String(error))
  })
}

interface LarkPlatformDeps {
  mode: 'bot' | 'user'
  appId: string
  appSecret: string
  baseUrl: string
  pollIntervalMs: number
  proxy?: string
  /** bot 模式为 tenant_access_token，user 模式为 user_access_token。 */
  getToken: () => Promise<string>
  /** user 模式必填。 */
  tokens?: TokenStore
  createWsClient?: Config['createWsClient']
  createEventDispatcher?: Config['createEventDispatcher']
}

export class LarkPlatform implements IMPlatform<LarkMediaLocator> {
  readonly platformKind = 'lark'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 100_000,
      maxMedia: 9,
    },
    conversations: { groups: true, channels: false, subchannels: false },
    messageActions: {
      delete: { own: { supported: true }, others: { supported: false } },
      edit: { mode: 'unsupported' },
      forward: { mode: 'unsupported', preservesAuthor: false },
    },
  }

  private readonly client: LarkClient
  private readonly deps: LarkPlatformDeps
  private readonly logger?: { info: (format: string, ...args: unknown[]) => void, warn: (format: string, ...args: unknown[]) => void }
  private readonly chatCache = new Map<string, { conversation: IMConversation<LarkMediaLocator>, at: number }>()
  private activePump?: LarkEventPump
  private activePoller?: LarkPoller
  private selfId?: string

  constructor(client: LarkClient, deps: LarkPlatformDeps, logger?: LarkPlatform['logger']) {
    this.client = client
    this.deps = deps
    this.logger = logger
  }

  async stop(): Promise<void> {
    await this.activePump?.close()
    this.activePump = undefined
    await this.activePoller?.close()
    this.activePoller = undefined
  }

  private requireSelfId(): string {
    if (!this.selfId) throw new Error('Lark platform is not provisioned yet')
    return this.selfId
  }

  /** user 模式可不经 getAccount 从凭据恢复自身身份。 */
  private async ensureSelfId(): Promise<string> {
    if (this.selfId) return this.selfId
    const state = await this.deps.tokens?.restore()
    if (state) {
      this.selfId = state.openId
      return this.selfId
    }
    throw new Error('Lark platform is not provisioned yet')
  }

  async getAccount(): Promise<IMPlatformAccount<LarkMediaLocator>> {
    if (this.deps.mode === 'bot') {
      const bot = await this.client.getBotInfo()
      if (!bot.open_id) throw new Error('Lark 应用未开启机器人能力（应用功能 → 机器人）')
      this.selfId = bot.open_id
      return {
        credentials: {},
        user: {
          id: bot.open_id,
          firstName: bot.app_name || 'Lark Bot',
          metadata: { openId: bot.open_id, mode: 'bot' },
        },
      }
    }
    const tokens = this.deps.tokens!
    const state = await tokens.restore()
    if (!state) {
      throw new Error('Lark 账号未授权：请先在日志中找到授权链接完成 OAuth 授权')
    }
    const token = await tokens.getFreshUserToken()
    const info = await this.client.getUserInfo(token)
    this.selfId = info.open_id
    return {
      // 必须整份返回当前快照：provision 会用它覆盖 mtproto_platform_session.credentials
      credentials: tokens.requireSnapshot() as unknown as JsonObject,
      user: {
        id: info.open_id,
        firstName: info.name ?? info.en_name ?? info.open_id,
        ...(info.union_id ? { username: info.union_id } : {}),
        metadata: { openId: info.open_id, mode: 'user' },
      },
    }
  }

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    if (!this.selfId) {
      const account = await this.getAccount()
      this.selfId = account.user.id
    }
    if (this.deps.mode === 'user') {
      const poller = new LarkPoller({
        client: this.client,
        getToken: this.deps.getToken,
        selfId: this.selfId,
        pollIntervalMs: this.deps.pollIntervalMs,
        logger: this.logger,
      })
      this.activePoller = poller
      await poller.start((event) => handler(event))
      return async () => {
        if (this.activePoller === poller) this.activePoller = undefined
        await poller.close()
      }
    }
    const pump = new LarkEventPump({
      onMessage: (data) => this.handleReceive(handler, this.selfId!, data),
      onRecalled: (data) => this.handleRecalled(handler, data),
    }, {
      appId: this.deps.appId,
      appSecret: this.deps.appSecret,
      baseUrl: this.deps.baseUrl,
      ...(this.deps.proxy ? { proxy: this.deps.proxy } : {}),
      ...(this.deps.createWsClient ? { createWsClient: this.deps.createWsClient } : {}),
      ...(this.deps.createEventDispatcher ? { createEventDispatcher: this.deps.createEventDispatcher } : {}),
    }, this.logger)
    this.activePump = pump
    await pump.start()
    this.logger?.info('Lark WS 事件通道已建立（bot 模式）')
    return async () => {
      if (this.activePump === pump) this.activePump = undefined
      await pump.close()
    }
  }

  private async handleReceive(
    handler: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>,
    selfOpenId: string,
    data: LarkReceiveEventData,
  ): Promise<void> {
    const raw = data.message
    if (!raw?.message_id || !raw.chat_id) return
    const message = this.toLarkMessage(raw, data)
    const senderOpenId = larkSenderOpenId(message.sender)
    const conversation = await this.resolveConversation(message.chat_id, raw.chat_type, senderOpenId)
    const sender = toSenderUser(message, data.sender.sender_type === 'app' ? 'Lark 应用' : undefined)
    const { parts, replyToId } = parseLarkMessage(message)
    await handler({
      type: 'message',
      conversation,
      message: {
        id: message.message_id,
        conversationId: message.chat_id,
        senderId: senderOpenId ?? 'unknown',
        ...(sender ? { sender } : {}),
        content: { parts },
        timestamp: larkMessageTimestamp(message),
        outgoing: senderOpenId === selfOpenId,
        ...(replyToId ? { replyToId } : {}),
      },
    })
  }

  private async handleRecalled(
    handler: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>,
    data: LarkRecalledEventData,
  ): Promise<void> {
    if (!data.message_id || !data.chat_id) return
    const conversation = await this.resolveConversation(data.chat_id, undefined, data.operator_id?.open_id)
    await handler({
      type: 'message-delete',
      eventId: data.event_id ?? data.message_id,
      conversation,
      messageIds: [data.message_id],
      timestamp: Math.floor(Date.now() / 1000),
    })
  }

  /** REST 与事件消息统一成 LarkMessage（事件 message_type / REST msg_type 字段名差异在此消化）。 */
  private toLarkMessage(
    raw: {
      message_id: string
      chat_id: string
      chat_type?: 'p2p' | 'group'
      messageType?: string
      message_type?: string
      msg_type?: string
      content: string
      create_time?: string
      root_id?: string
      parent_id?: string
      mentions?: LarkReceiveEventData['message']['mentions']
    },
    data: { sender?: LarkReceiveEventData['sender'] },
  ): LarkMessage {
    return {
      message_id: raw.message_id,
      chat_id: raw.chat_id,
      chat_type: raw.chat_type,
      messageType: raw.messageType ?? raw.message_type ?? raw.msg_type ?? '',
      content: raw.content,
      create_time: raw.create_time ?? '',
      root_id: raw.root_id,
      parent_id: raw.parent_id,
      sender: data.sender ?? { sender_id: {} },
      mentions: raw.mentions,
    }
  }

  private async resolveConversation(
    chatId: string,
    chatType: 'p2p' | 'group' | undefined,
    peerOpenId?: string,
  ): Promise<IMConversation<LarkMediaLocator>> {
    const cached = this.chatCache.get(chatId)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.conversation
    const token = await this.deps.getToken()
    const chat = await this.client.getChat(token, chatId).catch(() => null)
    const kind = chat?.chat_type === 'p2p' || (!chat && chatType === 'p2p') ? 'direct' : 'group'
    const conversation = toConversation(chat, chatId, {
      kind,
      ...(kind === 'direct' && peerOpenId ? { title: peerOpenId } : {}),
    })
    this.chatCache.set(chatId, { conversation, at: Date.now() })
    return conversation
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<LarkMediaLocator>> {
    const token = await this.deps.getToken()
    const response = await this.client.getChats(token, {
      pageSize: query.limit ?? 20,
      pageToken: query.cursor,
    })
    return {
      dialogs: (response.items ?? []).map((chat) => {
        const conversation = toConversation(chat, chat.chat_id, { kind: 'group' })
        this.chatCache.set(chat.chat_id, { conversation, at: Date.now() })
        return { conversation, unreadCount: 0 }
      }),
      nextCursor: response.has_more ? response.page_token : undefined,
    }
  }

  async getHistory(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<LarkMediaLocator>> {
    const token = await this.deps.getToken()
    await this.ensureSelfId()
    // after 锚点向前翻页用升序；默认从最新往回翻用降序
    const ascending = Boolean(query.after) || (query.cursor !== undefined && query.cursor.startsWith('asc:'))
    const cursor = query.cursor?.replace(/^asc:/, '')
    const response = await this.client.listMessages(token, {
      containerId: conversation.id,
      sortType: ascending ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
      pageSize: query.limit ?? 20,
      pageToken: cursor,
      ...(query.before && !query.cursor ? { endTime: query.before.timestamp } : {}),
      ...(query.after && !query.cursor ? { startTime: query.after.timestamp } : {}),
    })
    return {
      messages: response.items.flatMap((message) => this.projectHistoryMessage(message)),
      nextCursor: response.has_more
        ? `${ascending ? 'asc:' : ''}${response.page_token ?? ''}`
        : undefined,
    }
  }

  private projectHistoryMessage(message: LarkMessage): IMMessage<LarkMediaLocator>[] {
    const projected = toIncomingMessage(message, this.requireSelfId())
    return projected ? [projected] : []
  }

  async getMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<LarkMediaLocator> | null> {
    const token = await this.deps.getToken()
    const message = await this.client.getMessage(token, messageId)
    if (!message) return null
    const projected = this.projectHistoryMessage({ ...message, chat_id: message.chat_id || conversation.id })
    return projected[0] ?? null
  }

  async sendMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<LarkMediaLocator>> {
    const plan = buildSendPlan(content)
    if (!plan.length) throw new Error('Lark cannot send an empty message')
    const token = await this.deps.getToken()
    await this.ensureSelfId()
    const sourceIds: string[] = []
    for (let index = 0; index < plan.length; index++) {
      const item = plan[index]!
      let msgType: string
      let payload: string
      if (item.kind === 'text') {
        msgType = 'text'
        payload = item.content
      } else {
        const media = item.media.media
        let transferredBytes = 0
        const track = (size: number) => {
          transferredBytes += size
          return options.onProgress?.({
            phase: 'upload' as const,
            mediaIndex: index,
            transferredBytes,
            totalBytes: media.source.size,
          })
        }
        const stream = trackStream(media.source.stream({ signal: options.signal }), track)
        if (item.kind === 'image') {
          const imageKey = await this.client.uploadImage(token, stream, { signal: options.signal })
          msgType = 'image'
          payload = JSON.stringify({ image_key: imageKey })
        } else if (item.kind === 'audio') {
          const fileKey = await this.client.uploadAudio(token, trackStream(media.source.stream({ signal: options.signal }), track), {
            fileName: media.name ?? 'voice.opus',
            signal: options.signal,
          })
          msgType = 'audio'
          payload = JSON.stringify({ file_key: fileKey, duration: Math.round((media.duration ?? 0) * 1000) })
        } else {
          const fileKey = await this.client.uploadFile(token, trackStream(media.source.stream({ signal: options.signal }), track), {
            fileName: media.name ?? 'file',
            signal: options.signal,
          })
          msgType = 'file'
          payload = JSON.stringify({ file_key: fileKey, file_name: media.name ?? 'file' })
        }
      }
      const sent = await this.client.sendMessage(token, {
        receiveId: conversation.id,
        msgType,
        content: payload,
        ...(index === 0 && content.replyToId ? { replyToMessageId: content.replyToId } : {}),
      }, options.signal)
      sourceIds.push(sent.message_id)
    }
    const sentTimestamp = Math.floor(Date.now() / 1000)
    return {
      id: sourceIds[0]!,
      sourceIds,
      conversationId: conversation.id,
      senderId: this.requireSelfId(),
      content: { parts: echoParts(content) },
      timestamp: sentTimestamp,
      outgoing: true,
      ...(content.replyToId ? { replyToId: content.replyToId } : {}),
    }
  }

  async deleteMessages(
    _session: PlatformSession,
    _conversation: IMConversationRef,
    messageIds: readonly string[],
  ): Promise<void> {
    const token = await this.deps.getToken()
    for (const messageId of new Set(messageIds)) {
      await this.client.recallMessage(token, messageId)
    }
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<LarkMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const locator = media.locator
    if (!locator?.fileKey || !locator.messageId) {
      throw new Error(`Lark media has no resource locator: ${media.id}`)
    }
    const token = await this.deps.getToken()
    const response = await this.client.downloadResource(token, locator.messageId, locator.fileKey, locator.type, options.signal)
    if (!response.body) throw new Error(`Lark media response has no body: ${media.id}`)
    let skipped = 0
    let emitted = 0
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(options.limit))
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        const chunk = value
        if (skipped + chunk.length <= offset) {
          skipped += chunk.length
          continue
        }
        const start = Math.max(0, offset - skipped)
        const accepted = chunk.subarray(start, start + limit - emitted)
        skipped += chunk.length
        if (accepted.length) {
          emitted += accepted.length
          await options.onProgress?.({
            phase: 'download', mediaIndex: 0, transferredBytes: emitted,
            totalBytes: Number.isFinite(limit) ? limit : media.size,
          })
          yield accepted
        }
        if (emitted >= limit) return
      }
    } finally {
      reader.releaseLock()
    }
  }
}

function echoParts(content: IMMessageInput): IMMessage<LarkMediaLocator>['content']['parts'] {
  const parts: IMMessage<LarkMediaLocator>['content']['parts'] = []
  for (const part of content.parts) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text, ...(part.entities ? { entities: part.entities } : {}) })
    } else if (part.type === 'media') {
      const media = part.media
      parts.push({
        type: 'media',
        media: {
          id: media.name ?? 'pending',
          kind: media.kind,
          ...(media.name ? { name: media.name } : {}),
          ...(media.mimeType ? { mimeType: media.mimeType } : {}),
          ...(media.size !== undefined ? { size: media.size } : {}),
          ...(media.width !== undefined ? { width: media.width } : {}),
          ...(media.height !== undefined ? { height: media.height } : {}),
          ...(media.duration !== undefined ? { duration: media.duration } : {}),
          ...(media.voice !== undefined ? { voice: media.voice } : {}),
        },
      })
    }
  }
  return parts
}

function trackStream(
  source: AsyncIterable<Uint8Array>,
  track: (size: number) => void | Promise<void>,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        await track(chunk.length)
        yield chunk
      }
    },
  }
}
