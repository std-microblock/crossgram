import { randomBytes } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  BridgeManagementError,
  type BridgeManagementClientAuthorization,
  type BridgeManagementIdentity,
  type BridgeManagementService,
  type IMConversation,
  type IMInlineKeyboard,
  type IMInlineKeyboardButton,
  type IMMessage,
  type IMTextEntity,
  type JsonObject,
  type PlatformAccountView,
  type PlatformSession,
  type SystemPeer,
  type SystemPeerCallbackInput,
  type SystemPeerCallbackResult,
  type SystemBot,
  SystemPeerCallbackError,
  type SystemPeerProvider,
  type SystemPeerService,
} from '@mtproto-relay/bridge'

export const PLATFORM_ADMIN_CONVERSATION_ID = 'bridge:platform-admin'
export const PLATFORM_ADMIN_USERNAME = 'CrossGramAdminBot'

const CALLBACK_PREFIX = 'cgadmin:'
const PAGE_SIZE_MAX = 12

export interface Config {
  /** Empty means every active platform identity can manage its own data. */
  allowedPlatformSessionIds?: string[]
  /** Allow approved operators to inspect and operate on every platform identity. */
  crossAccountAccess?: boolean
  /** Include the rotating login code in account and identity output. */
  showLoginCodes?: boolean
  /** Optional externally reachable WebUI URL shown as a menu button. */
  webuiUrl?: string
  pageSize?: number
}

export const Config = z.object({
  allowedPlatformSessionIds: z.array(z.string()).default([])
    .description('Platform session IDs allowed to use the administration bot; empty allows self-service access.'),
  crossAccountAccess: z.boolean().default(false)
    .description('Allow approved operators to inspect and manage every platform account.'),
  showLoginCodes: z.boolean().default(true)
    .description('Show rotating Telegram login codes in account and identity views.'),
  webuiUrl: z.string().default('').role('link')
    .description('Public WebUI URL displayed as a button in the administration bot.'),
  pageSize: z.natural().min(1).max(PAGE_SIZE_MAX).default(6)
    .description('Number of accounts or identities displayed on each administration page.'),
})

export const name = 'platform-admin-bot'
export const inject = ['bridgeManagement', 'systemPeer']

export function apply(ctx: Context, config: Config = {}): void {
  const unregister = ctx.systemPeer.register(new PlatformAdminBotProvider(ctx.bridgeManagement, config, ctx.systemPeer))
  ctx.effect(() => unregister, 'platform-admin-bot.system-peer')
}

interface BotView {
  text: string
  keyboard?: IMInlineKeyboard
  entities?: IMTextEntity[]
  metadata?: JsonObject
}

interface CallbackMetadata extends JsonObject {
  adminAction: string
  page?: number
  providerId?: string
  packId?: string
  platformSessionId?: string
}

/** A local Telegram-style system peer that exposes safe bridge management operations. */
export class PlatformAdminBotProvider implements SystemPeerProvider {
  private readonly _allowed: Set<string>
  private readonly _crossAccountAccess: boolean
  private readonly _showLoginCodes: boolean
  private readonly _webuiUrl: string
  private readonly _pageSize: number

