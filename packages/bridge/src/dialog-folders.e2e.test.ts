import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import {
  isBareVector, type RpcResult, type ServerRpcContext,
} from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogFolderStore } from './dialog-folders.js'
import { DialogRpc, stableId } from './dialogs.js'
import { defineModels } from './models.js'
import type { IMDialog, IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness, type CordisRpcTestHarness } from './rpc-test-harness.js'

const RPC_RESULT_ID = 0xf35c6d01
const VECTOR_ID = 0x1cb5c415
const BOOL_TRUE_ID = 0x997275b5
const BOOL_FALSE_ID = 0xbc799737

const session: PlatformSession = {
  platformSessionId: 'folder-session', platformId: 'test', userId: 'self',
  credentials: {}, metadata: {},
}
const sourceDialogs: IMDialog[] = [
  { conversation: { id: 'alice', kind: 'direct', title: 'Alice' }, unreadCount: 0 },
  { conversation: { id: 'group-a', kind: 'group', title: 'Group A' }, unreadCount: 2 },
  { conversation: { id: 'channel-a', kind: 'channel', title: 'Channel A' }, unreadCount: 0 },
]
const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: true, subchannels: false },
  },
  async subscribe() { return () => {} },
  async getDialogs(_session, query) {
    const start = query?.afterId
      ? sourceDialogs.findIndex((dialog) => dialog.conversation.id === query.afterId) + 1
      : 0
    const limit = query?.limit ?? sourceDialogs.length
    const dialogs = sourceDialogs.slice(Math.max(0, start), Math.max(0, start) + limit)
    return { dialogs, total: sourceDialogs.length }
  },
  async getHistory() { return { messages: [] } },
  async sendMessage() { throw new Error('send is disabled') },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function makeContext(): ServerRpcContext {
  return {
    connection: {} as ServerRpcContext['connection'], apiLayer: 228,
    authKeyId: new Uint8Array(8), sessionId: Long.ONE, isAuthorized: true,
    sendUpdate() {}, getPlatformData: <T>() => null as T, setPlatformData() {},
  }
}

function createDialog(folders: DialogFolderStore, targetPlatform: IMPlatform = platform): DialogRpc {
  return new DialogRpc(
    targetPlatform, session, undefined, undefined, undefined, 1,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, folders,
  )
}

function rpcHarnessFor(dialogs: DialogRpc): CordisRpcTestHarness {
  const rpcHarness = createCordisRpcTestHarness()
  rpcHarness.register('messages.getDialogs', async (_context, request) =>
    dialogs.getDialogs(request as tl.messages.RawGetDialogsRequest))
  rpcHarness.register('messages.getPeerDialogs', async (_context, request) =>
    dialogs.getPeerDialogs(request as tl.messages.RawGetPeerDialogsRequest))
  rpcHarness.register('messages.getDialogFilters', async () => dialogs.getDialogFilters())
  rpcHarness.register('messages.updateDialogFilter', async (_context, request) => {
    await dialogs.updateDialogFilter(request as tl.messages.RawUpdateDialogFilterRequest)
    return { _: 'boolTrue' }
  })
  rpcHarness.register('messages.updateDialogFiltersOrder', async (_context, request) => {
    await dialogs.updateDialogFiltersOrder(request as tl.messages.RawUpdateDialogFiltersOrderRequest)
    return { _: 'boolTrue' }
  })
  rpcHarness.register('folders.editPeerFolders', async (_context, request) =>
    dialogs.editPeerFolders(request as tl.folders.RawEditPeerFoldersRequest))
  return rpcHarness
}

function getDialogs(
  folderId?: number,
  overrides: Partial<tl.messages.RawGetDialogsRequest> = {},
): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO, folderId,
    ...overrides,
  }
}

async function roundTripRpc(rpcHarness: CordisRpcTestHarness, query: tl.RpcMethod): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const decodedRequest = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpcHarness.dispatch(makeContext(), decodedRequest)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

