import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  projectDetachedMessage,
  stableId,
  type BridgeSessionState,
  type IMMedia,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type MessageProjectionInput,
  type MessageProjectionResult,
} from '@mtproto-relay/bridge'
import { RpcError, type ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['mtproto', 'mtprotoBridge']

interface BundleRecord {
  platformSessionId: string
  chatId: number
  bundle: IMMessageBundle
  /** 编码进 `chatId` 的持久地址；仅进程内存活的转发没有该字段。 */
  address?: BundleAddress
  snapshots?: Promise<IMMessageSnapshot[]>
  avatar?: Promise<IMMedia<any> | undefined>
  projection?: Promise<ProjectedBundle>
}

interface AvatarEntry {
  media: IMMedia<any>
  peer: AvatarPeer
}

interface AvatarPeer { kind: 'user' | 'chat', id: number }

/**
 * 单个平台会话下的头像表。peer location 按 peer+photo 索引（不同转发可共用同一张头像）；
 * photo location 不带 peer，取首次注册的条目。
 */
interface SessionAvatars {
  peers: Map<string, AvatarEntry>
  photos: Map<string, AvatarEntry>
}

interface ProjectedBundle {
  messages: tl.TypeMessage[]
  chats: tl.TypeChat[]
  users: tl.TypeUser[]
}

/**
 * 合并转发的位置：承载它的持久化消息行 ID，以及从外到内的 bundle 序号路径。
 * `path[0]` 是落库消息中的第几个 bundle，后续每一级对应父级转发内归档消息的 bundle 序号。
 */
export interface BundleAddress {
  storedMessageId: number
  path: number[]
}

/**
 * 合并转发虚拟群 ID 的起始值。高于普通 peer 与 `stableId`（< 2^31），避免与普通会话冲突。
 */
const BUNDLE_CHAT_ID_BASE = 2 ** 32
/**
 * 曾经的起始值。基址从 2^31 抬到 2^32 之前发出的转发链接是 `2^31 + row * 1024 + pathCode`，
 * 它们还留在客户端的消息缓存里，点开时只带得回一个 `chatId`，所以只在旧基址区间里按旧公式兜底。
 * 旧基址有效期内容量最大约 1.4M 行（产出 ID < 2^32），新旧区间因此互不相交。
 */
const LEGACY_BUNDLE_CHAT_ID_BASE = 2 ** 31
const BUNDLE_PATH_CODES = 1024
/** TDLib 客户端接受的普通群（basic chat）最大 ID 上限。 */
const MAX_BUNDLE_CHAT_ID = 999_999_999_999

/** 将 `BundleAddress` 编码进虚拟群 `chatId`，使重启后仅凭客户端持有的 ID 即可还原；超出编码范围时返回 `undefined`。 */
export function encodeBundleChatId(address: BundleAddress): number | undefined {
  const { storedMessageId, path } = address
  if (!Number.isSafeInteger(storedMessageId) || storedMessageId <= 0) return
  const code = encodeBundlePath(path)
  if (code === undefined || code >= BUNDLE_PATH_CODES) return
  const id = BUNDLE_CHAT_ID_BASE + storedMessageId * BUNDLE_PATH_CODES + code
  return Number.isSafeInteger(id) && id <= MAX_BUNDLE_CHAT_ID ? id : undefined
}

export function decodeBundleChatId(chatId: number): BundleAddress | undefined {
  if (!Number.isSafeInteger(chatId) || chatId > MAX_BUNDLE_CHAT_ID) return
  // 先按现行基址解码：现行 ID 用旧基址的公式也能算出「合法」的行号，反过来的顺序会把
  // 每条新链接都误读成一条更旧的行。旧基址区间在现行基址下相对值为负，自然落到兜底分支。
  const current = decodeBundleChatIdAt(BUNDLE_CHAT_ID_BASE, chatId)
  if (current) return current
  if (chatId < LEGACY_BUNDLE_CHAT_ID_BASE || chatId >= BUNDLE_CHAT_ID_BASE) return
  return decodeBundleChatIdAt(LEGACY_BUNDLE_CHAT_ID_BASE, chatId)
}

function decodeBundleChatIdAt(base: number, chatId: number): BundleAddress | undefined {
  const relative = chatId - base
  const storedMessageId = Math.floor(relative / BUNDLE_PATH_CODES)
  if (storedMessageId <= 0) return
  const path = decodeBundlePath(relative % BUNDLE_PATH_CODES)
  return path ? { storedMessageId, path } : undefined
}

/** 用带前导哨兵位的 Elias-gamma 编码将 `ordinal + 1` 序列打包进 10 bit 整数，首条顶层转发编码为 0。 */
function encodeBundlePath(path: readonly number[]): number | undefined {
  if (!path.length || path.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0)) return
  let bits = '1'
  for (const ordinal of path) {
    const binary = (ordinal + 1).toString(2)
    bits += '0'.repeat(binary.length - 1) + binary
    if (bits.length > 16) return
  }
  return parseInt(bits, 2) - 3
}

function decodeBundlePath(code: number): number[] | undefined {
  const bits = (code + 3).toString(2).slice(1)
  const path: number[] = []
  let cursor = 0
  while (cursor < bits.length) {
    let zeros = 0
    while (cursor + zeros < bits.length && bits[cursor + zeros] === '0') zeros++
    const end = cursor + zeros * 2 + 1
    if (end > bits.length) return
    path.push(parseInt(bits.slice(cursor + zeros, end), 2) - 1)
    cursor = end
  }
  return path.length && encodeBundlePath(path) === code ? path : undefined
}

function bundleParts(parts: readonly { type: string }[]): IMMessageBundle[] {
  return parts.flatMap((part) => part.type === 'message-bundle'
    ? [(part as { type: 'message-bundle', bundle: IMMessageBundle }).bundle]
    : [])
}

