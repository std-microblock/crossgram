import { describe, it, expect } from 'vitest'
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync,
  writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuthKeyStore, FileAuthKeyStore, type FileAuthKeyStoreFileSystem } from './auth-key-store.js'

const id = (n: number) => new Uint8Array([n, n, n, n, n, n, n, n])
const key = (n: number) => { const k = new Uint8Array(256); k.fill(n); return k }

function fileSystem(overrides: Partial<FileAuthKeyStoreFileSystem> = {}): FileAuthKeyStoreFileSystem {
  return {
    existsSync: overrides.existsSync ?? existsSync,
    readFileSync: overrides.readFileSync ?? readFileSync,
    writeFileSync: overrides.writeFileSync ?? writeFileSync,
    mkdirSync: overrides.mkdirSync ?? mkdirSync,
    renameSync: overrides.renameSync ?? renameSync,
    openSync: overrides.openSync ?? openSync,
    fsyncSync: overrides.fsyncSync ?? fsyncSync,
    closeSync: overrides.closeSync ?? closeSync,
    writeSync: overrides.writeSync ?? writeSync,
    ftruncateSync: overrides.ftruncateSync ?? ftruncateSync,
  }
}

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

  it('revokes a permanent key together with its temporary keys', () => {
    const store = new MemoryAuthKeyStore()
    store.save(id(1), { key: key(0xaa) })
    store.save(id(2), { key: key(0xbb), permanentKeyId: id(1), expiresAt: 4_000_000_000 })
    store.save(id(3), { key: key(0xcc) })

    expect(store.delete(id(1))).toBe(true)
    expect(store.get(id(1))).toBeUndefined()
    expect(store.get(id(2))).toBeUndefined()
    expect(store.get(id(3))).toEqual({ key: key(0xcc) })
    expect(store.delete(id(1))).toBe(false)
  })

  it('fails closed for a permanent key and its children between revocation phases', () => {
    const store = new MemoryAuthKeyStore()
    store.save(id(1), { key: key(0xaa) })
    store.save(id(2), { key: key(0xbb), permanentKeyId: id(1), expiresAt: 4_000_000_000 })

    store.beginRevocation(id(1))
    expect(store.get(id(1))).toBeUndefined()
    expect(store.get(id(2))).toBeUndefined()
    expect(() => store.save(id(1), { key: key(0xcc) })).toThrow('being revoked')
    expect(() => store.save(id(2), { key: key(0xcc), permanentKeyId: id(1) })).toThrow('being revoked')

    expect(store.finishRevocation(id(1))).toBe(true)
  })
})

