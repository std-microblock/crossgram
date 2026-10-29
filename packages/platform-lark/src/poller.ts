import type { IMEvent, IMConversation } from '@mtproto-relay/bridge'
import type { LarkClient } from './client.js'
import { toConversation, toIncomingMessage } from './convert.js'
import type { LarkMediaLocator } from './types.js'

export interface LarkPollerDeps {
  client: LarkClient
  /** user 模式恒为 user_access_token。 */
  getToken: () => Promise<string>
  /** 当前账号 open_id，用于 outgoing 判定。 */
  selfId: string
  pollIntervalMs: number
  /** 测试注入时钟/休眠。 */
  sleep?: (ms: number) => Promise<void>
  logger?: { warn: (format: string, ...args: unknown[]) => void }
}

interface ChatCursor {
  conversation: IMConversation<LarkMediaLocator>
  /** 最后一条已见消息的 create_time（秒）。 */
  lastTime: number
  /** 游标秒内已见 message_id，避免同秒消息每轮重发。 */
  seenInSecond: Set<string>
}

/**
 * user 模式消息源：Lark 无用户身份实时事件，按会话轮询 `im/v1/messages` 增量拉取。
 * 重复投递由 bridge 的 (platformSessionId, conversationId, sourceId) 幂等摄入兜底。
 */
export class LarkPoller {
  private readonly deps: LarkPollerDeps
  private readonly chats = new Map<string, ChatCursor>()
  private readonly sleepers = new Set<() => void>()
  private running?: Promise<void>
  private closed = false

  constructor(deps: LarkPollerDeps) {
    this.deps = deps
  }

  async start(emit: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>): Promise<void> {
    this.running = this.loop(emit)
  }

  async close(): Promise<void> {
    this.closed = true
    // 唤醒休眠中的循环，避免 close 等待整个轮询周期
    for (const wake of this.sleepers) wake()
    await this.running?.catch(() => {})
  }

  private async loop(emit: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>): Promise<void> {
    while (!this.closed) {
      try {
        await this.pollOnce(emit)
      } catch (error: unknown) {
        this.deps.logger?.warn('Lark 轮询失败: %s', String(error))
      }
      if (this.closed) return
      await this.sleep(this.deps.pollIntervalMs)
    }
  }

  private async sleep(ms: number): Promise<void> {
    let wake: () => void
    const wakePromise = new Promise<void>((resolve) => {
      wake = resolve
      this.sleepers.add(wake!)
    })
    try {
      await Promise.race([
        this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)),
        wakePromise,
      ])
    } finally {
      this.sleepers.delete(wake!)
    }
  }

  private async pollOnce(emit: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>): Promise<void> {
    const token = await this.deps.getToken()
    for (const chat of await this.listChats(token)) {
      if (this.closed) return
      await this.pollChat(token, chat, emit)
    }
  }

  private async listChats(token: string) {
    const chats = []
    let pageToken: string | undefined
    do {
      const page = await this.deps.client.getChats(token, { pageSize: 100, pageToken })
      chats.push(...(page.items ?? []))
      pageToken = page.has_more ? page.page_token : undefined
    } while (pageToken)
    return chats
  }

  private async pollChat(
    token: string,
    chat: { chat_id: string, name?: string, chat_type?: 'p2p' | 'group', member_count?: number, external?: boolean },
    emit: (event: IMEvent<LarkMediaLocator>) => void | Promise<void>,
  ): Promise<void> {
    const existing = this.chats.get(chat.chat_id)
    const conversation = existing
      ? existing.conversation
      : toConversation(chat, chat.chat_id, { kind: 'group' })
    // 新会话首拉取最新一页作基线（recovery 补齐），此后按 create_time 增量
    const first = !existing
    const response = await this.deps.client.listMessages(token, {
      containerId: chat.chat_id,
      sortType: first ? 'ByCreateTimeDesc' : 'ByCreateTimeAsc',
      pageSize: first ? 20 : 50,
      ...(first ? {} : { startTime: existing!.lastTime }),
    })
    const cursor: ChatCursor = existing ?? {
      conversation,
      lastTime: 0,
      seenInSecond: new Set(),
    }
    // 升序游标推进；降序基线取最大 create_time
    const ordered = first ? [...response.items].reverse() : response.items
    for (const message of ordered) {
      const time = toSeconds(message.create_time)
      if (!first && time < cursor.lastTime) continue
      if (!first && time === cursor.lastTime && cursor.seenInSecond.has(message.message_id)) continue
      const projected = toIncomingMessage(message, this.deps.selfId)
      if (projected) {
        await emit({
          type: 'message',
          conversation,
          message: projected,
          ...(first ? { delivery: 'recovery' as const } : {}),
        })
      }
      if (time > cursor.lastTime) {
        cursor.lastTime = time
        cursor.seenInSecond.clear()
      }
      cursor.seenInSecond.add(message.message_id)
    }
    this.chats.set(chat.chat_id, cursor)
  }
}

function toSeconds(createTime: string): number {
  const raw = Number(createTime)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw > 1e12 ? Math.floor(raw / 1000) : raw
}
