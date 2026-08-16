import type { Context } from 'cordis'
import type { JsonObject } from '@mtproto-relay/bridge'

export interface BotApiStateRow {
  botId: string
  tokenVersion: number
  nextUpdateId: number
  nextChatId: number
  webhookUrl: string | null
  webhookSecretToken: string | null
  allowedUpdates: JsonObject | null
  lastErrorDate: number | null
  lastErrorMessage: string | null
  retryDelayMs: number
  updatedAt: Date
}

export interface BotApiUpdateRow {
  id: number
  botId: string
  updateId: number
  payload: JsonObject
  createdAt: Date
}

export interface BotApiChatRow {
  id: number
  botId: string
  chatId: number
  conversationId: string
  title: string
  username: string | null
  createdAt: Date
  updatedAt: Date
}

export interface BotApiMessageProjectionRow {
  id: number
  botId: string
  chatId: number
  canonicalMessageId: string
  messageId: number
  createdAt: Date
}

export interface BotApiMessageCounterRow {
  id: string
  botId: string
  chatId: number
  nextMessageId: number
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_bot_api_state: BotApiStateRow
    mtproto_bot_api_update: BotApiUpdateRow
    mtproto_bot_api_chat: BotApiChatRow
    mtproto_bot_api_message_projection: BotApiMessageProjectionRow
    mtproto_bot_api_message_counter: BotApiMessageCounterRow
  }
}

/** Telegram Bot API state belongs to its adapter, not the bridge's canonical models. */
export function defineTelegramBotApiModels(ctx: Context): void {
  ctx.model.extend('mtproto_bot_api_state', {
    botId: 'string', tokenVersion: 'unsigned', nextUpdateId: 'unsigned', nextChatId: 'unsigned',
    webhookUrl: { type: 'text', nullable: true }, webhookSecretToken: { type: 'text', nullable: true },
    allowedUpdates: { type: 'json', nullable: true }, lastErrorDate: { type: 'integer', nullable: true },
    lastErrorMessage: { type: 'text', nullable: true }, retryDelayMs: 'unsigned', updatedAt: 'timestamp',
  }, { primary: 'botId' })

  ctx.model.extend('mtproto_bot_api_update', {
    id: 'unsigned', botId: 'string', updateId: 'unsigned', payload: 'json', createdAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['botId', 'updateId']],
    indexes: [['botId', 'updateId']],
  })

  ctx.model.extend('mtproto_bot_api_chat', {
    id: 'unsigned', botId: 'string', chatId: 'unsigned', conversationId: 'text', title: 'text',
    username: { type: 'text', nullable: true }, createdAt: 'timestamp', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['botId', 'chatId'], ['botId', 'conversationId']],
    indexes: [['botId', 'conversationId']],
  })

  ctx.model.extend('mtproto_bot_api_message_projection', {
    id: 'unsigned', botId: 'string', chatId: 'unsigned', canonicalMessageId: 'text', messageId: 'unsigned', createdAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['botId', 'canonicalMessageId'], ['botId', 'chatId', 'messageId']],
    indexes: [['botId', 'chatId']],
  })

  ctx.model.extend('mtproto_bot_api_message_counter', {
    id: 'string', botId: 'string', chatId: 'unsigned', nextMessageId: 'unsigned',
  }, {
    primary: 'id',
    unique: [['botId', 'chatId']],
  })
}
