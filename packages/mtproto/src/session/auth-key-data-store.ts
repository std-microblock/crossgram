export const AUTH_KEY_DATA_IDLE_TTL_MS = 5 * 60_000

/**
 * Process-local bridge state shared by every connection using the same
 * permanent auth key. The bridge persists durable account bindings separately;
 * this store keeps hydrated state (ID maps, subscriptions, counters) consistent
 * across Telegram Desktop's parallel main/upload/download connections.
 * Reconstructible state expires after the last live connection/RPC goes idle;
 * durable authentication and account bindings are never evicted here.
 */
export class AuthKeyDataStore {
  private readonly _data = new Map<string, unknown>()
  private readonly _lastUsed = new Map<string, number>()

  get<T>(authKeyId: Uint8Array | null): T | null {
    if (!authKeyId) return null
    const key = authKeyIdHex(authKeyId)
    if (this._data.has(key)) this._lastUsed.set(key, Date.now())
    return (this._data.get(key) as T | undefined) ?? null
  }

  set(authKeyId: Uint8Array | null, data: unknown): void {
    if (!authKeyId) throw new Error('cannot attach backend data without a permanent auth key')
    const key = authKeyIdHex(authKeyId)
    this._data.set(key, data)
    this._lastUsed.set(key, Date.now())
  }

  delete(authKeyId: Uint8Array | null): boolean {
    if (!authKeyId) return false
    const key = authKeyIdHex(authKeyId)
    this._lastUsed.delete(key)
    return this._data.delete(key)
  }

  /** Keep live devices and short reconnects warm, not every device ever seen. */
  prune(activeAuthKeys: ReadonlySet<string>, now = Date.now()): string[] {
    const removed: string[] = []
    for (const [key, lastUsed] of this._lastUsed) {
      if (activeAuthKeys.has(key)) {
        this._lastUsed.set(key, now)
      } else if (now - lastUsed >= AUTH_KEY_DATA_IDLE_TTL_MS) {
        this._data.delete(key)
        this._lastUsed.delete(key)
        removed.push(key)
      }
    }
    return removed
  }

  clear(): void {
    this._data.clear()
    this._lastUsed.clear()
  }
}

/** Stable, content-based key for an 8-byte MTProto auth key ID. */
export function authKeyIdHex(authKeyId: Uint8Array): string {
  let result = ''
  for (const byte of authKeyId) result += byte.toString(16).padStart(2, '0')
  return result
}
