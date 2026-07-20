import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StoredAuthKey {
  /** The 256-byte MTProto auth key. */
  key: Uint8Array
  /** Present for a temporary PFS key and points at its permanent identity. */
  permanentKeyId?: Uint8Array
  /** Unix timestamp after which a temporary key must be rejected. */
  expiresAt?: number
}

/** Persistent store for permanent keys and their bound temporary PFS keys. */
export interface AuthKeyStore {
  /** Look up an auth key by its 8-byte id. */
  get(id: Uint8Array): Promise<StoredAuthKey | undefined> | StoredAuthKey | undefined
  /** Persist a permanent key or temporary key association under its 8-byte id. */
  save(id: Uint8Array, record: StoredAuthKey): Promise<void> | void
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

  get(id: Uint8Array): StoredAuthKey | undefined {
    const record = this._keys.get(toHex(id))
    if (record?.expiresAt !== undefined && record.expiresAt <= Date.now() / 1000) {
      this._keys.delete(toHex(id))
      return undefined
    }
    return record
  }

  save(id: Uint8Array, record: StoredAuthKey): void {
    this._keys.set(toHex(id), record)
  }
}

interface SerializedAuthKey {
  key: string
  permanentKeyId?: string
  expiresAt?: number
}

/**
 * JSON-file-backed store — survives server restarts. The whole map is kept in
 * memory and flushed to disk on each save (auth keys are established rarely).
 */
export class FileAuthKeyStore implements AuthKeyStore {
  private _keys = new Map<string, SerializedAuthKey>()

  constructor(private readonly _path: string) {
    if (existsSync(_path)) {
      try {
        const raw = JSON.parse(readFileSync(_path, 'utf-8')) as Record<string, string | SerializedAuthKey>
        for (const [id, value] of Object.entries(raw)) {
          // Files written before temporary-key support stored the key as a bare
          // hex string. Treat those entries as permanent keys during migration.
          this._keys.set(id, typeof value === 'string' ? { key: value } : value)
        }
      } catch {
        // corrupt/empty file — start fresh
      }
    }
  }

  get(id: Uint8Array): StoredAuthKey | undefined {
    const idHex = toHex(id)
    const value = this._keys.get(idHex)
    if (!value) return undefined
    if (value.expiresAt !== undefined && value.expiresAt <= Date.now() / 1000) {
      this._keys.delete(idHex)
      return undefined
    }
    return {
      key: fromHex(value.key),
      permanentKeyId: value.permanentKeyId ? fromHex(value.permanentKeyId) : undefined,
      expiresAt: value.expiresAt,
    }
  }

  save(id: Uint8Array, record: StoredAuthKey): void {
    this._keys.set(toHex(id), {
      key: toHex(record.key),
      permanentKeyId: record.permanentKeyId ? toHex(record.permanentKeyId) : undefined,
      expiresAt: record.expiresAt,
    })
    mkdirSync(dirname(this._path), { recursive: true })
    const temporaryPath = `${this._path}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(this._keys)))
    renameSync(temporaryPath, this._path)
  }
}
