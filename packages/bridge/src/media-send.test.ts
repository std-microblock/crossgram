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
import { DialogRpc, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type {
  IMConversation, IMMedia, IMMessage, IMMessageInput, IMPlatform, IMTransferOptions, PlatformSession,
} from './platform.js'
import { UploadManager } from './upload-manager.js'

const session: PlatformSession = {
  platformSessionId: 'send-media-session', platformId: 'streaming', userId: 'self', credentials: {}, metadata: {},
}
const conversation: IMConversation = { id: 'peer', kind: 'direct', title: 'Peer' }
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createHarness(failSends = 0) {
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
          mimeType: part.media.mimeType, size: part.media.size, locator: { remote: mediaIndex },
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
  }
  const progress: Array<{ mediaIndex: number, transferredBytes: number }> = []
  const store = new MessageStore(ctx.database)
  const rpc = new DialogRpc(platform, session, store, uploads, (_session, event) => {
    progress.push({ mediaIndex: event.mediaIndex, transferredBytes: event.transferredBytes })
  })
  disposals.push(async () => {
    await rm(directory, { recursive: true, force: true })
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { rpc, platform, uploads, store, consumed, inputs, progress }
}

function inputFile(id: number, parts: number, name: string): tl.RawInputFile {
  return { _: 'inputFile', id: Long.fromNumber(id), parts, name, md5Checksum: '' }
}

function peer(): tl.RawInputPeerUser {
  return { _: 'inputPeerUser', userId: stableId(`peer:${conversation.id}`), accessHash: Long.ZERO }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('media send streaming', () => {
  it('streams file parts into the adapter, reports progressive bytes, persists, and cleans up', async () => {
    const { rpc, uploads, store, consumed, progress } = await createHarness()
    await uploads.savePart(session.platformSessionId, '42', 0, new TextEncoder().encode('first-'))
    await uploads.savePart(session.platformSessionId, '42', 1, new TextEncoder().encode('second'))
    const request: tl.messages.RawSendMediaRequest = {
      _: 'messages.sendMedia', peer: peer(), randomId: Long.fromNumber(42), message: 'report',
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

    const update = (result as tl.RawUpdates).updates[0] as tl.RawUpdateNewMessage
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
  })

  it('sends mixed image and file content through one platform call with independent streams', async () => {
    const { rpc, uploads, inputs, consumed, progress } = await createHarness()
    await uploads.savePart(session.platformSessionId, '1', 0, new Uint8Array([1, 2]))
    await uploads.savePart(session.platformSessionId, '2', 0, new Uint8Array([3, 4, 5]))
    const result = await rpc.sendMultiMedia({
      _: 'messages.sendMultiMedia', peer: peer(),
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
    expect((result as tl.RawUpdates).updates).toHaveLength(2)
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('stages uploadMedia across connections, serves previews, and sends referenced documents', async () => {
    const { rpc, platform, uploads, store, consumed } = await createHarness()
    await uploads.savePart(session.platformSessionId, '77', 0, new TextEncoder().encode('large-'))
    await uploads.savePart(session.platformSessionId, '77', 1, new TextEncoder().encode('document'))
    const uploaded = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer: peer(),
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
      _: 'messages.sendMedia', peer: peer(), randomId: Long.fromNumber(77), message: 'two-stage',
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
    const { rpc, uploads, consumed } = await createHarness(1)
    await uploads.savePart(session.platformSessionId, '88', 0, new TextEncoder().encode('retry-me'))
    const uploaded = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer: peer(),
      media: {
        _: 'inputMediaUploadedDocument', file: inputFile(88, 1, 'retry.txt'),
        mimeType: 'text/plain', attributes: [],
      },
    }) as tl.RawMessageMediaDocument
    const document = uploaded.document as tl.RawDocument
    const request: tl.messages.RawSendMediaRequest = {
      _: 'messages.sendMedia', peer: peer(), randomId: Long.fromNumber(88), message: '',
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

  it('stages photos with the configured media DC and sends them by reference', async () => {
    const { platform, uploads, store, consumed } = await createHarness()
    const rpc = new DialogRpc(platform, session, store, uploads, undefined, 5)
    await uploads.savePart(session.platformSessionId, '89', 0, new Uint8Array([137, 80, 78, 71]))
    const uploaded = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer: peer(),
      media: { _: 'inputMediaUploadedPhoto', file: inputFile(89, 1, 'photo.png') },
    }) as tl.RawMessageMediaPhoto
    const photo = uploaded.photo as tl.RawPhoto
    expect(photo).toMatchObject({ _: 'photo', dcId: 5 })

    await expect(rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(), randomId: Long.fromNumber(89), message: 'photo',
      media: {
        _: 'inputMediaPhoto',
        id: {
          _: 'inputPhoto', id: photo.id, accessHash: photo.accessHash,
          fileReference: photo.fileReference,
        },
      },
    })).resolves.toMatchObject({ _: 'updates' })
    expect([...consumed[0][0]]).toEqual([137, 80, 78, 71])
  })

  it('rejects missing parts before invoking the platform', async () => {
    const { rpc, uploads, inputs } = await createHarness()
    await uploads.savePart(session.platformSessionId, '9', 0, new Uint8Array([1]))
    await expect(rpc.sendMedia({
      _: 'messages.sendMedia', peer: peer(), randomId: Long.fromNumber(9), message: '',
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