  constructor(
    private readonly _management: BridgeManagementService,
    config: Config = {},
    private readonly _systemPeers?: SystemPeerService,
  ) {
    this._allowed = new Set(config.allowedPlatformSessionIds ?? [])
    this._crossAccountAccess = config.crossAccountAccess ?? false
    this._showLoginCodes = config.showLoginCodes ?? true
    this._webuiUrl = validWebuiUrl(config.webuiUrl)
    this._pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, config.pageSize ?? 6))
  }

  async bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void> {
    if (!this._allows(session)) return
    const peer = adminPeer()
    await peers.emit(session, { type: 'conversation', conversation: peer.conversation })
    await this._emit(session, peer.conversation, {
      ...this._menuView(),
      metadata: { platformAdminView: 'welcome' },
    }, peers, 'welcome')
  }

  async resolve(session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined> {
    if (conversationId !== PLATFORM_ADMIN_CONVERSATION_ID || !this._allows(session)) return
    return adminPeer()
  }

  listBots() {
    const peer = adminPeer()
    return [{
      conversationId: peer.id,
      title: peer.conversation.title,
      username: PLATFORM_ADMIN_USERNAME,
      sourcePlugin: '@mtproto-relay/platform-admin-bot',
    }]
  }

  async receive(
    session: PlatformSession,
    peer: SystemPeer,
    message: IMMessage,
    peers: SystemPeerService,
  ): Promise<void> {
    if (!this._allows(session) || peer.id !== PLATFORM_ADMIN_CONVERSATION_ID || !message.outgoing) return
    const text = plainText(message)?.trim()
    if (!text) return
    try {
      const view = await this._command(session, text)
      await this._emit(session, peer.conversation, view, peers)
    } catch (error) {
      await this._emit(session, peer.conversation, this._errorView(error), peers)
    }
  }

  async callback(
    session: PlatformSession,
    peer: SystemPeer,
    input: SystemPeerCallbackInput,
    peers: SystemPeerService,
  ): Promise<SystemPeerCallbackResult> {
    if (!this._allows(session) || peer.id !== PLATFORM_ADMIN_CONVERSATION_ID) {
      throw new SystemPeerCallbackError('CHAT_ADMIN_REQUIRED')
    }
    const button = input.message.content.inlineKeyboard?.rows
      .flatMap(row => row.buttons)
      .find(candidate => candidate.type === 'callback' && candidate.data === input.data)
    if (!button || button.type !== 'callback') throw new SystemPeerCallbackError('DATA_INVALID')
    try {
      const view = await this._callbackView(session, input.data, button.metadata as CallbackMetadata | undefined)
      await this._emit(session, peer.conversation, view, peers)
      return { message: callbackToast(input.data), cacheTime: 0 }
    } catch (error) {
      const view = this._errorView(error)
      await this._emit(session, peer.conversation, view, peers)
      return { alert: true, message: view.text, cacheTime: 0 }
    }
  }

  private async _command(session: PlatformSession, input: string): Promise<BotView> {
    const parsed = parseCommand(input)
    if (!parsed) return this._aliasView(session, input)
    switch (parsed.name) {
      case 'start':
      case 'menu':
      case 'help': return this._menuView(parsed.name === 'help')
      case 'status': return this._statusView()
      case 'accounts': return this._accountsView(session, parsePage(parsed.args[0]))
      case 'identities': return this._identitiesView(session, parsePage(parsed.args[0]))
      case 'sessions':
      case 'clients': return this._clientsView(session, parsePage(parsed.args[0]))
      case 'server':
      case 'server_json': return this._serverView()
      case 'stickers': return this._stickersView(session, parsePage(parsed.args[0]))
      case 'bots': return this._botsView()
      case 'refresh': return this._refreshView()
      case 'approve': return this._approveView(session, parsed.args)
      case 'sticker': return this._stickerCommandView(session, parsed.args)
      default: return this._unknownView(parsed.name)
    }
  }

  private async _aliasView(session: PlatformSession, input: string): Promise<BotView> {
    switch (input.toLocaleLowerCase('zh-CN')) {
      case '菜单':
      case '帮助': return this._menuView()
      case '状态': return this._statusView()
      case '账号':
      case '平台账号': return this._accountsView(session, 0)
      case '身份':
      case '身份列表': return this._identitiesView(session, 0)
      case '会话':
      case '客户端': return this._clientsView(session, 0)
      case '服务器':
      case '服务器json': return this._serverView()
      case '表情包': return this._stickersView(session, 0)
      case '刷新': return this._refreshView()
      case '机器人':
      case 'bot':
      case 'bots': return this._botsView()
      default: return this._unknownView(input)
    }
  }

  private async _callbackView(
    session: PlatformSession,
    data: string,
    metadata?: CallbackMetadata,
  ): Promise<BotView> {
    if (!data.startsWith(CALLBACK_PREFIX)) throw new SystemPeerCallbackError('DATA_INVALID')
    const action = data.slice(CALLBACK_PREFIX.length).split(':')[0]
    switch (action) {
      case 'menu': return this._menuView()
      case 'status': return this._statusView()
      case 'accounts': return this._accountsView(session, metadata?.page ?? 0)
      case 'identities': return this._identitiesView(session, metadata?.page ?? 0)
      case 'clients': return this._clientsView(session, metadata?.page ?? 0)
      case 'server': return this._serverView()
      case 'stickers': return this._stickersView(session, metadata?.page ?? 0)
      case 'bots': return this._botsView()
      case 'refresh': return this._refreshView()
      case 'pack': return this._stickerPackView(session, requiredMetadata(metadata, ['providerId', 'packId']))
      case 'toggle': return this._toggleStickerView(
        session,
        requiredMetadata(metadata, ['providerId', 'packId', 'platformSessionId']),
      )
      default: throw new SystemPeerCallbackError('DATA_INVALID')
    }
  }

  private _menuView(withHelp = false): BotView {
    const lines = [
      'CrossGram 平台管理助手',
      '',
      '可查看服务器状态、平台账号、登录身份、客户端会话、服务器 JSON 和表情包关联。',
    ]
    if (withHelp) {
      lines.push('', '命令：')
      lines.push('/status — 服务器状态')
      lines.push('/accounts — 平台账号')
      lines.push('/identities — 身份列表与登录码')
      lines.push('/sessions — Telegram 客户端会话')
      lines.push('/server — 服务器 JSON')
      lines.push('/stickers [页码] — 表情包关联')
      lines.push('/bots — 已启用 Bot 与 t.me 链接')
      lines.push('/approve <平台ID> <登录令牌> — 批准二维码登录')
      lines.push('/sticker <providerId> <packId> <on|off> [身份ID] — 修改表情包关联')
      lines.push('/refresh — 刷新账号和表情包')
    }
    return { text: lines.join('\n'), keyboard: this._mainKeyboard() }
  }

  private async _statusView(): Promise<BotView> {
    const status = await this._management.status()
    const lines = [
      'CrossGram 服务器状态',
      '',
      `运行时间：${formatDuration(status.uptimeSeconds)}`,
      `内存：RSS ${formatBytes(status.memory.rssBytes)} / Heap ${formatBytes(status.memory.heapUsedBytes)}`,
      `MTProto：${status.mtproto.host}:${status.mtproto.port}`,
      `连接：${status.mtproto.activeConnections}（已认证 ${status.mtproto.authorizedConnections}）`,
      `平台：${status.platforms.registered.length} 个已注册 / ${status.platforms.activeSessions} 个活跃身份`,
      `存储：${status.storage.identities} 个身份 / ${status.storage.authBindings} 个绑定 / ${status.storage.clientAuthorizations} 个客户端`,
      `更新时间：${formatDate(status.generatedAt)}`,
    ]
    return { text: lines.join('\n'), keyboard: backKeyboard('status') }
  }

  private async _accountsView(session: PlatformSession, page: number): Promise<BotView> {
    const accounts = this._management.accounts(this._scope(session))
    const paged = paginate(accounts, page, this._pageSize)
    const lines = [`平台账号（${accounts.length}）`, '']
    if (!paged.items.length) lines.push('暂无平台账号。')
    for (const account of paged.items) lines.push(formatAccount(account, this._showLoginCodes), '')
    return {
      text: lines.join('\n').trimEnd(),
      keyboard: pageKeyboard('accounts', paged.page, paged.pages),
    }
  }

  private async _identitiesView(session: PlatformSession, page: number): Promise<BotView> {
    const identities = await this._management.identities(this._scope(session))
    const paged = paginate(identities, page, this._pageSize)
    const lines = [`身份列表（${identities.length}）`, '']
    if (!paged.items.length) lines.push('暂无身份。')
    for (const identity of paged.items) lines.push(formatIdentity(identity, this._showLoginCodes), '')
    return {
      text: lines.join('\n').trimEnd(),
      keyboard: pageKeyboard('identities', paged.page, paged.pages),
    }
  }

  private async _clientsView(session: PlatformSession, page: number): Promise<BotView> {
    const clients = await this._management.clientAuthorizations(this._scope(session))
    const paged = paginate(clients, page, this._pageSize)
    const lines = [`Telegram 客户端会话（${clients.length}）`, '']
    if (!paged.items.length) lines.push('暂无客户端会话。')
    for (const client of paged.items) lines.push(formatClient(client), '')
    return {
      text: lines.join('\n').trimEnd(),
      keyboard: pageKeyboard('clients', paged.page, paged.pages),
    }
  }

  private _serverView(): BotView {
    const text = JSON.stringify(this._management.serverConfig(), null, 2)
    return {
      text,
      entities: [{ type: 'pre', offset: 0, length: text.length, language: 'json' }],
      keyboard: backKeyboard('server'),
    }
  }

  private async _stickersView(session: PlatformSession, page: number): Promise<BotView> {
    const snapshot = this._management.stickers(this._scope(session))
    const paged = paginate(snapshot.packs, page, this._pageSize)
    const lines = [
      `表情包（${snapshot.packs.length}）`,
      `账号：${snapshot.accounts.length} / 更新时间：${formatDate(snapshot.updatedAt)}`,
      '',
    ]
    if (!paged.items.length) lines.push('暂无可管理的表情包。')
    for (const pack of paged.items) {
      const assigned = pack.assignments.filter(item => item.assigned).length
      lines.push(`${pack.title} · ${assigned}/${pack.assignments.length} 个账号已关联`)
    }
    const rows: IMInlineKeyboard['rows'] = paged.items.map((pack, index) => ({ buttons: [callbackButton(
      `📦 ${truncate(pack.title, 36)}`,
      `${CALLBACK_PREFIX}pack:${paged.page}:${index}`,
      { adminAction: 'pack', providerId: pack.providerId, packId: pack.packId },
    )] }))
    rows.push(...pageKeyboardRows('stickers', paged.page, paged.pages))
    return { text: lines.join('\n'), keyboard: { rows } }
  }

  private async _botsView(): Promise<BotView> {
    const bots = this._systemPeers ? await this._systemPeers.listBots() : this.listBots()
    const lines = [`Bot 管理（${bots.length}）`, '']
    if (!bots.length) lines.push('暂无已启用的 Bot。')
    for (const bot of bots) lines.push(formatBot(bot), '')
    lines.push('提示：通过 @BotFather 可创建、查看、重置或撤销自建 Bot。')
    return { text: lines.join('\n').trimEnd(), keyboard: backKeyboard('bots') }
  }

  private async _stickerPackView(
    session: PlatformSession,
    metadata: CallbackMetadata,
  ): Promise<BotView> {
    const snapshot = this._management.stickers(this._scope(session))
    const pack = snapshot.packs.find(item =>
      item.providerId === metadata.providerId && item.packId === metadata.packId)
    if (!pack) throw new BridgeManagementError('STICKER_PACK_NOT_FOUND', '表情包不存在，请刷新后重试。')
    const accounts = new Map(snapshot.accounts.map(account => [account.platformSessionId, account]))
    const lines = [
      pack.title,
      `Provider：${pack.providerId}`,
      `Pack：${pack.packId}`,
      ...(pack.count === undefined ? [] : [`数量：${pack.count}`]),
      '',
    ]
    for (const assignment of pack.assignments) {
      const account = accounts.get(assignment.platformSessionId)
      lines.push(`${assignment.assigned ? '✅' : '⬜'} ${account?.displayName ?? assignment.platformSessionId}${assignment.automatic ? '（固有）' : ''}`)
    }
    const rows = pack.assignments.map((assignment, index) => {
      const account = accounts.get(assignment.platformSessionId)
      return { buttons: [callbackButton(
        `${assignment.assigned ? '取消' : '关联'} · ${truncate(account?.displayName ?? assignment.platformSessionId, 28)}`,
        `${CALLBACK_PREFIX}toggle:${index}`,
        {
          adminAction: 'toggle', providerId: pack.providerId, packId: pack.packId,
          platformSessionId: assignment.platformSessionId,
        },
        assignment.automatic ? undefined : assignment.assigned ? 'danger' : 'success',
      )] }
    })
    rows.push({ buttons: [callbackButton('⬅️ 返回表情包', `${CALLBACK_PREFIX}stickers`, {
      adminAction: 'stickers', page: 0,
    })] })
    return { text: lines.join('\n'), keyboard: { rows } }
  }

  private async _toggleStickerView(
    session: PlatformSession,
    metadata: CallbackMetadata,
  ): Promise<BotView> {
    if (!this._canAccessSession(session, metadata.platformSessionId!)) {
      throw new SystemPeerCallbackError('CHAT_ADMIN_REQUIRED')
    }
    const snapshot = this._management.stickers(this._scope(session))
    const pack = snapshot.packs.find(item =>
      item.providerId === metadata.providerId && item.packId === metadata.packId)
    const assignment = pack?.assignments.find(item => item.platformSessionId === metadata.platformSessionId)
    if (!pack || !assignment) {
      throw new BridgeManagementError('STICKER_ACCOUNT_NOT_FOUND', '表情包或目标账号不存在，请刷新后重试。')
    }
    if (assignment.automatic && assignment.assigned) {
      throw new BridgeManagementError('STICKER_ASSIGNMENT_AUTOMATIC', '账号固有表情包不能取消关联。')
    }
    await this._management.setStickerPackAssigned(
      assignment.platformSessionId, pack.providerId, pack.packId, !assignment.assigned,
    )
    return this._stickerPackView(session, metadata)
  }

  private async _refreshView(): Promise<BotView> {
    await this._management.refresh()
    await this._management.refreshStickers()
    const view = await this._statusView()
    return { ...view, text: `刷新完成。\n\n${view.text}` }
  }

  private _approveView(session: PlatformSession, args: string[]): BotView {
    if (args.length !== 2) return this._usageView('/approve <平台ID> <登录令牌>')
    const [platformId, token] = args
    const account = this._management.accounts(this._scope(session)).find(item => item.platformId === platformId)
    if (!account) throw new BridgeManagementError('PLATFORM_ACCOUNT_UNAVAILABLE', '当前身份无权管理该平台账号。')
    this._management.approveLoginToken(platformId, token)
    return { text: `已批准 ${platformId} 的登录请求。`, keyboard: backKeyboard('approve') }
  }

  private async _stickerCommandView(session: PlatformSession, args: string[]): Promise<BotView> {
    if (args.length < 3 || args.length > 4 || !['on', 'off'].includes(args[2]!)) {
      return this._usageView('/sticker <providerId> <packId> <on|off> [身份ID]')
    }
    const targetSessionId = args[3] ?? session.platformSessionId
    if (!this._canAccessSession(session, targetSessionId)) {
      throw new BridgeManagementError('STICKER_ACCOUNT_NOT_FOUND', '当前身份无权管理目标账号。')
    }
    await this._management.setStickerPackAssigned(targetSessionId, args[0]!, args[1]!, args[2] === 'on')
    return this._stickerPackView(session, {
      adminAction: 'pack', providerId: args[0], packId: args[1],
    })
  }

  private _usageView(usage: string): BotView {
    return { text: `用法：${usage}`, keyboard: backKeyboard('usage') }
  }

  private _unknownView(command: string): BotView {
    return { text: `未知命令：${command}\n发送 /help 查看可用命令。`, keyboard: this._mainKeyboard() }
  }

  private _errorView(error: unknown): BotView {
    const message = error instanceof BridgeManagementError
      ? error.message
      : error instanceof SystemPeerCallbackError
        ? callbackErrorText(error.code)
        : error instanceof Error ? error.message : String(error)
    return { text: `操作失败：${message}`, keyboard: this._mainKeyboard() }
  }

  private _mainKeyboard(): IMInlineKeyboard {
    const rows: IMInlineKeyboard['rows'] = [
      { buttons: [
        callbackButton('📊 状态', `${CALLBACK_PREFIX}status`, { adminAction: 'status' }, 'primary'),
        callbackButton('👤 身份', `${CALLBACK_PREFIX}identities`, { adminAction: 'identities', page: 0 }),
      ] },
      { buttons: [
        callbackButton('🧩 平台账号', `${CALLBACK_PREFIX}accounts`, { adminAction: 'accounts', page: 0 }),
        callbackButton('📱 客户端', `${CALLBACK_PREFIX}clients`, { adminAction: 'clients', page: 0 }),
      ] },
      { buttons: [
        callbackButton('🧾 服务器 JSON', `${CALLBACK_PREFIX}server`, { adminAction: 'server' }),
        callbackButton('😀 表情包', `${CALLBACK_PREFIX}stickers`, { adminAction: 'stickers', page: 0 }),
      ] },
      { buttons: [callbackButton('🤖 Bot 管理', `${CALLBACK_PREFIX}bots`, { adminAction: 'bots' })] },
      { buttons: [callbackButton('🔄 全部刷新', `${CALLBACK_PREFIX}refresh`, { adminAction: 'refresh' }, 'success')] },
    ]
    if (this._webuiUrl) rows.push({ buttons: [{ type: 'url', text: '🌐 打开 WebUI', url: this._webuiUrl }] })
    return { rows }
  }

  private _scope(session: PlatformSession): string | undefined {
    return this._crossAccountAccess ? undefined : session.platformSessionId
  }

  private _allows(session: PlatformSession): boolean {
    return !this._allowed.size || this._allowed.has(session.platformSessionId)
  }

  private _canAccessSession(session: PlatformSession, platformSessionId: string): boolean {
    return this._crossAccountAccess || session.platformSessionId === platformSessionId
  }

  private async _emit(
    session: PlatformSession,
    conversation: IMConversation,
    view: BotView,
    peers: SystemPeerService,
    stableId?: string,
  ): Promise<void> {
    await peers.emit(session, {
      type: 'message',
      conversation,
      message: botMessage(conversation, view, stableId),
    })
  }
}

