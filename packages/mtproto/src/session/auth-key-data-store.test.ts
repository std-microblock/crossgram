import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_KEY_DATA_IDLE_TTL_MS, AuthKeyDataStore, authKeyIdHex } from './auth-key-data-store.js'

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


describe('idle device cache eviction', () => {
  afterEach(() => vi.useRealTimers())

  it('retains active devices and expires only after a full disconnected grace period', () => {
    vi.useFakeTimers()
    const store = new AuthKeyDataStore()
    const key = Uint8Array.of(1)
    const active = new Set([authKeyIdHex(key)])
    const state = { users: new Map() }
    store.set(key, state)
    vi.advanceTimersByTime(AUTH_KEY_DATA_IDLE_TTL_MS * 2)
    expect(store.prune(active)).toEqual([])
    expect(store.get(key)).toBe(state)
    vi.advanceTimersByTime(AUTH_KEY_DATA_IDLE_TTL_MS - 1)
    expect(store.prune(new Set())).toEqual([])
    vi.advanceTimersByTime(1)
    expect(store.prune(new Set())).toEqual([authKeyIdHex(key)])
    expect(store.get(key)).toBeNull()
  })

  it('refreshes on reads and writes, isolates devices, and allows rehydration', () => {
    vi.useFakeTimers()
    const store = new AuthKeyDataStore()
    const a = Uint8Array.of(1), b = Uint8Array.of(2), c = Uint8Array.of(3)
    for (const key of [a, b, c]) store.set(key, { old: true })
    vi.advanceTimersByTime(AUTH_KEY_DATA_IDLE_TTL_MS - 1)
    store.get(a.slice())
    store.set(b, { replacement: true })
    vi.advanceTimersByTime(1)
    expect(store.prune(new Set())).toEqual([authKeyIdHex(c)])
    expect(store.get(a)).toEqual({ old: true })
    expect(store.get(b)).toEqual({ replacement: true })
    store.set(c, { rehydrated: true })
    expect(store.get(c)).toEqual({ rehydrated: true })
    store.clear()
    expect(store.get(a)).toBeNull()
    expect(store.get(c)).toBeNull()
    expect(store.prune(new Set(), Date.now() + AUTH_KEY_DATA_IDLE_TTL_MS)).toEqual([])
  })
})
