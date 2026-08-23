import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type {
  ActivePlatformSession, IMConversation, IMMediaInput, IMMediaUploadPreparation, IMMediaUploadProbe,
  IMMessage, IMMessageInput, PlatformSession, SystemPeer, SystemPeerProvider, SystemPeerService,
} from '@mtproto-relay/bridge'
import z from 'schemastery'

export const QQ_FLASH_TRANSFER_CONVERSATION_ID = 'bridge:qq-flash-transfer'

export interface Config {
  maxFiles?: number
  maxTotalBytes?: number
}

export const Config = z.object({
  maxFiles: z.natural().min(1).max(100).default(100)
    .description('Maximum number of files accepted by one QQ flash-transfer request.'),
  maxTotalBytes: z.natural().min(1).max(100 * 1024 ** 3).default(100 * 1024 ** 3)
    .description('Maximum combined byte size accepted by one QQ flash-transfer request.'),
})

export const name = 'qq-flash-transfer-bot'
export const inject = ['imPlatform', 'systemPeer']

export function apply(ctx: Context, config: Config = {}): void {
  const provider = new QQFlashTransferPeerProvider(
    ctx,
    config.maxFiles ?? 100,
    config.maxTotalBytes ?? 100 * 1024 ** 3,
  )
  const unregister = ctx.systemPeer.register(provider)
  ctx.effect(() => async () => {
    await provider.dispose()
    unregister()
  }, 'qq-flash-transfer-bot.system-peer')
}

export class QQFlashTransferPeerProvider implements SystemPeerProvider {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly controller = new AbortController()
  private active = true

  constructor(
    private readonly ctx: Context,
    private readonly maxFiles: number,
    private readonly maxTotalBytes: number,
  ) {}

  async dispose(): Promise<void> {
    this.active = false
    this.controller.abort()
    await Promise.allSettled(this.tails.values())
    this.tails.clear()
  }

  async bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void> {
    const binding = this.qqBinding(session)
    if (!this.active || !binding) return
    const peer = flashTransferPeer()
    await peers.emit(session, { type: 'conversation', conversation: peer.conversation })
    if (!this.active) return
    await reply(
      session,
      peer.conversation,
      '仅支持 QQ。转发已有 QQ 文件会直接复用 QQ 远端身份与哈希元数据，不读取或重新上传 QQNT 本地缓存；新文件通过 QQ 闪传分片协议上传。文件说明会用作闪传名称。',
      peers,
      'bridge:qq-flash-transfer:welcome',
    )
  }

  async resolve(session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined> {
    if (!this.active || conversationId !== QQ_FLASH_TRANSFER_CONVERSATION_ID) return
    return this.qqBinding(session) ? flashTransferPeer() : undefined
  }

  listBots() {
    const peer = flashTransferPeer()
    return [{
      conversationId: peer.id,
      title: peer.conversation.title,
      username: String(peer.conversation.metadata?.username),
      sourcePlugin: '@mtproto-relay/qq-flash-transfer-bot',
    }]
  }

  async receive(
    session: PlatformSession,
    peer: SystemPeer,
    _message: IMMessage,
    peers: SystemPeerService,
    input?: IMMessageInput,
  ): Promise<void> {
    if (!this.active || peer.id !== QQ_FLASH_TRANSFER_CONVERSATION_ID) return
    const text = plainInputText(input)
    const media = input?.parts.flatMap((part) => part.type === 'media' ? [part.media] : []) ?? []
    if (!media.length) {
      await reply(
        session,
        peer.conversation,
        text === '/start' || text === '/help'
          ? '转发一个或多个已有 QQ 文件即可复用创建闪传；也可直接上传新文件。可附带文字作为闪传名称。'
          : '请发送文件；纯文字消息不会创建 QQ 闪传。',
        peers,
      )
      return
    }
    return this.enqueue(session.platformSessionId, () => this.create(session, peer.conversation, media, text, peers))
  }

  async prepareMediaUpload(
    session: PlatformSession,
    peer: SystemPeer,
    media: IMMediaUploadProbe,
  ): Promise<IMMediaUploadPreparation | undefined> {
    if (!this.active || peer.id !== QQ_FLASH_TRANSFER_CONVERSATION_ID) return
    return this.qqBinding(session)?.platform.flashTransfer?.prepareUpload?.(session, media)
  }

  private async create(
    session: PlatformSession,
    conversation: IMConversation,
    media: IMMediaInput[],
    text: string | undefined,
    peers: SystemPeerService,
  ): Promise<void> {
    const binding = this.qqBinding(session)
    const flashTransfer = binding?.platform.flashTransfer
    if (!this.active || !binding) return
    if (!flashTransfer) {
      await reply(session, conversation, 'QQ 闪传服务未初始化，请检查 QQ 平台适配器。', peers)
      return
    }
    if (media.length > this.maxFiles) {
      await reply(session, conversation, `一次最多创建 ${this.maxFiles} 个文件的 QQ 闪传。`, peers)
      return
    }
    const sizes = media.map((item) => item.source.size ?? item.size)
    if (sizes.some((size) => !Number.isSafeInteger(size) || size! < 0)) {
      await reply(session, conversation, '存在无法确定大小的文件，不能创建 QQ 闪传。', peers)
      return
    }
    const totalBytes = sizes.reduce((sum, size) => sum + size!, 0)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxTotalBytes) {
      await reply(session, conversation, `文件总大小超过 ${formatBytes(this.maxTotalBytes)} 限制。`, peers)
      return
    }
    const reused = media.filter((item) => item.origin?.locator).length
    const uploaded = media.length - reused
    const mode = [
      reused ? `复用 ${reused} 个 QQ 文件` : '',
      uploaded ? `上传 ${uploaded} 个新文件` : '',
    ].filter(Boolean).join('，')
    await reply(
      session,
      conversation,
      `正在创建 QQ 闪传：${media.length} 个文件，共 ${formatBytes(totalBytes)}（${mode}）……`,
      peers,
    )
    try {
      const result = await flashTransfer.create(session, media, {
        name: transferName(text, media),
        signal: this.controller.signal,
      })
      if (!this.active) return
      const expires = result.expiresAt ? `\n有效期至：${new Date(result.expiresAt).toISOString()}` : ''
      const body = `QQ 闪传已创建：\n${result.shareLink}\n文件集 ID：${result.fileSetId}${expires}`
      await reply(session, conversation, body, peers, undefined, result.shareLink)
    } catch (error) {
      if (!this.active || this.controller.signal.aborted) return
      this.ctx.logger('qq-flash-transfer-bot').warn('QQ flash transfer failed: %s', errorText(error))
      await reply(session, conversation, flashTransferFailureMessage(error), peers)
    }
  }