function nestedBundles(snapshots: readonly IMMessageSnapshot[]): IMMessageBundle[] {
  return snapshots.flatMap((snapshot) => bundleParts(snapshot.content.parts))
}

export type BundleSessionState = Pick<BridgeSessionState, 'platform' | 'session'> & {
  dialogs?: Partial<Pick<BridgeSessionState['dialogs'], 'readStoredMessage'>>
}

const MAX_CACHED_RECORDS = 256
const MAX_NESTED_ADDRESSES = 4096

/**
 * 合并转发虚拟会话的缓存与投影。
 * 带持久地址的转发编码在 `chatId` 中，重启后可从 `MessageStore` 重建；转发内部消息 ID 按时间序递增分配以支持客户端游标分页。
 */
export class MergedForwardProjection {
  private readonly _records = new Map<string, Map<number, BundleRecord>>()
  private readonly _nestedAddresses = new Map<string, Map<string, BundleAddress>>()
  private readonly _rebuilds = new Map<string, Promise<BundleRecord | undefined>>()
  private readonly _avatars = new Map<string, SessionAvatars>()
  private readonly _photoIds = new Set<string>()

  constructor(private readonly _dcId = 1) {}

  makeBundleUser(state: BridgeSessionState, snapshot: IMMessageSnapshot): tl.RawUser {
    const id = bundleUserId(state, snapshot.senderId)
    const source = snapshot.sender
    return {
      _: 'user', id, accessHash: Long.fromNumber(id),
      firstName: source?.firstName || snapshot.senderId,
      lastName: source?.lastName,
      username: source?.username,
      photo: source?.avatar
        ? this.registerAvatar(
            state.session.platformSessionId, { kind: 'user', id }, source.avatar,
          ).photo
        : { _: 'userProfilePhotoEmpty' },
    }
  }

  /**
   * 记录虚拟群。`chatId` 显式给出时优先使用：旧基址链接重建出的记录必须回显客户端请求的 ID，
   * 否则响应里的 peer 会和用户点开的链接指向两个不同的群。缺省时按地址重新编码。
   */
  remember(
    platformSessionId: string,
    bundle: IMMessageBundle,
    address?: BundleAddress,
    chatId?: number,
  ): BundleRecord {
    const encoded = address ? encodeBundleChatId(address) : undefined
    const id = chatId ?? encoded ?? bundleChatId(bundle)
    const records = this._records.get(platformSessionId) ?? new Map<number, BundleRecord>()
    const existing = records.get(id)
    if (existing?.bundle.id === bundle.id) {
      existing.bundle = bundle
      records.delete(id)
      records.set(id, existing)
      return existing
    }
    const record: BundleRecord = {
      platformSessionId, chatId: id, bundle,
      ...(encoded !== undefined ? { address: { storedMessageId: address!.storedMessageId, path: [...address!.path] } } : {}),
    }
    records.set(id, record)
    this._records.set(platformSessionId, records)
    this.evict(records)
    return record
  }

  /** 只淘汰带持久地址的记录（可从 `MessageStore` 重建），保留进程内临时转发。 */
  private evict(records: Map<number, BundleRecord>): void {
    let addressed = 0
    for (const record of records.values()) if (record.address) addressed++
    for (const [chatId, record] of records) {
      if (addressed <= MAX_CACHED_RECORDS) break
      if (!record.address) continue
      records.delete(chatId)
      addressed--
    }
  }

  resolve(platformSessionId: string, chatId: number): BundleRecord | undefined {
    return this._records.get(platformSessionId)?.get(chatId)
  }

  /**
   * 查找虚拟群对应的转发记录；未命中缓存时根据 `chatId` 编码的地址从落库消息重建。
   * `strict` 只由 `contacts.resolveUsername` 使用：重建遇到 DB/平台接口的瞬时错误时向上抛，
   * 让 RPC 回一个可重试的错误，而不是伪装成「这个用户名不存在」被客户端记成死链。
   * 默认的宽松模式把这些错误收敛成 `undefined`，因为复用它的 `messages.getHistory` 等分支
   * 靠 `undefined` 表示「不是合并转发 peer，请走默认实现」。
   */
  async lookup(
    state: BundleSessionState,
    chatId: number,
    options: { strict?: boolean } = {},
  ): Promise<BundleRecord | undefined> {
    const strict = options.strict ?? false
    const platformSessionId = state.session.platformSessionId
    const cached = this.resolve(platformSessionId, chatId)
    if (cached) return cached
    const address = decodeBundleChatId(chatId)
    if (!address || !state.dialogs?.readStoredMessage) return
    const key = `${platformSessionId}\u0000${chatId}`
    const running = this._rebuilds.get(key)
    if (running) return strict ? running : running.catch(() => undefined)
    // 去重表里保留原始 Promise，由各调用方自己决定吞掉还是抛出瞬时错误。
    const pending = this.rebuild(state, address, chatId)
      .finally(() => {
        if (this._rebuilds.get(key) === pending) this._rebuilds.delete(key)
      })
    this._rebuilds.set(key, pending)
    return strict ? pending : pending.catch(() => undefined)
  }

  /** 重建时只有「行不存在 / 该行不含这个 bundle」才是真的失效链接，其它异常属于暂时失败。 */
  private async rebuild(
    state: BundleSessionState,
    address: BundleAddress,
    chatId?: number,
  ): Promise<BundleRecord | undefined> {
    const source = await state.dialogs!.readStoredMessage!(address.storedMessageId)
    if (!source) return
    let bundle = bundleParts(source.content.parts)[address.path[0]!]
    for (let depth = 1; bundle && depth < address.path.length; depth++) {
      const parent = this.remember(state.session.platformSessionId, bundle, {
        storedMessageId: address.storedMessageId, path: address.path.slice(0, depth),
      })
      bundle = nestedBundles(await this.loadSnapshots(state, parent))[address.path[depth]!]
    }
    if (!bundle) return
    return this.remember(state.session.platformSessionId, bundle, address, chatId)
  }