function adminPeer(): SystemPeer {
  return {
    id: PLATFORM_ADMIN_CONVERSATION_ID,
    conversation: {
      id: PLATFORM_ADMIN_CONVERSATION_ID,
      kind: 'direct',
      title: 'CrossGram 管理助手',
      metadata: {
        bridgeOwned: true, localOnly: true, systemPeer: 'platform-admin', bot: true,
        username: PLATFORM_ADMIN_USERNAME,
      },
    },
  }
}

function botMessage(conversation: IMConversation, view: BotView, stableId?: string): IMMessage {
  return {
    id: stableId
      ? `bridge:platform-admin:${stableId}`
      : `bridge:platform-admin:reply:${randomBytes(12).toString('hex')}`,
    conversationId: conversation.id,
    senderId: conversation.id,
    sender: {
      id: conversation.id,
      firstName: conversation.title,
      username: PLATFORM_ADMIN_USERNAME,
      metadata: conversation.metadata,
    },
    content: {
      parts: [{ type: 'text', text: view.text, entities: view.entities }],
      inlineKeyboard: view.keyboard,
    },
    timestamp: Math.floor(Date.now() / 1_000),
    outgoing: false,
    metadata: { platformAdmin: true, ...view.metadata },
  }
}

function plainText(message: IMMessage): string | undefined {
  if (!message.content.parts.length || message.content.parts.some(part => part.type !== 'text')) return
  return message.content.parts.map(part => part.type === 'text' ? part.text : '').join('\n')
}