function encodeRpcResult(requestId: Long, result: RpcResult): Uint8Array {
  let body: Uint8Array
  if (result._ === 'boolTrue' || result._ === 'boolFalse') {
    const writer = TlBinaryWriter.manual(4)
    writer.uint(result._ === 'boolTrue' ? BOOL_TRUE_ID : BOOL_FALSE_ID)
    body = writer.result()
  } else if (isBareVector(result)) {
    const items = result.items.map((item) => TlBinaryWriter.serializeObject(__tlWriterMap, item))
    const writer = TlBinaryWriter.manual(8 + items.reduce((size, item) => size + item.length, 0))
    writer.uint(VECTOR_ID)
    writer.uint(items.length)
    for (const item of items) writer.raw(item)
    body = writer.result()
  } else {
    body = TlBinaryWriter.serializeObject(__tlWriterMap, result)
  }
  const writer = TlBinaryWriter.manual(12 + body.length)
  writer.uint(RPC_RESULT_ID)
  writer.long(requestId)
  writer.raw(body)
  return writer.result()
}

function decodeRpcResult(bytes: Uint8Array): any {
  const reader = new TlBinaryReader(__tlReaderMap, bytes)
  expect(reader.uint()).toBe(RPC_RESULT_ID)
  reader.long(true)
  const constructor = reader.uint()
  if (constructor === BOOL_TRUE_ID) return { _: 'boolTrue' }
  if (constructor === BOOL_FALSE_ID) return { _: 'boolFalse' }
  if (constructor === VECTOR_ID) return reader.vector(reader.object, true)
  reader.pos -= 4
  return reader.object()
}

