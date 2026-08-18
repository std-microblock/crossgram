import { rm } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type { Database } from '@cordisjs/plugin-database'
import type { JsonValue } from '@mtproto-relay/bridge'
import type { QQMediaLocator } from './protocol.js'

export interface RawMediaMigrationResult {
  mediaRows: number
  messages: number
  previewRows: number
  cacheRows: number
  animationRows: number
  files: number
}

const RAW_MESSAGE_MEDIA_MIGRATION = 'raw-message-media-v1'
const MIGRATION_BATCH_SIZE = 250

/**
 * Reverts message media created by the removed server-side preview/transcode
 * pipeline. Sticker and reaction cache rows are deliberately left untouched.
 */
export async function migrateLegacyQQMessageMedia(
  database: Database,
  platformId: string,
  mediaCachePath: string,
): Promise<RawMediaMigrationResult> {
  const result: RawMediaMigrationResult = {
    mediaRows: 0, messages: 0, previewRows: 0, cacheRows: 0, animationRows: 0, files: 0,
  }
  const [completed] = await database.get('mtproto_qqnt_migration', { id: RAW_MESSAGE_MEDIA_MIGRATION })
  if (completed) return result

  const sessions = await database.get('mtproto_platform_session', { platformId })
  const sessionIds = new Set(sessions.map((session) => session.id))
  const previewKeys = new Set<string>()
  const cachedPaths = new Set<string>()
  const changedMessageIds = new Set<number>()

  if (sessionIds.size) {
    let afterId = 0
    while (true) {
      const mediaRows = await database.select('mtproto_im_media', { id: { $gt: afterId } })
        .orderBy('id').limit(MIGRATION_BATCH_SIZE).execute()
      if (!mediaRows.length) break
      afterId = mediaRows.at(-1)!.id
      const messages = await database.get('mtproto_im_message', {
        id: { $in: [...new Set(mediaRows.map((row) => row.messageId))] },
      })
      const scopedMessages = new Map(messages
        .filter((message) => sessionIds.has(message.platformSessionId))
        .map((message) => [message.id, message]))
      const messageContent = new Map<number, JsonValue>()
      const changedInBatch = new Set<number>()

      await database.withTransaction(async (transaction) => {
        for (const row of mediaRows) {
          const message = scopedMessages.get(row.messageId)
          if (!message) continue
          const locator = qqLocator(row.locator)
          if (!locator || !isLegacyLocalProjection(row, locator)) continue
          if (locator.previewKey) previewKeys.add(locator.previewKey)
          const previewLocator = row.preview && qqLocator(row.preview.locator)
          if (previewLocator?.previewKey) previewKeys.add(previewLocator.previewKey)
          const removePreview = Boolean(previewLocator && hasLegacyLocalMarker(previewLocator))
          if (locator.cachedPath) cachedPaths.add(locator.cachedPath)
          const cleanedLocator = rawLocator(locator)
          const transformed = isTranscodedRow(row, locator)
          const raw = transformed ? rawMediaValues(row, cleanedLocator) : undefined
          await transaction.set('mtproto_im_media', { id: row.id }, {
            ...raw,
            locator: cleanedLocator as unknown as JsonValue,
            ...(removePreview ? { preview: null } : {}),
            strippedThumbnail: null,
          })
          result.mediaRows++

          const content = messageContent.get(message.id) ?? cloneJson(message.content)
          messageContent.set(message.id, content)
          if (rewriteStoredPart(content, row.partIndex, {
            ...raw,
            id: raw?.platformMediaId ?? row.platformMediaId,
            locator: cleanedLocator,
            ...(removePreview ? { preview: undefined } : {}),
            strippedThumbnail: undefined,
          })) changedInBatch.add(message.id)
        }
        for (const messageId of changedInBatch) {
          await transaction.set('mtproto_im_message', { id: messageId }, {
            content: messageContent.get(messageId)!, updatedAt: new Date(),
          })
          changedMessageIds.add(messageId)
        }
      })
      if (mediaRows.length < MIGRATION_BATCH_SIZE) break
    }
  }
  result.messages = changedMessageIds.size

  // No runtime path consumes these former transform tables anymore. Purge
  // every row, including orphaned assets no longer referenced by messages.
  const previewRows = await database.get('mtproto_qqnt_media_preview', {})
  result.previewRows = previewRows.length
  if (previewRows.length) await database.remove('mtproto_qqnt_media_preview', {})
  const cacheRows = await database.get('mtproto_qqnt_media_cache', {})
  result.cacheRows = cacheRows.length
  for (const row of cacheRows) cachedPaths.add(row.path)
  if (cacheRows.length) await database.remove('mtproto_qqnt_media_cache', {})
  const animationRows = await database.get('mtproto_qqnt_media_animation', {})
  result.animationRows = animationRows.length
  if (animationRows.length) await database.remove('mtproto_qqnt_media_animation', {})

  const root = resolve(mediaCachePath)
  for (const path of cachedPaths) {
    const target = resolve(path)
    const child = relative(root, target)
    if (!child || child.startsWith('..') || resolve(root, child) !== target) continue
    await rm(target, { force: true }).then(() => result.files++).catch(() => undefined)
  }
  await database.upsert('mtproto_qqnt_migration', [{
    id: RAW_MESSAGE_MEDIA_MIGRATION,
    completedAt: new Date(),
  }])
  return result
}

