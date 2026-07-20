import type { Database } from '@cordisjs/plugin-database'
import type { IMMessageAliasRow, IMMessageRow } from './models.js'
import { messageMedia, messageText, type IMConversation, type IMMessage, type PlatformSession } from './platform.js'

export interface IngestResult {
  message: IMMessageRow
  created: boolean
}

/** Durable canonical store shared by history sync, push ingestion, and sends. */
export class MessageStore {
  private readonly _counterLocks = new Map<string, Promise<void>>()

  constructor(private readonly _database: Database) {}

  async ingest(
    session: PlatformSession,
    conversation: IMConversation,
    source: IMMessage,
  ): Promise<IngestResult> {
    if (source.conversationId !== conversation.id) {
      throw new Error('message conversation does not match ingestion target')
    }

    return this._database.withTransaction(async (database) => {
      const now = new Date()
      await database.upsert('mtproto_im_conversation', [{
        platformSessionId: session.platformSessionId,
        platformConversationId: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        parentPlatformConversationId: conversation.parentId ?? null,
        spacePlatformId: conversation.spaceId ?? null,
        metadata: conversation.metadata ?? {},
        updatedAt: now,
      }], ['platformSessionId', 'platformConversationId'])
      const [conversationRow] = await database.get('mtproto_im_conversation', {
        platformSessionId: session.platformSessionId,
        platformConversationId: conversation.id,
      })
      if (!conversationRow) throw new Error('failed to persist conversation')

      const sourceIds = [...new Set([source.id, ...(source.sourceIds ?? [])])]
      let existingAlias: IMMessageAliasRow | undefined
      for (const platformMessageId of sourceIds) {
        ;[existingAlias] = await database.get('mtproto_im_message_alias', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          platformMessageId,
        })
        if (existingAlias) break
      }

      let message: IMMessageRow | undefined
      if (existingAlias) {
        ;[message] = await database.get('mtproto_im_message', { id: existingAlias.messageId })
      } else {
        ;[message] = await database.get('mtproto_im_message', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          primaryPlatformMessageId: source.id,
        })
      }

      const created = !message
      if (!message) {
        message = await database.create('mtproto_im_message', {
          platformSessionId: session.platformSessionId,
          conversationId: conversationRow.id,
          primaryPlatformMessageId: source.id,
          senderPlatformUserId: source.senderId,
          text: messageText(source),
          timestamp: source.timestamp,
          outgoing: source.outgoing ?? false,
          platformGroupId: source.groupId ?? null,
          metadata: source.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        })
      } else {
        await database.set('mtproto_im_message', { id: message.id }, {
          senderPlatformUserId: source.senderId,
          text: messageText(source),
          timestamp: source.timestamp,
          outgoing: source.outgoing ?? false,
          platformGroupId: source.groupId ?? null,
          metadata: source.metadata ?? {},
          updatedAt: now,
        })
        ;[message] = await database.get('mtproto_im_message', { id: message.id })
        if (!message) throw new Error('message disappeared during ingestion')
      }

      await database.upsert('mtproto_im_message_alias', sourceIds.map((platformMessageId, ordinal) => ({
        platformSessionId: session.platformSessionId,
        conversationId: conversationRow.id,
        platformMessageId,
        messageId: message!.id,
        ordinal,
      })), ['platformSessionId', 'conversationId', 'platformMessageId'])

      const media = messageMedia(source)
      await database.upsert('mtproto_im_media', media.map((item, ordinal) => ({
        messageId: message!.id,
        ordinal,
        partIndex: source.content.parts.findIndex((part) => part.type === 'media' && part.media === item),
        platformMediaId: item.id,
        kind: item.kind,
        name: item.name ?? null,
        mimeType: item.mimeType ?? null,
        size: item.size ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        locator: item.locator ?? null,
      })), ['messageId', 'ordinal'])

      const storedMedia = await database.get('mtproto_im_media', { messageId: message.id })
      for (const stale of storedMedia.filter((item) => item.ordinal >= media.length)) {
        await database.remove('mtproto_im_media', { id: stale.id })
      }

      return { message, created }
    })
  }

  async findByExternalId(
    platformSessionId: string,
    platformConversationId: string,
    platformMessageId: string,
  ): Promise<IMMessageRow | undefined> {
    const [conversation] = await this._database.get('mtproto_im_conversation', {
      platformSessionId, platformConversationId,
    })
    if (!conversation) return
    const [alias] = await this._database.get('mtproto_im_message_alias', {
      platformSessionId, conversationId: conversation.id, platformMessageId,
    })
    if (!alias) return
    const [message] = await this._database.get('mtproto_im_message', { id: alias.messageId })
    return message
  }

  async allocateIds(scope: string, count: number): Promise<number[]> {
    if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('count must be a positive integer')
    const previous = this._counterLocks.get(scope) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this._counterLocks.set(scope, tail)
    await previous
    try {
      return await this._database.withTransaction(async (database) => {
        const [counter] = await database.get('mtproto_id_counter', { scope })
        const first = counter?.nextId ?? 1
        const nextId = first + count
        if (nextId - 1 > 0x7fffffff) throw new RangeError(`message ID scope exhausted: ${scope}`)
        await database.upsert('mtproto_id_counter', [{ scope, nextId }])
        return Array.from({ length: count }, (_, index) => first + index)
      })
    } finally {
      release()
      if (this._counterLocks.get(scope) === tail) this._counterLocks.delete(scope)
    }
  }
}
