import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Long from 'long'
import SSO from '@cordisjs/plugin-sso'
import type { tl } from '@mtcute/core'
import { __tlWriterMap, addPublicKey } from '@mtcute/core/utils.js'
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { generateWriterCodeForTlEntries, parseTlToEntries } from '@mtcute/tl-utils'
import { CROSSGRAM_API_SCHEMA, generateRsaKeyPair } from '@mtproto-relay/mtproto'
import * as bridge from '@mtproto-relay/bridge'
import type { ImageStorageDashboardData } from '../../bridge/src/dashboard-types.js'
import { makePlatformPlugin, startApp, waitForPlatformLogin, waitForWebuiRoute } from './harness.js'

// mtcute 将 Long 指纹转为未补零的十六进制查找公钥，测试密钥避开前导零指纹。
let rsaKey = generateRsaKeyPair()
while (rsaKey.fingerprint.startsWith('0')) rsaKey = generateRsaKeyPair()

const PLATFORM_ID = 'image-storage-e2e'
const GROUP: bridge.IMConversation = { id: 'group-a', kind: 'group', title: '归档群 A' }
const OTHER_GROUP: bridge.IMConversation = { id: 'group-b', kind: 'group', title: '归档群 B' }
const DAY = '2026-10-14'
const MIDNIGHT = Date.parse('2026-10-15T00:00:00Z') / 1000
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const BYTES = Buffer.concat([PNG, Buffer.from(Array.from({ length: 12_288 }, (_, index) => index % 251))])
const writerMap = Object.assign(Object.create(null), __tlWriterMap, new Function(`${generateWriterCodeForTlEntries(
  parseTlToEntries(CROSSGRAM_API_SCHEMA),
  { variableName: 'm', includePrelude: true, includeStaticSizes: true },
)};return m`)())
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

async function step<T>(name: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`图片归档 e2e 等待超时：${name}`)), 10_000)
      timer.unref?.()
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function image(id: string): bridge.IMMessagePart {
  return { type: 'media', media: {
    id, kind: 'image', mimeType: 'image/png', name: `${id}.png`,
    size: 1, width: 1, height: 1, locator: { id },
  } }
}

function sourcePlatform() {
  const instanceId = randomUUID()
  let handler: ((event: bridge.IMEvent) => void | Promise<void>) | undefined
  let sequence = 0
  let expired = false
  let historyCalls = 0
  const downloads: string[] = []
  const urls: string[] = []
  const conversations = new Map<string, { conversation: bridge.IMConversation, messages: bridge.IMMessage[] }>()
  const platform: bridge.IMPlatform = {
    capabilities: {
      history: true,
      send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
      conversations: { groups: true, channels: false, subchannels: false },
    },
    async getAccount() { return { credentials: {}, user: { id: 'self', firstName: '归档测试账号' } } },
    async subscribe(_session, next) {
      handler = next
      return () => { handler = undefined }
    },
    async getDialogs() {
      return { dialogs: [...conversations.values()].map(({ conversation, messages }) => ({
        conversation, unreadCount: 0, lastMessage: messages.at(-1),
      })) }
    },
    async getHistory(_session, conversation) {
      historyCalls++
      return { messages: [...(conversations.get(conversation.id)?.messages ?? [])].reverse() }
    },
    async getUser(_session, id) { return { id, firstName: id } },
    async sendMessage(): Promise<bridge.IMMessage> { throw new Error('测试平台不支持发送') },
    async *downloadMedia(_session, media, options) {
      downloads.push(media.id)
      if (expired) throw new Error('源图片已过期')
      const offset = options?.offset ?? 0
      const bytes = BYTES.subarray(offset, offset + (options?.limit ?? BYTES.length))
      yield bytes.subarray(0, 31)
      yield bytes.subarray(31)
    },
    async resolveMediaUrl(_session, media) {
      urls.push(media.id)
      if (expired) throw new Error('源直链已过期')
      return { url: `https://images.example.test/${media.id}`, expiresAt: Date.now() + 60_000, supportsRange: true }
    },
  }
  return {
    platform, downloads, urls,
    get historyCalls() { return historyCalls },
    expire() { expired = true },
    async push(parts: bridge.IMMessagePart[] = [image('photo')], conversation = GROUP, timestamp = MIDNIGHT - 1) {
      if (!handler) throw new Error('平台尚未订阅')
      const message: bridge.IMMessage = {
        id: `incoming-${instanceId}-${++sequence}`, conversationId: conversation.id,
        senderId: 'sender', timestamp, content: { parts },
      }
      const state = conversations.get(conversation.id) ?? { conversation, messages: [] }
      state.messages.push(message)
      conversations.set(conversation.id, state)
      await handler({ type: 'message', conversation, message })
      return message
    },
  }
}

