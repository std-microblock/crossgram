import {
  readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync,
  ftruncateSync,
} from 'node:fs'
import { dirname } from 'node:path'

export class AuthKeyStorePublishedError extends Error {
  constructor(readonly cause: unknown, readonly phase: 'post-rename' | 'windows-journal') {
    super('auth key snapshot may have been published before durability failed')
  }
}

export interface StoredAuthKey {
  /** The 256-byte MTProto auth key. */
  key: Uint8Array
  /** Present for a temporary PFS key and points at its permanent identity. */
  permanentKeyId?: Uint8Array
  /** Unix timestamp after which a temporary key must be rejected. */
  expiresAt?: number
  /** Last API layer negotiated by the permanent key. */
  apiLayer?: number
}

/** Persistent store for permanent keys and their bound temporary PFS keys. */
export interface AuthKeyStore {
  /** Look up an auth key by its 8-byte id. */
  get(id: Uint8Array): Promise<StoredAuthKey | undefined> | StoredAuthKey | undefined
  /** Persist a permanent key or temporary key association under its 8-byte id. */
  save(id: Uint8Array, record: StoredAuthKey): Promise<void> | void
  /** Write a durable fail-closed marker before a permanent key is revoked. */
  beginRevocation(id: Uint8Array): Promise<void> | void
  /** Remove revoked key material, then clear its marker only after that succeeds. */
  finishRevocation(id: Uint8Array): Promise<boolean> | boolean
  /** Complete any revocations that survived a process restart. */
  recoverPendingRevocations(): Promise<void> | void
  /** Revoke a permanent key and every temporary key bound to it. */
  delete(id: Uint8Array): Promise<boolean> | boolean
}

function toHex(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0')
  return s
}

function fromHex(s: string): Uint8Array {
  const u = new Uint8Array(s.length / 2)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return u
}

/** In-memory store — survives across connections within one process, not restarts. */
export class MemoryAuthKeyStore implements AuthKeyStore {
  private _keys = new Map<string, StoredAuthKey>()
  private _revoked = new Set<string>()

  get(id: Uint8Array): StoredAuthKey | undefined {
    const idHex = toHex(id)
    const record = this._keys.get(idHex)
    if (this._revoked.has(idHex) || (record?.permanentKeyId && this._revoked.has(toHex(record.permanentKeyId)))) {
      return undefined
    }
    if (record?.expiresAt !== undefined && record.expiresAt <= Date.now() / 1000) {
      this._keys.delete(idHex)
      return undefined
    }
    return record
  }

  save(id: Uint8Array, record: StoredAuthKey): void {
    const idHex = toHex(id)
    const existing = this._keys.get(idHex)
    const permanentId = record.permanentKeyId
      ? toHex(record.permanentKeyId)
      : (existing?.permanentKeyId ? toHex(existing.permanentKeyId) : idHex)
    if (this._revoked.has(permanentId)) throw new Error('auth key is being revoked')
    this._keys.set(idHex, record)
  }

  beginRevocation(id: Uint8Array): void {
    this._revoked.add(toHex(id))
  }

  finishRevocation(id: Uint8Array): boolean {
    const idHex = toHex(id)
    let deleted = this._keys.delete(idHex)
    for (const [key, record] of this._keys) {
      if (record.permanentKeyId && toHex(record.permanentKeyId) === idHex) {
        this._keys.delete(key)
        deleted = true
      }
    }
    this._revoked.delete(idHex)
    return deleted
  }

  recoverPendingRevocations(): void {
    for (const id of [...this._revoked]) this.finishRevocation(fromHex(id))
  }

  delete(id: Uint8Array): boolean {
    this.beginRevocation(id)
    return this.finishRevocation(id)
  }
}

interface SerializedAuthKey {
  key: string
  permanentKeyId?: string
  expiresAt?: number
  apiLayer?: number
}

interface SerializedAuthKeyEnvelope {
  version: 1
  keys: Record<string, string | SerializedAuthKey>
  revoked: string[]
}

