import { describe, expect, it } from 'vitest'
import { __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { getApiLayerWriterMap } from './api-layer.js'
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
    const bytes = TlBinaryWriter.serializeObject(getApiLayerWriterMap(__tlWriterMap, 105), request)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(0xdcbb8260)

    const decoded = new TlBinaryReader(getServerReaderMap(), bytes).object() as any
    expect(decoded).toMatchObject({
      _: 'messages.getHistory', peer: { _: 'inputPeerUser', userId: 42 }, limit: 20,
    })
  })
})
