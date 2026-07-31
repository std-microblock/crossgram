import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import Long from 'long'
import { getServerReaderMap } from '../rpc/server-reader-map.js'
import { receivePlainHandshakeObject, selectPendingPqChallenge } from './server-authorization.js'

describe('plain handshake message reader', () => {
  it('skips Android plaintext acknowledgements before the next handshake request', async () => {
    const nonce = new Uint8Array(16).fill(7)
    const frames = [
      serializePlain({ _: 'mt_msgs_ack', msgIds: [Long.fromInt(42)] }),
      serializePlain({ _: 'mt_req_pq_multi', nonce }),
    ]
    const recvPlain = vi.fn(async () => frames.shift()!)
    const logger = { debug: vi.fn() } as unknown as Logger

    const object = await receivePlainHandshakeObject(getServerReaderMap(), logger, recvPlain)

    expect(object).toEqual({ _: 'mt_req_pq_multi', nonce })
    expect(recvPlain).toHaveBeenCalledTimes(2)
    expect(logger.debug).toHaveBeenCalledWith('ignoring plaintext msgs_ack during handshake')
  })
})

describe('PQ challenge selection', () => {
  it('keeps an earlier response valid after a later probe is answered', () => {
    const first = {
      clientNonce: new Uint8Array(16).fill(1),
      serverNonce: new Uint8Array(16).fill(2),
      pq: 15n,
    }
    const second = {
      clientNonce: new Uint8Array(16).fill(3),
      serverNonce: new Uint8Array(16).fill(4),
      pq: 35n,
    }

    expect(selectPendingPqChallenge([first, second], first.clientNonce, first.serverNonce)).toBe(first)
  })

  it('distinguishes unknown client and server nonces', () => {
    const challenge = {
      clientNonce: new Uint8Array(16).fill(1),
      serverNonce: new Uint8Array(16).fill(2),
      pq: 15n,
    }

    expect(() => selectPendingPqChallenge(
      [challenge],
      new Uint8Array(16).fill(9),
      challenge.serverNonce,
    )).toThrow('Step 2: invalid nonce from client')
    expect(() => selectPendingPqChallenge(
      [challenge],
      challenge.clientNonce,
      new Uint8Array(16).fill(9),
    )).toThrow('Step 2: invalid server nonce from client')
  })
})

function serializePlain(object: { _: string, [key: string]: unknown }): Uint8Array {
  const length = TlSerializationCounter.countNeededBytes(__tlWriterMap, object)
  const writer = TlBinaryWriter.alloc(__tlWriterMap, length + 20)
  writer.long(Long.ZERO)
  writer.long(Long.fromInt(4))
  writer.uint(length)
  writer.object(object)
  return writer.result()
}
