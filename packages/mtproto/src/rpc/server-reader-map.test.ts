import { describe, expect, it } from 'vitest'
import { __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { getApiLayerSchemaWriterMap } from './api-layer.js'
import { getServerReaderMap } from './server-reader-map.js'

describe('historical server reader map', () => {
  it('decodes a layer-105 messages.getHistory request whose method ID predates the current schema', () => {
    const request = {
      _: 'messages.getHistory',
      peer: { _: 'inputPeerUser', userId: 42, accessHash: Long.ZERO },
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit: 20,
      maxId: 0,
      minId: 0,
      hash: Long.ZERO,
    }
    const bytes = TlBinaryWriter.serializeObject(getApiLayerSchemaWriterMap(__tlWriterMap, 105), request)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(0xdcbb8260)

    const decoded = new TlBinaryReader(getServerReaderMap(), bytes).object() as any
    expect(decoded).toMatchObject({
      _: 'messages.getHistory', peer: { _: 'inputPeerUser', userId: 42 }, limit: 20,
    })
  })

  it('decodes Telegram Android legacy/private requests used at the current layer', () => {
    const channel = TlBinaryWriter.serializeObject(__tlWriterMap, {
      _: 'inputChannel', channelId: 42, accessHash: Long.ZERO,
    } as any)
    const channelRequest = TlBinaryWriter.manual(4 + channel.length + 4 + 4 + 8)
    channelRequest.uint(0x93d7b347)
    channelRequest.raw(channel)
    channelRequest.uint(0x1cb5c415)
    channelRequest.uint(2)
    channelRequest.uint(100)
    channelRequest.uint(200)

    expect(new TlBinaryReader(getServerReaderMap(), channelRequest.result()).object()).toMatchObject({
      _: 'channels.getMessages',
      channel: { _: 'inputChannel', channelId: 42 },
      id: [100, 200],
    })

    const languagesRequest = TlBinaryWriter.manual(4)
    languagesRequest.uint(0x800fd57d)
    expect(new TlBinaryReader(getServerReaderMap(), languagesRequest.result()).object()).toEqual({
      _: 'langpack.getLanguages',
    })

    const token = tlString('internal-push-token')
    const registerRequest = TlBinaryWriter.manual(8 + token.length)
    registerRequest.uint(0x637ea878)
    registerRequest.uint(7)
    registerRequest.raw(token)
    expect(new TlBinaryReader(getServerReaderMap(), registerRequest.result()).object()).toEqual({
      _: 'account.registerDevice', tokenType: 7, token: 'internal-push-token',
    })
  })

  it('decodes the stable Crossgram direct-download request constructor', () => {
    const location = TlBinaryWriter.serializeObject(__tlWriterMap, {
      _: 'inputDocumentFileLocation',
      id: Long.fromNumber(42),
      accessHash: Long.fromNumber(42),
      fileReference: new TextEncoder().encode('bridge-media:42'),
      thumbSize: '',
    } as any)
    const request = TlBinaryWriter.manual(4 + location.length)
    request.uint(0x7520f6ea)
    request.raw(location)

    expect(new TlBinaryReader(getServerReaderMap(), request.result()).object()).toMatchObject({
      _: 'crossgram.getFileUrl',
      location: {
        _: 'inputDocumentFileLocation', id: Long.fromNumber(42),
        accessHash: Long.fromNumber(42), thumbSize: '',
      },
    })
  })
})

function tlString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length >= 254) throw new Error('test helper only supports short TL strings')
  const length = Math.ceil((bytes.length + 1) / 4) * 4
  const result = new Uint8Array(length)
  result[0] = bytes.length
  result.set(bytes, 1)
  return result
}