describe('dialog folders RPC e2e', () => {
  it('round-trips custom folders and archive moves through TL and SQLite restarts', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const folders = new DialogFolderStore(ctx.database)
    const rpcHarness = rpcHarnessFor(createDialog(folders))
    const groupPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:group-a'), accessHash: Long.ONE,
    }
    const channelPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:channel-a'), accessHash: Long.ONE,
    }
    await roundTripRpc(rpcHarness, getDialogs())

    await expect(roundTripRpc(rpcHarness, {
      _: 'messages.updateDialogFilter', id: 2,
      filter: {
        _: 'dialogFilter', id: 2, groups: true, excludeArchived: true,
        title: {
          _: 'textWithEntities', text: '工作',
          entities: [{
            _: 'messageEntityCustomEmoji', offset: 0, length: 1, documentId: Long.fromNumber(42),
          }],
        },
        pinnedPeers: [groupPeer], includePeers: [groupPeer, channelPeer], excludePeers: [],
      },
    })).resolves.toEqual({ _: 'boolTrue' })
    await expect(roundTripRpc(rpcHarness, {
      _: 'messages.updateDialogFiltersOrder', order: [2, 0],
    })).resolves.toEqual({ _: 'boolTrue' })

    const resumedHarness = rpcHarnessFor(createDialog(new DialogFolderStore(ctx.database)))
    const filters = await roundTripRpc(resumedHarness, { _: 'messages.getDialogFilters' })
    expect(filters.filters.map((filter: tl.TypeDialogFilter) => filter._)).toEqual([
      'dialogFilter', 'dialogFilterDefault',
    ])
    expect(filters.filters[0]).toMatchObject({
      _: 'dialogFilter', id: 2, groups: true, excludeArchived: true,
      title: {
        _: 'textWithEntities', text: '工作',
        entities: [{ _: 'messageEntityCustomEmoji', documentId: Long.fromNumber(42) }],
      },
      pinnedPeers: [groupPeer], includePeers: [groupPeer, channelPeer],
    })

    const archived = await roundTripRpc(resumedHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })
    expect(archived).toMatchObject({
      _: 'updates', updates: [{
        _: 'updateFolderPeers', ptsCount: 1,
        folderPeers: [{ _: 'folderPeer', folderId: 1 }],
      }],
    })
    await expect(roundTripRpc(resumedHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })).resolves.toMatchObject({
      _: 'updates', updates: [{ _: 'updateFolderPeers', ptsCount: 0 }],
    })

    const main = await roundTripRpc(resumedHarness, getDialogs(0))
    expect(main.dialogs.map((dialog: tl.RawDialog) => dialog.peer)).toEqual([
      { _: 'peerUser', userId: stableId('peer:alice') },
      { _: 'peerChannel', channelId: stableId('peer:channel-a') },
    ])
    const archive = await roundTripRpc(resumedHarness, getDialogs(1))
    expect(archive.dialogs).toMatchObject([{
      _: 'dialog', peer: { _: 'peerChannel', channelId: stableId('peer:group-a') }, folderId: 1,
    }])
    const peerArchive = await roundTripRpc(resumedHarness, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeerFolder', folderId: 1 }],
    })
    expect(peerArchive.dialogs).toMatchObject([{
      _: 'dialog', peer: { _: 'peerChannel', channelId: stableId('peer:group-a') }, folderId: 1,
    }])

    const secondRestart = rpcHarnessFor(createDialog(new DialogFolderStore(ctx.database)))
    await roundTripRpc(secondRestart, getDialogs(1))
    await expect(roundTripRpc(secondRestart, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 0 }],
    })).resolves.toMatchObject({
      _: 'updates', updates: [{ _: 'updateFolderPeers', ptsCount: 1 }],
    })
    const unarchived = await roundTripRpc(secondRestart, getDialogs())
    expect(unarchived.dialogs).toHaveLength(3)
    expect(unarchived.dialogs.every((dialog: tl.RawDialog) => dialog.folderId === undefined)).toBe(true)
  })

  it('keeps an unscoped Android page full when QQ archive conversion removes main-list rows', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const source = Array.from({ length: 130 }, (_, index): IMDialog => {
      const id = `android-dialog-${String(index).padStart(3, '0')}`
      return {
        conversation: {
          id, kind: 'group', title: id,
          metadata: { qqGroupMsgMask: index < 40 ? 2 : 1 },
        },
        unreadCount: 0,
        lastMessage: {
          id: `message-${index}`, conversationId: id, senderId: id,
          timestamp: 2_000_000_000 - index,
          content: { parts: [{ type: 'text', text: id }] },
        },
      }
    })
    const targetPlatform: IMPlatform = {
      ...platform,
      platformKind: 'qq',
      async getDialogs(_session, query) {
        const start = query?.afterId
          ? source.findIndex((dialog) => dialog.conversation.id === query.afterId) + 1
          : 0
        const limit = query?.limit ?? source.length
        return {
          dialogs: source.slice(Math.max(0, start), Math.max(0, start) + limit),
          total: source.length,
        }
      },
      async getHistory() { return { messages: [] } },
    }
    const rpcHarness = rpcHarnessFor(createDialog(new DialogFolderStore(ctx.database), targetPlatform))

    const first = await roundTripRpc(rpcHarness, getDialogs())
    expect(first).toMatchObject({ _: 'messages.dialogsSlice', count: 130 })
    expect(first.dialogs).toHaveLength(100)
    expect(first.dialogs.slice(0, 40).every((dialog: tl.RawDialog) => dialog.folderId === 1)).toBe(true)
    const last = first.dialogs.at(-1) as tl.RawDialog
    const lastMessage = first.messages.find((message: tl.RawMessage) => message.id === last.topMessage) as tl.RawMessage

    const second = await roundTripRpc(rpcHarness, getDialogs(undefined, {
      offsetPeer: {
        _: 'inputPeerChannel', channelId: stableId('peer:android-dialog-099'), accessHash: Long.ONE,
      },
      offsetId: last.topMessage,
      offsetDate: lastMessage.date,
    }))
    expect(second.dialogs).toHaveLength(30)
    expect(second.dialogs.map((dialog: tl.RawDialog) =>
      (dialog.peer as tl.RawPeerChannel).channelId)).toEqual(
      Array.from({ length: 30 }, (_, index) => stableId(
        `peer:android-dialog-${String(index + 100).padStart(3, '0')}`,
      )),
    )

    const explicitMain = await roundTripRpc(rpcHarness, getDialogs(0))
    expect(explicitMain.dialogs).toHaveLength(90)
    expect(explicitMain.dialogs.every((dialog: tl.RawDialog) => dialog.folderId === undefined)).toBe(true)
  })

  it('reverse-syncs QQ group masks when archive folders change', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const qqGroup = {
      id: 'qq-group', kind: 'group' as const, title: 'QQ group', metadata: { qqGroupMsgMask: 1 },
    }
    const plainGroup = { id: 'plain-group', kind: 'group' as const, title: 'Plain group' }
    const maskCalls: Array<{ conversationId: string, mask: number }> = []
    const targetPlatform: IMPlatform = {
      ...platform,
      platformKind: 'qq',
      async getDialogs() {
        return { dialogs: [
          { conversation: qqGroup, unreadCount: 0 },
          { conversation: plainGroup, unreadCount: 0 },
        ] }
      },
      async getHistory() { return { messages: [] } },
      async setConversationNotificationMask(_session, conversationId, mask) {
        maskCalls.push({ conversationId, mask })
      },
    }
    const folders = new DialogFolderStore(ctx.database)
    const rpcHarness = rpcHarnessFor(createDialog(folders, targetPlatform))
    const peer = (id: string) => ({
      _: 'inputPeerChannel' as const, channelId: stableId(`peer:${id}`), accessHash: Long.ONE,
    })
    await roundTripRpc(rpcHarness, getDialogs())

    await roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: peer('plain-group'), folderId: 1 }],
    })
    expect(maskCalls).toEqual([])

    await roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: peer('qq-group'), folderId: 1 }],
    })
    expect(maskCalls).toEqual([{ conversationId: 'qq-group', mask: 2 }])

    await roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: peer('qq-group'), folderId: 1 }],
    })
    expect(maskCalls).toHaveLength(1)

    await roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: peer('qq-group'), folderId: 0 }],
    })
    expect(maskCalls).toEqual([
      { conversationId: 'qq-group', mask: 2 },
      { conversationId: 'qq-group', mask: 1 },
    ])
  })

  it('retries failed QQ group mask syncs after the archive row is persisted', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const group = {
      id: 'retry-group', kind: 'group' as const, title: 'Retry group', metadata: { qqGroupMsgMask: 1 },
    }
    const maskCalls: number[] = []
    let failFirstArchiveMask = true
    const targetPlatform: IMPlatform = {
      ...platform,
      platformKind: 'qq',
      async getDialogs() { return { dialogs: [{ conversation: group, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async setConversationNotificationMask(_session, _conversationId, mask) {
        maskCalls.push(mask)
        if (mask === 2 && failFirstArchiveMask) {
          failFirstArchiveMask = false
          throw new Error('temporary QQ failure')
        }
        group.metadata.qqGroupMsgMask = mask
      },
    }
    const folders = new DialogFolderStore(ctx.database)
    const rpcHarness = rpcHarnessFor(createDialog(folders, targetPlatform))
    const groupPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:retry-group'), accessHash: Long.ONE,
    }
    const archiveRequest = {
      _: 'folders.editPeerFolders' as const,
      folderPeers: [{ _: 'inputFolderPeer' as const, peer: groupPeer, folderId: 1 }],
    }
    await roundTripRpc(rpcHarness, getDialogs())

    await expect(roundTripRpc(rpcHarness, archiveRequest)).resolves.toMatchObject({
      _: 'updates', updates: [{ _: 'updateFolderPeers', ptsCount: 1 }],
    })
    expect(await folders.archivedPeerIds(session.platformSessionId)).toContain('retry-group')

    expect(group.metadata.qqGroupMsgMask).toBe(1)
    const resumedHarness = rpcHarnessFor(createDialog(folders, targetPlatform))
    await roundTripRpc(resumedHarness, getDialogs())

    await expect(roundTripRpc(resumedHarness, archiveRequest)).resolves.toMatchObject({
      _: 'updates', updates: [{ _: 'updateFolderPeers', ptsCount: 0 }],
    })
    expect(maskCalls).toEqual([2, 2])

    await roundTripRpc(resumedHarness, archiveRequest)
    expect(maskCalls).toEqual([2, 2])

    const main = await roundTripRpc(resumedHarness, getDialogs(0))
    expect(main.dialogs).toEqual([])
    const archive = await roundTripRpc(resumedHarness, getDialogs(1))
    expect(archive.dialogs).toMatchObject([{
      _: 'dialog', peer: { _: 'peerChannel', channelId: stableId('peer:retry-group') }, folderId: 1,
    }])
  })

  it('recovers the folder edit queue after an invalid folder request', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const group = {
      id: 'queue-recovery-group', kind: 'group' as const, title: 'Queue recovery group',
      metadata: { qqGroupMsgMask: 1 },
    }
    const maskCalls: number[] = []
    const targetPlatform: IMPlatform = {
      ...platform,
      platformKind: 'qq',
      async getDialogs() { return { dialogs: [{ conversation: group, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async setConversationNotificationMask(_session, _conversationId, mask) {
        maskCalls.push(mask)
      },
    }
    const folders = new DialogFolderStore(ctx.database)
    const dialogs = createDialog(folders, targetPlatform)
    const rpcHarness = rpcHarnessFor(dialogs)
    const groupPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:queue-recovery-group'), accessHash: Long.ONE,
    }

    await expect(dialogs.editPeerFolders({
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 2 }],
    })).rejects.toMatchObject({ code: 400, text: 'FOLDER_ID_INVALID' })

    await expect(roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })).resolves.toMatchObject({
      _: 'updates', updates: [{ _: 'updateFolderPeers', ptsCount: 1 }],
    })
    expect(maskCalls).toEqual([2])
  })

  it('does not reverse-sync group masks on non-QQ platforms', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const group = {
      id: 'metadata-group', kind: 'group' as const, title: 'Metadata group', metadata: { qqGroupMsgMask: 1 },
    }
    const maskCalls: Array<{ conversationId: string, mask: number }> = []
    const targetPlatform: IMPlatform = {
      ...platform,
      async getDialogs() { return { dialogs: [{ conversation: group, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async setConversationNotificationMask(_session, conversationId, mask) {
        maskCalls.push({ conversationId, mask })
      },
    }
    const folders = new DialogFolderStore(ctx.database)
    const rpcHarness = rpcHarnessFor(createDialog(folders, targetPlatform))
    const groupPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:metadata-group'), accessHash: Long.ONE,
    }
    await roundTripRpc(rpcHarness, getDialogs())

    await roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })
    expect(maskCalls).toEqual([])
  })

  it('serializes archive and unarchive QQ mask reverse-syncs', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const group = {
      id: 'queued-group', kind: 'group' as const, title: 'Queued group', metadata: { qqGroupMsgMask: 1 },
    }
    const maskCalls: number[] = []
    let releaseArchiveMask!: () => void
    const archiveMaskReleased = new Promise<void>((resolve) => { releaseArchiveMask = resolve })
    let markArchiveMaskStarted!: () => void
    const archiveMaskStarted = new Promise<void>((resolve) => { markArchiveMaskStarted = resolve })
    const targetPlatform: IMPlatform = {
      ...platform,
      platformKind: 'qq',
      async getDialogs() { return { dialogs: [{ conversation: group, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async setConversationNotificationMask(_session, _conversationId, mask) {
        maskCalls.push(mask)
        if (mask === 2) {
          markArchiveMaskStarted()
          await archiveMaskReleased
        }
      },
    }
    const folders = new DialogFolderStore(ctx.database)
    const rpcHarness = rpcHarnessFor(createDialog(folders, targetPlatform))
    const groupPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:queued-group'), accessHash: Long.ONE,
    }
    await roundTripRpc(rpcHarness, getDialogs())

    const archive = roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })
    await archiveMaskStarted
    const unarchive = roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 0 }],
    })
    await Promise.resolve()
    expect(maskCalls).toEqual([2])

    releaseArchiveMask()
    const [archiveResult, unarchiveResult] = await Promise.all([archive, unarchive])
    expect(maskCalls).toEqual([2, 1])
    expect(archiveResult.updates[0]).toMatchObject({ ptsCount: 1 })
    expect(unarchiveResult.updates[0]).toMatchObject({ ptsCount: 1 })
    expect(archiveResult.updates[0].pts).toBeLessThan(unarchiveResult.updates[0].pts)
    expect(await folders.archivedPeerIds(session.platformSessionId)).toEqual(new Set())

    const main = await roundTripRpc(rpcHarness, getDialogs())
    expect(main.dialogs).toMatchObject([{
      peer: { _: 'peerChannel', channelId: stableId('peer:queued-group') },
    }])
    const archiveDialogs = await roundTripRpc(rpcHarness, getDialogs(1))
    expect(archiveDialogs.dialogs).toEqual([])
  })

  it('uses QQ group masks as transient folder overrides from the first query', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const maskedDialogs: IMDialog[] = [
      { conversation: { id: 'mask-notify', kind: 'group', title: 'Notify', metadata: { qqGroupMsgMask: 1 } }, unreadCount: 0 },
      { conversation: { id: 'mask-assistant', kind: 'group', title: 'Assistant', metadata: { qqGroupMsgMask: 2 } }, unreadCount: 0 },
      { conversation: { id: 'mask-receive', kind: 'group', title: 'Receive', metadata: { qqGroupMsgMask: 4 } }, unreadCount: 0 },
      { conversation: { id: 'mask-unspecified', kind: 'group', title: 'Unspecified', metadata: { qqGroupMsgMask: 0 } }, unreadCount: 0 },
      { conversation: { id: 'mask-shield', kind: 'group', title: 'Shield', metadata: { qqGroupMsgMask: 3 } }, unreadCount: 0 },
    ]
    const targetPlatform: IMPlatform = {
      ...platform,
      async getDialogs(_session, query) {
        const start = query?.afterId
          ? maskedDialogs.findIndex((dialog) => dialog.conversation.id === query.afterId) + 1
          : 0
        const limit = query?.limit ?? maskedDialogs.length
        return { dialogs: maskedDialogs.slice(Math.max(0, start), Math.max(0, start) + limit), total: maskedDialogs.length }
      },
      async getHistory() { return { messages: [] } },
    }
    const folders = new DialogFolderStore(ctx.database)
    const rpcHarness = rpcHarnessFor(createDialog(folders, targetPlatform))
    const peer = (id: string) => ({
      _: 'inputPeerChannel' as const, channelId: stableId(`peer:${id}`), accessHash: Long.ONE,
    })
    const ids = (result: any) => result.dialogs.map((dialog: tl.RawDialog) =>
      (dialog.peer as tl.RawPeerChannel).channelId)

    const initialMain = await roundTripRpc(rpcHarness, getDialogs(0))
    expect(ids(initialMain)).toEqual([
      stableId('peer:mask-notify'), stableId('peer:mask-receive'),
      stableId('peer:mask-unspecified'), stableId('peer:mask-shield'),
    ])
    const initialArchive = await roundTripRpc(rpcHarness, getDialogs(1))
    expect(initialArchive.dialogs).toMatchObject([{
      peer: { _: 'peerChannel', channelId: stableId('peer:mask-assistant') }, folderId: 1,
    }])

    await roundTripRpc(rpcHarness, {
      _: 'folders.editPeerFolders',
      folderPeers: [
        { _: 'inputFolderPeer', peer: peer('mask-notify'), folderId: 1 },
        { _: 'inputFolderPeer', peer: peer('mask-assistant'), folderId: 0 },
        { _: 'inputFolderPeer', peer: peer('mask-receive'), folderId: 1 },
        { _: 'inputFolderPeer', peer: peer('mask-unspecified'), folderId: 1 },
        { _: 'inputFolderPeer', peer: peer('mask-shield'), folderId: 1 },
      ],
    })
    const main = await roundTripRpc(rpcHarness, getDialogs(0))
    expect(ids(main)).toEqual([stableId('peer:mask-notify'), stableId('peer:mask-receive')])
    const archive = await roundTripRpc(rpcHarness, getDialogs(1))
    expect(ids(archive)).toEqual([
      stableId('peer:mask-assistant'), stableId('peer:mask-unspecified'), stableId('peer:mask-shield'),
    ])
    expect(archive.dialogs[0]).toMatchObject({ folderId: 1 })

    const peerMain = await roundTripRpc(rpcHarness, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeerFolder', folderId: 0 }],
    })
    expect(ids(peerMain)).toEqual([stableId('peer:mask-notify'), stableId('peer:mask-receive')])
    const peerArchive = await roundTripRpc(rpcHarness, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeerFolder', folderId: 1 }],
    })
    expect(ids(peerArchive)).toEqual([
      stableId('peer:mask-assistant'), stableId('peer:mask-unspecified'), stableId('peer:mask-shield'),
    ])
  })
})