function parseCommand(input: string): { name: string, args: string[] } | undefined {
  if (!input.startsWith('/')) return
  const [head = '', ...args] = input.split(/\s+/u)
  const name = head.slice(1).split('@')[0]!.toLocaleLowerCase('en-US')
  return { name, args }
}

function parsePage(value: string | undefined): number {
  if (!value) return 0
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number - 1 : 0
}

function callbackButton(
  text: string,
  data: string,
  metadata: CallbackMetadata,
  style?: 'primary' | 'danger' | 'success',
): Extract<IMInlineKeyboardButton, { type: 'callback' }> {
  return { type: 'callback', text, data, metadata, style }
}

function backKeyboard(source: string): IMInlineKeyboard {
  return { rows: [{ buttons: [callbackButton('⬅️ 返回菜单', `${CALLBACK_PREFIX}menu:${source}`, {
    adminAction: 'menu',
  })] }] }
}

function pageKeyboard(action: string, page: number, pages: number): IMInlineKeyboard {
  return { rows: pageKeyboardRows(action, page, pages) }
}

function pageKeyboardRows(action: string, page: number, pages: number): IMInlineKeyboard['rows'] {
  const rows: IMInlineKeyboard['rows'] = []
  const buttons: IMInlineKeyboardButton[] = []
  if (page > 0) buttons.push(callbackButton('⬅️ 上一页', `${CALLBACK_PREFIX}${action}:prev`, {
    adminAction: action, page: page - 1,
  }))
  if (page + 1 < pages) buttons.push(callbackButton('下一页 ➡️', `${CALLBACK_PREFIX}${action}:next`, {
    adminAction: action, page: page + 1,
  }))
  if (buttons.length) rows.push({ buttons })
  rows.push({ buttons: [callbackButton('🏠 返回菜单', `${CALLBACK_PREFIX}menu:${action}`, { adminAction: 'menu' })] })
  return rows
}