  records(platformSessionId: string): Iterable<BundleRecord> {
    return this._records.get(platformSessionId)?.values() ?? []
  }

  async resolveUsername(
    state: BundleSessionState,
    username: string,
    options: { strict?: boolean } = {},
  ): Promise<BundleRecord | undefined> {
    const match = /^bridge(?:bundle|chat)_(\d+)$/i.exec(username)
    return match ? this.lookup(state, Number(match[1]), options) : undefined
  }

  private addressOf(input: MessageProjectionInput, bundle: IMMessageBundle, ordinal: number): BundleAddress | undefined {
    if (input.mode !== 'bundle') {
      return input.storedMessageId ? { storedMessageId: input.storedMessageId, path: [ordinal] } : undefined
    }
    return this._nestedAddresses.get(input.session.platformSessionId)?.get(bundle.id)
  }

  private registerNested(record: BundleRecord, snapshots: readonly IMMessageSnapshot[]): void {
    if (!record.address) return
    const nested = nestedBundles(snapshots)
    if (!nested.length) return
    let addresses = this._nestedAddresses.get(record.platformSessionId)
    if (!addresses) {
      addresses = new Map()
      this._nestedAddresses.set(record.platformSessionId, addresses)
    }
    for (const [index, bundle] of nested.entries()) {
      addresses.delete(bundle.id)
      addresses.set(bundle.id, {
        storedMessageId: record.address.storedMessageId, path: [...record.address.path, index],
      })
    }
    while (addresses.size > MAX_NESTED_ADDRESSES) addresses.delete(addresses.keys().next().value!)
  }

  async project(
    input: MessageProjectionInput,
    next: () => MessageProjectionResult | Promise<MessageProjectionResult>,
  ): Promise<MessageProjectionResult> {
    if (input.ordinal !== 0) return next()
    const bundles = input.draft.source.content.parts
      .filter((part): part is Extract<typeof part, { type: 'message-bundle' }> => part.type === 'message-bundle')
    if (!bundles.length) return next()

    const links = new Map<string, string>()
    const targets = new Map<string, number>()
    const records = new Map<string, BundleRecord>()
    for (const [ordinal, part] of bundles.entries()) {
      const record = this.remember(
        input.session.platformSessionId, part.bundle, this.addressOf(input, part.bundle, ordinal),
      )
      records.set(part.bundle.id, record)
      const snapshots = await this.loadSnapshots(input, record)
      if (!record.bundle.preview?.trim()) {
        const preview = snapshotPreview(snapshots)
        if (preview) record.bundle = { ...record.bundle, preview }
      }
      const first = firstSnapshot(snapshots)
      // 链接锚定在转发首条消息，使客户端从头打开聊天记录而非跳到末尾。
      const target = first ? transcriptMessageId(0, 0) : undefined
      if (target) targets.set(part.bundle.id, target)
      links.set(part.bundle.id, this.makeLink(
        record,
        target,
      ))
      input.draft.chats.push(this.makeChat(record, snapshots, await this.loadAvatar(input, record)))
    }

    const source = input.draft.source
    input.draft.source = {
      ...source,
      content: {
        ...source.content,
        parts: source.content.parts.map((part) => {
          if (part.type !== 'message-bundle') return part
          const text = '查看聊天记录'
          return {
            type: 'text' as const,
            text,
            entities: [{
              type: 'text-link' as const,
              offset: 0,
              length: text.length,
              url: links.get(part.bundle.id)!,
            }],
          }
        }),
      },
    }
    if (!source.content.parts.some((part) =>
      part.type === 'media' || part.type === 'sticker' || part.type === 'card')) {
      const record = records.get(bundles[0].bundle.id)
      if (record) {
        input.draft.media = this.makePreview(record, targets.get(bundles[0].bundle.id))
      }
    }
    return next()
  }

  makeLink(record: BundleRecord, messageId?: number): string {
    return `https://t.me/bridgebundle_${record.chatId}${messageId ? `/${messageId}` : ''}`
  }

  makeChat(
    record: BundleRecord,
    snapshots: readonly IMMessageSnapshot[] = [],
    avatar?: IMMedia<any>,
  ): tl.RawChat {
    return {
      _: 'chat', left: true, id: record.chatId, title: record.bundle.title,
      photo: avatar
        ? this.registerAvatar(record.platformSessionId, { kind: 'chat', id: record.chatId }, avatar).photo
        : { _: 'chatPhotoEmpty' },
      participantsCount: Math.max(1, new Set(snapshots.map((item) => item.senderId)).size),
      date: 0, version: 1,
    }
  }