describe('FileAuthKeyStore', () => {
  it('migrates legacy root maps and rewrites them as a versioned envelope', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    writeFileSync(path, JSON.stringify({
      '0707070707070707': Buffer.from(key(0x42)).toString('hex'),
      '0808080808080808': { key: Buffer.from(key(0x43)).toString('hex'), apiLayer: 227 },
    }))

    const store = new FileAuthKeyStore(path)
    expect(store.get(id(7))).toMatchObject({ key: key(0x42) })
    expect(store.get(id(8))).toMatchObject({ key: key(0x43), apiLayer: 227 })
    store.save(id(9), { key: key(0x44) })

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      revoked: [],
      keys: {
        '0707070707070707': { key: Buffer.from(key(0x42)).toString('hex') },
        '0808080808080808': { key: Buffer.from(key(0x43)).toString('hex'), apiLayer: 227 },
        '0909090909090909': { key: Buffer.from(key(0x44)).toString('hex') },
      },
    })
  })

  it('persists keys to disk and reloads them in a new instance', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')

    const store1 = new FileAuthKeyStore(path)
    store1.save(id(7), { key: key(0x42), apiLayer: 227 })
    store1.save(id(8), { key: key(0x43), permanentKeyId: id(7), expiresAt: 4_000_000_000 })
    expect(store1.get(id(7))).toEqual({
      key: key(0x42), permanentKeyId: undefined, expiresAt: undefined, apiLayer: 227,
    })

    // A fresh instance reading the same file sees the persisted key.
    const store2 = new FileAuthKeyStore(path)
    expect(store2.get(id(7))).toEqual({
      key: key(0x42), permanentKeyId: undefined, expiresAt: undefined, apiLayer: 227,
    })
    expect(store2.get(id(8))).toEqual({
      key: key(0x43), permanentKeyId: id(7), expiresAt: 4_000_000_000, apiLayer: undefined,
    })
    expect(store2.get(id(9))).toBeUndefined()
  })

  it('loads legacy bare-string entries as permanent keys', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    writeFileSync(path, JSON.stringify({ '0707070707070707': Buffer.from(key(0x42)).toString('hex') }))
    const store = new FileAuthKeyStore(path)
    expect(store.get(id(7))).toEqual({
      key: key(0x42), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined,
    })
  })

  it('persists permanent and temporary key revocation', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(path)
    store.save(id(1), { key: key(0xaa) })
    store.save(id(2), { key: key(0xbb), permanentKeyId: id(1), expiresAt: 4_000_000_000 })

    expect(store.delete(id(1))).toBe(true)
    const resumed = new FileAuthKeyStore(path)
    expect(resumed.get(id(1))).toBeUndefined()
    expect(resumed.get(id(2))).toBeUndefined()
  })

  it('persists a fail-closed revocation marker across restart and recovers it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(path)
    store.save(id(1), { key: key(0xaa) })
    store.save(id(2), { key: key(0xbb), permanentKeyId: id(1), expiresAt: 4_000_000_000 })
    store.beginRevocation(id(1))
    expect(store.get(id(1))).toBeUndefined()
    expect(store.get(id(2))).toBeUndefined()
    expect(() => store.save(id(1), { key: key(0xcc) })).toThrow('being revoked')
    expect(() => store.save(id(2), {
      key: key(0xcc), permanentKeyId: id(1), expiresAt: 4_000_000_000,
    })).toThrow('being revoked')

    const restarted = new FileAuthKeyStore(path)
    expect(restarted.get(id(1))).toBeUndefined()
    expect(restarted.get(id(2))).toBeUndefined()
    expect(() => restarted.save(id(1), { key: key(0xcc) })).toThrow('being revoked')
    expect(() => restarted.save(id(2), {
      key: key(0xcc), permanentKeyId: id(1), expiresAt: 4_000_000_000,
    })).toThrow('being revoked')

    restarted.recoverPendingRevocations()
    const recovered = new FileAuthKeyStore(path)
    expect(recovered.get(id(1))).toBeUndefined()
    expect(recovered.get(id(2))).toBeUndefined()
  })

  it('keeps the prior memory and disk snapshot when writing a revocation tombstone fails', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    const before = readFileSync(path, 'utf8')
    const store = new FileAuthKeyStore(path, fileSystem({
      writeFileSync: () => { throw new Error('write failed') },
    }))

    expect(() => store.beginRevocation(id(1))).toThrow('write failed')
    expect(store.get(id(1))).toEqual({ key: key(0xaa), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('keeps the prior memory and disk snapshot when renaming a revocation tombstone fails', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    const before = readFileSync(path, 'utf8')
    const store = new FileAuthKeyStore(path, fileSystem({
      renameSync: () => { throw new Error('rename failed') },
    }))

    expect(() => store.beginRevocation(id(1))).toThrow('rename failed')
    expect(store.get(id(1))).toEqual({ key: key(0xaa), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('fails closed after a durable tombstone but before material purge survives a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(path)
    store.save(id(1), { key: key(0xaa) })
    store.save(id(2), { key: key(0xbb), permanentKeyId: id(1), expiresAt: 4_000_000_000 })
    store.beginRevocation(id(1))
    const failedFinish = new FileAuthKeyStore(path, fileSystem({
      renameSync: () => { throw new Error('purge flush failed') },
    }))

    expect(() => failedFinish.finishRevocation(id(1))).toThrow('purge flush failed')
    const restarted = new FileAuthKeyStore(path)
    expect(restarted.get(id(1))).toBeUndefined()
    expect(restarted.get(id(2))).toBeUndefined()
    restarted.recoverPendingRevocations()
    const recovered = new FileAuthKeyStore(path)
    expect(recovered.get(id(1))).toBeUndefined()
    expect(recovered.get(id(2))).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, keys: {}, revoked: [] })
  })

  it('keeps a completed-material tombstone fail-closed when marker removal fails until recovery', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(path)
    store.save(id(1), { key: key(0xaa) })
    store.save(id(2), { key: key(0xbb), permanentKeyId: id(1), expiresAt: 4_000_000_000 })
    store.beginRevocation(id(1))
    let renames = 0
    const failedFinish = new FileAuthKeyStore(path, fileSystem({
      renameSync: (...args: Parameters<typeof renameSync>) => {
        renames++
        if (renames === 2) throw new Error('marker clear failed')
        return renameSync(...args)
      },
    }))

    expect(() => failedFinish.finishRevocation(id(1))).toThrow('marker clear failed')
    const restarted = new FileAuthKeyStore(path)
    expect(restarted.get(id(1))).toBeUndefined()
    expect(restarted.get(id(2))).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ revoked: ['0101010101010101'], keys: {} })
    restarted.recoverPendingRevocations()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, keys: {}, revoked: [] })
  })

  it('does not acknowledge begin when file or directory fsync fails', () => {
    if (process.platform === 'win32') return
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    const before = readFileSync(path, 'utf8')

    for (const failingSync of [1, 2]) {
      let syncs = 0
      const store = new FileAuthKeyStore(path, fileSystem({
        fsyncSync: (fd) => {
          syncs++
          if (syncs === failingSync) throw new Error(`fsync ${failingSync} failed`)
          return fsyncSync(fd)
        },
      }))
      if (failingSync === 1) {
        expect(() => store.beginRevocation(id(1))).toThrow('fsync 1 failed')
        expect(store.get(id(1))).toEqual({
          key: key(0xaa), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined,
        })
        expect(readFileSync(path, 'utf8')).toBe(before)
      } else {
        expect(() => store.beginRevocation(id(1))).toThrow('auth key snapshot may have been published before durability failed')
        expect(store.get(id(1))).toBeUndefined()
        expect(new FileAuthKeyStore(path).get(id(1))).toBeUndefined()
      }
    }
  })

  it('writes the durable barrier in file-fsync-rename-directory-fsync order', () => {
    if (process.platform === 'win32') return
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const calls: string[] = []
    const store = new FileAuthKeyStore(path, fileSystem({
      writeFileSync: (...args) => {
        calls.push('write')
        return writeFileSync(...args)
      },
      openSync: (path, flags) => {
        calls.push(String(path).endsWith('.tmp') ? 'open-file' : 'open-directory')
        return openSync(path, flags)
      },
      fsyncSync: (fd) => {
        calls.push('fsync')
        return fsyncSync(fd)
      },
      closeSync: (fd) => {
        calls.push('close')
        return closeSync(fd)
      },
      renameSync: (...args) => {
        calls.push('rename')
        return renameSync(...args)
      },
    }))

    store.save(id(1), { key: key(0xaa) })
    calls.length = 0
    store.beginRevocation(id(1))
    expect(calls).toEqual([
      'write', 'open-file', 'fsync', 'close', 'rename', 'open-directory', 'fsync', 'close',
    ])
  })

  it('uses a fsynced append-only journal before compacting a Windows snapshot', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const calls: string[] = []
    const store = new FileAuthKeyStore(path, fileSystem({
      writeFileSync: (...args) => {
        calls.push('write-temp')
        return writeFileSync(...args)
      },
      openSync: (path, flags) => {
        const kind = String(path).endsWith('.revocations')
          ? 'journal'
          : (String(path).endsWith('.tmp') ? 'temp' : 'final')
        calls.push(`open:${kind}:${flags}`)
        return openSync(path, flags)
      },
      writeSync: (fd, data) => {
        calls.push(`append:${String(data).trim()}`)
        return writeSync(fd, data)
      },
      fsyncSync: (fd) => {
        calls.push('fsync')
        return fsyncSync(fd)
      },
      closeSync: (fd) => {
        calls.push('close')
        return closeSync(fd)
      },
      renameSync: (...args) => {
        calls.push('rename')
        return renameSync(...args)
      },
    }), 'win32')

    store.save(id(1), { key: key(0xaa) })
    calls.length = 0
    store.beginRevocation(id(1))
    expect(calls).toEqual([
      'open:journal:a', 'append:v1 begin 0101010101010101', 'fsync', 'close',
      'write-temp', 'open:temp:r', 'fsync', 'close', 'rename',
    ])
  })

  it('refuses Windows startup when the revocation journal cannot be fsynced', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    expect(() => new FileAuthKeyStore(path, fileSystem({
      fsyncSync: () => { throw new Error('journal fsync failed') },
    }), 'win32')).toThrow('journal fsync failed')
  })

  it('keeps the old key usable when a Windows begin journal append is denied before writing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    const store = new FileAuthKeyStore(path, fileSystem({
      writeSync: () => { throw new Error('journal access denied') },
    }), 'win32')

    expect(() => store.beginRevocation(id(1))).toThrow('journal access denied')
    expect(store.get(id(1))).toEqual({ key: key(0xaa), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
    expect(new FileAuthKeyStore(path, fileSystem(), 'win32').get(id(1))).toEqual({
      key: key(0xaa), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined,
    })
  })

  it('completes short Windows journal writes before fsyncing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    let writes = 0
    const store = new FileAuthKeyStore(path, fileSystem({
      writeSync: (fd, data, offset, length) => {
        writes++
        return writeSync(fd, data, offset, Math.min(length!, 3))
      },
    }), 'win32')
    store.save(id(1), { key: key(0xaa) })
    store.beginRevocation(id(1))

    expect(writes).toBeGreaterThan(1)
    expect(readFileSync(`${path}.revocations`, 'utf8')).toBe('v1 begin 0101010101010101\n')
  })

  it('rejects a Windows journal write that makes no progress', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    const store = new FileAuthKeyStore(path, fileSystem({ writeSync: () => 0 }), 'win32')

    expect(() => store.beginRevocation(id(1))).toThrow('write made no progress')
    expect(store.get(id(1))).toEqual({ key: key(0xaa), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
  })

  it('truncates a torn Windows journal tail while replaying complete preceding records', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    initial.save(id(2), { key: key(0xbb) })
    writeFileSync(`${path}.revocations`, 'v1 begin 0101010101010101\nv1 begin 0202')

    const store = new FileAuthKeyStore(path, fileSystem(), 'win32')
    expect(store.get(id(1))).toBeUndefined()
    expect(store.get(id(2))).toEqual({ key: key(0xbb), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
    expect(readFileSync(`${path}.revocations`, 'utf8')).toBe('v1 begin 0101010101010101\n')
  })

  it('fails closed when a Windows journal begin succeeds but snapshot compaction fails', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    initial.save(id(2), { key: key(0xbb) })
    const store = new FileAuthKeyStore(path, fileSystem({
      writeFileSync: () => { throw new Error('snapshot write failed') },
    }), 'win32')

    expect(() => store.beginRevocation(id(1))).toThrow('auth key snapshot may have been published before durability failed')
    expect(store.get(id(1))).toBeUndefined()
    const restarted = new FileAuthKeyStore(path, fileSystem(), 'win32')
    expect(restarted.get(id(1))).toBeUndefined()
    expect(restarted.get(id(2))).toEqual({ key: key(0xbb), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
  })

  it('preserves the old complete Windows snapshot when temp rename fails after a journaled begin', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const initial = new FileAuthKeyStore(path)
    initial.save(id(1), { key: key(0xaa) })
    initial.save(id(2), { key: key(0xbb) })
    const store = new FileAuthKeyStore(path, fileSystem({
      renameSync: () => { throw new Error('snapshot rename failed') },
    }), 'win32')

    expect(() => store.beginRevocation(id(1))).toThrow('auth key snapshot may have been published before durability failed')
    const restarted = new FileAuthKeyStore(path, fileSystem(), 'win32')
    expect(restarted.get(id(1))).toBeUndefined()
    expect(restarted.get(id(2))).toEqual({ key: key(0xbb), permanentKeyId: undefined, expiresAt: undefined, apiLayer: undefined })
  })

  it('records a Windows done event after a durable purge without retrying on restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(path, fileSystem(), 'win32')
    store.save(id(1), { key: key(0xaa) })
    store.beginRevocation(id(1))
    store.finishRevocation(id(1))

    expect(readFileSync(`${path}.revocations`, 'utf8')).toContain('v1 done 0101010101010101')
    const restarted = new FileAuthKeyStore(path, fileSystem(), 'win32')
    restarted.recoverPendingRevocations()
    expect(restarted.get(id(1))).toBeUndefined()
  })

  it('keeps a Windows begin pending when appending done fails until recovery succeeds', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(path, fileSystem({
      writeSync: (fd, data) => {
        if (String(data).startsWith('v1 done')) throw new Error('done append failed')
        return writeSync(fd, data)
      },
    }), 'win32')
    store.save(id(1), { key: key(0xaa) })
    store.beginRevocation(id(1))

    expect(() => store.finishRevocation(id(1))).toThrow('done append failed')
    const restarted = new FileAuthKeyStore(path, fileSystem(), 'win32')
    expect(restarted.get(id(1))).toBeUndefined()
    restarted.recoverPendingRevocations()
    expect(readFileSync(`${path}.revocations`, 'utf8')).toContain('v1 done 0101010101010101')
  })

  it('refuses a malformed Windows revocation journal', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'auth-keys.json')
    writeFileSync(`${path}.revocations`, 'bad journal\n')
    expect(() => new FileAuthKeyStore(path, fileSystem(), 'win32')).toThrow('invalid auth key revocation journal')
  })

  it('starts empty when the file does not exist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'authkeys-')), 'missing.json')
    const store = new FileAuthKeyStore(path)
    expect(store.get(id(1))).toBeUndefined()
  })
})
