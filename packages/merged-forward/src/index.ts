import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  projectDetachedMessage,
  stableId,
  type BridgeSessionState,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type MessageProjectionInput,
  type MessageProjectionResult,
} from '@mtproto-relay/bridge'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['mtproto', 'mtprotoBridge']

interface BundleRecord {
  platformSessionId: string
  chatId: number
  bundle: IMMessageBundle
  snapshots?: Promise<IMMessageSnapshot[]>
  projection?: Promise<ProjectedBundle>
}

interface ProjectedBundle {
  messages: tl.TypeMessage[]
  chats: tl.TypeChat[]
  users: tl.TypeUser[]
}

/**
 * Ephemeral feature-owned registry. It remembers only bundles encountered in
 * projected messages; it never restores virtual dialogs from MessageStore.
 */
export class MergedForwardProjection {
  private readonly _records = new Map<string, Map<number, BundleRecord>>()

  remember(platformSessionId: string, bundle: IMMessageBundle): BundleRecord {
    const chatId = bundleChatId(bundle)
    const records = this._records.get(platformSessionId) ?? new Map<number, BundleRecord>()
    const existing = records.get(chatId)
    if (existing?.bundle.id === bundle.id) {
      existing.bundle = bundle
      return existing
    }
    const record = { platformSessionId, chatId, bundle }
    records.set(chatId, record)
    this._records.set(platformSessionId, records)
    return record
  }

  resolve(platformSessionId: string, chatId: number): BundleRecord | undefined {
    return this._records.get(platformSessionId)?.get(chatId)
  }

  records(platformSessionId: string): Iterable<BundleRecord> {
    return this._records.get(platformSessionId)?.values() ?? []
  }

  resolveUsername(platformSessionId: string, username: string): BundleRecord | undefined {
    const match = /^bridge(?:bundle|chat)_(\d+)$/.exec(username)
    return match ? this.resolve(platformSessionId, Number(match[1])) : undefined
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
    for (const part of bundles) {
      const record = this.remember(input.session.platformSessionId, part.bundle)
      const snapshots = await this.loadSnapshots(input, record)
      const latest = newestSnapshot(snapshots)
      const target = latest ? bundleMessageId(part.bundle, latest, 0) : undefined
      if (target) targets.set(part.bundle.id, target)
      links.set(part.bundle.id, this.makeLink(
        record,
        target,
      ))
      input.draft.chats.push(this.makeChat(record, snapshots))
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
      const record = this.resolve(input.session.platformSessionId, bundleChatId(bundles[0].bundle))
      if (record) input.draft.media = this.makePreview(record, targets.get(bundles[0].bundle.id))
    }
    return next()
  }

  makeLink(record: BundleRecord, messageId?: number): string {
    return `https://t.me/bridgebundle_${record.chatId}${messageId ? `/${messageId}` : ''}`
  }

  makeChat(record: BundleRecord, snapshots: readonly IMMessageSnapshot[] = []): tl.RawChat {
    return {
      _: 'chat', left: true, id: record.chatId, title: record.bundle.title,
      photo: { _: 'chatPhotoEmpty' },
      participantsCount: Math.max(1, new Set(snapshots.map((item) => item.senderId)).size),
      date: 0, version: 1,
    }
  }

