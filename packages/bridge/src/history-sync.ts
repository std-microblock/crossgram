import { Service, type Context } from 'cordis'
import type { MessageStore } from './message-store.js'
import { qqMessageSequenceFromMetadata } from './message-id.js'
import {
  PlatformDataService, type ActivePlatformSession, type HistoryBackfillPage, type IMPlatformService,
} from './platform-manager.js'
import type { IMConversationKind, IMHistoryQuery } from './platform.js'
import { isLocalOnlyConversation } from './request-inbox.js'

declare module 'cordis' {
  interface Context {
    historySync: HistorySyncService
  }
}

export interface HistorySyncConversation {
  conversationId: string
  kind: IMConversationKind
  title: string
  /** 本地专属会话（申请收件箱、系统会话）没有上游历史。 */
  localOnly: boolean
  lastMessage?: {
    id: string
    timestamp: number
    /** 平台原生序号（QQ msgSeq）。 */
    sequence?: number
  }
}

export interface StoredMessageAnchor {
  id: string
  timestamp: number
  sequence?: number
}

/**
 * 不代表用户正在使用客户端的后台 RPC：客户端挂着时也会周期性调用，不能据此判定「忙」。
 * 实测 Telegram Desktop / Android 在会话列表停住时仍会每分钟轮询这些方法，若都算活跃，
 * 回填就永远等不到空闲窗口。
 */
const PASSIVE_RPC_PREFIXES = ['updates.', 'help.', 'langpack.', 'stories.']
const PASSIVE_RPC_METHODS = new Set([
  'account.updateStatus',
  'ping',
  'ping_delay_disconnect',
  // 客户端重启/重连后补齐的只读状态。
  'account.getNotifySettings',
  'account.getNotifyExceptions',
  'account.getAutoDownloadSettings',
  'account.getGlobalPrivacySettings',
  'messages.getDialogFilters',
  'messages.getPeerDialogs',
  'messages.getSavedDialogs',
  'messages.getMessagesReactions',
  'messages.getTopReactions',
  'messages.getAvailableReactions',
  'messages.getRecentReactions',
  'messages.readReactions',
  'messages.getMessagesViews',
  'contacts.getContacts',
  'contacts.getBlocked',
  // 媒体直链续期与分片下载：播放/下载时每几秒一次。
  'crossgram.getFileUrl',
  'upload.getFile',
  'upload.getFileHashes',
])

export function isPassiveRpc(method: string | undefined): boolean {
  if (!method) return true
  return PASSIVE_RPC_METHODS.has(method) || PASSIVE_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))
}

/**
 * 历史同步的公开接口，供回填等后台插件读取会话、已存序号并按锚点向上游补拉历史。
 * 只暴露与持久化无关的读写原语；回填进度等状态由使用方自行保存在内存里。
 */
export class HistorySyncService extends Service {
  private readonly _activity = new Map<string, number>()

  constructor(
    ctx: Context,
    private readonly _store: MessageStore,
    private readonly _platforms: IMPlatformService,
    private readonly _now: () => number = Date.now,
  ) {
    super(ctx, 'historySync')
  }

  /** 记录一次客户端 RPC；后台性质的 RPC 不计入。 */
  touch(platformSessionId: string, method?: string): void {
    if (isPassiveRpc(method)) return
    this._activity.set(platformSessionId, this._now())
  }

  /** 最近一次用户相关 RPC 的时间（毫秒），从未有过时为 `undefined`。 */
  lastActivityAt(platformSessionId: string): number | undefined {
    return this._activity.get(platformSessionId)
  }

  sessions(): ActivePlatformSession[] {
    return this._platforms.sessions
  }

  supportsSequenceHistory(binding: ActivePlatformSession): boolean {
    return binding.platform.capabilities.sequenceHistory === 'group'
      && binding.platform.capabilities.history
      && typeof binding.platform.getHistory === 'function'
  }

  supportsHistory(binding: ActivePlatformSession): boolean {
    return binding.platform.capabilities.history && typeof binding.platform.getHistory === 'function'
  }

  /** 按会话最近活跃时间倒序列出本地已知的全部会话。 */
  async listConversations(platformSessionId: string): Promise<HistorySyncConversation[]> {
    const output: HistorySyncConversation[] = []
    const seen = new Set<string>()
    let afterConversationId: string | undefined
    for (;;) {
      const dialogs = await this._store.listDialogs(platformSessionId, { limit: 200, afterConversationId })
      if (!dialogs.length) break
      for (const dialog of dialogs) {
        const { conversation, lastMessage } = dialog
        if (seen.has(conversation.id)) continue
        seen.add(conversation.id)
        const sequence = lastMessage ? qqMessageSequenceFromMetadata(lastMessage.metadata) : undefined
        output.push({
          conversationId: conversation.id,
          kind: conversation.kind,
          title: conversation.title,
          localOnly: isLocalOnlyConversation(conversation),
          ...(lastMessage ? {
            lastMessage: {
              id: lastMessage.id,
              timestamp: lastMessage.timestamp,
              ...(sequence !== undefined ? { sequence } : {}),
            },
          } : {}),
        })
      }
      const last = dialogs.at(-1)!.conversation.id
      if (dialogs.length < 200 || last === afterConversationId) break
      afterConversationId = last
    }
    return output
  }

  /** 本地已存的原生序号，倒序、去重；`below` 为不含端点的上界。 */
  readStoredSequences(
    platformSessionId: string,
    conversationId: string,
    options: { below?: number, limit: number },
  ): Promise<number[]> {
    return this._store.readNativeSequences(platformSessionId, conversationId, options)
  }

  /** 本地最早的一条消息，作为按锚点向更早方向回填的起点。 */
  async oldestStoredMessage(platformSessionId: string, conversationId: string): Promise<StoredMessageAnchor | undefined> {
    const [oldest] = await this._store.readHistory(platformSessionId, conversationId, { limit: 1, order: 'asc' })
    if (!oldest) return
    const sequence = qqMessageSequenceFromMetadata(oldest.metadata)
    return { id: oldest.id, timestamp: oldest.timestamp, ...(sequence !== undefined ? { sequence } : {}) }
  }

  /** 向上游读取一页历史并写入本地，不发布 update。 */
  backfill(
    binding: Pick<ActivePlatformSession, 'platform' | 'session'>,
    conversationId: string,
    query: IMHistoryQuery,
  ): Promise<HistoryBackfillPage> {
    return new PlatformDataService(binding.platform, binding.session, this._store).backfillHistory(conversationId, query)
  }

  findSession(platformSessionId: string): ActivePlatformSession | undefined {
    return this._platforms.sessions.find((binding) => binding.session.platformSessionId === platformSessionId)
  }
}

