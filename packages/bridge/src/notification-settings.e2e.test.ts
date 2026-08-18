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
import { DialogRpc, stableId } from './dialogs.js'
import { defineModels } from './models.js'
import { MUTE_FOREVER, NotificationSettingsStore } from './notification-settings.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { createCordisRpcTestHarness, type CordisRpcTestHarness } from './rpc-test-harness.js'

const RPC_RESULT_ID = 0xf35c6d01
const VECTOR_ID = 0x1cb5c415
const BOOL_TRUE_ID = 0x997275b5
const BOOL_FALSE_ID = 0xbc799737

const session: PlatformSession = {
  platformSessionId: 'notification-session', platformId: 'test', userId: 'self',
  credentials: {}, metadata: {},
}
const group: IMConversation = { id: 'group-1', kind: 'group', title: 'Noisy group' }
const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
    conversations: { groups: true, channels: true, subchannels: false },
  },
  async subscribe() { return () => {} },
  async getDialogs() {
    return {
      dialogs: [{
        conversation: group, unreadCount: 3,
        lastMessage: {
          id: 'message-1', conversationId: group.id, senderId: 'member-1', timestamp: 1,
          content: { parts: [{ type: 'text', text: 'ping' }] },
        },
      }],
    }
  },
  async getHistory() {
    return {
      messages: [{
        id: 'message-1', conversationId: group.id, senderId: 'member-1', timestamp: 1,
        content: { parts: [{ type: 'text', text: 'ping' }] },
      }],
    }
  },
  async getUser(_session, id) { return { id, firstName: id } },
  async sendMessage() { throw new Error('send is disabled') },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

function makeContext(): ServerRpcContext {
  return {
    connection: {} as ServerRpcContext['connection'],
    apiLayer: 228,
    authKeyId: new Uint8Array(8),
    sessionId: Long.ONE,
    isAuthorized: true,
    sendUpdate() {},
    getPlatformData: <T>() => null as T,
    setPlatformData() {},
  }
}

function createDialog(settings: NotificationSettingsStore, targetPlatform: IMPlatform = platform): DialogRpc {
  return new DialogRpc(
    targetPlatform, session, undefined, undefined, undefined, 1,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    settings,
  )
}

function rpcHarnessFor(
  dialogs: DialogRpc,
  onReset?: (updates: tl.RawUpdateNotifySettings[]) => void,
): CordisRpcTestHarness {
  const rpcHarness = createCordisRpcTestHarness()
  rpcHarness.register('account.getNotifySettings', async (_context, request) =>
    dialogs.getNotifySettings(request as tl.account.RawGetNotifySettingsRequest))
  rpcHarness.register('account.updateNotifySettings', async (_context, request) => {
    await dialogs.updateNotifySettings(request as tl.account.RawUpdateNotifySettingsRequest)
    return { _: 'boolTrue' }
  })
  rpcHarness.register('account.resetNotifySettings', async () => {
    onReset?.(await dialogs.resetNotifySettings())
    return { _: 'boolTrue' }
  })
  rpcHarness.register('account.getNotifyExceptions', async (_context, request) =>
    dialogs.getNotifyExceptions(request as tl.account.RawGetNotifyExceptionsRequest))
  return rpcHarness
}