  /**
   * 合并转发的网页预览卡片。不附带 `photo`，否则 Telegram Android 会把 `telegram_message` 的图片渲染为通栏大图；
   * 会话头像只挂在虚拟群 `chat` 实体上。
   */
  makePreview(
    record: BundleRecord,
    messageId?: number,
  ): tl.RawMessageMediaWebPage {
    const url = this.makeLink(record, messageId)
    return {
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage',
        id: Long.fromNumber(stableId(`merged-forward-preview:${record.bundle.id}`)),
        url, displayUrl: record.bundle.title, hash: 0,
        type: 'telegram_message', title: record.bundle.title,
        description: record.bundle.preview?.trim() || undefined,
      },
    }
  }

  makeFullChat(
    record: BundleRecord,
    snapshots: readonly IMMessageSnapshot[],
    avatar?: IMMedia<any>,
  ): tl.messages.RawChatFull {
    const chat = this.makeChat(record, snapshots, avatar)
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: record.chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId: record.chatId },
        chatPhoto: avatar
          ? this.makeBundlePhoto(record.platformSessionId, record.chatId, avatar)
          : { _: 'photoEmpty', id: Long.ZERO },
        notifySettings: { _: 'peerNotifySettings' }, botInfo: [],
      },
      chats: [chat], users: [],
    }
  }

  loadAvatar(input: Pick<MessageProjectionInput, 'platform' | 'session'>, record: BundleRecord) {
    if (record.avatar) return record.avatar
    const pending: Promise<IMMedia<any> | undefined> = readBundleAvatar(input, record)
    record.avatar = pending
    pending.catch(() => {
      if (record.avatar === pending) record.avatar = undefined
    })
    return pending.catch(() => undefined)
  }

  private makeBundlePhoto(
    platformSessionId: string,
    chatId: number,
    media: IMMedia<any>,
  ): tl.RawPhoto {
    const { photoId } = this.registerAvatar(platformSessionId, { kind: 'chat', id: chatId }, media)
    const width = media.width ?? BUNDLE_PHOTO_SIZE
    const height = media.height ?? BUNDLE_PHOTO_SIZE
    return {
      _: 'photo',
      id: photoId,
      accessHash: Long.fromNumber(stableId(`merged-forward-photo:${media.id}`)),
      fileReference: BUNDLE_PHOTO_FILE_REFERENCE,
      date: 0,
      sizes: [
        { _: 'photoSize', type: 'm', w: width, h: height, size: 0 },
        { _: 'photoSize', type: 'x', w: width, h: height, size: media.size ?? 0 },
      ],
      dcId: this._dcId,
    }
  }

  private registerAvatar(
    platformSessionId: string,
    peer: { kind: 'user', id: number },
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawUserProfilePhoto }
  private registerAvatar(
    platformSessionId: string,
    peer: { kind: 'chat', id: number },
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawChatPhoto }
  private registerAvatar(
    platformSessionId: string,
    peer: AvatarPeer,
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawUserProfilePhoto | tl.RawChatPhoto } {
    const photoId = Long.fromNumber(stableId(`avatar:${media.id}`))
    const session = this.avatarSession(platformSessionId)
    const entry: AvatarEntry = { media, peer }
    this._photoIds.add(photoId.toString())
    session.peers.set(peerKey(peer, photoId), entry)
    const photoKey = photoId.toString()
    if (!session.photos.has(photoKey)) session.photos.set(photoKey, entry)
    return {
      photoId,
      photo: peer.kind === 'user'
        ? { _: 'userProfilePhoto', photoId, dcId: this._dcId }
        : { _: 'chatPhoto', photoId, dcId: this._dcId },
    }
  }

  private avatarSession(platformSessionId: string): SessionAvatars {
    let session = this._avatars.get(platformSessionId)
    if (!session) {
      session = { peers: new Map(), photos: new Map() }
      this._avatars.set(platformSessionId, session)
    }
    return session
  }

  /** 在解析平台会话前快速判断文件位置是否可能属于合并转发头像，避免影响普通媒体下载路径。 */
  mightServeLocation(location: tl.TypeInputFileLocation): boolean {
    if (transcriptPhotoChatId(location) !== undefined) return true
    if (!this._photoIds.size) return false
    if (location._ === 'inputPeerPhotoFileLocation') {
      return this._photoIds.has(location.photoId.toString())
    }
    if (location._ === 'inputPhotoFileLocation') {
      return sameBytes(location.fileReference, BUNDLE_PHOTO_FILE_REFERENCE)
        && this._photoIds.has(location.id.toString())
    }
    return false
  }

  resolveAvatarLocation(platformSessionId: string, location: tl.TypeInputFileLocation): AvatarEntry | undefined {
    const session = this._avatars.get(platformSessionId)
    if (!session) return
    if (location._ === 'inputPeerPhotoFileLocation') {
      const peer = inputPeerKey(location.peer)
      return peer ? session.peers.get(`${peer}:${location.photoId}`) : undefined
    }
    if (location._ === 'inputPhotoFileLocation') {
      if (!sameBytes(location.fileReference, BUNDLE_PHOTO_FILE_REFERENCE)) return
      return session.photos.get(location.id.toString())
    }
  }

  loadSnapshots(input: Pick<MessageProjectionInput, 'platform' | 'session'>, record: BundleRecord) {
    if (record.snapshots) return record.snapshots
    const provider = input.platform.messageBundles
    record.snapshots = provider
      ? provider.load(input.session, record.bundle.locator)
      : Promise.resolve([])
    record.snapshots.catch(() => {
      record.snapshots = undefined
    })
    return record.snapshots
  }

  materialize(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    if (record.projection) return record.projection
    record.projection = this.buildProjection(state, record)
    record.projection.catch(() => {
      record.projection = undefined
    })
    return record.projection
  }

  clear(): void {
    this._records.clear()
    this._nestedAddresses.clear()
    this._rebuilds.clear()
    this._avatars.clear()
    this._photoIds.clear()
  }

  private async buildProjection(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    const snapshots = await this.loadSnapshots(state, record)
    this.registerNested(record, snapshots)
    const peer = { _: 'peerChat' as const, chatId: record.chatId }
    const ranks = transcriptRanks(snapshots)
    const replyIds = new Map(snapshots.map((snapshot) => [
      snapshot.id,
      transcriptMessageId(ranks.get(snapshot.id) ?? 0, 0),
    ]))
    const messages: tl.TypeMessage[] = []
    const chats: tl.TypeChat[] = [this.makeChat(record, snapshots, await this.loadAvatar(state, record))]
    const users = new Map<number, tl.TypeUser>()

    for (const snapshot of snapshots) {
      users.set(bundleUserId(state, snapshot.senderId), this.makeBundleUser(state, snapshot))
      const rendered = await projectDetachedMessage({
        pipeline: state.projection,
        platform: state.platform,
        session: state.session,
        stickers: state.stickers,
        source: snapshot,
        target: { peer, title: record.bundle.title },
        messageId: (ordinal) => transcriptMessageId(ranks.get(snapshot.id) ?? 0, ordinal),
        mediaId: (partIndex) => stableId(
          `merged-forward-media:${record.bundle.id}:${snapshot.id}:${partIndex}`,
        ),
        userId: (id) => bundleUserId(state, id),
        replyToMessageId: snapshot.replyToId ? replyIds.get(snapshot.replyToId) : undefined,
        groupedId: String(stableId(
          `merged-forward-group:${record.bundle.id}:${snapshot.groupId ?? snapshot.id}`,
        )),
      })
      messages.push(...rendered.messages)
      chats.push(...rendered.chats)
    }
    // 历史分页按最新在前返回；QQ 时间戳精度到秒，同秒消息用按归档序递增的 ID 决胜。
    messages.sort((left, right) => messageDate(right) - messageDate(left) || right.id - left.id)
    return {
      messages,
      chats: uniqueById(chats),
      users: [...users.values()],
    }
  }
}

