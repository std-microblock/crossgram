import { describe, expect, it } from 'vitest'
import Long from 'long'
import { AuthTransferStore } from './auth-transfer.js'

function deterministicRandom(...values: Uint8Array[]) {
  let index = 0
  return (size: number) => {
    const value = values[index++]
    expect(value).toHaveLength(size)
    return value
  }
}

describe('AuthTransferStore', () => {
  const idBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
  const ticketBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 10)
  const identity = { platformId: 'qqnt', platformSessionId: 'qq-session' }

  it('issues a TL-compatible id and consumes a matching ticket exactly once', () => {
    const store = new AuthTransferStore(60_000, () => 1_000, deterministicRandom(idBytes, ticketBytes))

    const exported = store.issue(identity, 2)

    expect(Long.isLong(exported.id)).toBe(true)
    expect(exported.id.toBytesLE()).toEqual([...idBytes])
    expect(exported.bytes).toEqual(ticketBytes)
    expect(store.has(exported.id, exported.bytes)).toBe(true)
    expect(store.take(exported.id, exported.bytes)).toEqual(identity)
    expect(store.has(exported.id, exported.bytes)).toBe(false)
    expect(store.take(exported.id, exported.bytes)).toBeUndefined()
  })

  it('rejects the wrong secret without consuming the real ticket', () => {
    const store = new AuthTransferStore(60_000, () => 1_000, deterministicRandom(idBytes, ticketBytes))
    const exported = store.issue(identity, 3)
    const wrongBytes = exported.bytes.slice()
    wrongBytes[0] ^= 0xff

    expect(store.has(exported.id, wrongBytes)).toBe(false)
    expect(store.take(exported.id, wrongBytes)).toBeUndefined()
    expect(store.take(exported.id, exported.bytes)).toEqual(identity)
  })

  it('expires tickets at the configured deadline', () => {
    let now = 1_000
    const store = new AuthTransferStore(500, () => now, deterministicRandom(idBytes, ticketBytes))
    const exported = store.issue(identity, 4)

    now = 1_499
    expect(store.has(exported.id, exported.bytes)).toBe(true)
    now = 1_500
    expect(store.has(exported.id, exported.bytes)).toBe(false)
    expect(store.take(exported.id, exported.bytes)).toBeUndefined()
  })
})
