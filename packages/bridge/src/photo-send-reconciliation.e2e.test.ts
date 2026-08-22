import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import type { RpcResult, ServerRpcContext } from '@mtproto-relay/mtproto'
import { getServerReaderMap } from '../../mtproto/src/rpc/server-reader-map.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type {
  IMConversation, IMMessage, IMPlatform, PlatformSession,
} from './platform.js'
import { createCordisRpcTestHarness } from './rpc-test-harness.js'
import { UploadManager } from './upload-manager.js'

const RPC_RESULT_ID = 0xf35c6d01
const session: PlatformSession = {
  platformSessionId: 'photo-reconciliation-e2e',
  platformId: 'photo-reconciliation',
  userId: 'self',
  credentials: {},
  metadata: {},
}
const conversation: IMConversation = { id: 'peer', kind: 'direct', title: 'Peer' }
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
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

async function roundTripRpc(
  rpc: ReturnType<typeof createCordisRpcTestHarness>,
  query: tl.RpcMethod,
): Promise<any> {
  const requestBytes = TlBinaryWriter.serializeObject(__tlWriterMap, query)
  const request = new TlBinaryReader(getServerReaderMap(), requestBytes).object() as tl.RpcMethod
  const result = await rpc.dispatch(makeContext(), request)
  return decodeRpcResult(encodeRpcResult(Long.fromNumber(0x228), result))
}

function encodeRpcResult(requestId: Long, result: RpcResult): Uint8Array {
  const body = TlBinaryWriter.serializeObject(__tlWriterMap, result as tl.TlObject)
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
  return reader.object()
}

describe('photo send reconciliation RPC e2e', () => {
  it('round-trips one cached photo tier when QQ reports a distinct zero-byte 720 preview', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    const directory = await mkdtemp(join(tmpdir(), 'photo-reconciliation-e2e-'))
    disposals.push(async () => {
      await rm(directory, { recursive: true, force: true })
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
        conversations: { groups: true, channels: true, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id } },
      async sendMessage(_session, target, input): Promise<IMMessage> {
        const uploaded = input.parts.find((part) => part.type === 'media')
        if (!uploaded || uploaded.type !== 'media') throw new Error('expected uploaded photo')
        for await (const _chunk of uploaded.media.source.stream()) {
          // Exercise the complete staged-upload stream before the response is projected.
        }
        return {
          id: 'qq-photo',
          conversationId: target.id,
          senderId: session.userId,
          outgoing: true,
          timestamp: 1_800_000_000,
          content: { parts: [{ type: 'media', media: {
            id: 'qq-photo-element',
            kind: 'image',
            name: 'small.png',
            mimeType: 'image/png',
            size: 24,
            width: 277,
            height: 119,
            preview: {
              size: 0,
              width: 160,
              height: 90,
              locator: { imageSpec: 720 },
            },
            locator: { imageSpec: 0 },
          } }] },
        }
      },
    }
    const store = new MessageStore(ctx.database)
    const peerId = (await store.upsertUser(session, { id: conversation.id, firstName: conversation.title })).id
    const uploads = new UploadManager(directory)
    const dialogs = new DialogRpc(platform, session, store, uploads)
    const rpc = createCordisRpcTestHarness()
    rpc.register('messages.uploadMedia', async (_context, request) =>
      dialogs.uploadMedia(request as tl.messages.RawUploadMediaRequest))
    rpc.register('messages.sendMedia', async (context, request) =>
      dialogs.sendMedia(request as tl.messages.RawSendMediaRequest, context.connection))

    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    new DataView(png.buffer).setUint32(16, 277)
    new DataView(png.buffer).setUint32(20, 119)
    await uploads.savePart(session.platformSessionId, '901', 0, png)
    const peer = { _: 'inputPeerUser' as const, userId: peerId, accessHash: Long.ZERO }
    const uploaded = await roundTripRpc(rpc, {
      _: 'messages.uploadMedia',
      peer,
      media: {
        _: 'inputMediaUploadedPhoto',
        file: { _: 'inputFile', id: Long.fromNumber(901), parts: 1, name: 'small.png', md5Checksum: '' },
      },
    }) as tl.RawMessageMediaPhoto
    if (uploaded.photo?._ !== 'photo') throw new Error('expected staged photo')

    const sent = await roundTripRpc(rpc, {
      _: 'messages.sendMedia',
      peer,
      randomId: Long.fromNumber(902),
      message: '',
      media: {
        _: 'inputMediaPhoto',
        id: {
          _: 'inputPhoto',
          id: uploaded.photo.id,
          accessHash: uploaded.photo.accessHash,
          fileReference: uploaded.photo.fileReference,
        },
      },
    }) as tl.RawUpdates

    expect(sent.updates).toMatchObject([
      { _: 'updateMessageID', randomId: Long.fromNumber(902) },
      { _: 'updateNewMessage', message: { media: {
        _: 'messageMediaPhoto',
        photo: { _: 'photo', sizes: [
          { _: 'photoSize', type: 'x', w: 277, h: 119, size: 24 },
        ] },
      } } },
    ])
  })
})