export function makeMergedForwardProvider(dcId = 1): MergedForwardProjection {
  return new MergedForwardProjection(dcId)
}

export function apply(ctx: Context): void {
  const projection = new MergedForwardProjection(ctx.mtprotoBridge.dcId)
  ctx.on('bridge/message/project', (input, next) => projection.project(input, next))
  ctx.on('mtproto/rpc', async function (
    this: ServerRpcContext,
    request: tl.RpcMethod,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const result = await routeMergedForwardRpc(ctx, projection, this, request)
    if (result === undefined) return next()
    return result
  } as never, { prepend: true })
  ctx.effect(() => () => projection.clear(), 'mergedForward.clear')
}

async function routeMergedForwardRpc(
  ctx: Context,
  projection: MergedForwardProjection,
  rpc: ServerRpcContext,
  request: tl.RpcMethod,
): Promise<unknown | undefined> {
  const resolveState = () => ctx.mtprotoBridge.resolveSession(rpc)
  if (request._ === 'upload.getFile') {
    const req = request as tl.upload.RawGetFileRequest
    if (!projection.mightServeLocation(req.location)) return
    const offset = Number(req.offset)
    if (!Number.isFinite(offset) || offset < 0 || req.limit <= 0) return
    const state = await resolveState()
    let entry = projection.resolveAvatarLocation(state.session.platformSessionId, req.location)
    if (!entry) {
      // 客户端可能在重启后拉取已缓存转发的头像，此时需先重建转发以重新注册头像。
      const chatId = transcriptPhotoChatId(req.location)
      const record = chatId === undefined ? undefined : await projection.lookup(state, chatId)
      if (record) {
        projection.makeChat(record, [], await projection.loadAvatar(state, record))
        entry = projection.resolveAvatarLocation(state.session.platformSessionId, req.location)
      }
    }
    if (!entry || !state.platform.downloadMedia) return
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of state.platform.downloadMedia(state.session, entry.media, {
      offset, limit: req.limit,
    })) {
      const remaining = req.limit - size
      if (remaining <= 0) break
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(accepted)
      size += accepted.length
    }
    const bytes = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) {
      bytes.set(chunk, cursor)
      cursor += chunk.length
    }
    return {
      _: 'upload.file',
      type: offset === 0 ? avatarStorageFileType(bytes) : { _: 'storage.fileUnknown' as const },
      mtime: Math.floor(Date.now() / 1000),
      bytes,
    }
  }
  if (request._ === 'contacts.resolveUsername') {
    const req = request as tl.contacts.RawResolveUsernameRequest
    if (!/^bridge(?:bundle|chat)_\d+$/i.test(req.username)) return
    const state = await resolveState()
    let record: BundleRecord | undefined
    try {
      record = await projection.resolveUsername(state, req.username, { strict: true })
    } catch (error) {
      // 重建失败是暂时性的（DB 抖动、QQ 归档接口失败）。把它当成「用户名不存在」会让客户端
      // 把链接永久记成死链，用户点开毫无反应；回一个可重试的服务端错误，客户端会再敲一次。
      ctx.logger.warn(
        'merged-forward resolveUsername failed username=%s error=%s', req.username, String(error),
      )
      throw new RpcError(500, 'MERGED_FORWARD_UNAVAILABLE')
    }
    if (!record) return
    // 参与者数量与头像只是装饰：归档/媒体接口失败时退化为 1 人与空头像，聊天记录本体
    // 仍然由随后的 messages.getHistory 提供，不该被装饰拖垮整个链接。
    const snapshots = await projection.loadSnapshots(state, record).catch(() => [])
    return {
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: record.chatId },
      chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
      users: [],
    }
  }
  if (request._ === 'messages.getFullChat') {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await resolveState()
    const record = await projection.lookup(state, req.chatId)
    if (!record) return
    return projection.makeFullChat(
      record,
      await projection.loadSnapshots(state, record),
      await projection.loadAvatar(state, record),
    )
  }
  if (
    request._ === 'messages.getHistory'
    || request._ === 'messages.readHistory'
    || request._ === 'messages.getScheduledHistory'
    || request._ === 'messages.getPeerSettings'
  ) {
    const req = request as tl.messages.RawGetHistoryRequest
      | tl.messages.RawReadHistoryRequest
      | tl.messages.RawGetScheduledHistoryRequest
      | tl.messages.RawGetPeerSettingsRequest
    if (req.peer._ !== 'inputPeerChat') return
    const state = await resolveState()
    const record = await projection.lookup(state, req.peer.chatId)
    if (!record) return
    if (request._ === 'messages.readHistory') {
      return { _: 'messages.affectedMessages', pts: 0, ptsCount: 0 }
    }
    if (request._ === 'messages.getScheduledHistory') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.messages', messages: [], topics: [],
        chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
        users: [],
      }
    }
    if (request._ === 'messages.getPeerSettings') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.peerSettings', settings: { _: 'peerSettings' },
        chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
        users: [],
      }
    }
    const bundle = await projection.materialize(state, record)
    return {
      _: 'messages.messagesSlice', count: bundle.messages.length,
      messages: selectTranscriptPage(bundle.messages, request as tl.messages.RawGetHistoryRequest),
      topics: [], chats: bundle.chats, users: bundle.users,
    }
  }
  if (request._ === 'messages.search') {
    const req = request as tl.messages.RawSearchRequest
    if (req.peer._ !== 'inputPeerChat') return
    // 只认「全部消息」这一个 filter：媒体/链接/文件等筛选需要真实索引，交回默认实现，
    // 免得给出一份看起来可信、实则被错误筛选过的结果。
    if (req.filter._ !== 'inputMessagesFilterEmpty') return
    // 按发送者/话题/收藏夹筛选同样需要索引，我们给不出正确结果时不猜，宁可回落。
    if (req.fromId || req.topMsgId || req.savedPeerId || req.savedReaction) return
    const state = await resolveState()
    const record = await projection.lookup(state, req.peer.chatId)
    if (!record) return
    // 和 `messages.getHistory` 用同一份投影：客户端按锚点定位、再在会话里搜索时，
    // 两边看到的消息与 ID 必须完全一致。
    const bundle = await projection.materialize(state, record)
    const matches = searchTranscript(bundle.messages, req.q).filter((message) => {
      // 搜索面板总会带上 min/max date（未筛选时为 0）；带了范围却不按范围回答，就会越界返回。
      if (req.minDate > 0 && messageDate(message) < req.minDate) return false
      if (req.maxDate > 0 && messageDate(message) > req.maxDate) return false
      return true
    })
    return {
      _: 'messages.messagesSlice', count: matches.length,
      messages: selectTranscriptPage(matches, req), topics: [],
      chats: bundle.chats, users: bundle.users,
    }
  }
  if (request._ === 'messages.getPeerDialogs') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const records = (await Promise.all(req.peers.map(async (item, index) => {
      if (item._ !== 'inputDialogPeer' || item.peer._ !== 'inputPeerChat') return undefined
      const record = await projection.lookup(state, item.peer.chatId)
      return record ? { index, record } : undefined
    }))).filter((entry): entry is { index: number, record: BundleRecord } => entry !== undefined)
    if (!records.length) return
    const virtualIndexes = new Set(records.map((entry) => entry.index))
    const ordinaryPeers = req.peers.filter((_item, index) => !virtualIndexes.has(index))
    const projectedChats = await Promise.all(records.map(async ({ record }) => {
      const snapshots = await projection.loadSnapshots(state, record)
      return projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))
    }))
    const ordinary = ordinaryPeers.length
      ? await state.dialogs.getPeerDialogs({ ...req, peers: ordinaryPeers })
      : undefined
    const virtualByIndex = new Map(records.map((entry) => [entry.index, entry.record]))
    // `topMessage = 0` 让客户端通过锚点消息前的 dialog 预检，同时跳过将该虚拟会话写入聊天列表。
    let ordinaryCursor = 0
    const dialogs: tl.TypeDialog[] = []
    for (let index = 0; index < req.peers.length; index++) {
      const record = virtualByIndex.get(index)
      if (record) {
        dialogs.push(transcriptDialog(record.chatId))
        continue
      }
      if (req.peers[index]?._ !== 'inputDialogPeer') continue
      const next = ordinary?.dialogs[ordinaryCursor++]
      if (next) dialogs.push(next)
    }
    return {
      _: 'messages.peerDialogs',
      dialogs,
      messages: ordinary?.messages ?? [],
      chats: uniqueById([...(ordinary?.chats ?? []), ...projectedChats]),
      users: ordinary?.users ?? [],
      state: ordinary?.state ?? { _: 'updates.state', pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 },
    }
  }
  if (request._ === 'messages.getMessages') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetMessagesRequest
    // 只有内存里的转发记录能回答：`messages.getMessages` 不带 peer，冷缓存时无从判断该 ID 属于
    // 哪一份聊天记录，也就无法从落库消息重建。
    const projected = await Promise.all(
      [...projection.records(state.session.platformSessionId)].map(async (record) => ({
        chatId: record.chatId,
        bundle: await projection.materialize(state, record),
      })),
    )
    const index = collectVirtualMessages(
      projected.map(({ chatId, bundle }) => ({ chatId, messages: bundle.messages })),
    )
    const requestedIds = req.id.map(inputMessageId)
    // 认领 = 有记录声称拥有这个 ID（不论唯一还是重号）；重号的不能猜，也不能交给默认实现。
    const claimed = new Set(requestedIds.filter((id) => index.messages.has(id) || index.ambiguous.has(id)))
    if (!claimed.size) return
    for (const id of claimed) {
      const chatIds = index.ambiguous.get(id)
      if (chatIds) {
        // 重号时回 messageEmpty，绝不把别的转发会话的消息交出去；日志留痕便于事后定位。
        ctx.logger.warn(
          'merged-forward messages.getMessages ambiguous id=%d chats=%s', id, chatIds.join(','),
        )
      }
    }
    const ordinaryInputs = req.id.filter((input) => !claimed.has(inputMessageId(input)))
    const ordinary = ordinaryInputs.length
      ? await state.dialogs.getMessages({ ...req, id: ordinaryInputs })
      : undefined
    const ordinaryMessages = ordinary && ordinary._ !== 'messages.messagesNotModified'
      ? ordinary.messages
      : []
    const byId = new Map([...ordinaryMessages, ...index.messages.values()].map((message) => [message.id, message]))
    return {
      _: 'messages.messages',
      messages: requestedIds.map((id) => byId.get(id) ?? { _: 'messageEmpty', id }),
      topics: [],
      chats: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.chats : []),
        ...projected.flatMap(({ bundle }) => bundle.chats),
      ]),
      users: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.users : []),
        ...projected.flatMap(({ bundle }) => bundle.users),
      ]),
    }
  }
}