  makePreview(record: BundleRecord, messageId?: number): tl.RawMessageMediaWebPage {
    const url = this.makeLink(record, messageId)
    return {
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage',
        id: Long.fromNumber(stableId(`merged-forward-preview:${record.bundle.id}`)),
        url, displayUrl: record.bundle.title, hash: 0,
        type: 'telegram_message', title: record.bundle.title,
        description: record.bundle.preview?.trim() || '点击查看合并转发消息',
      },
    }
  }

  makeFullChat(record: BundleRecord, snapshots: readonly IMMessageSnapshot[]): tl.messages.RawChatFull {
    const chat = this.makeChat(record, snapshots)
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: record.chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId: record.chatId },
        chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
        notifySettings: { _: 'peerNotifySettings' }, botInfo: [],
      },
      chats: [chat], users: [],
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
  }

  private async buildProjection(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    const snapshots = await this.loadSnapshots(state, record)
    const peer = { _: 'peerChat' as const, chatId: record.chatId }
    const replyIds = new Map(snapshots.map((snapshot) => [
      snapshot.id,
      bundleMessageId(record.bundle, snapshot, 0),
    ]))
    const messages: tl.TypeMessage[] = []
    const chats: tl.TypeChat[] = [this.makeChat(record, snapshots)]
    const users = new Map<number, tl.TypeUser>()

    for (const snapshot of snapshots) {
      users.set(bundleUserId(state, snapshot.senderId), makeBundleUser(state, snapshot))
      const rendered = await projectDetachedMessage({
        pipeline: state.projection,
        platform: state.platform,
        session: state.session,
        stickers: state.stickers,
        source: snapshot,
        target: { peer, title: record.bundle.title },
        messageId: (ordinal) => bundleMessageId(record.bundle, snapshot, ordinal),
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
    messages.sort((left, right) => messageDate(right) - messageDate(left) || right.id - left.id)
    return {
      messages,
      chats: uniqueById(chats),
      users: [...users.values()],
    }
  }
}

export function makeMergedForwardProvider(): MergedForwardProjection {
  return new MergedForwardProjection()
}

export function apply(ctx: Context): void {
  const projection = new MergedForwardProjection()
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
  if (request._ === 'contacts.resolveUsername') {
    const req = request as tl.contacts.RawResolveUsernameRequest
    if (!/^bridge(?:bundle|chat)_\d+$/.test(req.username)) return
    const state = await resolveState()
    const record = projection.resolveUsername(state.session.platformSessionId, req.username)
    if (!record) return
    const snapshots = await projection.loadSnapshots(state, record)
    return {
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: record.chatId },
      chats: [projection.makeChat(record, snapshots)], users: [],
    }
  }
  if (request._ === 'messages.getFullChat') {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await resolveState()
    const record = projection.resolve(state.session.platformSessionId, req.chatId)
    if (!record) return
    return projection.makeFullChat(record, await projection.loadSnapshots(state, record))
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
    const record = projection.resolve(state.session.platformSessionId, req.peer.chatId)
    if (!record) return
    if (request._ === 'messages.readHistory') {
      return { _: 'messages.affectedMessages', pts: 0, ptsCount: 0 }
    }
    if (request._ === 'messages.getScheduledHistory') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.messages', messages: [], topics: [],
        chats: [projection.makeChat(record, snapshots)], users: [],
      }
    }
    if (request._ === 'messages.getPeerSettings') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.peerSettings', settings: { _: 'peerSettings' },
        chats: [projection.makeChat(record, snapshots)], users: [],
      }
    }
    const bundle = await projection.materialize(state, record)
    const page = selectHistory(bundle.messages, request as tl.messages.RawGetHistoryRequest)
    return {
      _: 'messages.messagesSlice', count: bundle.messages.length,
      messages: page, topics: [], chats: bundle.chats, users: bundle.users,
    }
  }
  if (request._ === 'messages.getPeerDialogs') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const records = req.peers.flatMap((item, index) => {
      if (item._ !== 'inputDialogPeer' || item.peer._ !== 'inputPeerChat') return []
      const record = projection.resolve(state.session.platformSessionId, item.peer.chatId)
      return record ? [{ index, record }] : []
    })
    if (!records.length) return
    const virtualIndexes = new Set(records.map((entry) => entry.index))
    const ordinaryPeers = req.peers.filter((_item, index) => !virtualIndexes.has(index))
    // Synthetic peers are history-only views, not dialogs.  Returning a
    // `dialog` (or its top message) here makes Telegram clients mark the
    // peer as having a real dialog entry and persist it in the left chat
    // list.  Keep the peer entity available for resolving/opening the view,
    // but deliberately leave the dialog and message vectors untouched.
    const projectedChats = await Promise.all(records.map(async ({ record }) => {
      const snapshots = await projection.loadSnapshots(state, record)
      return projection.makeChat(record, snapshots)
    }))
    const ordinary = ordinaryPeers.length
      ? await state.dialogs.getPeerDialogs({ ...req, peers: ordinaryPeers })
      : undefined
    return {
      _: 'messages.peerDialogs',
      dialogs: ordinary?.dialogs ?? [],
      messages: ordinary?.messages ?? [],
      chats: uniqueById([...(ordinary?.chats ?? []), ...projectedChats]),
      users: ordinary?.users ?? [],
      state: ordinary?.state ?? { _: 'updates.state', pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 },
    }
  }
  if (request._ === 'messages.getMessages') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetMessagesRequest
    const bundles = await Promise.all(
      [...projection.records(state.session.platformSessionId)]
        .map((record) => projection.materialize(state, record)),
    )
    const virtualById = new Map(bundles.flatMap((bundle) => bundle.messages.map((message) => [message.id, message])))
    const requestedIds = req.id.map(inputMessageId)
    const ordinaryInputs = req.id.filter((input) => !virtualById.has(inputMessageId(input)))
    if (ordinaryInputs.length === req.id.length) return
    const ordinary = ordinaryInputs.length
      ? await state.dialogs.getMessages({ ...req, id: ordinaryInputs })
      : undefined
    const ordinaryMessages = ordinary && ordinary._ !== 'messages.messagesNotModified'
      ? ordinary.messages
      : []
    const byId = new Map([...ordinaryMessages, ...virtualById.values()].map((message) => [message.id, message]))
    return {
      _: 'messages.messages',
      messages: requestedIds.map((id) => byId.get(id) ?? { _: 'messageEmpty', id }),
      topics: [],
      chats: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.chats : []),
        ...bundles.flatMap((bundle) => bundle.chats),
      ]),
      users: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.users : []),
        ...bundles.flatMap((bundle) => bundle.users),
      ]),
    }
  }
}

