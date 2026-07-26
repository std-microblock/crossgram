/**
 * Process-local bridge state shared by every connection using the same
 * permanent auth key. The bridge persists durable account bindings separately;
 * this store keeps hydrated state (ID maps, subscriptions, counters) consistent
 * across Telegram Desktop's parallel main/upload/download connections.
 */
export class AuthKeyDataStore {
  private readonly _data = new Map<string, unknown>()

  get<T>(authKeyId: Uint8Array | null): T | null {
    if (!authKeyId) return null
    return (this._data.get(authKeyIdHex(authKeyId)) as T | undefined) ?? null
  }

  set(authKeyId: Uint8Array | null, data: unknown): void {
    if (!authKeyId) throw new Error('cannot attach backend data without a permanent auth key')
    this._data.set(authKeyIdHex(authKeyId), data)
  }

  delete(authKeyId: Uint8Array | null): boolean {
    return authKeyId ? this._data.delete(authKeyIdHex(authKeyId)) : false
  }
}

/** Stable, content-based key for an 8-byte MTProto auth key ID. */
export function authKeyIdHex(authKeyId: Uint8Array): string {
  let result = ''
  for (const byte of authKeyId) result += byte.toString(16).padStart(2, '0')
  return result
}
