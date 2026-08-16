import type { Context } from 'cordis'

export interface BotIdentityRow {
  id: string
  ownerPlatformId: string
  ownerPlatformSessionId: string
  ownerUserId: string
  name: string
  username: string
  usernameNormalized: string
  conversationId: string
  tokenVersion: number
  tokenVerifier: string
  enabled: boolean
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_bot_identity: BotIdentityRow
  }
}

export function defineBotModels(ctx: Context): void {
  ctx.model.extend('mtproto_bot_identity', {
    id: 'string',
    ownerPlatformId: 'string',
    ownerPlatformSessionId: 'string',
    ownerUserId: 'string',
    name: 'text',
    username: 'text',
    usernameNormalized: 'string',
    conversationId: 'string',
    tokenVersion: 'unsigned',
    tokenVerifier: 'string',
    enabled: 'boolean',
    revokedAt: { type: 'timestamp', nullable: true },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: 'id',
    unique: ['usernameNormalized', 'conversationId'],
    indexes: ['ownerPlatformSessionId', 'conversationId'],
  })
}