/** 聊天记录虚拟消息的归属索引：只有唯一属主的 ID 可以回答，重号的 ID 只能拒答。 */
export interface VirtualMessageIndex {
  /** 消息 ID → 唯一属主的那条消息 */
  messages: Map<number, tl.TypeMessage>
  /** 消息 ID → 所有声称拥有它的虚拟群 ID（至少两个） */
  ambiguous: Map<number, number[]>
}

/**
 * 按消息 ID 归档若干聊天记录投影出的消息。
 * 聊天记录的消息 ID 是**会话局部**编号（每个会话都从 1000 开始按归档顺序递增），不同转发之间
 * 必然重号；而 `messages.getMessages` 的请求里没有 peer，无法据此反查会话。所以只有「恰好一个
 * 记录拥有这个 ID」时才敢认领，重号的归入 `ambiguous` 交给调用方拒答，避免把 A 会话的消息当成
 * B 会话的回复/网页预览/媒体来源。
 */
export function collectVirtualMessages(
  owners: Iterable<{ chatId: number, messages: readonly tl.TypeMessage[] }>,
): VirtualMessageIndex {
  const held = new Map<number, { message: tl.TypeMessage, chatIds: number[] }>()
  for (const { chatId, messages } of owners) {
    for (const message of messages) {
      const entry = held.get(message.id)
      if (!entry) {
        held.set(message.id, { message, chatIds: [chatId] })
      } else if (!entry.chatIds.includes(chatId)) {
        entry.chatIds.push(chatId)
      }
    }
  }
  const index: VirtualMessageIndex = { messages: new Map(), ambiguous: new Map() }
  for (const [id, entry] of held) {
    if (entry.chatIds.length === 1) index.messages.set(id, entry.message)
    else index.ambiguous.set(id, entry.chatIds)
  }
  return index
}

