import { describe, expect, it } from 'vitest'
import { AuthKeyDataStore, authKeyIdHex } from './auth-key-data-store.js'

describe('AuthKeyDataStore', () => {
  it('shares state for distinct byte arrays containing the same auth key ID', () => {
    const store = new AuthKeyDataStore()
    const first = Uint8Array.of(0, 1, 2, 3, 0xfc, 0xfd, 0xfe, 0xff)
    const copy = first.slice()
    const state = { platformSessionId: 'session-1' }

    store.set(first, state)

    expect(store.get(copy)).toBe(state)
    expect(authKeyIdHex(first)).toBe('00010203fcfdfeff')
  })

  it('isolates different auth keys and supports deletion', () => {
    const store = new AuthKeyDataStore()
    const one = Uint8Array.of(1)
    const two = Uint8Array.of(2)
    store.set(one, 'first')
    store.set(two, 'second')

    expect(store.get(one)).toBe('first')
    expect(store.get(two)).toBe('second')
    expect(store.delete(one)).toBe(true)
    expect(store.get(one)).toBeNull()
    expect(store.get(two)).toBe('second')
  })

  it('rejects writes without an established permanent auth key', () => {
    const store = new AuthKeyDataStore()
    expect(store.get(null)).toBeNull()
    expect(store.delete(null)).toBe(false)
    expect(() => store.set(null, {})).toThrow('without a permanent auth key')
  })
})
