import type { Context } from 'cordis'

interface LegacyQQMediaCacheRow {
  key: string
  path: string
  mimeType: string
  size: number
  width: number | null
  height: number | null
  updatedAt: Date
}

interface LegacyQQMediaPreviewRow {
  key: string
  bytes: ArrayBuffer
  strippedBytes: ArrayBuffer | null
  outlineBytes: ArrayBuffer | null
  mimeType: string
  size: number
  width: number
  height: number
  updatedAt: Date
}

interface LegacyQQMediaAnimationRow {
  key: string
  animated: boolean
  updatedAt: Date
}

interface QQNTMigrationRow {
  id: string
  completedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_media_cache: LegacyQQMediaCacheRow
    mtproto_qqnt_media_preview: LegacyQQMediaPreviewRow
    mtproto_qqnt_media_animation: LegacyQQMediaAnimationRow
    mtproto_qqnt_migration: QQNTMigrationRow
  }
}

/** Registers removed cache tables only long enough for the startup migration to clean them. */
export function defineLegacyQQMediaSchema(ctx: Context): void {
  ctx.model.extend('mtproto_qqnt_media_cache', {
    key: 'string', path: 'text', mimeType: 'string', size: 'unsigned',
    width: { type: 'unsigned', nullable: true }, height: { type: 'unsigned', nullable: true },
    updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
  ctx.model.extend('mtproto_qqnt_media_preview', {
    key: 'string', bytes: 'binary',
    strippedBytes: { type: 'binary', nullable: true },
    outlineBytes: { type: 'binary', nullable: true },
    mimeType: 'string', size: 'unsigned', width: 'unsigned', height: 'unsigned', updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
  ctx.model.extend('mtproto_qqnt_media_animation', {
    key: 'string', animated: 'boolean', updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
  ctx.model.extend('mtproto_qqnt_migration', {
    id: 'string', completedAt: 'timestamp',
  }, { primary: 'id' })
}
