import type {
  IMConversationRef, IMForwardMessagesOptions, IMMessage, IMMessageInput, IMMessageTarget,
  IMPlatform, IMTransferOptions, PlatformSession,
} from './platform.js'

export class MessageActionUnavailableError extends Error {
  constructor(readonly action: 'delete' | 'edit' | 'forward') {
    super(`platform message action is unavailable: ${action}`)
    this.name = 'MessageActionUnavailableError'
  }
}

/** Applies platform-declared fallback semantics without leaking them into Telegram RPC code. */
export class PlatformMessageActions {
  constructor(
    private readonly _platform: IMPlatform<any>,
    private readonly _session: PlatformSession,
  ) {}

  async delete(
    conversation: IMConversationRef,
    messageIds: readonly string[],
    forEveryone: boolean,
  ): Promise<void> {
    if (!this._platform.deleteMessages) throw new MessageActionUnavailableError('delete')
    await this._platform.deleteMessages(this._session, conversation, messageIds, { forEveryone })
  }

  async edit(
    target: IMMessageTarget,
    content: IMMessageInput,
    options?: IMTransferOptions,
  ): Promise<{ message: IMMessage, replacedMessageId?: string }> {
    const mode = this._platform.capabilities.messageActions?.edit.mode ?? 'unsupported'
    if (mode === 'native') {
      if (!this._platform.editMessage) throw new MessageActionUnavailableError('edit')
      return { message: await this._platform.editMessage(this._session, target, content, options) }
    }
    if (mode === 'delete-and-resend') {
      await this.delete({ id: target.conversationId }, [target.targetId], true)
      const message = await this._platform.sendMessage(
        this._session, { id: target.conversationId }, content, options,
      )
      return { message, replacedMessageId: target.messageId }
    }
    throw new MessageActionUnavailableError('edit')
  }

  async forward(
    from: IMConversationRef,
    messageIds: readonly string[],
    to: IMConversationRef,
    options?: IMForwardMessagesOptions,
  ): Promise<IMMessage[]> {
    const mode = this._platform.capabilities.messageActions?.forward.mode ?? 'unsupported'
    if (mode === 'unsupported' || !this._platform.forwardMessages) {
      throw new MessageActionUnavailableError('forward')
    }
    return this._platform.forwardMessages(this._session, from, messageIds, to, options)
  }
}

export function messageRuleAllows(
  rule: { supported: boolean, maxAgeSeconds?: number } | undefined,
  messageTimestamp: number,
  now: number,
): boolean {
  if (!rule?.supported) return false
  return rule.maxAgeSeconds === undefined || now - messageTimestamp <= rule.maxAgeSeconds
}
