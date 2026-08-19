import type { Context } from 'cordis'

export interface TelegramStickerImportRow {
  platformSessionId: string
  shortName: string
  title: string
  count: number
  version: number
  payload: import('@mtproto-relay/bridge').JsonValue
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    telegram_sticker_import: TelegramStickerImportRow
  }
}

export function defineTelegramStickerImportModels(ctx: Context): void {
  ctx.model.extend('telegram_sticker_import', {
    platformSessionId: 'string',
    shortName: 'string',
    title: 'text',
    count: 'unsigned',
    version: 'unsigned',
    payload: 'json',
    updatedAt: 'timestamp',
  }, {
    primary: ['platformSessionId', 'shortName'],
    indexes: [['platformSessionId', 'updatedAt']],
  })
}