function paginate<T>(items: T[], requestedPage: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const page = Math.max(0, Math.min(pages - 1, requestedPage))
  return { items: items.slice(page * pageSize, (page + 1) * pageSize), page, pages }
}

function formatAccount(account: PlatformAccountView, showLoginCode: boolean): string {
  const status = { ready: '正常', loading: '加载中', error: '错误', unsupported: '不支持' }[account.status]
  const lines = [
    `${account.status === 'ready' ? '✅' : account.status === 'error' ? '❌' : '⏳'} ${account.displayName || account.platformId}`,
    `平台：${account.platformId}（${account.platformKind}） · ${status}`,
  ]
  if (account.username) lines.push(`账号：@${account.username}`)
  if (account.userId) lines.push(`用户 ID：${account.userId}`)
  if (account.virtualPhone) lines.push(`虚拟号码：${account.virtualPhone}`)
  if (showLoginCode && account.loginCode) {
    lines.push(`登录码：${account.loginCode}（${account.remainingSeconds ?? 0}s）`)
  }
  if (account.error) lines.push(`错误：${account.error}`)
  return lines.join('\n')
}

function formatIdentity(identity: BridgeManagementIdentity, showLoginCode: boolean): string {
  const lines = [
    `${identity.active ? '✅' : '⏸️'} ${identity.platformId} / ${identity.userId}`,
    `身份 ID：${identity.platformSessionId}`,
    `虚拟号码：${identity.virtualPhone ?? '未分配'}`,
    `绑定：${identity.authBindingCount} · 客户端：${identity.clientAuthorizationCount}`,
  ]
  if (showLoginCode && identity.loginCode) {
    const remaining = identity.loginCodeValidUntil
      ? Math.max(0, Math.ceil((identity.loginCodeValidUntil - Date.now()) / 1_000))
      : 0
    lines.push(`登录码：${identity.loginCode}（${remaining}s）`)
  }
  return lines.join('\n')
}

