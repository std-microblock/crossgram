import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { __tlReaderMapWithCompat, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import {
  collectNewestEntriesById,
  CURRENT_API_LAYER,
  getApiLayerReaderMap,
  getApiLayerWriterMap,
  resolveApiSchemaLayer,
  resolveApiSchemaProfile,
} from './api-layer.js'

const schemaDirectory = fileURLToPath(new URL('../../schema/api/', import.meta.url))
const schemaManifest = JSON.parse(readFileSync(resolve(schemaDirectory, 'manifest.json'), 'utf8'))

function constructorFromLocalSchema(layer: number, name: string): number {
  const resolvedLayer = resolveApiSchemaLayer(layer)
  if (resolvedLayer === null) throw new Error(`no local schema for layer ${layer}`)
  const record = schemaManifest.layers[String(resolvedLayer)]
  const schema = readFileSync(resolve(schemaDirectory, record.file), 'utf8')
  const match = schema.match(new RegExp(`^${name.replace('.', '\\.') }#([0-9a-f]{1,8})\\b`, 'm'))
  if (!match) throw new Error(`${name} is missing from schema layer ${resolvedLayer}`)
  return Number.parseInt(match[1], 16)
}

const message: tl.RawMessage = {
  _: 'message', id: 7,
  fromId: { _: 'peerUser', userId: 42 },
  peerId: { _: 'peerUser', userId: 42 },
  date: 1_800_000_000,
  message: 'legacy wire message',
}

describe('API layer response writers', () => {
  it('keeps only the newest definition for each historical constructor ID', () => {
    const oldestOnly = { id: 1, name: 'oldest-only' }
    const replaced = { id: 2, name: 'old-definition' }
    const replacement = { id: 2, name: 'new-definition' }
    const newestOnly = { id: 3, name: 'newest-only' }
    const layers = new Map([
      [100, [oldestOnly, replaced]],
      [200, [replacement, newestOnly]],
    ])

    expect(collectNewestEntriesById([100, 200], layer => layers.get(layer) ?? []))
      .toEqual([oldestOnly, replacement, newestOnly])
  })

  it.each([
    198, 200, 204, 216, 220, 222, 223, 224, 226,
  ])('writes the Message constructor sourced from the local schema for layer %i', (layer) => {
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, layer), message)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true))
      .toBe(constructorFromLocalSchema(layer, 'message'))

    const decoded = new TlBinaryReader(__tlReaderMapWithCompat, bytes).object() as tl.RawMessage
    expect(decoded).toMatchObject({
      _: 'message', id: 7, peerId: { _: 'peerUser', userId: 42 }, message: 'legacy wire message',
    })
  })

  it('keeps the base writer map for layers older than the local mirror', () => {
    expect(getApiLayerWriterMap(__tlWriterMap, 1)).toBe(__tlWriterMap)
    expect(getApiLayerWriterMap(__tlWriterMap, null)).toBe(__tlWriterMap)
  })

  it('encodes recalled markers in reserved message flag bits without changing the constructor id', () => {
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, CURRENT_API_LAYER), {
      ...message, recalled: true, recalledVisible: true,
    } as tl.RawMessage & { recalled: boolean, recalledVisible: boolean })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(constructorFromLocalSchema(CURRENT_API_LAYER, 'message'))
    expect(view.getUint32(4, true) & (1 << 12)).not.toBe(0)
    expect(view.getUint32(8, true) & (1 << 30)).not.toBe(0)
  })

  it('encodes the recalled bit on legacy layers that do not have flags2', () => {
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 117), {
      ...message, recalled: true,
    } as tl.RawMessage & { recalled: boolean })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(constructorFromLocalSchema(117, 'message'))
    expect(view.getUint32(4, true) & (1 << 12)).not.toBe(0)
  })

  it.each([227, 228])('round-trips custom service actions for Layer %i', (layer) => {
    const service: tl.RawMessageService = {
      _: 'messageService', id: 8,
      fromId: { _: 'peerUser', userId: 42 },
      peerId: { _: 'peerChannel', channelId: 7 },
      date: 1_800_000_000,
      action: { _: 'messageActionCustomAction', message: 'Alice joined the group' },
    }
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, layer), service)
    const readerMap = getApiLayerReaderMap(layer)
    expect(readerMap).not.toBeNull()
    const decoded = new TlBinaryReader(readerMap!, bytes).object() as tl.RawMessageService
    expect(decoded).toMatchObject({
      _: 'messageService',
      action: { _: 'messageActionCustomAction', message: 'Alice joined the group' },
    })
  })

  it('serializes a Layer 228 authorization with its generated reader and writer', () => {
    const authorization = {
      _: 'auth.authorization', flags: 0, setupPasswordRequired: false,
      user: {
        _: 'user', flags: 0, self: true, premium: true, id: 42, accessHash: Long.ZERO,
        firstName: 'Bridge', phone: '15550000000', status: { _: 'userStatusRecently' },
      },
    } as unknown as tl.TlObject
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 228), authorization)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true))
      .toBe(constructorFromLocalSchema(228, 'user'))

    const readerMap = getApiLayerReaderMap(228)
    expect(readerMap).not.toBeNull()
    const decoded = new TlBinaryReader(readerMap!, bytes).object() as { user: tl.RawUser }
    expect(decoded.user).toMatchObject({
      _: 'user', self: true, premium: true, id: 42, accessHash: Long.ZERO,
      firstName: 'Bridge', phone: '15550000000', status: { _: 'userStatusRecently' },
    })
  })

  it('serializes a complete AyuGram layer 224 object graph with its generated reader and writer', () => {
    const result: tl.messages.RawDialogs = {
      _: 'messages.dialogs',
      dialogs: [{
        _: 'dialog', peer: { _: 'peerUser', userId: 42 }, topMessage: 7,
        readInboxMaxId: 7, readOutboxMaxId: 7, unreadCount: 0,
        unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0,
        notifySettings: { _: 'peerNotifySettings' },
      }],
      messages: [message],
      chats: [],
      users: [{ _: 'user', id: 42, firstName: 'Alice', contact: true, mutualContact: true }],
    }

    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 224), result)
    const readerMap = getApiLayerReaderMap(224)
    expect(readerMap).not.toBeNull()
    const decoded = new TlBinaryReader(readerMap!, bytes).object() as tl.messages.RawDialogs

    expect(decoded.dialogs).toHaveLength(1)
    expect(decoded.messages).toMatchObject([{ _: 'message', id: 7, message: 'legacy wire message' }])
    expect(decoded.users).toMatchObject([{ _: 'user', id: 42, firstName: 'Alice' }])
  })

  it('selects every constructor from the complete AyuGram layer 224 profile', () => {
    const full: tl.RawUserFull = {
      _: 'userFull', id: 42,
      settings: { _: 'peerSettings' },
      notifySettings: { _: 'peerNotifySettings' },
      commonChatsCount: 0,
    }
    const service: tl.RawMessageService = {
      _: 'messageService', id: 8,
      fromId: { _: 'peerUser', userId: 42 },
      peerId: { _: 'peerUser', userId: 42 },
      date: 1_800_000_000,
      action: { _: 'messageActionEmpty' },
    }
    const dialog: tl.RawDialog = {
      _: 'dialog', peer: { _: 'peerUser', userId: 42 }, topMessage: 7,
      readInboxMaxId: 7, readOutboxMaxId: 7, unreadCount: 0,
      unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
    }
    const writerMap = getApiLayerWriterMap(__tlWriterMap, 224)
    const constructor = (value: { _: string }) => {
      const bytes = TlBinaryWriter.serializeObject(writerMap, value)
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
    }

    expect(resolveApiSchemaProfile(224)).toBe('tdlib-history')
    expect(constructor(message)).toBe(0x3ae56482)
    expect(constructor(dialog)).toBe(0xfc89f7f3)
    expect(constructor(full)).toBe(0x06cbe645)
    expect(constructor(service)).toBe(0x7a800e0a)
    expect(constructor(full)).toBe(constructorFromLocalSchema(224, 'userFull'))
    expect(writerMap.message).not.toBe(__tlWriterMap.message)
    expect(writerMap.userFull).not.toBe(__tlWriterMap.userFull)
    expect(writerMap.messageService).not.toBe(__tlWriterMap.messageService)
  })

  it('keeps historical layer 223 as its own complete Git snapshot', () => {
    const full: tl.RawUserFull = {
      _: 'userFull', id: 42,
      settings: { _: 'peerSettings' },
      notifySettings: { _: 'peerNotifySettings' },
      commonChatsCount: 0,
    }
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 223), full)
    const constructor = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
    expect(resolveApiSchemaProfile(223)).toBe('tdlib-history')
    expect(constructor).toBe(0xa02bc13e)
    expect(constructor).toBe(constructorFromLocalSchema(223, 'userFull'))
  })
})
