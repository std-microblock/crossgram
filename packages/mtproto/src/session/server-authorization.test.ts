import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import Long from 'long'
import { getServerReaderMap } from '../rpc/server-reader-map.js'
import {
  receivePlainHandshakeObject,
  rememberPendingPqChallenge,
  selectPendingPqChallenge,
} from './server-authorization.js'

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
  it('owns nonce bytes after the transport receive buffer is reused', () => {
    const challenges: Parameters<typeof rememberPendingPqChallenge>[0] = []
    const receiveBuffer = new Uint8Array(32)
    receiveBuffer.fill(1, 0, 16)
    receiveBuffer.fill(2, 16)

    const challenge = rememberPendingPqChallenge(
      challenges,
      receiveBuffer.subarray(0, 16),
      receiveBuffer.subarray(16),
      15n,
    )
    receiveBuffer.fill(9)

    expect(challenge.clientNonce).toEqual(new Uint8Array(16).fill(1))
    expect(challenge.serverNonce).toEqual(new Uint8Array(16).fill(2))
  })

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

  it('retains the first challenge across more than eight TDLib probes', () => {
    const challenges: Parameters<typeof rememberPendingPqChallenge>[0] = []
    const first = rememberPendingPqChallenge(
      challenges,
      new Uint8Array(16).fill(1),
      new Uint8Array(16).fill(2),
      15n,
    )
    for (let value = 3; value <= 12; value++) {
      rememberPendingPqChallenge(
        challenges,
        new Uint8Array(16).fill(value),
        new Uint8Array(16).fill(value + 16),
        BigInt(value * 5),
      )
    }

    expect(selectPendingPqChallenge(challenges, first.clientNonce, first.serverNonce)).toBe(first)
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
