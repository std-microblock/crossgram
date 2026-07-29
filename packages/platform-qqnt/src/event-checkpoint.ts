import type { Context } from 'cordis'

export interface QQNTEventCheckpointRow {
  platformSessionId: string
  lastEventId: string
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_event_checkpoint: QQNTEventCheckpointRow
  }
}

export function defineQQNTEventCheckpointModel(ctx: Context): void {
  ctx.model.extend('mtproto_qqnt_event_checkpoint', {
    platformSessionId: 'string', lastEventId: 'string', updatedAt: 'timestamp',
  }, { primary: 'platformSessionId', indexes: ['updatedAt'] })
}
