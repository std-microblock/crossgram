import { Service, type Context } from 'cordis'
import type { tl } from '@mtcute/core'
import type { IMConversation } from './platform.js'

export interface ConversationViewMessageTarget {
  conversationId: string
  platformMessageId: string
  tlMessageId: number
}

export interface ConversationViewContext {
  platformSessionId: string
  chatId: number
  conversation: IMConversation
}

/** One optional projection strategy for linked, non-dialog conversations. */
export interface ConversationViewProvider {
  readonly id: string
  supports(conversation: IMConversation): boolean
  makeLink(context: ConversationViewContext, target?: ConversationViewMessageTarget): string
  makePreview(context: ConversationViewContext, url: string): tl.RawMessageMediaWebPage
  makeChat(context: ConversationViewContext, dcId: number): tl.TypeChat
  makeFullChat(
    context: ConversationViewContext,
    notifySettings: tl.TypePeerNotifySettings,
  ): tl.messages.RawChatFull
  resolveUsername?(username: string): number | undefined
}

interface ConversationViewRecord extends ConversationViewContext {
  provider: ConversationViewProvider
  target?: ConversationViewMessageTarget
}

/**
 * Cordis-owned registry for optional linked-conversation projections.
 *
 * Bridge only understands this generic contract. Feature plugins own matching,
 * links, previews, and synthetic peer shape, and unregister cleanly on HMR.
 */
export class ConversationViewService extends Service {
  private readonly _providers = new Map<string, ConversationViewProvider>()
  private readonly _records = new Map<string, Map<number, ConversationViewRecord>>()

  constructor(ctx: Context) {
    super(ctx, 'conversationView')
  }

  register(provider: ConversationViewProvider): () => void {
    if (this._providers.has(provider.id)) {
      throw new Error(`duplicate conversation view provider: ${provider.id}`)
    }
    this._providers.set(provider.id, provider)
    return () => {
      if (this._providers.get(provider.id) !== provider) return
      this._providers.delete(provider.id)
      for (const [sessionId, records] of this._records) {
        for (const [chatId, record] of records) {
          if (record.provider === provider) records.delete(chatId)
        }
        if (!records.size) this._records.delete(sessionId)
      }
    }
  }

  supports(conversation: IMConversation): boolean {
    return this._provider(conversation) !== undefined
  }

  remember(
    platformSessionId: string,
    chatId: number,
    conversation: IMConversation,
  ): string | undefined {
    const provider = this._provider(conversation)
    if (!provider) return
    const records = this._records.get(platformSessionId) ?? new Map<number, ConversationViewRecord>()
    const previous = records.get(chatId)
    const record: ConversationViewRecord = {
      platformSessionId,
      chatId,
      conversation,
      provider,
      ...(previous?.provider === provider && previous.target ? { target: previous.target } : {}),
    }
    records.set(chatId, record)
    this._records.set(platformSessionId, records)
    return provider.makeLink(record, record.target)
  }

  resolve(platformSessionId: string, chatId: number): IMConversation | undefined {
    return this._records.get(platformSessionId)?.get(chatId)?.conversation
  }

  resolveUsername(
    platformSessionId: string,
    username: string,
  ): { chatId: number, conversation: IMConversation } | undefined {
    for (const provider of this._providers.values()) {
      const chatId = provider.resolveUsername?.(username)
      if (chatId === undefined) continue
      const record = this._records.get(platformSessionId)?.get(chatId)
      if (record?.provider === provider) return { chatId, conversation: record.conversation }
    }
  }

  ownsMessage(platformSessionId: string, tlMessageId: number): boolean {
    for (const record of this._records.get(platformSessionId)?.values() ?? []) {
      if (record.target?.tlMessageId === tlMessageId) return true
    }
    return false
  }

  target(platformSessionId: string, chatId: number): ConversationViewMessageTarget | undefined {
    return this._records.get(platformSessionId)?.get(chatId)?.target
  }

  setTarget(platformSessionId: string, chatId: number, target: ConversationViewMessageTarget): void {
    const record = this._records.get(platformSessionId)?.get(chatId)
    if (!record) throw new Error(`conversation view is not registered: ${platformSessionId}/${chatId}`)
    record.target = target
  }

  makeLink(platformSessionId: string, chatId: number): string | undefined {
    const record = this._records.get(platformSessionId)?.get(chatId)
    if (!record) return
    return record.provider.makeLink(record, record.target)
  }

  makePreview(
    platformSessionId: string,
    chatId: number,
  ): tl.RawMessageMediaWebPage | undefined {
    const record = this._records.get(platformSessionId)?.get(chatId)
    if (!record) return
    return record.provider.makePreview(record, record.provider.makeLink(record, record.target))
  }

  makeChat(platformSessionId: string, chatId: number, dcId: number): tl.TypeChat | undefined {
    const record = this._records.get(platformSessionId)?.get(chatId)
    if (!record) return
    return record.provider.makeChat(record, dcId)
  }

  makeFullChat(
    platformSessionId: string,
    chatId: number,
    notifySettings: tl.TypePeerNotifySettings,
  ): tl.messages.RawChatFull | undefined {
    const record = this._records.get(platformSessionId)?.get(chatId)
    if (!record) return
    return record.provider.makeFullChat(record, notifySettings)
  }

  private _provider(conversation: IMConversation): ConversationViewProvider | undefined {
    for (const provider of this._providers.values()) {
      if (provider.supports(conversation)) return provider
    }
  }
}
