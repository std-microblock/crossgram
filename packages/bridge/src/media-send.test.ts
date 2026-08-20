import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { IMMessageSendRejectedError } from './platform.js'
import type {
  IMConversation, IMMedia, IMMessage, IMMessageInput, IMPlatform, IMTransferOptions, PlatformSession,
} from './platform.js'
import { UploadManager } from './upload-manager.js'
import { SystemPeerService, type SystemPeerProvider } from './system-peer.js'

const session: PlatformSession = {
  platformSessionId: 'send-media-session', platformId: 'streaming', userId: 'self', credentials: {}, metadata: {},
}
const conversation: IMConversation = { id: 'peer', kind: 'direct', title: 'Peer' }
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness(failSends = 0, systemPeerProvider?: SystemPeerProvider) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const directory = await mkdtemp(join(tmpdir(), 'bridge-media-send-'))
  const uploads = new UploadManager(directory)
  const consumed: Uint8Array[][] = []
  const remoteFiles: Uint8Array[] = []
  const inputs: IMMessageInput[] = []
  let sequence = 0
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
      conversations: { groups: true, channels: true, subchannels: true },
    },
    async subscribe() { return () => {} },
    async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
    async getHistory() { return { messages: [] } },
    async getUser(_session, id) { return { id, firstName: id } },
    async sendMessage(_session, target, content, options): Promise<IMMessage> {
      inputs.push(content)
      const outputParts: IMMessage['content']['parts'] = []
      let mediaIndex = 0
      for (const part of content.parts) {
        if (part.type === 'text') {
          outputParts.push(part)
          continue
        }
        if (part.type !== 'media') throw new Error('sticker input is not supported by this harness')
        const chunks: Uint8Array[] = []
        let transferredBytes = 0
        for await (const chunk of part.media.source.stream({ signal: options?.signal })) {
          chunks.push(chunk)
          transferredBytes += chunk.length
          await options?.onProgress?.({
            phase: 'upload', mediaIndex, transferredBytes, totalBytes: part.media.source.size,
          })
        }
        consumed.push(chunks)
        const remote = new Uint8Array(transferredBytes)
        let remoteOffset = 0
        for (const chunk of chunks) {
          remote.set(chunk, remoteOffset)
          remoteOffset += chunk.length
        }
        remoteFiles.push(remote)
        const media: IMMedia = {
          id: `remote-${mediaIndex}`, kind: part.media.kind, name: part.media.name,
          mimeType: part.media.mimeType, size: part.media.size,
          width: part.media.width, height: part.media.height,
          locator: { remote: mediaIndex },
        }
        outputParts.push({ type: 'media', media })
        mediaIndex++
      }
      if (failSends > 0) {
        failSends--
        throw new Error('simulated platform upload failure')
      }
      return {
        id: `sent-${++sequence}`, conversationId: target.id, senderId: 'self', outgoing: true,
        timestamp: 1_800_000_000 + sequence, content: { parts: outputParts },
      }
    },
    async *downloadMedia(_session, media, options) {
      const index = Number(media.id.replace('remote-', ''))
      const source = remoteFiles[index] ?? new Uint8Array()
      const offset = options?.offset ?? 0
      const bytes = source.subarray(offset, offset + (options?.limit ?? source.length))
      for (let position = 0; position < bytes.length; position += 4) {
        const chunk = bytes.subarray(position, position + 4)
        await options?.onProgress?.({
          phase: 'download', mediaIndex: index,
          transferredBytes: Math.min(position + chunk.length, bytes.length), totalBytes: bytes.length,
        })
        yield chunk
      }
    },
    async resolveMediaUrl(_session, media) {
      const locator = media.locator as { remote?: number } | undefined
      if (locator?.remote === undefined) return
      return {
        url: `https://cdn.example.test/media/${locator.remote}`,
        expiresAt: Date.now() + 60_000,
        supportsRange: true,
      }
    },
  }
  const progress: Array<{ mediaIndex: number, transferredBytes: number }> = []
  const store = new MessageStore(ctx.database)
  const peerId = (await store.upsertUser(session, { id: conversation.id, firstName: conversation.title })).id
  const systemPeers = systemPeerProvider ? new SystemPeerService(ctx) : undefined
  if (systemPeers && systemPeerProvider) systemPeers.register(systemPeerProvider)
  const rpc = new DialogRpc(platform, session, store, uploads, (_session, event) => {
    progress.push({ mediaIndex: event.mediaIndex, transferredBytes: event.transferredBytes })
  }, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, systemPeers)
  disposals.push(async () => {
    await rm(directory, { recursive: true, force: true })
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { rpc, platform, uploads, store, consumed, inputs, progress, peerId }
}

function inputFile(id: number, parts: number, name: string): tl.RawInputFile {
  return { _: 'inputFile', id: Long.fromNumber(id), parts, name, md5Checksum: '' }
}

function peer(userId: number): tl.RawInputPeerUser {
  return { _: 'inputPeerUser', userId, accessHash: Long.ZERO }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('media send streaming', () => {
  it('delivers uploaded files to a system peer without calling the backing platform', async () => {
    const received: Uint8Array[] = []
    const provider: SystemPeerProvider = {
      bootstrap: async () => {},
      resolve: async (_session, conversationId) => conversationId === conversation.id
        ? { id: conversation.id, conversation }
        : undefined,
      receive: async (_session, _peer, message, _peers, input) => {
        expect(message.content.parts).toMatchObject([{ type: 'media', media: { id: expect.stringMatching(/^bridge:system-peer-media:/) } }])
        const media = input?.parts.find((part) => part.type === 'media')
        if (!media || media.type !== 'media') throw new Error('missing system-peer media input')
        for await (const chunk of media.media.source.stream()) received.push(chunk)
      },
    }
    const { rpc, uploads, inputs, peerId } = await createHarness(0, provider)
    await uploads.savePart(session.platformSessionId, '314', 0, new TextEncoder().encode('flash-me'))

    const result = await rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(314), message: '',
      media: {
        _: 'inputMediaUploadedDocument', file: inputFile(314, 1, 'flash.txt'), mimeType: 'text/plain',
        attributes: [{ _: 'documentAttributeFilename', fileName: 'flash.txt' }],
      },
    })

    expect(result._).toBe('updates')
    expect(new TextDecoder().decode(Buffer.concat(received.map((chunk) => Buffer.from(chunk))))).toBe('flash-me')
    expect(inputs).toEqual([])
    await expect(uploads.open(session.platformSessionId, '314', 1)).rejects.toThrow('part is missing')
  })

  it('stages a platform-native hash hit and sends without Telegram upload parts', async () => {
    const { rpc, platform, consumed, inputs, peerId } = await createHarness()
    const prepare = vi.fn(async (_session, _conversation, media) => ({
      kind: media.kind,
      name: media.name,
      mimeType: media.mimeType,
      size: media.hashes.size,
      source: { size: media.hashes.size, async *stream() {} },
    }))
    platform.prepareMediaUpload = prepare

    await expect(rpc.prepareMediaUpload({
      peer: peer(peerId), fileId: Long.fromNumber(9_001), name: 'rapid.jpg',
      size: Long.fromNumber(4), kind: 'image', mimeType: 'image/jpeg',
      md5: Uint8Array.from({ length: 16 }, (_, index) => index),
      sha1: Uint8Array.from({ length: 20 }, (_, index) => index + 16),
      file10mMd5: Uint8Array.from({ length: 16 }, (_, index) => index),
      width: 1, height: 1, duration: 0,
    })).resolves.toMatchObject({ _: 'boolTrue' })

    await expect(rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(9_001), message: '',
      media: { _: 'inputMediaUploadedPhoto', file: inputFile(9_001, 1, 'rapid.jpg') },
    })).resolves.toMatchObject({ _: 'updates' })

    expect(prepare).toHaveBeenCalledWith(
      session, { id: conversation.id },
      expect.objectContaining({
        kind: 'image', name: 'rapid.jpg', hashes: {
          size: 4,
          md5: '000102030405060708090a0b0c0d0e0f',
          sha1: '101112131415161718191a1b1c1d1e1f20212223',
          file10MMd5: '000102030405060708090a0b0c0d0e0f',
        },
      }),
    )
    expect(consumed).toEqual([[]])
    expect(inputs[0].parts[0]).toMatchObject({ type: 'media', media: { name: 'rapid.jpg', size: 4 } })
  })

  it('streams file parts into the adapter, reports progressive bytes, persists, and cleans up', async () => {
    const { rpc, uploads, store, consumed, progress, peerId } = await createHarness()
    const priorPush = await store.prepareUpdateDelivery(
      'prior-push', session.platformSessionId, 1, 1_799_999_999,
    )
    expect(priorPush).toMatchObject({ pts: 2, seq: 1 })
    await uploads.savePart(session.platformSessionId, '42', 0, new TextEncoder().encode('first-'))
    await uploads.savePart(session.platformSessionId, '42', 1, new TextEncoder().encode('second'))
    const request: tl.messages.RawSendMediaRequest = {
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(42), message: 'report',
      media: {
        _: 'inputMediaUploadedDocument', file: inputFile(42, 2, 'report.txt'), mimeType: 'text/plain',
        attributes: [{ _: 'documentAttributeFilename', fileName: 'report.txt' }],
      },
    }

    const result = await rpc.sendMedia(request)
    expect(result._).toBe('updates')
    expect(consumed[0].map((chunk) => new TextDecoder().decode(chunk)).join('')).toBe('first-second')
    expect(progress).toEqual([
      { mediaIndex: 0, transferredBytes: 6 },
      { mediaIndex: 0, transferredBytes: 12 },
    ])
    expect((await store.readHistory(session.platformSessionId, conversation.id, { limit: 10 }))[0])
      .toMatchObject({ id: 'sent-1', content: { parts: [{ type: 'text', text: 'report' }, { type: 'media' }] } })
    await expect(uploads.open(session.platformSessionId, '42', 2)).rejects.toThrow('part is missing')
    expect(() => wireRoundTrip(result)).not.toThrow()

    expect((result as tl.RawUpdates).updates[0]).toEqual({
      _: 'updateMessageID', id: expect.any(Number), randomId: Long.fromNumber(42),
    })
    const update = (result as tl.RawUpdates).updates[1] as tl.RawUpdateNewMessage
    expect(update).toMatchObject({ pts: 3, ptsCount: 1 })
    expect(await store.getUpdateState(session.platformSessionId)).toMatchObject({ pts: 3, seq: 1 })
    const media = (update.message as tl.RawMessage).media as tl.RawMessageMediaDocument
    const document = media.document as tl.RawDocument
    expect(document.accessHash).not.toEqual(Long.ZERO)
    const downloaded = await rpc.getFile({
      _: 'upload.getFile', offset: 6, limit: 6,
      location: {
        _: 'inputDocumentFileLocation', id: document.id, accessHash: document.accessHash,
        fileReference: document.fileReference, thumbSize: '',
      },
    }) as tl.upload.RawFile
    expect(new TextDecoder().decode(downloaded.bytes)).toBe('second')
    expect(progress.slice(2)).toEqual([
      { mediaIndex: 0, transferredBytes: 4 },
      { mediaIndex: 0, transferredBytes: 6 },
    ])
    expect(() => wireRoundTrip(downloaded)).not.toThrow()

    const direct = await rpc.getFileUrl({
      _: 'inputDocumentFileLocation', id: document.id, accessHash: document.accessHash,
      fileReference: document.fileReference, thumbSize: '',
    })
    expect(JSON.parse(direct.data)).toMatchObject({
      url: 'https://cdn.example.test/media/0', supportsRange: true,
    })
    expect(() => wireRoundTrip(direct)).not.toThrow()

    await expect(rpc.getFileUrl({
      _: 'inputDocumentFileLocation', id: document.id, accessHash: document.accessHash,
      fileReference: new TextEncoder().encode('bridge-media:999'), thumbSize: '',
    })).rejects.toThrow('FILE_REFERENCE_INVALID')
  })

  it('keeps ordinary document audio non-voice while preserving its duration', async () => {
    const { rpc, uploads, inputs, peerId } = await createHarness()
    await uploads.savePart(session.platformSessionId, '91', 0, Uint8Array.of(1, 2, 3))
    await rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(91), message: '',
      media: {
        _: 'inputMediaUploadedDocument', file: inputFile(91, 1, 'music.mp3'), mimeType: 'audio/mpeg',
        attributes: [
          { _: 'documentAttributeFilename', fileName: 'music.mp3' },
          { _: 'documentAttributeAudio', voice: false, duration: 12 },
        ],
      },
    })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.parts).toMatchObject([{ type: 'media', media: {
      kind: 'file', name: 'music.mp3', mimeType: 'audio/mpeg', duration: 12, voice: false,
    } }])
  })

  it('sends mixed image and file content through one platform call with independent streams', async () => {
    const { rpc, uploads, inputs, consumed, progress, peerId } = await createHarness()
    await uploads.savePart(session.platformSessionId, '1', 0, new Uint8Array([1, 2]))
    await uploads.savePart(session.platformSessionId, '2', 0, new Uint8Array([3, 4, 5]))
    const result = await rpc.sendMultiMedia({
      _: 'messages.sendMultiMedia', peer: peer(peerId),
      multiMedia: [
        {
          _: 'inputSingleMedia', randomId: Long.ONE, message: 'mixed caption',
          media: { _: 'inputMediaUploadedPhoto', file: inputFile(1, 1, 'photo.png') },
        },
        {
          _: 'inputSingleMedia', randomId: Long.fromNumber(2), message: '',
          media: {
            _: 'inputMediaUploadedDocument', file: inputFile(2, 1, 'data.bin'),
            mimeType: 'application/octet-stream', attributes: [],
          },
        },
      ],
    })

    expect(inputs).toHaveLength(1)
    expect(inputs[0].parts.map((part) => part.type === 'media' ? part.media.kind : part.type))
      .toEqual(['text', 'image', 'file'])
    expect(consumed.map((chunks) => chunks.reduce((size, chunk) => size + chunk.length, 0))).toEqual([2, 3])
    expect(progress).toEqual([
      { mediaIndex: 0, transferredBytes: 2 },
      { mediaIndex: 1, transferredBytes: 3 },
    ])
    expect(result._).toBe('updates')
    expect((result as tl.RawUpdates).updates.map((update) => update._)).toEqual([
      'updateMessageID', 'updateNewMessage', 'updateMessageID', 'updateNewMessage',
    ])
    expect((result as tl.RawUpdates).updates.filter((update) => update._ === 'updateMessageID'))
      .toMatchObject([
        { randomId: Long.ONE },
        { randomId: Long.fromNumber(2) },
      ])
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('stages uploadMedia across connections, serves previews, and sends referenced documents', async () => {
    const { rpc, platform, uploads, store, consumed, peerId } = await createHarness()
    await uploads.savePart(session.platformSessionId, '77', 0, new TextEncoder().encode('large-'))
    await uploads.savePart(session.platformSessionId, '77', 1, new TextEncoder().encode('document'))
    const uploaded = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer: peer(peerId),
      media: {
        _: 'inputMediaUploadedDocument',
        file: { _: 'inputFileBig', id: Long.fromNumber(77), parts: 2, name: 'large.txt' },
        mimeType: 'text/plain',
        attributes: [{ _: 'documentAttributeFilename', fileName: 'large.txt' }],
      },
    }) as tl.RawMessageMediaDocument
    const document = uploaded.document as tl.RawDocument
    expect(document).toMatchObject({ _: 'document', mimeType: 'text/plain', size: 14 })
    expect(() => wireRoundTrip(uploaded)).not.toThrow()

    const preview = await rpc.getFile({
      _: 'upload.getFile', offset: 6, limit: 8,
      location: {
        _: 'inputDocumentFileLocation', id: document.id, accessHash: document.accessHash,
        fileReference: document.fileReference, thumbSize: '',
      },
    }) as tl.upload.RawFile
    expect(new TextDecoder().decode(preview.bytes)).toBe('document')

    const resumed = new DialogRpc(platform, session, store, uploads)
    const sent = await resumed.sendMedia({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(77), message: 'two-stage',
      media: {
        _: 'inputMediaDocument',
        id: {
          _: 'inputDocument', id: document.id, accessHash: document.accessHash,
          fileReference: document.fileReference,
        },
      },
    })
    expect(sent._).toBe('updates')
    expect(consumed[0].map((chunk) => new TextDecoder().decode(chunk)).join('')).toBe('large-document')
    await expect(uploads.open(session.platformSessionId, '77', 2)).rejects.toThrow('part is missing')
  })

  it('keeps staged parts after a platform failure and retries the same random ID', async () => {
    const { rpc, uploads, consumed, peerId } = await createHarness(1)
    await uploads.savePart(session.platformSessionId, '88', 0, new TextEncoder().encode('retry-me'))
    const uploaded = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer: peer(peerId),
      media: {
        _: 'inputMediaUploadedDocument', file: inputFile(88, 1, 'retry.txt'),
        mimeType: 'text/plain', attributes: [],
      },
    }) as tl.RawMessageMediaDocument
    const document = uploaded.document as tl.RawDocument
    const request: tl.messages.RawSendMediaRequest = {
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(88), message: '',
      media: {
        _: 'inputMediaDocument',
        id: {
          _: 'inputDocument', id: document.id, accessHash: document.accessHash,
          fileReference: document.fileReference,
        },
      },
    }

    await expect(rpc.sendMedia(request)).rejects.toThrow('simulated platform upload failure')
    expect(new TextDecoder().decode(await collectSource(
      (await uploads.open(session.platformSessionId, '88', 1)).source,
    ))).toBe('retry-me')
    await expect(rpc.sendMedia(request)).resolves.toMatchObject({ _: 'updates' })
    expect(consumed).toHaveLength(2)
    await expect(uploads.open(session.platformSessionId, '88', 1)).rejects.toThrow('part is missing')
  })

  it('maps permanent media send rejection without downgrading transient platform failures', async () => {
    const { rpc, platform, uploads, peerId } = await createHarness()
    const send = vi.spyOn(platform, 'sendMessage')
      .mockRejectedValueOnce(new IMMessageSendRejectedError(
        'permission-denied',
        'QQNT bridge 403: QQ message send rejected',
      ))
      .mockRejectedValueOnce(new IMMessageSendRejectedError(
        'platform-rejected',
        'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
      ))
      .mockRejectedValueOnce(new Error('QQNT bridge 500: temporary media send failure'))
    await uploads.savePart(session.platformSessionId, '188', 0, new TextEncoder().encode('keep-me'))
    const request = (randomId: number): tl.messages.RawSendMediaRequest => ({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(randomId), message: '',
      media: {
        _: 'inputMediaUploadedDocument', file: inputFile(188, 1, 'retry.txt'),
        mimeType: 'text/plain', attributes: [],
      },
    })

    await expect(rpc.sendMedia(request(18_801)))
      .rejects.toMatchObject({ code: 403, text: 'CHAT_WRITE_FORBIDDEN' })
    await expect(rpc.sendMedia(request(18_802)))
      .rejects.toMatchObject({
        code: 400,
        text: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
      })
    await expect(rpc.sendMedia(request(18_803)))
      .rejects.toThrow('QQNT bridge 500: temporary media send failure')
    expect(new TextDecoder().decode(await collectSource(
      (await uploads.open(session.platformSessionId, '188', 1)).source,
    ))).toBe('keep-me')
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('stages photos with the configured media DC and sends them by reference', async () => {
    const { platform, uploads, store, consumed, inputs, peerId } = await createHarness()
    const rpc = new DialogRpc(platform, session, store, uploads, undefined, 5)
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    new DataView(png.buffer).setUint32(16, 1096)
    new DataView(png.buffer).setUint32(20, 892)
    await uploads.savePart(session.platformSessionId, '89', 0, png)
    const uploaded = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer: peer(peerId),
      media: { _: 'inputMediaUploadedPhoto', file: inputFile(89, 1, 'photo.png') },
    }) as tl.RawMessageMediaPhoto
    const photo = uploaded.photo as tl.RawPhoto
    expect(photo).toMatchObject({ _: 'photo', dcId: 5 })
    expect(photo.sizes[0]).toMatchObject({ _: 'photoSize', w: 1096, h: 892 })

    const sent = await rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(89), message: 'photo',
      media: {
        _: 'inputMediaPhoto',
        id: {
          _: 'inputPhoto', id: photo.id, accessHash: photo.accessHash,
          fileReference: photo.fileReference,
        },
      },
    })
    expect(sent).toMatchObject({
      _: 'updates',
      updates: [
        { _: 'updateMessageID', randomId: Long.fromNumber(89) },
        { _: 'updateNewMessage', message: {
          media: { _: 'messageMediaPhoto', photo: { sizes: [{ w: 1096, h: 892 }] } },
        } },
      ],
    })
    expect(inputs[0].parts).toContainEqual(expect.objectContaining({
      type: 'media', media: expect.objectContaining({ width: 1096, height: 892 }),
    }))
    expect([...consumed[0][0]]).toEqual([...png])
  })

  it('rejects missing parts before invoking the platform', async () => {
    const { rpc, uploads, inputs, peerId } = await createHarness()
    await uploads.savePart(session.platformSessionId, '9', 0, new Uint8Array([1]))
    await expect(rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(peerId), randomId: Long.fromNumber(9), message: '',
      media: { _: 'inputMediaUploadedPhoto', file: inputFile(9, 2, 'broken.jpg') },
    })).rejects.toMatchObject({ code: 400 })
    expect(inputs).toEqual([])
  })
})

async function collectSource(source: import('./platform.js').IMMediaSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source.stream()) chunks.push(chunk)
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}