function formatClient(client: BridgeManagementClientAuthorization): string {
  return [
    `${client.unconfirmed ? '⚠️' : '✅'} ${client.deviceModel || client.appName}`,
    `${client.appName} ${client.appVersion} · ${client.platform} ${client.systemVersion}`,
    `IP：${client.ip}${client.country ? ` · ${client.country}` : ''}${client.region ? ` / ${client.region}` : ''}`,
    `最近活动：${formatDate(client.dateActive * 1_000)}`,
    `Auth：${truncate(client.authKeyId, 16)}`,
  ].join('\n')
}

function formatBot(bot: SystemBot): string {
  return [
    `🤖 ${bot.title}`,
    `账号：@${bot.username}`,
    `来源：${bot.sourcePlugin}`,
    `https://t.me/${bot.username}`,
  ].join('\n')
}

function requiredMetadata<T extends keyof CallbackMetadata>(
  metadata: CallbackMetadata | undefined,
  keys: T[],
): CallbackMetadata & Required<Pick<CallbackMetadata, T>> {
  if (!metadata || keys.some(key => typeof metadata[key] !== 'string' || !metadata[key])) {
    throw new SystemPeerCallbackError('DATA_INVALID')
  }
  return metadata as CallbackMetadata & Required<Pick<CallbackMetadata, T>>
}

function validWebuiUrl(value: string | undefined): string {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor(seconds % 86_400 / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  return [days ? `${days}天` : '', hours ? `${hours}小时` : '', `${minutes}分钟`].filter(Boolean).join(' ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`
}

function callbackToast(data: string): string {
  if (data.startsWith(`${CALLBACK_PREFIX}toggle`)) return '表情包关联已更新'
  if (data.startsWith(`${CALLBACK_PREFIX}refresh`)) return '刷新完成'
  return '已打开'
}

function callbackErrorText(code: string): string {
  if (code === 'CHAT_ADMIN_REQUIRED') return '当前身份无权执行此操作。'
  if (code === 'DATA_INVALID') return '按钮已失效，请重新打开菜单。'
  return code
}
