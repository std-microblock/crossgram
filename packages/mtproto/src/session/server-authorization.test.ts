import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@mtcute/core/utils.js'
import { __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import Long from 'long'
import { getServerReaderMap } from '../rpc/server-reader-map.js'
import { PqChallengeStore, receivePlainHandshakeObject } from './server-authorization.js'

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
    const challenges = new PqChallengeStore()
    const receiveBuffer = new Uint8Array(32)
    receiveBuffer.fill(1, 0, 16)
    receiveBuffer.fill(2, 16)

    const challenge = challenges.remember(
      receiveBuffer.subarray(0, 16),
      receiveBuffer.subarray(16),
      15n,
    )
    receiveBuffer.fill(9)

    expect(challenge.clientNonce).toEqual(new Uint8Array(16).fill(1))
    expect(challenge.serverNonce).toEqual(new Uint8Array(16).fill(2))
  })

  it('shares an earlier response with a later TCP connection', () => {
    const challenges = new PqChallengeStore()
    const first = challenges.remember(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 15n)
    challenges.remember(new Uint8Array(16).fill(3), new Uint8Array(16).fill(4), 35n)

    expect(challenges.select(first.clientNonce, first.serverNonce)).toBe(first)
  })

  it('retains the first challenge across more than eight TDLib probes', () => {
    const challenges = new PqChallengeStore()
    const first = challenges.remember(
      new Uint8Array(16).fill(1),
      new Uint8Array(16).fill(2),
      15n,
    )
    for (let value = 3; value <= 12; value++) {
      challenges.remember(
        new Uint8Array(16).fill(value),
        new Uint8Array(16).fill(value + 16),
        BigInt(value * 5),
      )
    }

    expect(challenges.select(first.clientNonce, first.serverNonce)).toBe(first)
  })

  it('expires old cross-connection challenges', () => {
    let now = 1000
    const challenges = new PqChallengeStore(8, 100, () => now)
    const first = challenges.remember(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 15n)
    now += 101

    expect(() => challenges.select(first.clientNonce, first.serverNonce)).toThrow('Step 2: invalid nonce from client')
  })

  it('distinguishes unknown client and server nonces', () => {
    const challenges = new PqChallengeStore()
    const challenge = challenges.remember(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 15n)

    expect(() => challenges.select(
      new Uint8Array(16).fill(9),
      challenge.serverNonce,
    )).toThrow('Step 2: invalid nonce from client')
    expect(() => challenges.select(
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
