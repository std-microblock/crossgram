import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { mkdtemp, readdir, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineModels } from './models.js'
import { ImageStorage } from './image-storage.js'
import { QQNTClient } from '../../platform-crossgram/src/client.js'
import type { IMConversation, IMMedia, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = { platformSessionId: 'account-one', platformId: 'test', userId: 'self', credentials: {}, metadata: {} }
const group: IMConversation = { id: 'group/../one', kind: 'group', title: '群一' }
const media: IMMedia = { id: '../../image', kind: 'image', size: 99999, mimeType: 'image/png', locator: { key: 'image' } }
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

function message(id = 'one', timestamp = Date.parse('2026-10-15T00:00:00Z') / 1000, parts = [media]): IMMessage {
  return { id, conversationId: group.id, senderId: 'sender', timestamp,
    content: { parts: [{ type: 'text', text: '图文' }, ...parts.map(item => ({ type: 'media' as const, media: item }))] } }
}

async function setup(enabled = true) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const path = await mkdtemp(join(tmpdir(), 'crossgram-images-'))
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    await rm(path, { recursive: true, force: true })
  })
  const errors = vi.fn()
  const storage = new ImageStorage(ctx.database, { enabled, path }, errors)
  disposals.push(() => storage.close())
  const download = vi.fn(async function* (_session: PlatformSession, _media: IMMedia, _options?: { signal?: AbortSignal }) {
    yield bytes.subarray(0, 3)
    yield bytes.subarray(3)
  })
  const platform = { downloadMedia: download } as unknown as IMPlatform
  return { ctx, path, storage, errors, platform, download }
}

async function ready(storage: ImageStorage, count = 1) {
  await expect.poll(async () => (await storage.query({})).count).toBe(count)
}