async function roundTripRpc(rpcHarness: CordisRpcTestHarness, query: tl.RpcMethod): Promise<unknown> {
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
    const items = result.items.map(item => TlBinaryWriter.serializeObject(__tlWriterMap, item))
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

function decodeRpcResult(bytes: Uint8Array): unknown {
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

function roundTripObject<T>(value: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, value as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('notification settings RPC e2e', () => {
  it('keeps muted groups exceptional for explicit mentions and replies to the current user', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const mentionGroup: IMConversation = { id: 'muted-mention', kind: 'group', title: 'Muted mention' }
    const replyGroup: IMConversation = { id: 'muted-reply', kind: 'group', title: 'Muted reply' }
    const mention: IMMessage = {
      id: 'mention', conversationId: mentionGroup.id, senderId: 'alice', timestamp: 20,
      content: { parts: [{
        type: 'text', text: '@self ping',
        entities: [{ type: 'mention', offset: 0, length: 5, userId: session.userId }],
      }] },
    }
    const ownMessage: IMMessage = {
      id: 'own-message', conversationId: replyGroup.id, senderId: session.userId,
      outgoing: true, timestamp: 21, content: { parts: [{ type: 'text', text: 'question' }] },
    }
    const reply: IMMessage = {
      id: 'reply', conversationId: replyGroup.id, senderId: 'bob', replyToId: ownMessage.id,
      timestamp: 22, content: { parts: [{ type: 'text', text: 'answer' }] },
    }
    const histories = new Map([
      [mentionGroup.id, [mention]],
      [replyGroup.id, [ownMessage, reply]],
    ])
    const targetPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [
          { conversation: replyGroup, unreadCount: 1, lastMessage: reply, readInboxMaxMessage: ownMessage },
          { conversation: mentionGroup, unreadCount: 1, lastMessage: mention },
        ] }
      },
      async getHistory(_session, conversation) {
        return { messages: histories.get(conversation.id) ?? [] }
      },
    }
    const settings = new NotificationSettingsStore(ctx.database, true)
    const dialogs = createDialog(settings, targetPlatform)
    await expect(roundTripRpc(rpcHarnessFor(dialogs), {
      _: 'account.getNotifySettings', peer: { _: 'inputNotifyChats' },
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: MUTE_FOREVER })
    const page = roundTripObject(await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })) as tl.messages.RawDialogs

    expect(page.dialogs).toHaveLength(2)
    expect(page.dialogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        unreadMentionsCount: 1,
        notifySettings: expect.objectContaining({ _: 'peerNotifySettings' }),
      }),
      expect.objectContaining({
        unreadMentionsCount: 1,
        notifySettings: expect.objectContaining({ _: 'peerNotifySettings' }),
      }),
    ]))
    expect(page.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'message', message: '@self ping', mentioned: true }),
      expect.objectContaining({
        _: 'message', message: 'answer', mentioned: true,
        replyTo: expect.objectContaining({ _: 'messageReplyHeader' }),
      }),
    ]))
  })

  it('mirrors QQ group message masks in peer notify settings and dialog materialization', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const groups: IMConversation[] = [
      { id: 'mask-notify', kind: 'group', title: 'Notify', metadata: { qqGroupMsgMask: 1 } },
      { id: 'mask-assistant', kind: 'group', title: 'Assistant', metadata: { qqGroupMsgMask: 2 } },
      { id: 'mask-receive', kind: 'group', title: 'Receive', metadata: { qqGroupMsgMask: 4 } },
      { id: 'mask-unspecified', kind: 'group', title: 'Unspecified', metadata: { qqGroupMsgMask: 0 } },
      { id: 'mask-shield', kind: 'group', title: 'Shield', metadata: { qqGroupMsgMask: 3 } },
    ]
    const targetPlatform: IMPlatform = {
      ...platform,
      async getDialogs() { return { dialogs: groups.map(conversation => ({ conversation, unreadCount: 0 })) } },
      async getHistory() { return { messages: [] } },
    }
    const settings = new NotificationSettingsStore(ctx.database, true)
    const dialogs = createDialog(settings, targetPlatform)
    const rpcHarness = rpcHarnessFor(dialogs)
    await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const peer = (id: string) => ({
      _: 'inputNotifyPeer' as const,
      peer: { _: 'inputPeerChannel' as const, channelId: stableId(`peer:${id}`), accessHash: Long.ONE },
    })

    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('mask-notify'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: MUTE_FOREVER },
    })).resolves.toEqual({ _: 'boolTrue' })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('mask-unspecified'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: 123 },
    })).resolves.toEqual({ _: 'boolTrue' })

    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('mask-notify'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 0 })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('mask-assistant'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: MUTE_FOREVER })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('mask-receive'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: MUTE_FOREVER })
    const assistantTopic = {
      _: 'inputNotifyForumTopic' as const,
      peer: peer('mask-assistant').peer,
      topMsgId: 1,
    }
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: assistantTopic,
      settings: { _: 'inputPeerNotifySettings', muteUntil: 456 },
    })).resolves.toEqual({ _: 'boolTrue' })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: assistantTopic,
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 456 })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('mask-unspecified'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 123 })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('mask-shield'),
    })).resolves.toEqual({ _: 'peerNotifySettings' })

    const page = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    if (page._ === 'messages.dialogsNotModified') throw new Error('expected materialized dialogs')
    const archive = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO, folderId: 1,
    })
    if (archive._ === 'messages.dialogsNotModified') throw new Error('expected materialized archive')
    const muteUntilByPeer = new Map([...page.dialogs, ...archive.dialogs]
      .filter((dialog): dialog is tl.RawDialog => dialog._ === 'dialog')
      .map((dialog) => [
        (dialog.peer as tl.RawPeerChannel).channelId,
        dialog.notifySettings.muteUntil,
      ]))
    expect(muteUntilByPeer.get(stableId('peer:mask-notify'))).toBe(0)
    expect(muteUntilByPeer.get(stableId('peer:mask-assistant'))).toBe(MUTE_FOREVER)
    expect(muteUntilByPeer.get(stableId('peer:mask-receive'))).toBe(MUTE_FOREVER)
    expect(muteUntilByPeer.get(stableId('peer:mask-unspecified'))).toBe(123)
    expect(muteUntilByPeer.get(stableId('peer:mask-shield'))).toBeUndefined()
  })

  it('round-trips group defaults and durable per-chat overrides through TL and SQLite', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const settings = new NotificationSettingsStore(ctx.database, true)
    const dialogs = createDialog(settings)
    await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const rpcHarness = rpcHarnessFor(dialogs)

    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: { _: 'inputNotifyChats' },
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: MUTE_FOREVER })

    const peer = {
      _: 'inputNotifyPeer' as const,
      peer: { _: 'inputPeerChannel' as const, channelId: stableId('peer:group-1'), accessHash: Long.ONE },
    }
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer,
      settings: { _: 'inputPeerNotifySettings', muteUntil: 0 },
    })).resolves.toEqual({ _: 'boolTrue' })

    const resumedSettings = new NotificationSettingsStore(ctx.database, true)
    const resumedDialogs = createDialog(resumedSettings)
    const resumedPage = await resumedDialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    if (resumedPage._ === 'messages.dialogsNotModified') throw new Error('expected materialized dialogs')
    expect(resumedPage.dialogs[0]).toMatchObject({
      _: 'dialog', notifySettings: { _: 'peerNotifySettings', muteUntil: 0 },
    })

    const resetUpdates: tl.RawUpdateNotifySettings[][] = []
    const resumedHarness = rpcHarnessFor(resumedDialogs, updates => resetUpdates.push(updates))
    await expect(roundTripRpc(resumedHarness, {
      _: 'account.getNotifySettings', peer,
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 0 })
    await expect(roundTripRpc(resumedHarness, {
      _: 'account.getNotifyExceptions', peer: { _: 'inputNotifyChats' },
    })).resolves.toMatchObject({
      _: 'updates',
      updates: [{
        _: 'updateNotifySettings',
        peer: { _: 'notifyPeer', peer: { _: 'peerChannel', channelId: stableId('peer:group-1') } },
        notifySettings: { _: 'peerNotifySettings', muteUntil: 0 },
      }],
    })

    await expect(roundTripRpc(resumedHarness, {
      _: 'account.resetNotifySettings',
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(resetUpdates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _: 'updateNotifySettings',
        peer: { _: 'notifyChats' },
        notifySettings: expect.objectContaining({ muteUntil: MUTE_FOREVER }),
      }),
      {
        _: 'updateNotifySettings',
        peer: { _: 'notifyPeer', peer: { _: 'peerChannel', channelId: stableId('peer:group-1') } },
        notifySettings: { _: 'peerNotifySettings' },
      },
    ]))
    await expect(roundTripRpc(resumedHarness, {
      _: 'account.getNotifySettings', peer,
    })).resolves.toEqual({ _: 'peerNotifySettings' })
    await expect(roundTripRpc(resumedHarness, {
      _: 'account.getNotifySettings', peer: { _: 'inputNotifyChats' },
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: MUTE_FOREVER })
  })

  it('reverse-syncs Telegram mute state into the QQ group message mask', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const qqGroup: IMConversation = {
      id: 'qq-group', kind: 'group', title: 'QQ group',
      metadata: { qqGroupMsgMask: 1, qq: '1058754719', chatType: 2 },
    }
    const nonQqGroup: IMConversation = { id: 'plain-group', kind: 'group', title: 'Plain group' }
    const maskCalls: Array<{ conversationId: string, mask: number }> = []
    let maskFailure: Error | undefined
    const targetPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [
          { conversation: qqGroup, unreadCount: 0 },
          { conversation: nonQqGroup, unreadCount: 0 },
        ] }
      },
      async getHistory() { return { messages: [] } },
      async setConversationNotificationMask(_session, conversationId, mask) {
        if (maskFailure) throw maskFailure
        maskCalls.push({ conversationId, mask })
      },
    }
    const settings = new NotificationSettingsStore(ctx.database, true)
    const dialogs = createDialog(settings, targetPlatform)
    const rpcHarness = rpcHarnessFor(dialogs)
    await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    })
    const peer = (id: string) => ({
      _: 'inputNotifyPeer' as const,
      peer: { _: 'inputPeerChannel' as const, channelId: stableId(`peer:${id}`), accessHash: Long.ONE },
    })

    // mute → mask 4 (receive without notification)
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('qq-group'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: MUTE_FOREVER },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(maskCalls).toEqual([{ conversationId: 'qq-group', mask: 4 }])
    // overlay reflects the freshly written mask immediately
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('qq-group'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: MUTE_FOREVER })

    // unmute → mask 1 (notify)
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('qq-group'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: 0 },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(maskCalls).toEqual([
      { conversationId: 'qq-group', mask: 4 },
      { conversationId: 'qq-group', mask: 1 },
    ])
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('qq-group'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 0 })

    // a future timestamp also counts as muted → mask 4
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('qq-group'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: 9_999_999_999 },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(maskCalls.at(-1)).toEqual({ conversationId: 'qq-group', mask: 4 })

    // non-QQ group (no qqGroupMsgMask metadata) must not trigger a platform call
    const callsBeforePlain = maskCalls.length
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('plain-group'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: MUTE_FOREVER },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(maskCalls.length).toBe(callsBeforePlain)

    // return to mask 1 (unmute) so the overlay reflects muteUntil 0 before the
    // failure scenario, then verify a failed mute does not block the TG response
    // nor flip the overlay (the previous successful mask stays in effect).
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('qq-group'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: 0 },
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(maskCalls.at(-1)).toEqual({ conversationId: 'qq-group', mask: 1 })
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('qq-group'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 0 })

    maskFailure = new Error('upstream down')
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.updateNotifySettings', peer: peer('qq-group'),
      settings: { _: 'inputPeerNotifySettings', muteUntil: MUTE_FOREVER },
    })).resolves.toEqual({ _: 'boolTrue' })
    // overlay is unchanged (still mask 1) because the platform call failed
    await expect(roundTripRpc(rpcHarness, {
      _: 'account.getNotifySettings', peer: peer('qq-group'),
    })).resolves.toMatchObject({ _: 'peerNotifySettings', muteUntil: 0 })
    maskFailure = undefined
  })
})
