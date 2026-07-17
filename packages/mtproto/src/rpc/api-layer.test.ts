import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { tl } from '@mtcute/core'
import { __tlReaderMapWithCompat, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { CURRENT_API_LAYER, getApiLayerReaderMap, getApiLayerWriterMap, resolveApiSchemaLayer } from './api-layer.js'

const schemaDirectory = fileURLToPath(new URL('../../schema/api/', import.meta.url))
const schemaManifest = JSON.parse(readFileSync(resolve(schemaDirectory, 'manifest.json'), 'utf8'))

function constructorFromLocalSchema(layer: number, name: string): number {
  const resolvedLayer = resolveApiSchemaLayer(layer)
  if (resolvedLayer === null) throw new Error(`no local schema for layer ${layer}`)
  const record = schemaManifest.layers[String(resolvedLayer)]
  const schema = gunzipSync(readFileSync(resolve(schemaDirectory, record.file))).toString('utf8')
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

  it('keeps the current writer map for the current layer and layers older than the local mirror', () => {
    expect(getApiLayerWriterMap(__tlWriterMap, CURRENT_API_LAYER)).toBe(__tlWriterMap)
    expect(getApiLayerWriterMap(__tlWriterMap, 1)).toBe(__tlWriterMap)
    expect(getApiLayerWriterMap(__tlWriterMap, null)).toBe(__tlWriterMap)
  })

  it('recursively downgrades messages and users without desynchronizing dialogs vectors', () => {
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

    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 223), result)
    const decoded = new TlBinaryReader(getApiLayerReaderMap(223)!, bytes).object() as tl.messages.RawDialogs

    expect(decoded.dialogs).toHaveLength(1)
    expect(decoded.messages).toMatchObject([{ _: 'message', id: 7, message: 'legacy wire message' }])
    expect(decoded.users).toMatchObject([{ _: 'user', id: 42, firstName: 'Alice' }])
  })

  it('writes the mandatory synthetic UserFull core for older layers', () => {
    const full: tl.RawUserFull = {
      _: 'userFull', id: 42,
      settings: { _: 'peerSettings' },
      notifySettings: { _: 'peerNotifySettings' },
      commonChatsCount: 0,
    }
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 223), full)
    const decoded = new TlBinaryReader(__tlReaderMapWithCompat, bytes).object() as tl.RawUserFull
    expect(decoded).toMatchObject({ _: 'userFull', id: 42, commonChatsCount: 0 })
  })

  it('code-generates the historical MessageService writer', () => {
    const service: tl.RawMessageService = {
      _: 'messageService', id: 8,
      fromId: { _: 'peerUser', userId: 42 },
      peerId: { _: 'peerUser', userId: 42 },
      date: 1_800_000_000,
      action: { _: 'messageActionEmpty' },
    }
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 223), service)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true))
      .toBe(constructorFromLocalSchema(223, 'messageService'))
    expect(new TlBinaryReader(__tlReaderMapWithCompat, bytes).object()).toMatchObject({
      _: 'messageService', id: 8, peerId: { _: 'peerUser', userId: 42 },
    })
  })
})
