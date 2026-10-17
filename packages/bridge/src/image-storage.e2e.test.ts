import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import { ImageStorage } from './image-storage.js'
import { DialogRpc } from './dialogs.js'
import { PlatformRegistry, PlatformSubscriptionManager } from './platform-manager.js'
import type { IMConversation, IMEvent, IMMedia, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = { platformId: 'images', platformSessionId: 'image-account', userId: 'self', credentials: {}, metadata: {} }
const conversation: IMConversation = { id: 'group', kind: 'group', title: '图片群' }

describe('图片存储接收与下载 e2e', () => {
  it('没有客户端也主动归档；媒体行重建、源过期和关闭存储后仍可分块读取，账号不能越权', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    const path = await mkdtemp(join(tmpdir(), 'crossgram-image-e2e-'))
    const data = new Uint8Array(Array.from({ length: 14000 }, (_, index) => index % 251))
    const preview = new Uint8Array(Array.from({ length: 200 }, (_, index) => (index * 7) % 251))
    let receive!: (event: IMEvent) => void | Promise<void>
    let expired = false
    const download = vi.fn(async function* (_session: PlatformSession, media: IMMedia) {
      if (expired) throw new Error('QQ 图片源已过期')
      const bytes = media.id.endsWith(':preview') ? preview : data
      yield bytes.subarray(0, 5000)
      yield bytes.subarray(5000)
    })
    const resolveMediaUrl = vi.fn(async () => ({ url: 'https://example.com/expired', expiresAt: Date.now() + 60000, supportsRange: true }))
    const platform: IMPlatform = {
      capabilities: {
        history: false,
        send: { text: true, images: true, files: false, mixed: true, maxTextLength: 4096, maxMedia: 10 },
        conversations: { groups: true, channels: false, subchannels: false },
      },
      async subscribe(_session, handler) { receive = handler; return () => {} },
      async sendMessage() { throw new Error('此测试不发送消息') },
      downloadMedia: download,
      resolveMediaUrl,
    }
    const store = new MessageStore(ctx.database)
    const errors = vi.fn()
    const storage = new ImageStorage(ctx.database, { enabled: true, path }, errors)
    let restored: ImageStorage | undefined
    ctx.on('im-platform/event-committed', async (account, committed) => {
      if (committed.event.type !== 'message' && committed.event.type !== 'message-edit') return
      if (!('result' in committed) || !('message' in committed.result)) return
      await storage.enqueue(account, committed.event.conversation, committed.event.message, Number(committed.result.message.id))
    })
    const subscriptions = new PlatformSubscriptionManager(ctx.database, new PlatformRegistry([['images', platform]]), store, undefined, undefined, undefined, ctx)
    try {
      await storage.activate(session, platform)
      await subscriptions.ensure(session)
      const message: IMMessage = {
        id: 'message-one', conversationId: conversation.id, senderId: 'alice', timestamp: 1792022400,
        content: { parts: [{ type: 'text', text: '第一张' }, { type: 'media', media: {
          id: 'original-media', kind: 'image', size: data.length, mimeType: 'image/png', width: 2000, height: 1000,
          locator: { path: '../../not-a-local-file' },
          preview: { mimeType: 'image/webp', size: preview.length, width: 100, height: 50, locator: { key: 'preview' } },
        } }, { type: 'text', text: '第二张' }, { type: 'media', media: {
          id: 'second-media', kind: 'image', size: data.length, locator: {},
        } }] },
      }
      await receive({ type: 'message', conversation, message })
      await expect.poll(async () => {
        const result = await storage.query({})
        return [result.count, result.pendingCount]
      }).toEqual([2, 0])
      expect(await storage.query({})).toMatchObject({ count: 2, bytes: data.length * 2 + preview.length })
      expect(download).toHaveBeenCalledTimes(3)
      expired = true
      const [storedMessage] = await ctx.database.get('mtproto_im_message', { platformSessionId: session.platformSessionId })
      const before = await ctx.database.get('mtproto_im_media', { messageId: storedMessage.id })
      await ctx.database.remove('mtproto_im_media', { messageId: storedMessage.id })
      await store.ingest(session, conversation, {
        ...message, content: { parts: [...message.content.parts, { type: 'text', text: '更新文字' }] },
      })
      const after = await ctx.database.get('mtproto_im_media', { messageId: storedMessage.id })
      expect(after[0].id).not.toBe(before[0].id)
      await storage.close()
      restored = new ImageStorage(ctx.database, { enabled: false, path }, errors)
      const rpc = new DialogRpc(
        platform, session, new MessageStore(ctx.database), undefined, undefined, 1,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, restored,
      )
      const id = Long.fromNumber(after[0].id)
      const location = { _: 'inputPhotoFileLocation' as const, id, accessHash: id,
        fileReference: new TextEncoder().encode(`bridge-media:${id.toString()}`), thumbSize: 'x' }
      await expect(rpc.getFileUrl(location)).rejects.toThrow('MEDIA_DIRECT_URL_UNAVAILABLE')
      const thumb = { ...location, thumbSize: 'm' }
      await expect(rpc.getFileUrl(thumb)).rejects.toThrow('MEDIA_DIRECT_URL_UNAVAILABLE')
      const thumbnail = await rpc.getFile({ _: 'upload.getFile', location: thumb, offset: 0, limit: 4096 })
      expect(thumbnail).toMatchObject({ _: 'upload.file', type: { _: 'storage.fileWebp' }, bytes: preview })
      const documentThumb = await rpc.getFile({ _: 'upload.getFile',
        location: { ...thumb, _: 'inputDocumentFileLocation' }, offset: 0, limit: 4096,
      })
      expect(documentThumb).toMatchObject({ _: 'upload.file', type: { _: 'storage.fileWebp' }, bytes: preview })
      const previewTail = await rpc.getFile({ _: 'upload.getFile', location: thumb, offset: 180, limit: 4096 })
      expect(previewTail).toMatchObject({ _: 'upload.file', bytes: preview.subarray(180) })
      expect(resolveMediaUrl).not.toHaveBeenCalled()
      const chunks: Uint8Array[] = []
      for (const offset of [0, 4096, 8192, 12288]) {
        const file = await rpc.getFile({ _: 'upload.getFile', location, offset, limit: 4096 })
        if (file._ !== 'upload.file') throw new Error('应返回本地图片')
        expect(file.type).toEqual({ _: 'storage.filePng' })
        chunks.push(file.bytes)
      }
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(data))
      expect(download).toHaveBeenCalledTimes(3)
      expect(await restored.read({ ...session, platformSessionId: 'unauthorized' }, storedMessage.id, message.content.parts[1].type === 'media' ? message.content.parts[1].media : {} as never, 0, 100)).toBeUndefined()
      expect(await restored.delete({ conversationId: conversation.id })).toEqual({ count: 2, bytes: data.length * 2 + preview.length })
      expect(await ctx.database.get('mtproto_image_storage', { state: 'deleted' })).toHaveLength(3)
      await expect(rpc.getFile({ _: 'upload.getFile', location: thumb, offset: 0, limit: 4096 })).rejects.toThrow()
      await expect(rpc.getFile({ _: 'upload.getFile', location, offset: 0, limit: 4096 })).rejects.toThrow()
      expect(errors).not.toHaveBeenCalled()
    } finally {
      await subscriptions.stop()
      await restored?.close()
      await storage.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(path, { recursive: true, force: true })
    }
  })
})