function isLegacyLocalProjection(
  row: { platformMediaId: string, preview: unknown, strippedThumbnail: unknown },
  locator: QQMediaLocator,
): boolean {
  const previewLocator = row.preview && typeof row.preview === 'object' && 'locator' in row.preview
    ? qqLocator(row.preview.locator as JsonValue)
    : undefined
  return Boolean(
    hasLegacyLocalMarker(locator)
    || previewLocator && hasLegacyLocalMarker(previewLocator)
    || row.strippedThumbnail || row.platformMediaId.endsWith(':webm-v1'),
  )
}

function hasLegacyLocalMarker(locator: QQMediaLocator): boolean {
  return Boolean(locator.cachedPath || locator.previewKey || locator.deferred)
}

function isTranscodedRow(
  row: { platformMediaId: string, mimeType: string | null },
  locator: QQMediaLocator,
): boolean {
  return row.platformMediaId.endsWith(':webm-v1')
    || Boolean(locator.cachedPath && row.mimeType === 'video/webm' && locator.kind === 'image')
}

function rawMediaValues(
  row: { platformMediaId: string, name: string | null, size: number | null },
  locator: QQMediaLocator,
) {
  const name = locator.fileName || row.name || undefined
  const declaredSize = Number(locator.fileSize)
  return {
    platformMediaId: row.platformMediaId.replace(/:webm-v1$/, ''),
    kind: locator.kind === 'image' ? 'image' : 'file',
    name: name ?? null,
    mimeType: mimeTypeFromName(name, locator.kind === 'image' ? 'image' : 'file'),
    size: Number.isSafeInteger(declaredSize) && declaredSize >= 0 ? declaredSize : row.size,
  } as const
}

function mimeTypeFromName(name: string | undefined, kind: 'image' | 'file'): string {
  const extension = extname(name ?? '').toLowerCase()
  if (extension === '.gif') return 'image/gif'
  if (extension === '.apng') return 'image/apng'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return kind === 'image' ? 'image/png' : 'application/octet-stream'
}

function rawLocator(locator: QQMediaLocator): QQMediaLocator {
  const {
    cachedPath: _cachedPath, previewKey: _previewKey, deferred: _deferred, ...raw
  } = locator
  return raw
}

function qqLocator(value: JsonValue): QQMediaLocator | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  if (typeof value.messageId !== 'string' || typeof value.elementId !== 'string') return
  return value as unknown as QQMediaLocator
}

function rewriteStoredPart(
  content: unknown,
  partIndex: number,
  media: Record<string, unknown>,
): boolean {
  if (!content || typeof content !== 'object' || !('parts' in content)) return false
  const parts = (content as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return false
  const part = parts[partIndex]
  if (!part || typeof part !== 'object' || !('media' in part)) return false
  const current = (part as { media?: unknown }).media
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false
  const next = { ...current, ...media }
  if ('preview' in media && media.preview === undefined) delete next.preview
  if ('strippedThumbnail' in media && media.strippedThumbnail === undefined) delete next.strippedThumbnail
  ;(part as { media: unknown }).media = next
  return true
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}