describe('ImageStorage', () => {
  it('默认关闭，不保存新图', async () => {
    const { ctx, path, platform } = await setup()
    const storage = new ImageStorage(ctx.database, { path })
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    expect(storage.enabled).toBe(false)
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 0, totalGroups: 0 })
    expect(await readdir(path)).toEqual([])
    await storage.close()
  })

  it('主动保存图文多图、忽略附件，按实际字节统计并保留账号和UTC日期隔离', async () => {
    const { storage, platform, path, download } = await setup()
    await storage.activate(session, platform)
    const other = { ...session, platformSessionId: 'account-two' }
    await storage.activate(other, platform)
    const yesterday = Date.parse('2026-10-14T23:59:59Z') / 1000
    await storage.enqueue(session, group, message('one', yesterday, [media, { ...media, id: 'second' }, { ...media, id: 'file', kind: 'file' }]), 1)
    await storage.enqueue(other, { ...group, id: 'private', kind: 'direct', title: '私聊' }, message(), 2)
    await ready(storage, 3)
    expect(download).toHaveBeenCalledTimes(3)
    expect(await storage.query({ platformSessionId: session.platformSessionId, startDate: '2026-10-14', endDate: '2026-10-14' }))
      .toMatchObject({ count: 2, bytes: bytes.length * 2, totalGroups: 1, pendingCount: 0,
        groups: [{ conversationId: group.id, conversationTitle: group.title, count: 2, bytes: bytes.length * 2 }] })
    expect(await storage.query({ groupBy: 'date', pageSize: 1, page: 2 }))
      .toMatchObject({ count: 3, bytes: bytes.length * 3, totalGroups: 2, groups: [{ date: '2026-10-15', platformSessionId: other.platformSessionId }] })
    expect((await readdir(path)).every(name => /^[a-f0-9]{64}$/.test(name))).toBe(true)
    for (const account of await readdir(path)) {
      expect((await stat(join(path, account))).mode & 0o777).toBe(0o700)
      for (const file of await readdir(join(path, account))) {
        expect((await stat(join(path, account, file))).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('重复事件幂等，关闭开关和重建实例后仍能读取原生范围', async () => {
    const { ctx, storage, path, platform, download } = await setup()
    await storage.activate(session, platform)
    await Promise.all(Array.from({ length: 5 }, () => storage.enqueue(session, group, message(), 1)))
    await ready(storage)
    await storage.close()
    const disabled = new ImageStorage(ctx.database, { path })
    expect(await disabled.read(session, 1, media, 2, 3)).toEqual(bytes.subarray(2, 5))
    expect(await disabled.read(session, 1, media, 100, 3)).toEqual(new Uint8Array())
    expect(await disabled.read({ ...session, platformSessionId: 'other' }, 1, media, 0, 3)).toBeUndefined()
    expect(await disabled.has(session, 1, media)).toBe(true)
    expect(download).toHaveBeenCalledTimes(1)
    await disabled.close()
  })

  it('迟到的独立预览可补存，统计不重复计图，主动删除后原图和预览均不能复活', async () => {
    const { storage, platform, download, ctx } = await setup()
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await ready(storage)
    const withPreview = { ...media, preview: { mimeType: 'image/webp', size: 999, width: 100, height: 50, locator: { key: 'preview' } } }
    await storage.enqueue(session, group, message('one', undefined, [withPreview]), 1)
    await expect.poll(async () => (await storage.query({})).pendingCount).toBe(0)
    expect(await storage.query({})).toMatchObject({ count: 1, bytes: bytes.length * 2 })
    expect(await storage.read(session, 1, withPreview, 0, 100, true)).toEqual(bytes)
    expect(await storage.delete({})).toEqual({ count: 1, bytes: bytes.length * 2 })
    await storage.enqueue(session, group, message('one', undefined, [withPreview]), 1)
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 0 })
    expect(await ctx.database.get('mtproto_image_storage', { state: 'deleted' })).toHaveLength(2)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('下载失败不留半文件，重启后恢复待下载的新图片', async () => {
    const { ctx, storage, path, platform, download, errors } = await setup()
    download.mockImplementationOnce(async function* () { yield bytes; throw new Error('过期') })
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await expect.poll(() => errors.mock.calls.length).toBeGreaterThan(0)
    await storage.close()
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 1 })
    const accounts = await readdir(path)
    expect(await readdir(join(path, accounts[0]))).toEqual([])
    const restored = new ImageStorage(ctx.database, { enabled: true, path })
    disposals.push(() => restored.close())
    await restored.activate(session, platform)
    await ready(restored)
    expect(await restored.read(session, 1, media, 0, 100)).toEqual(bytes)
  })

  it('队列并发有界且无需客户端触发，删除待下载项不能被旧任务或重复推送恢复', async () => {
    const { storage, platform, download, ctx } = await setup()
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    download.mockImplementation(async function* () {
      active++
      maximum = Math.max(maximum, active)
      try { await new Promise<void>(resolve => releases.push(resolve)); yield bytes } finally { active-- }
    })
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message('many', undefined, Array.from({ length: 5 }, (_, i) => ({ ...media, id: String(i) }))), 1)
    await expect.poll(() => releases.length).toBe(2)
    const result = await storage.delete({ platformSessionId: session.platformSessionId })
    expect(result).toEqual({ count: 0, bytes: 0 })
    for (const release of releases) release()
    await storage.close()
    expect(maximum).toBe(2)
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 0 })
    expect(await ctx.database.get('mtproto_image_storage', { state: 'deleted' })).toHaveLength(5)
  })

  it('停止时中断流式下载、不留半文件，待下载状态可在重启后恢复', async () => {
    const { ctx, storage, platform, path, download } = await setup()
    download.mockImplementationOnce(async function* (_session, _media, options) {
      yield bytes.subarray(0, 2)
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve()
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('已中断')
    })
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await expect.poll(() => download.mock.calls.length).toBe(1)
    await storage.close()
    expect(await storage.query({})).toMatchObject({ pendingCount: 1, count: 0, bytes: 0 })
    for (const account of await readdir(path)) expect(await readdir(join(path, account))).toEqual([])
    const restored = new ImageStorage(ctx.database, { enabled: true, path })
    disposals.push(() => restored.close())
    await restored.activate(session, platform)
    await ready(restored)
  })

  it('账号停用取消进行中的下载，重新激活后恢复而不记录正常取消为错误', async () => {
    const { storage, platform, download, errors } = await setup()
    let signal: AbortSignal | undefined
    download.mockImplementationOnce(async function* (_session, _media, options) {
      signal = options?.signal
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('已取消')
    })
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await expect.poll(() => signal !== undefined).toBe(true)
    storage.deactivate(session)
    expect(signal?.aborted).toBe(true)
    await storage.activate(session, platform)
    await ready(storage)
    expect(errors).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('超时终止下载且不计入已保存容量', async () => {
    const { storage, platform, download, errors } = await setup()
    download.mockImplementationOnce(async function* (_session, _media, options) {
      yield bytes.subarray(0, 2)
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve()
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('下载超时')
    })
    await storage.activate(session, platform)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await storage.enqueue(session, group, message(), 1)
      await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(120001)
    } finally {
      vi.useRealTimers()
    }
    await expect.poll(() => errors.mock.calls.length).toBeGreaterThan(0)
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 1 })
  })

  it('真实QQ直链查询永挂时，归档超时释放两槽并可关闭，迟到失败不产生未处理拒绝', async () => {
    const { ctx, storage, path, platform } = await setup()
    const lookup = Promise.withResolvers<Response>()
    const fetch = vi.fn(() => lookup.promise)
    const qq = new QQNTClient({ fetch })
    const qqPlatform = { downloadMedia: (_session: PlatformSession, item: IMMedia, options?: { signal?: AbortSignal }) =>
      qq.downloadFile(item.locator as Parameters<QQNTClient['downloadFile']>[0], options) } as unknown as IMPlatform
    const images = Array.from({ length: 3 }, (_, index) => ({ ...media, id: `qq-${index}`, locator: {
      messageId: 'msg', chatType: 2, peerUid: 'g', fileUuid: `distinct-${index}`,
    } }))
    await storage.activate(session, qqPlatform)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await storage.enqueue(session, group, message('qq-stalled', undefined, images), 1)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(120001)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
      await vi.advanceTimersByTimeAsync(120001)
    } finally {
      vi.useRealTimers()
    }
    try {
      await expect.poll(async () => (await ctx.database.get('mtproto_image_storage', { state: 'failed' })).length).toBe(3)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([storage.close(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('永挂QQ查询阻塞了归档关闭')), 1000)
        })])
      } finally {
        clearTimeout(timer)
      }
      for (const account of await readdir(path)) expect(await readdir(join(path, account))).toEqual([])
      expect(await ctx.database.get('mtproto_image_storage', { state: 'pending' })).toHaveLength(0)
    } finally {
      lookup.reject(new Error('迟到的QQ直链查询失败'))
      await new Promise(resolve => setImmediate(resolve))
    }
    const restored = new ImageStorage(ctx.database, { enabled: true, path })
    disposals.push(() => restored.close())
    await restored.activate(session, platform)
    await ready(restored, 3)
  })

  it('按会话或日期删除，只清除指定副本并保留墓碑', async () => {
    const { storage, platform, download } = await setup()
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await storage.enqueue(session, { ...group, id: 'other' }, message('two'), 2)
    await ready(storage, 2)
    expect(await storage.delete({ conversationId: group.id, startDate: '2026-10-15', endDate: '2026-10-15' }))
      .toEqual({ count: 1, bytes: bytes.length })
    await storage.enqueue(session, group, message(), 1)
    expect(await storage.query({})).toMatchObject({ count: 1, bytes: bytes.length })
    expect(await storage.read(session, 1, media, 0, 10)).toBeUndefined()
    expect(await storage.read(session, 2, media, 0, 10)).toEqual(bytes)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('文件缺失不返回成功；删除磁盘错误保留可重试状态和容量', async () => {
    const { ctx, storage, path, platform } = await setup()
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await ready(storage)
    const [account] = await readdir(path)
    const [file] = await readdir(join(path, account))
    const location = join(path, account, file)
    await rm(location)
    await mkdir(location)
    await writeFile(join(location, 'blocked'), 'x')
    await expect(storage.delete({})).rejects.toThrow()
    expect(await ctx.database.get('mtproto_image_storage', {})).toMatchObject([{ state: 'deleting', bytes: bytes.length }])
    await rm(location, { recursive: true })
    expect(await storage.delete({})).toEqual({ count: 1, bytes: bytes.length })
    await storage.enqueue(session, group, message(), 2)
    await ready(storage)
    const [remaining] = await readdir(join(path, account))
    await rm(join(path, account, remaining))
    expect(await storage.read(session, 2, media, 0, 10)).toBeUndefined()
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 1 })
  })

  it('未启动下载的任务持久化，重启后按有界并发排空队列', async () => {
    const { ctx, storage, path, platform, download } = await setup()
    await storage.enqueue(session, group, message('queued', undefined, Array.from({ length: 7 }, (_, i) => ({ ...media, id: String(i) }))), 1)
    expect(await storage.query({})).toMatchObject({ pendingCount: 7, count: 0 })
    await storage.close()
    const restored = new ImageStorage(ctx.database, { enabled: true, path })
    disposals.push(() => restored.close())
    await restored.activate(session, platform)
    await ready(restored, 7)
    expect(await restored.query({})).toMatchObject({ count: 7, pendingCount: 0, bytes: bytes.length * 7 })
    expect(download).toHaveBeenCalledTimes(7)
  })

  it('原子改名后尚未提交元数据的完整文件可恢复，不再依赖上游', async () => {
    const { ctx, storage, path, platform, download } = await setup()
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await ready(storage)
    await storage.close()
    await ctx.database.set('mtproto_image_storage', {}, { state: 'pending', bytes: 0 })
    download.mockImplementation(async function* () { throw new Error('上游已过期') })
    const restored = new ImageStorage(ctx.database, { enabled: true, path })
    disposals.push(() => restored.close())
    await restored.activate(session, platform)
    await ready(restored)
    expect(await restored.read(session, 1, media, 0, 100)).toEqual(bytes)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('空下载不记成功，磁盘写入失败不会留下成功记录', async () => {
    const { ctx, storage, platform, download, errors, path } = await setup()
    download.mockImplementationOnce(async function* () {})
    await storage.activate(session, platform)
    await storage.enqueue(session, group, message(), 1)
    await expect.poll(() => errors.mock.calls.length).toBe(1)
    expect(await storage.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 1 })
    await storage.close()
    await rm(path, { recursive: true })
    await writeFile(path, '目录不可用')
    const blocked = new ImageStorage(ctx.database, { enabled: true, path }, errors)
    disposals.push(() => blocked.close())
    await blocked.activate(session, platform)
    await expect.poll(() => errors.mock.calls.length).toBeGreaterThan(1)
    expect(await blocked.query({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 1 })
  })

  it('校验日期、分页、筛选、路径和读取范围', async () => {
    const { ctx, storage } = await setup()
    for (const query of [null, { startDate: '2026-02-30' }, { endDate: 'x' }, { startDate: '2026-10-16', endDate: '2026-10-15' }, { page: 0 }, { pageSize: 1000 }, { conversationId: {} }, { platformSessionId: '' }, { groupBy: 'all' }]) {
      await expect(storage.query(query as any)).rejects.toThrow()
    }
    expect(() => new ImageStorage(ctx.database, { path: '' })).toThrow()
    await expect(storage.read(session, 1, media, -1, 2)).rejects.toThrow()
  })
})