async function fixture(options: { enabled?: boolean, root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'bridge-image-storage-e2e-'))
  if (!options.root) disposals.push(() => rm(root, { recursive: true, force: true }))
  const source = sourcePlatform()
  const app = await startApp({
    rsaKey,
    databasePath: pathToFileURL(join(root, 'bridge.db')).href,
    authKeyStorePath: join(root, 'auth-keys.json'),
    bridgeConfig: { uploadPath: join(root, 'uploads'), imageStorage: {
      path: join(root, 'images'),
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    } },
    platform: { id: PLATFORM_ID, adapter: source.platform },
  })
  const sso = app.ctx.plugin(SSO)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await sso.dispose()
    await app.stop()
  }
  disposals.push(stop)
  await sso
  await app.ctx.database.prepared()
  let [identity] = await app.ctx.sso.getIdentities(1)
  if (!identity) {
    const created = await app.ctx.sso.createUser('image-storage-e2e')
    expect(created.user.id).toBe(1)
    identity = (await app.ctx.sso.getIdentity(created.identityId))!
  }
  const token = await app.ctx.sso.createSession(1, identity.id)
  expect(await app.ctx.sso.validateSession(token)).toMatchObject({ id: 1 })
  const login = await waitForPlatformLogin(app.ctx, PLATFORM_ID)
  await vi.waitFor(() => expect(app.ctx.imPlatform.sessions).toHaveLength(1))
  const entry = await waitForWebuiRoute(app.ctx, '/platform-accounts')
  const data = entry.data as ImageStorageDashboardData
  const dashboard: ImageStorageDashboardData = {
    imageStorageEnabled: data.imageStorageEnabled,
    getImageStorage: query => data.getImageStorage(query, token),
    deleteImageStorage: filter => data.deleteImageStorage(filter, token),
  }
  return { ...app, stop, root, source, login, dashboard }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function ready(f: Fixture, count: number) {
  await vi.waitFor(async () => {
    expect(await f.dashboard.getImageStorage({})).toMatchObject({ count, pendingCount: 0 })
  }, { timeout: 5_000, interval: 10 })
}

async function connectClient(f: Fixture, platformId = PLATFORM_ID) {
  const login = await waitForPlatformLogin(f.ctx, platformId)
  addPublicKey(new NodeCryptoProvider(), f.rsaKey.publicKeyPem, false)
  const dc = { id: 1, ipAddress: '127.0.0.1', port: f.port }
  const client = new TelegramClient({
    apiId: 1, apiHash: 'crossgram-image-storage-e2e', storage: new MemoryStorage(),
    defaultDcs: { main: dc, media: dc }, updates: {}, logLevel: 0, writerMap,
    initConnectionOptions: {
      deviceModel: 'Crossgram image storage E2E', systemVersion: 'test', appVersion: '0.1.0',
      systemLangCode: 'zh', langPack: '', langCode: 'zh',
    },
  })
  disposals.push(() => client.destroy())
  await step(`MTProto 账号登录 ${platformId}`, client.start({
    phone: `+${login.auth.virtualPhone}`, code: () => bridge.generateLoginCode(login.auth.totpSecret),
    codeSentCallback: () => {},
  }))
  return client
}

async function photoLocation(client: TelegramClient, title = GROUP.title, caption?: string): Promise<tl.RawInputPhotoFileLocation> {
  const dialogs = await client.call({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' },
    limit: 100, hash: Long.ZERO,
  })
  if (dialogs._ === 'messages.dialogsNotModified') throw new Error('群会话未返回')
  const chat = dialogs.chats.find(chat => 'title' in chat && chat.title === title)
  if (!chat || chat._ !== 'channel') throw new Error(`找不到归档群：${title}`)
  const history = await client.call({
    _: 'messages.getHistory', peer: { _: 'inputPeerChannel', channelId: chat.id, accessHash: chat.accessHash! },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  })
  if (history._ === 'messages.messagesNotModified') throw new Error('图片历史未返回')
  const message = history.messages.find(message => message._ === 'message' && message.media?._ === 'messageMediaPhoto'
    && (caption === undefined || message.message === caption))
  if (message?._ !== 'message' || message.media?._ !== 'messageMediaPhoto' || message.media.photo?._ !== 'photo') {
    throw new Error('归档图片没有可下载的 photo')
  }
  const photo = message.media.photo
  return { _: 'inputPhotoFileLocation', id: photo.id, accessHash: photo.accessHash, fileReference: photo.fileReference, thumbSize: 'x' }
}

