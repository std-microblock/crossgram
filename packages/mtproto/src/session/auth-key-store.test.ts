import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuthKeyStore, FileAuthKeyStore } from './auth-key-store.js'

const id = (n: number) => new Uint8Array([n, n, n, n, n, n, n, n])
const key = (n: number) => { const k = new Uint8Array(256); k.fill(n); return k }

describe('MemoryAuthKeyStore', () => {
  it('saves and retrieves keys by id', () => {
    const store = new MemoryAuthKeyStore()
    expect(store.get(id(1))).toBeUndefined()
    store.save(id(1), { key: key(0xaa) })
    expect(store.get(id(1))).toEqual({ key: key(0xaa) })
    // a different id is independent
    expect(store.get(id(2))).toBeUndefined()
  })

  it('overwrites an existing id', () => {
    const store = new MemoryAuthKeyStore()
    store.save(id(1), { key: key(0xaa) })
    store.save(id(1), { key: key(0xbb) })
    expect(store.get(id(1))).toEqual({ key: key(0xbb) })
  })

  it('retains the permanent identity of a temporary key and rejects it after expiry', () => {
    const store = new MemoryAuthKeyStore()
    const expiresAt = Math.floor(Date.now() / 1000) + 60
    store.save(id(2), { key: key(0xcc), permanentKeyId: id(1), expiresAt })
    expect(store.get(id(2))).toEqual({
      key: key(0xcc), permanentKeyId: id(1), expiresAt,
    })
    store.save(id(3), { key: key(0xdd), permanentKeyId: id(1), expiresAt: 1 })
    expect(store.get(id(3))).toBeUndefined()
  })
})

describe('FileAuthKeyStore', () => {
  it('persists keys to disk and reloads them in a new instance', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')

    const store1 = new FileAuthKeyStore(path)
    store1.save(id(7), { key: key(0x42) })
    store1.save(id(8), { key: key(0x43), permanentKeyId: id(7), expiresAt: 4_000_000_000 })
    expect(store1.get(id(7))).toEqual({ key: key(0x42), permanentKeyId: undefined, expiresAt: undefined })

    // A fresh instance reading the same file sees the persisted key.
    const store2 = new FileAuthKeyStore(path)
    expect(store2.get(id(7))).toEqual({ key: key(0x42), permanentKeyId: undefined, expiresAt: undefined })
    expect(store2.get(id(8))).toEqual({ key: key(0x43), permanentKeyId: id(7), expiresAt: 4_000_000_000 })
    expect(store2.get(id(9))).toBeUndefined()
  })

  it('loads legacy bare-string entries as permanent keys', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    writeFileSync(path, JSON.stringify({ '0707070707070707': Buffer.from(key(0x42)).toString('hex') }))
    const store = new FileAuthKeyStore(path)
    expect(store.get(id(7))).toEqual({ key: key(0x42), permanentKeyId: undefined, expiresAt: undefined })
  })

  it('starts empty when the file does not exist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'missing.json')
    const store = new FileAuthKeyStore(path)
    expect(store.get(id(1))).toBeUndefined()
  })
})