function transcriptDialog(chatId: number): tl.RawDialog {
  return {
    _: 'dialog',
    peer: { _: 'peerChat', chatId },
    topMessage: 0,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    unreadCount: 0,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    notifySettings: { _: 'peerNotifySettings' },
  }
}

function firstSnapshot(
  snapshots: readonly IMMessageSnapshot[],
): IMMessageSnapshot | undefined {
  return chronologicalSnapshots(snapshots)[0]
}

export function snapshotPreview(snapshots: readonly IMMessageSnapshot[]): string | undefined {
  const lines = [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(0, 4)
    .map((snapshot) => {
      const sender = [snapshot.sender?.firstName, snapshot.sender?.lastName]
        .filter(Boolean).join(' ').trim() || snapshot.senderId
      const content = snapshot.content.parts.map((part) => {
        if (part.type === 'text') return part.text.trim()
        if (part.type === 'media') {
          return part.media.kind === 'image' ? '[图片]' : part.media.name?.trim() || '[文件]'
        }
        if (part.type === 'sticker') return '[表情]'
        if (part.type === 'card') return part.card.title?.trim() || '[卡片消息]'
        return `[${part.bundle.title || '聊天记录'}]`
      }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      return content ? `${sender}: ${content}` : ''
    })
    .filter(Boolean)
  return lines.join('\n') || undefined
}

async function readBundleAvatar(
  input: Pick<MessageProjectionInput, 'platform' | 'session'>,
  record: BundleRecord,
): Promise<IMMedia<any> | undefined> {
  return await input.platform.messageBundles?.avatar?.(input.session, record.bundle.locator)
}

function bundleChatId(bundle: IMMessageBundle): number {
  return stableId(`merged-forward-chat:${bundle.id}`)
}

/** 避开客户端表示“从历史开头读取”的 `offsetId = 1` 哨兵值。 */
const TRANSCRIPT_MESSAGE_ID_BASE = 1000

/** 每条归档消息预留的 ID 步长，用于容纳单条消息拆分出的多个 part。 */
const TRANSCRIPT_MESSAGE_ID_STRIDE = 1000

/** 按归档时间序分配消息 ID，满足客户端用 `offset_id`/`max_id`/`min_id` 游标分页及同秒消息排序。 */
export function transcriptMessageId(rank: number, ordinal: number): number {
  return TRANSCRIPT_MESSAGE_ID_BASE + rank * TRANSCRIPT_MESSAGE_ID_STRIDE + ordinal
}

function chronologicalSnapshots(snapshots: readonly IMMessageSnapshot[]): IMMessageSnapshot[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((left, right) =>
      left.snapshot.timestamp - right.snapshot.timestamp || left.index - right.index)
    .map((entry) => entry.snapshot)
}

function transcriptRanks(snapshots: readonly IMMessageSnapshot[]): Map<string, number> {
  return new Map(chronologicalSnapshots(snapshots).map((snapshot, rank) => [snapshot.id, rank]))
}

function bundleUserId(state: BridgeSessionState, platformUserId: string): number {
  return stableId(`merged-forward-user:${state.session.platformSessionId}:${platformUserId}`)
}

const BUNDLE_PHOTO_SIZE = 640

const BUNDLE_PHOTO_FILE_REFERENCE = new TextEncoder().encode('crossgram-merged-forward-avatar:v1')

function peerKey(peer: AvatarPeer, photoId: Long): string {
  return `${peer.kind}:${peer.id}:${photoId.toString()}`
}

function transcriptPhotoChatId(location: tl.TypeInputFileLocation): number | undefined {
  if (location._ !== 'inputPeerPhotoFileLocation' || location.peer._ !== 'inputPeerChat') return
  return decodeBundleChatId(location.peer.chatId) ? location.peer.chatId : undefined
}

function inputPeerKey(location: tl.TypeInputPeer): string | undefined {
  if (location._ === 'inputPeerUser') return `user:${location.userId}`
  if (location._ === 'inputPeerChat') return `chat:${location.chatId}`
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function avatarStorageFileType(bytes: Uint8Array): tl.storage.TypeFileType {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { _: 'storage.filePng' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { _: 'storage.fileJpeg' }
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { _: 'storage.fileWebp' }
  }
  return { _: 'storage.fileUnknown' }
}

const kFirstMessageOffsetId = 1

/**
 * 与 peer 无关的分页游标：`messages.getHistory` 与 `messages.search` 都带这几个字段，
 * 客户端也用它俩共用一套 `offset_id` / `add_offset` / `max_id` / `min_id` 语义翻页。
 */
type TranscriptCursor = Pick<tl.messages.RawGetHistoryRequest,
  'offsetId' | 'addOffset' | 'maxId' | 'minId' | 'limit'>

function firstPage(
  messages: readonly tl.TypeMessage[],
  limit: number,
): tl.TypeMessage[] {
  const count = Math.max(0, limit)
  return messages.slice(Math.max(0, messages.length - count))
}

/**
 * 取聊天记录的一页。
 * 语义与客户端的 `offset_id` / `add_offset` / `max_id` / `min_id` 一致，`messages.getHistory`
 * 与 `messages.search` 共用这一份，避免两条路由的分页口径漂移。
 */
export function selectTranscriptPage(
  messages: readonly tl.TypeMessage[],
  request: TranscriptCursor,
): tl.TypeMessage[] {
  const filtered = selectWithinBounds(messages, request)
  const limit = Math.max(0, request.limit)
  if (!filtered.length) return []
  // `offsetId = 1` 是客户端「从历史开头读」的哨兵（旧版深链不带锚点），它低于所有聊天记录 ID。
  if (request.offsetId === kFirstMessageOffsetId) return firstPage(filtered, limit)
  const newest = filtered[0]!.id
  const oldest = filtered[filtered.length - 1]!.id
  if (request.offsetId > newest) {
    // 「往更新的方向」要一页却已经越过最新一条时，聊天记录不会再增长，正确回答是空页。
    // 反例就是 tdesktop 的 `HistoryWidget::loadMessagesDown()`（offset_id = maxId + 1,
    // add_offset = -loadCount）：它只有拿到空 slice 才会把 `loadedAtBottom` 置上，
    // 回一页重复消息会让它 20ms 一次无限重拉，窗口永远 activate 不了。
    if (request.addOffset < 0) return []
    // 例外是 add_offset = 0 的锚点跳转（`offset_id = anchor + 1`）：客户端要的是「含锚点的那一页」。
    // 单条消息的转录锚点就是最新一条，这里回空页会让窗口里什么都没有。
    return filtered.slice(0, limit)
  }
  // 深链锚点就是最早那条消息时，客户端会直接拿 `offset_id = anchor`（不带偏移）来开窗；
  // `offsetId` 是排他游标，按它算会得到空页——与哨兵同义，回「从锚点开始的首页」。
  if (request.addOffset === 0 && request.offsetId === oldest) return firstPage(filtered, limit)
  const start = pageStart(filtered, request)
  return filtered.slice(start, start + limit)
}

function selectWithinBounds(
  messages: readonly tl.TypeMessage[],
  request: TranscriptCursor,
): tl.TypeMessage[] {
  let filtered = [...messages]
  if (request.maxId > 0) filtered = filtered.filter((message) => message.id < request.maxId)
  if (request.minId > 0) filtered = filtered.filter((message) => message.id > request.minId)
  return filtered
}

/**
 * 计算最新在前数组中的分页起点。
 * `offsetId` 为排他游标（从第一条 `< offsetId` 的消息开始），`addOffset` 为负时向更新的消息偏移。
 */
function pageStart(
  filtered: readonly tl.TypeMessage[],
  request: TranscriptCursor,
): number {
  let start = 0
  if (request.offsetId > 0) {
    const below = filtered.findIndex((message) => message.id < request.offsetId)
    start = below < 0 ? filtered.length : below
  }
  return Math.max(0, start + request.addOffset)
}

/**
 * 合并转发会话内的搜索匹配：大小写不敏感的子串匹配，只看消息文本。
 * 不做词边界切分——中文关键字之间没有空格，`\b` 这类 ASCII 规则会把「米哈游」当成一个整词，
 * 客户端（tdesktop 的 `Data::SearchController`）在这里期待的就是子串行为。
 * 空 query 视为全部命中，因为部分客户端会用它配合 `max_id` / `min_id` 做范围翻页。
 */
export function searchTranscript(
  messages: readonly tl.TypeMessage[],
  query: string,
): tl.TypeMessage[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...messages]
  // 只有 `message` 带文本；`messageEmpty` 与 `messageService`（服务动作）没有可匹配的内容。
  return messages.filter((message) =>
    message._ === 'message' && message.message.toLowerCase().includes(needle))
}

function inputMessageId(input: tl.TypeInputMessage): number {
  return input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
}

function messageDate(message: tl.TypeMessage): number {
  return message._ === 'messageEmpty' ? 0 : message.date
}

function uniqueById<T extends { _: string, id: number }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [`${item._}:${item.id}`, item])).values()]
}