/** Injectable synchronous filesystem boundary for deterministic persistence-failure tests. */
export interface FileAuthKeyStoreFileSystem {
  readFileSync: typeof readFileSync
  writeFileSync: typeof writeFileSync
  mkdirSync: typeof mkdirSync
  existsSync: typeof existsSync
  renameSync: typeof renameSync
  openSync: typeof openSync
  fsyncSync: typeof fsyncSync
  closeSync: typeof closeSync
  writeSync: typeof writeSync
  ftruncateSync: typeof ftruncateSync
}

const nativeFileSystem: FileAuthKeyStoreFileSystem = {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  writeSync,
  ftruncateSync,
}

function isEnvelope(value: unknown): value is SerializedAuthKeyEnvelope {
  return Boolean(value && typeof value === 'object'
    && (value as { version?: unknown }).version === 1
    && typeof (value as { keys?: unknown }).keys === 'object'
    && Array.isArray((value as { revoked?: unknown }).revoked))
}

/**
 * JSON-file-backed store — survives server restarts. The whole snapshot is
 * written through a temporary file before replacing in-memory state.
 */
export class FileAuthKeyStore implements AuthKeyStore {
  private _keys = new Map<string, SerializedAuthKey>()
  private _revoked = new Set<string>()
  private _pendingRevocations = new Set<string>()

  constructor(
    private readonly _path: string,
    private readonly _fs: FileAuthKeyStoreFileSystem = nativeFileSystem,
    private readonly _platform: NodeJS.Platform = process.platform,
  ) {
    if (!_fs.existsSync(_path)) {
      if (this._platform === 'win32') this._loadWindowsJournal()
      return
    }
    try {
      const raw = JSON.parse(_fs.readFileSync(_path, 'utf-8')) as unknown
      const keys = isEnvelope(raw)
        ? raw.keys
        : raw as Record<string, string | SerializedAuthKey>
      for (const [id, value] of Object.entries(keys)) {
        // Files written before temporary-key support stored the key as a bare
        // hex string. Treat those entries as permanent keys during migration.
        this._keys.set(id, typeof value === 'string' ? { key: value } : value)
      }
      if (isEnvelope(raw)) this._revoked = new Set(raw.revoked)
    } catch {
      // A corrupt main snapshot contains no trusted key material.
    }
    if (this._platform === 'win32') this._loadWindowsJournal()
  }

  get(id: Uint8Array): StoredAuthKey | undefined {
    const idHex = toHex(id)
    const value = this._keys.get(idHex)
    if (!value || this._revoked.has(idHex) || (value.permanentKeyId && this._revoked.has(value.permanentKeyId))) {
      return undefined
    }
    if (value.expiresAt !== undefined && value.expiresAt <= Date.now() / 1000) return undefined
    return {
      key: fromHex(value.key),
      permanentKeyId: value.permanentKeyId ? fromHex(value.permanentKeyId) : undefined,
      expiresAt: value.expiresAt,
      apiLayer: value.apiLayer,
    }
  }

  save(id: Uint8Array, record: StoredAuthKey): void {
    const idHex = toHex(id)
    const existing = this._keys.get(idHex)
    const permanentId = record.permanentKeyId
      ? toHex(record.permanentKeyId)
      : existing?.permanentKeyId ?? idHex
    if (this._revoked.has(permanentId)) throw new Error('auth key is being revoked')
    const keys = new Map(this._keys)
    keys.set(idHex, {
      key: toHex(record.key),
      permanentKeyId: record.permanentKeyId ? toHex(record.permanentKeyId) : undefined,
      expiresAt: record.expiresAt,
      apiLayer: record.apiLayer,
    })
    this._commit(keys, new Set(this._revoked))
  }

  beginRevocation(id: Uint8Array): void {
    const idHex = toHex(id)
    if (this._platform === 'win32') {
      this._appendWindowsJournal('begin', idHex)
      this._revoked.add(idHex)
      this._pendingRevocations.add(idHex)
      try {
        this._commit(new Map(this._keys), new Set(this._revoked))
      } catch (error) {
        throw new AuthKeyStorePublishedError(error, 'windows-journal')
      }
      return
    }
    const revoked = new Set(this._revoked)
    revoked.add(idHex)
    this._commit(new Map(this._keys), revoked)
  }

