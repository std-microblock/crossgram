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
  const sessions = await database.get('mtproto_platform_session', { platformId })
  const sessionIds = sessions.map((session) => session.id)
  if (!sessionIds.length) {
    result.animationRows = (await database.get('mtproto_qqnt_media_animation', {})).length
    if (result.animationRows) await database.remove('mtproto_qqnt_media_animation', {})
    return result
  }
  const messages = await database.get('mtproto_im_message', {
    platformSessionId: { $in: sessionIds },
  })
  const messageIds = messages.map((message) => message.id)
  if (!messageIds.length) {
    result.animationRows = (await database.get('mtproto_qqnt_media_animation', {})).length
    if (result.animationRows) await database.remove('mtproto_qqnt_media_animation', {})
    return result
  }

  const mediaRows = await database.get('mtproto_im_media', { messageId: { $in: messageIds } })
  const previewKeys = new Set<string>()
  const cachedPaths = new Set<string>()
  const messageContent = new Map(messages.map((message) => [message.id, cloneJson(message.content)]))
  const changedMessages = new Set<number>()

  await database.withTransaction(async (transaction) => {
    for (const row of mediaRows) {
      const locator = qqLocator(row.locator)
      if (!locator || !isLegacyLocalProjection(row, locator)) continue
      if (locator.previewKey) previewKeys.add(locator.previewKey)
      const previewLocator = row.preview && qqLocator(row.preview.locator)
      if (previewLocator?.previewKey) previewKeys.add(previewLocator.previewKey)
      if (locator.cachedPath) cachedPaths.add(locator.cachedPath)
      const cleanedLocator = rawLocator(locator)
      const transformed = isTranscodedRow(row, locator)
      const raw = transformed ? rawMediaValues(row, cleanedLocator) : undefined
      await transaction.set('mtproto_im_media', { id: row.id }, {
        ...raw,
        locator: cleanedLocator as unknown as JsonValue,
        preview: null,
        strippedThumbnail: null,
      })
      result.mediaRows++

      const content = messageContent.get(row.messageId)
      if (rewriteStoredPart(content, row.partIndex, {
        ...raw,
        id: raw?.platformMediaId ?? row.platformMediaId,
        locator: cleanedLocator,
        preview: undefined,
        strippedThumbnail: undefined,
      })) changedMessages.add(row.messageId)
    }
    for (const messageId of changedMessages) {
      await transaction.set('mtproto_im_message', { id: messageId }, {
        content: messageContent.get(messageId)!, updatedAt: new Date(),
      })
    }
    // No runtime path consumes these former transform tables anymore. Purge
    // every row, including orphaned assets no longer referenced by messages.
    const previewRows = await transaction.get('mtproto_qqnt_media_preview', {})
    result.previewRows = previewRows.length
    if (previewRows.length) await transaction.remove('mtproto_qqnt_media_preview', {})
    const cacheRows = await transaction.get('mtproto_qqnt_media_cache', {})
    result.cacheRows = cacheRows.length
    for (const row of cacheRows) cachedPaths.add(row.path)
    if (cacheRows.length) await transaction.remove('mtproto_qqnt_media_cache', {})
    const animationRows = await transaction.get('mtproto_qqnt_media_animation', {})
    result.animationRows = animationRows.length
    if (animationRows.length) await transaction.remove('mtproto_qqnt_media_animation', {})
  })
  result.messages = changedMessages.size

  const root = resolve(mediaCachePath)
  for (const path of cachedPaths) {
    const target = resolve(path)
    const child = relative(root, target)
    if (!child || child.startsWith('..') || resolve(root, child) !== target) continue
    await rm(target, { force: true }).then(() => result.files++).catch(() => undefined)
  }
  return result
}

function isLegacyLocalProjection(
  row: { platformMediaId: string, preview: unknown, strippedThumbnail: unknown },
  locator: QQMediaLocator,
): boolean {
  return Boolean(
    locator.cachedPath || locator.previewKey || locator.deferred
    || row.preview || row.strippedThumbnail || row.platformMediaId.endsWith(':webm-v1'),
  )
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
    kind: locator.kind,
    name: name ?? null,
    mimeType: mimeTypeFromName(name, locator.kind),
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
  delete next.preview
  delete next.strippedThumbnail
  ;(part as { media: unknown }).media = next
  return true
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}
