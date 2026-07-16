import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Persistent store for established permanent auth keys.
 *
 * MTProto clients (especially Telegram Desktop) cache their permanent auth key
 * and reuse it on reconnect by sending encrypted traffic with the cached
 * `auth_key_id` — without redoing the DH handshake. A stateless server that
 * forgets keys on restart therefore leaves such clients stuck. Persisting keys
 * lets the server recognize a returning client and skip the handshake.
 *
 * Only the 256-byte auth key is stored; the server salt is renegotiated per
 * connection (clients adapt via `bad_server_salt`).
 */
export interface AuthKeyStore {
  /** Look up an auth key by its 8-byte id. */
  get(id: Uint8Array): Promise<Uint8Array | undefined> | Uint8Array | undefined
  /** Persist an auth key under its 8-byte id. */
  save(id: Uint8Array, key: Uint8Array): Promise<void> | void
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
  private _keys = new Map<string, Uint8Array>()

  get(id: Uint8Array): Uint8Array | undefined {
    return this._keys.get(toHex(id))
  }

  save(id: Uint8Array, key: Uint8Array): void {
    this._keys.set(toHex(id), key)
  }
}

/**
 * JSON-file-backed store — survives server restarts. The whole map is kept in
 * memory and flushed to disk on each save (auth keys are established rarely).
 */
export class FileAuthKeyStore implements AuthKeyStore {
  private _keys = new Map<string, string>()

  constructor(private readonly _path: string) {
    if (existsSync(_path)) {
      try {
        const raw = JSON.parse(readFileSync(_path, 'utf-8')) as Record<string, string>
        for (const [id, key] of Object.entries(raw)) this._keys.set(id, key)
      } catch {
        // corrupt/empty file — start fresh
      }
    }
  }

  get(id: Uint8Array): Uint8Array | undefined {
    const hex = this._keys.get(toHex(id))
    return hex ? fromHex(hex) : undefined
  }

  save(id: Uint8Array, key: Uint8Array): void {
    this._keys.set(toHex(id), toHex(key))
    mkdirSync(dirname(this._path), { recursive: true })
    writeFileSync(this._path, JSON.stringify(Object.fromEntries(this._keys)))
  }
}