function newestSnapshot(snapshots: readonly IMMessageSnapshot[]): IMMessageSnapshot | undefined {
  return snapshots.map((snapshot, index) => ({ snapshot, index }))
    .sort((left, right) => right.snapshot.timestamp - left.snapshot.timestamp || right.index - left.index)[0]
    ?.snapshot
}

function bundleChatId(bundle: IMMessageBundle): number {
  return stableId(`merged-forward-chat:${bundle.id}`)
}

function bundleMessageId(bundle: IMMessageBundle, snapshot: IMMessageSnapshot, ordinal: number): number {
  return stableId(`merged-forward-message:${bundle.id}:${snapshot.id}:${ordinal}`)
}

function bundleUserId(state: BridgeSessionState, platformUserId: string): number {
  return stableId(`merged-forward-user:${state.session.platformSessionId}:${platformUserId}`)
}

function makeBundleUser(state: BridgeSessionState, snapshot: IMMessageSnapshot): tl.RawUser {
  const id = bundleUserId(state, snapshot.senderId)
  const source = snapshot.sender
  return {
    _: 'user', id, accessHash: Long.fromNumber(id),
    firstName: source?.firstName || snapshot.senderId,
    lastName: source?.lastName,
    username: source?.username,
    photo: { _: 'userProfilePhotoEmpty' },
  }
}

function selectHistory(
  messages: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): tl.TypeMessage[] {
  let filtered = [...messages]
  if (request.maxId > 0) filtered = filtered.filter((message) => message.id < request.maxId)
  if (request.minId > 0) filtered = filtered.filter((message) => message.id > request.minId)
  let start = 0
  if (request.offsetId > 0) {
    const anchor = filtered.findIndex((message) => message.id === request.offsetId)
    start = anchor < 0 ? 0 : anchor + 1
  }
  start = Math.max(0, start + request.addOffset)
  return filtered.slice(start, start + Math.max(0, request.limit))
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