  private binding(session: PlatformSession): ActivePlatformSession | undefined {
    return this.ctx.imPlatform.sessions.find((item) =>
      item.session.platformId === session.platformId
      && item.session.platformSessionId === session.platformSessionId)
  }

  private qqBinding(session: PlatformSession): ActivePlatformSession | undefined {
    const binding = this.binding(session)
    return binding?.platform.platformKind === 'qq' ? binding : undefined
  }

  private enqueue(platformSessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(platformSessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.tails.set(platformSessionId, current)
    const cleanup = () => {
      if (this.tails.get(platformSessionId) === current) this.tails.delete(platformSessionId)
    }
    void current.then(cleanup, cleanup)
    return current
  }
}

function flashTransferPeer(): SystemPeer {
  return {
    id: QQ_FLASH_TRANSFER_CONVERSATION_ID,
    conversation: {
      id: QQ_FLASH_TRANSFER_CONVERSATION_ID,
      kind: 'direct',
      title: 'QQ 闪传',
      metadata: {
        bridgeOwned: true,
        localOnly: true,
        systemPeer: 'qq-flash-transfer',
        bot: true,
        username: 'QQFlashTransferBot',
      },
    },
  }
}

async function reply(
  session: PlatformSession,
  conversation: IMConversation,
  text: string,
  peers: SystemPeerService,
  id = `bridge:qq-flash-transfer:${randomUUID()}`,
  link?: string,
): Promise<void> {
  const offset = link ? text.indexOf(link) : -1
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
      content: {
        parts: [{
          type: 'text',
          text,
          ...(link && offset >= 0 ? { entities: [{ type: 'text-link' as const, offset, length: link.length, url: link }] } : {}),
        }],
      },
      timestamp: Math.floor(Date.now() / 1_000),
      outgoing: false,
    },
  })
}

function plainInputText(input: IMMessageInput | undefined): string | undefined {
  const parts = input?.parts ?? []
  if (parts.some((part) => part.type === 'text' && part.entities?.length)) return
  const text = parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim()
  return text || undefined
}

function transferName(text: string | undefined, media: readonly IMMediaInput[]): string {
  if (text && !text.startsWith('/')) return text.slice(0, 255)
  if (media.length === 1) return (media[0]!.name || 'CrossGram 文件').slice(0, 255)
  return `${media[0]!.name || 'CrossGram 文件'} 等 ${media.length} 个文件`.slice(0, 255)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
}

function flashTransferFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/no reusable MD5\/SHA-1 identity/iu.test(message)) {
    return '该 QQ 文件缺少可复用的远端 MD5/SHA-1 元数据，无法直接创建闪传。'
  }
  if (/cannot be reused without downloading it/iu.test(message)) {
    return '该 QQ 远端文件已不再命中秒传，按照无重复下载策略未重新拉取并上传。'
  }
  return 'QQ 闪传创建失败，请稍后重试。'
}