  finishRevocation(id: Uint8Array): boolean {
    const idHex = toHex(id)
    const keys = new Map(this._keys)
    let deleted = keys.delete(idHex)
    for (const [key, record] of keys) {
      if (record.permanentKeyId === idHex) {
        keys.delete(key)
        deleted = true
      }
    }
    // Keep the tombstone through the durable key-material purge.
    this._commit(keys, new Set(this._revoked))
    if (this._platform === 'win32') {
      this._appendWindowsJournal('done', idHex)
      this._pendingRevocations.delete(idHex)
      return deleted
    }
    const revoked = new Set(this._revoked)
    revoked.delete(idHex)
    this._commit(new Map(this._keys), revoked)
    return deleted
  }

  recoverPendingRevocations(): void {
    const pending = this._platform === 'win32' ? this._pendingRevocations : this._revoked
    for (const id of [...pending]) this.finishRevocation(fromHex(id))
  }

  delete(id: Uint8Array): boolean {
    this.beginRevocation(id)
    return this.finishRevocation(id)
  }

  private _commit(keys: Map<string, SerializedAuthKey>, revoked: Set<string>): void {
    this._flush(keys, revoked, () => {
      this._keys = keys
      this._revoked = revoked
    })
  }

  private _flush(
    keys: Map<string, SerializedAuthKey>,
    revoked: Set<string>,
    onPublished: () => void,
  ): void {
    this._fs.mkdirSync(dirname(this._path), { recursive: true })
    const temporaryPath = `${this._path}.tmp`
    const snapshot: SerializedAuthKeyEnvelope = {
      version: 1,
      keys: Object.fromEntries(keys),
      revoked: [...revoked],
    }
    const serialized = JSON.stringify(snapshot)
    this._fs.writeFileSync(temporaryPath, serialized)
    this._syncPath(temporaryPath)
    this._fs.renameSync(temporaryPath, this._path)
    onPublished()
    if (this._platform === 'win32') return
    try {
      this._syncPath(dirname(this._path))
    } catch (error) {
      throw new AuthKeyStorePublishedError(error, 'post-rename')
    }
  }

  private _loadWindowsJournal(): void {
    const path = `${this._path}.revocations`
    this._fs.mkdirSync(dirname(path), { recursive: true })
    this._syncWindowsJournal(path)
    const bytes = this._fs.readFileSync(path) as Buffer
    const lastNewline = bytes.lastIndexOf(0x0a)
    if (lastNewline + 1 < bytes.length) this._truncateWindowsJournal(path, lastNewline + 1)
    const complete = bytes.subarray(0, Math.max(0, lastNewline + 1)).toString('utf8')
    for (const line of complete.split('\n')) {
      if (!line) continue
      const match = /^v1 (begin|done) ([0-9a-f]{16})$/.exec(line)
      if (!match) throw new Error('invalid auth key revocation journal')
      const [, action, id] = match
      this._revoked.add(id!)
      if (action === 'begin') this._pendingRevocations.add(id!)
      else this._pendingRevocations.delete(id!)
    }
  }

  private _appendWindowsJournal(action: 'begin' | 'done', id: string): void {
    const path = `${this._path}.revocations`
    const event = Buffer.from(`v1 ${action} ${id}\n`)
    const fd = this._fs.openSync(path, 'a')
    try {
      let offset = 0
      while (offset < event.length) {
        const written = this._fs.writeSync(fd, event, offset, event.length - offset)
        if (written <= 0) throw new Error('auth key revocation journal write made no progress')
        offset += written
      }
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  private _truncateWindowsJournal(path: string, length: number): void {
    const fd = this._fs.openSync(path, 'r+')
    try {
      this._fs.ftruncateSync(fd, length)
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  private _syncWindowsJournal(path: string): void {
    const fd = this._fs.openSync(path, 'a')
    try {
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  private _syncPath(path: string): void {
    // Windows rejects FlushFileBuffers/fsync for handles opened without write
    // access (Node 24 surfaces this as EPERM). The temporary snapshot is ours,
    // so open it read/write there while retaining the least-privilege read-only
    // directory/file handle used by POSIX.
    const fd = this._fs.openSync(path, this._platform === 'win32' ? 'r+' : 'r')
    try {
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }
}
