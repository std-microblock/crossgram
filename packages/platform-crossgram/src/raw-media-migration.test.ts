import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { MessageStore, type PlatformSession } from '@mtproto-relay/bridge'
import { defineModels } from '../../bridge/src/models.js'
import { defineLegacyQQMediaSchema } from './legacy-media-schema.js'
import { migrateLegacyQQMessageMedia } from './raw-media-migration.js'

const temporaryDirectories: string[] = []
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('legacy QQ message media migration', () => {
  it('restores cached WebM/preview rows to the original direct-download GIF locator', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    defineLegacyQQMediaSchema(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const session: PlatformSession = {
      platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
    }
    await ctx.database.create('mtproto_platform_session', {
      id: session.platformSessionId, platformId: session.platformId, userId: session.userId,
      credentials: {}, metadata: {}, active: true, createdAt: new Date(),
    })
    const store = new MessageStore(ctx.database)
    const ingested = await store.ingest(session, { id: 'group', kind: 'group', title: 'Group' }, {
      id: 'message', conversationId: 'group', senderId: 'alice', timestamp: 1,
      content: { parts: [{ type: 'media', media: {
        id: 'gif:original-v1', kind: 'image', name: 'animation.gif', mimeType: 'image/gif',
        size: 200, width: 16, height: 12,
        locator: locator({ fileName: 'animation.gif', fileSize: '200' }),
      } }] },
    })
    const [row] = await ctx.database.get('mtproto_im_media', { messageId: ingested.message.id })
    const cacheRoot = await mkdtemp(join(tmpdir(), 'qq-legacy-media-'))
    temporaryDirectories.push(cacheRoot)
    const cachedPath = join(cacheRoot, 'legacy.webm')
    await writeFile(cachedPath, Uint8Array.from([1, 2, 3]))
    await ctx.database.set('mtproto_im_media', { id: row!.id }, {
      platformMediaId: 'gif:original-v1:webm-v1', kind: 'file', name: 'animation.webm',
      mimeType: 'video/webm', size: 3,
      locator: { ...locator({ fileName: 'animation.gif', fileSize: '200' }), cachedPath },
      preview: {
        mimeType: 'image/webp', size: 2, width: 8, height: 6,
        locator: { ...locator(), previewKey: 'preview-key' },
      },
      strippedThumbnail: Uint8Array.from([4, 5]).buffer,
    })
    const [message] = await ctx.database.get('mtproto_im_message', { id: ingested.message.id })
    const staleContent = structuredClone(message!.content) as any
    Object.assign(staleContent.parts[0].media, {
      id: 'gif:original-v1:webm-v1', kind: 'file', name: 'animation.webm', mimeType: 'video/webm',
      size: 3, locator: { ...locator(), cachedPath }, preview: { locator: { previewKey: 'preview-key' } },
    })
    await ctx.database.set('mtproto_im_message', { id: message!.id }, { content: staleContent })
    await ctx.database.create('mtproto_qqnt_media_cache', {
      key: 'cache-key', path: cachedPath, mimeType: 'video/webm', size: 3,
      width: 16, height: 12, updatedAt: new Date(),
    })
    await ctx.database.create('mtproto_qqnt_media_preview', {
      key: 'preview-key', bytes: Uint8Array.from([6]).buffer, strippedBytes: null, outlineBytes: null,
      mimeType: 'image/webp', size: 1, width: 8, height: 6, updatedAt: new Date(),
    })
    await ctx.database.create('mtproto_qqnt_media_animation', {
      key: 'animation-key', animated: true, updatedAt: new Date(),
    })
    const nativePreview = {
      mimeType: 'image/jpeg', size: 80, width: 1280, height: 579,
      locator: locator({ fileName: 'native_720.jpg', fileSize: '80', filePath: '/qq/Thumb/native_720.jpg' }),
    }
    const nativeIngested = await store.ingest(session, { id: 'group', kind: 'group', title: 'Group' }, {
      id: 'native-preview-message', conversationId: 'group', senderId: 'alice', timestamp: 2,
      content: { parts: [{ type: 'media', media: {
        id: 'native-photo:original-v1', kind: 'image', name: 'native.jpg', mimeType: 'image/jpeg',
        size: 320_332, width: 2832, height: 1280, preview: nativePreview,
        strippedThumbnail: Uint8Array.from([1, 18, 40, 1]),
        locator: locator({ fileName: 'native.jpg', fileSize: '320332' }),
      } }] },
    })
    const [nativeRow] = await ctx.database.get('mtproto_im_media', { messageId: nativeIngested.message.id })

    const getSpy = vi.spyOn(ctx.database, 'get')
    await expect(migrateLegacyQQMessageMedia(ctx.database, 'qqnt', cacheRoot)).resolves.toEqual({
      mediaRows: 2, messages: 2, previewRows: 1, cacheRows: 1, animationRows: 1, files: 1,
    })
    const messageQueries = getSpy.mock.calls
      .filter(([table]) => table === 'mtproto_im_message')
      .map(([, query]) => query as Record<string, unknown>)
    expect(messageQueries).not.toHaveLength(0)
    expect(messageQueries.every((query) => 'id' in query && !('platformSessionId' in query))).toBe(true)
    const [migrated] = await ctx.database.get('mtproto_im_media', { id: row!.id })
    expect(migrated).toMatchObject({
      platformMediaId: 'gif:original-v1', kind: 'image', name: 'animation.gif', mimeType: 'image/gif',
      size: 200, locator: expect.not.objectContaining({ cachedPath: expect.anything(), previewKey: expect.anything() }),
      preview: null, strippedThumbnail: null,
    })
    const [migratedMessage] = await ctx.database.get('mtproto_im_message', { id: message!.id })
    expect(migratedMessage!.content).toMatchObject({ parts: [{ media: {
      id: 'gif:original-v1', kind: 'image', name: 'animation.gif', mimeType: 'image/gif', size: 200,
      locator: expect.not.objectContaining({ cachedPath: expect.anything(), previewKey: expect.anything() }),
    } }] })
    const [nativeMigrated] = await ctx.database.get('mtproto_im_media', { id: nativeRow!.id })
    expect(nativeMigrated).toMatchObject({
      preview: nativePreview,
      strippedThumbnail: null,
    })
    const [nativeMessage] = await ctx.database.get('mtproto_im_message', { id: nativeIngested.message.id })
    expect(nativeMessage!.content).toMatchObject({
      parts: [{ media: { preview: nativePreview } }],
    })
    await expect(ctx.database.get('mtproto_qqnt_media_preview', {})).resolves.toEqual([])
    await expect(ctx.database.get('mtproto_qqnt_media_cache', {})).resolves.toEqual([])
    await expect(ctx.database.get('mtproto_qqnt_media_animation', {})).resolves.toEqual([])
    await expect(readFile(cachedPath)).rejects.toThrow()
    await expect(ctx.database.get('mtproto_qqnt_migration', { id: 'raw-message-media-v1' }))
      .resolves.toHaveLength(1)
    await expect(migrateLegacyQQMessageMedia(ctx.database, 'qqnt', cacheRoot)).resolves.toEqual({
      mediaRows: 0, messages: 0, previewRows: 0, cacheRows: 0, animationRows: 0, files: 0,
    })
  })
})

function locator(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'message', elementId: 'element', chatType: 2 as const, peerUid: 'group',
    kind: 'image' as const, fileName: 'animation.gif', fileUuid: 'uuid', ...overrides,
  }
}