async function download(client: TelegramClient, location: tl.RawInputPhotoFileLocation, offset = 0, limit = 32_768) {
  const result = await client.call({ _: 'upload.getFile', location, offset, limit, precise: true })
  if (result._ !== 'upload.file') throw new Error('图片被重定向而不是返回文件')
  return Buffer.from(result.bytes)
}

function directUrl(client: TelegramClient, location: tl.RawInputPhotoFileLocation) {
  return client.call({ _: 'crossgram.getFileUrl', location } as unknown as tl.RpcMethod) as Promise<tl.RawDataJSON>
}

describe('服务端图片归档 e2e', () => {
  it('默认关闭时不主动下载平台推送的图片', async () => {
    const f = await fixture()
    await f.source.push()
    expect(f.dashboard.imageStorageEnabled).toBe(false)
    expect(await f.dashboard.getImageStorage({})).toMatchObject({ count: 0, bytes: 0, pendingCount: 0 })
    expect(f.source.downloads).toEqual([])
    expect(await f.ctx.database.get('mtproto_image_storage', {})).toEqual([])
  })

  it('没有客户端和历史请求时也将图文中的所有图片落盘而不保存普通附件', async () => {
    const f = await fixture({ enabled: true })
    await f.source.push([
      { type: 'text', text: '图文开头' }, image('first'),
      { type: 'text', text: '图文结尾' }, image('second'),
      { type: 'media', media: { id: 'attachment', kind: 'file', mimeType: 'application/pdf', locator: { id: 'attachment' } } },
    ])
    await ready(f, 2)
    expect(f.source.downloads.sort()).toEqual(['first', 'second'])
    expect(f.source.historyCalls).toBe(0)
    const files = await readdir(join(f.root, 'images'), { recursive: true })
    const saved = []
    for (const file of files) {
      const path = join(f.root, 'images', file)
      if ((await stat(path)).isFile()) saved.push(await readFile(path))
    }
    expect(saved).toEqual([BYTES, BYTES])
  })

  it('按消息的 UTC 日期和来源群统计实际字节而非平台声明的大小', async () => {
    const f = await fixture({ enabled: true })
    await f.source.push([image('before-midnight')], GROUP, MIDNIGHT - 1)
    await f.source.push([image('at-midnight')], GROUP, MIDNIGHT)
    await f.source.push([image('other-group')], OTHER_GROUP, MIDNIGHT - 1)
    await ready(f, 3)
    expect(await f.dashboard.getImageStorage({
      platformSessionId: f.login.session.id, conversationId: GROUP.id, startDate: DAY, endDate: DAY, groupBy: 'date',
    })).toMatchObject({
      count: 1, bytes: BYTES.length, totalGroups: 1,
      groups: [{ platformSessionId: f.login.session.id, date: DAY, count: 1, bytes: BYTES.length }],
    })
    expect(await f.dashboard.getImageStorage({ groupBy: 'conversation' })).toMatchObject({
      count: 3, bytes: BYTES.length * 3, totalGroups: 2,
      groups: [
        { conversationId: GROUP.id, conversationTitle: GROUP.title, count: 2, bytes: BYTES.length * 2 },
        { conversationId: OTHER_GROUP.id, conversationTitle: OTHER_GROUP.title, count: 1, bytes: BYTES.length },
      ],
    })
  })

  it.each([
    { name: '完整文件', offset: 0, limit: 32_768 },
    { name: '中间分块', offset: 4096, limit: 4096 },
    { name: '文件尾部', offset: 12_288, limit: 4096 },
    { name: '越过文件末尾', offset: 16_384, limit: 4096 },
  ])('源下载过期后通过真实 upload.getFile 读取归档的$name', async ({ offset, limit }) => {
    const f = await fixture({ enabled: true })
    await f.source.push()
    await ready(f, 1)
    f.source.expire()
    const client = await connectClient(f)
    const location = await photoLocation(client)
    expect(await download(client, location, offset, limit)).toEqual(BYTES.subarray(offset, offset + limit))
    expect(f.source.downloads).toEqual(['photo'])
  })

  it('已有归档时拒绝 QQ 直链并让客户端回退到 MTProto 文件下载', async () => {
    const f = await fixture({ enabled: true })
    await f.source.push()
    await ready(f, 1)
    const client = await connectClient(f)
    const location = await photoLocation(client)
    await expect(directUrl(client, location)).rejects.toMatchObject({ text: 'MEDIA_DIRECT_URL_UNAVAILABLE' })
    expect(f.source.urls).toEqual([])
    expect(await download(client, location)).toEqual(BYTES)
  })

  it('另一个已认证账号不能用原账号的 photo 引用读取归档', async () => {
    const f = await fixture({ enabled: true })
    await f.source.push()
    await ready(f, 1)
    const owner = await connectClient(f)
    const location = await photoLocation(owner)
    const otherSource = sourcePlatform()
    const other = f.ctx.plugin(makePlatformPlugin('image-storage-other', otherSource.platform))
    await other
    disposals.push(async () => { await other.dispose() })
    const foreign = await connectClient(f, 'image-storage-other')
    await expect(download(foreign, location)).rejects.toMatchObject({ text: 'FILE_ID_INVALID' })
    await expect(directUrl(foreign, location)).rejects.toMatchObject({ text: 'FILE_ID_INVALID' })
    expect(otherSource.downloads).toEqual([])
  })

  it('重启并关闭新图片存储后仍能读取旧副本且不下载新推送', async () => {
    const original = await fixture({ enabled: true })
    await original.source.push()
    await ready(original, 1)
    const originalClient = await connectClient(original)
    const location = await photoLocation(originalClient)
    await originalClient.destroy()
    await original.stop()
    const restarted = await fixture({ enabled: false, root: original.root })
    restarted.source.expire()
    await restarted.source.push([image('new-photo')])
    const client = await connectClient(restarted)
    expect(await download(client, location)).toEqual(BYTES)
    expect(restarted.dashboard.imageStorageEnabled).toBe(false)
    expect(await restarted.dashboard.getImageStorage({})).toMatchObject({ count: 1, bytes: BYTES.length })
    expect(restarted.source.downloads).toEqual([])
  })

  it('只删除目标账号、群和日期的副本且保留消息及平台源下载回退', async () => {
    const f = await fixture({ enabled: true })
    await f.source.push([{ type: 'text', text: 'target-caption' }, image('target')], GROUP, MIDNIGHT - 1)
    await f.source.push([image('later')], GROUP, MIDNIGHT)
    await f.source.push([image('other-group')], OTHER_GROUP, MIDNIGHT - 1)
    const otherSource = sourcePlatform()
    const other = f.ctx.plugin(makePlatformPlugin('image-storage-other', otherSource.platform))
    await other
    disposals.push(async () => { await other.dispose() })
    await waitForPlatformLogin(f.ctx, 'image-storage-other')
    await vi.waitFor(() => expect(f.ctx.imPlatform.sessions).toHaveLength(2))
    await otherSource.push([image('other-account')], GROUP, MIDNIGHT - 1)
    await ready(f, 4)
    const client = await connectClient(f)
    const location = await photoLocation(client, GROUP.title, 'target-caption')
    const filter = { platformSessionId: f.login.session.id, conversationId: GROUP.id, startDate: DAY, endDate: DAY }
    expect(await f.dashboard.deleteImageStorage(filter)).toEqual({ count: 1, bytes: BYTES.length })
    expect(await f.dashboard.getImageStorage(filter)).toMatchObject({ count: 0, bytes: 0 })
    expect(await f.dashboard.getImageStorage({})).toMatchObject({ count: 3, bytes: BYTES.length * 3 })
    expect((await f.ctx.database.get('mtproto_image_storage', { state: 'ready' })).map(row => row.platformMediaId).sort())
      .toEqual(['later', 'other-account', 'other-group'])
    const files = await readdir(join(f.root, 'images'), { recursive: true })
    let diskBytes = 0
    for (const file of files) {
      const info = await stat(join(f.root, 'images', file))
      if (info.isFile()) diskBytes += info.size
    }
    expect(diskBytes).toBe(BYTES.length * 3)
    expect(await download(client, location)).toEqual(BYTES)
    expect(f.source.downloads.filter(id => id === 'target')).toHaveLength(2)
    expect(JSON.parse((await directUrl(client, location)).data)).toMatchObject({ url: 'https://images.example.test/target' })
  })
})
