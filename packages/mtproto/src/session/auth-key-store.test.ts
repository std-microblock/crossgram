import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuthKeyStore, FileAuthKeyStore } from './auth-key-store.js'

const id = (n: number) => new Uint8Array([n, n, n, n, n, n, n, n])
const key = (n: number) => { const k = new Uint8Array(256); k.fill(n); return k }

describe('MemoryAuthKeyStore', () => {
  it('saves and retrieves keys by id', () => {
    const store = new MemoryAuthKeyStore()
    expect(store.get(id(1))).toBeUndefined()
    store.save(id(1), key(0xaa))
    expect(store.get(id(1))).toEqual(key(0xaa))
    // a different id is independent
    expect(store.get(id(2))).toBeUndefined()
  })

  it('overwrites an existing id', () => {
    const store = new MemoryAuthKeyStore()
    store.save(id(1), key(0xaa))
    store.save(id(1), key(0xbb))
    expect(store.get(id(1))).toEqual(key(0xbb))
  })
})

describe('FileAuthKeyStore', () => {
  it('persists keys to disk and reloads them in a new instance', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')

    const store1 = new FileAuthKeyStore(path)
    store1.save(id(7), key(0x42))
    expect(store1.get(id(7))).toEqual(key(0x42))

    // A fresh instance reading the same file sees the persisted key.
    const store2 = new FileAuthKeyStore(path)
    expect(store2.get(id(7))).toEqual(key(0x42))
    expect(store2.get(id(8))).toBeUndefined()
  })

  it('starts empty when the file does not exist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'missing.json')
    const store = new FileAuthKeyStore(path)
    expect(store.get(id(1))).toBeUndefined()
  })
})
