import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import {
  RpcDispatcher, isBareVector, type RpcResult, type ServerRpcContext,
} from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogFolderStore } from './dialog-folders.js'
import { DialogRpc, stableId } from './dialogs.js'
import { defineModels } from './models.js'
import type { IMDialog, IMPlatform, PlatformSession } from './platform.js'

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

function dispatcherFor(dialogs: DialogRpc): RpcDispatcher {
  const dispatcher = new RpcDispatcher()
  dispatcher.register('messages.getDialogs', async (_context, request) =>
    dialogs.getDialogs(request as tl.messages.RawGetDialogsRequest))
  dispatcher.register('messages.getPeerDialogs', async (_context, request) =>
    dialogs.getPeerDialogs(request as tl.messages.RawGetPeerDialogsRequest))
  dispatcher.register('messages.getDialogFilters', async () => dialogs.getDialogFilters())
  dispatcher.register('messages.updateDialogFilter', async (_context, request) => {
    await dialogs.updateDialogFilter(request as tl.messages.RawUpdateDialogFilterRequest)
    return { _: 'boolTrue' }
  })
  dispatcher.register('messages.updateDialogFiltersOrder', async (_context, request) => {
    await dialogs.updateDialogFiltersOrder(request as tl.messages.RawUpdateDialogFiltersOrderRequest)
    return { _: 'boolTrue' }
  })
  dispatcher.register('folders.editPeerFolders', async (_context, request) =>
    dialogs.editPeerFolders(request as tl.folders.RawEditPeerFoldersRequest))
  return dispatcher
}

function getDialogs(folderId?: number): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO, folderId,
  }
}

async function roundTripRpc(dispatcher: RpcDispatcher, query: tl.RpcMethod): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const decodedRequest = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await dispatcher.dispatch(makeContext(), decodedRequest)
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
    const dispatcher = dispatcherFor(createDialog(folders))
    const groupPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:group-a'), accessHash: Long.ONE,
    }
    const channelPeer = {
      _: 'inputPeerChannel' as const, channelId: stableId('peer:channel-a'), accessHash: Long.ONE,
    }
    await roundTripRpc(dispatcher, getDialogs())

    await expect(roundTripRpc(dispatcher, {
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
    await expect(roundTripRpc(dispatcher, {
      _: 'messages.updateDialogFiltersOrder', order: [2, 0],
    })).resolves.toEqual({ _: 'boolTrue' })

    const resumedDispatcher = dispatcherFor(createDialog(new DialogFolderStore(ctx.database)))
    const filters = await roundTripRpc(resumedDispatcher, { _: 'messages.getDialogFilters' })
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

    const archived = await roundTripRpc(resumedDispatcher, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })
    expect(archived).toMatchObject({
      _: 'updates', updates: [{
        _: 'updateFolderPeers', ptsCount: 1,
        folderPeers: [{ _: 'folderPeer', folderId: 1 }],
      }],
    })
    await expect(roundTripRpc(resumedDispatcher, {
      _: 'folders.editPeerFolders',
      folderPeers: [{ _: 'inputFolderPeer', peer: groupPeer, folderId: 1 }],
    })).resolves.toMatchObject({
      _: 'updates', updates: [{ _: 'updateFolderPeers', ptsCount: 0 }],
    })

    const main = await roundTripRpc(resumedDispatcher, getDialogs())
    expect(main.dialogs.map((dialog: tl.RawDialog) => dialog.peer)).toEqual([
      { _: 'peerUser', userId: stableId('peer:alice') },
      { _: 'peerChannel', channelId: stableId('peer:channel-a') },
    ])
    const archive = await roundTripRpc(resumedDispatcher, getDialogs(1))
    expect(archive.dialogs).toMatchObject([{
      _: 'dialog', peer: { _: 'peerChannel', channelId: stableId('peer:group-a') }, folderId: 1,
    }])
    const peerArchive = await roundTripRpc(resumedDispatcher, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeerFolder', folderId: 1 }],
    })
    expect(peerArchive.dialogs).toMatchObject([{
      _: 'dialog', peer: { _: 'peerChannel', channelId: stableId('peer:group-a') }, folderId: 1,
    }])

    const secondRestart = dispatcherFor(createDialog(new DialogFolderStore(ctx.database)))
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
    const dispatcher = dispatcherFor(createDialog(folders, targetPlatform))
    const peer = (id: string) => ({
      _: 'inputPeerChannel' as const, channelId: stableId(`peer:${id}`), accessHash: Long.ONE,
    })
    const ids = (result: any) => result.dialogs.map((dialog: tl.RawDialog) =>
      (dialog.peer as tl.RawPeerChannel).channelId)

    const initialMain = await roundTripRpc(dispatcher, getDialogs())
    expect(ids(initialMain)).toEqual([
      stableId('peer:mask-notify'), stableId('peer:mask-receive'),
      stableId('peer:mask-unspecified'), stableId('peer:mask-shield'),
    ])
    const initialArchive = await roundTripRpc(dispatcher, getDialogs(1))
    expect(initialArchive.dialogs).toMatchObject([{
      peer: { _: 'peerChannel', channelId: stableId('peer:mask-assistant') }, folderId: 1,
    }])

    await roundTripRpc(dispatcher, {
      _: 'folders.editPeerFolders',
      folderPeers: [
        { _: 'inputFolderPeer', peer: peer('mask-notify'), folderId: 1 },
        { _: 'inputFolderPeer', peer: peer('mask-assistant'), folderId: 0 },
        { _: 'inputFolderPeer', peer: peer('mask-receive'), folderId: 1 },
        { _: 'inputFolderPeer', peer: peer('mask-unspecified'), folderId: 1 },
        { _: 'inputFolderPeer', peer: peer('mask-shield'), folderId: 1 },
      ],
    })
    const main = await roundTripRpc(dispatcher, getDialogs())
    expect(ids(main)).toEqual([stableId('peer:mask-notify'), stableId('peer:mask-receive')])
    const archive = await roundTripRpc(dispatcher, getDialogs(1))
    expect(ids(archive)).toEqual([
      stableId('peer:mask-assistant'), stableId('peer:mask-unspecified'), stableId('peer:mask-shield'),
    ])
    expect(archive.dialogs[0]).toMatchObject({ folderId: 1 })

    const peerMain = await roundTripRpc(dispatcher, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeerFolder', folderId: 0 }],
    })
    expect(ids(peerMain)).toEqual([stableId('peer:mask-notify'), stableId('peer:mask-receive')])
    const peerArchive = await roundTripRpc(dispatcher, {
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeerFolder', folderId: 1 }],
    })
    expect(ids(peerArchive)).toEqual([
      stableId('peer:mask-assistant'), stableId('peer:mask-unspecified'), stableId('peer:mask-shield'),
    ])
  })
})
