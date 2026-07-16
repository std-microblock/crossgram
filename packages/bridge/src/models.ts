import type { Context } from 'cordis'

/** A pending virtual-phone login (created by the HTTP auth flow, consumed by auth.signIn). */
export interface AuthSessionRow {
  id: string
  virtualPhone: string
  loginCode: string
  platformId: string
  platformSessionId: string
  used: boolean
}

/** An authenticated IM-platform session. */
export interface PlatformSessionRow {
  id: string
  platformId: string
  userId: string
  credentials: unknown
  metadata: Record<string, unknown>
  active: boolean
  createdAt: Date
}

/** Durable mapping used to restore bridge identity from a resumed auth key. */
export interface AuthBindingRow {
  authKeyId: string
  platformId: string
  platformSessionId: string
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_auth_session: AuthSessionRow
    mtproto_platform_session: PlatformSessionRow
    mtproto_auth_binding: AuthBindingRow
  }
}

/** Register the bridge's minato models on `ctx.model`. */
export function defineModels(ctx: Context): void {
  ctx.model.extend('mtproto_auth_session', {
    id: 'string',
    virtualPhone: 'string',
    loginCode: 'string',
    platformId: 'string',
    platformSessionId: 'string',
    used: 'boolean',
  }, { primary: 'id' })

  ctx.model.extend('mtproto_platform_session', {
    id: 'string',
    platformId: 'string',
    userId: 'string',
    credentials: 'json',
    metadata: 'json',
    active: 'boolean',
    createdAt: 'timestamp',
  }, { primary: 'id' })

  ctx.model.extend('mtproto_auth_binding', {
    authKeyId: 'string',
    platformId: 'string',
    platformSessionId: 'string',
  }, { primary: 'authKeyId' })
}
