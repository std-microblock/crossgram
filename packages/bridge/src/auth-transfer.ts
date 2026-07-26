import { randomBytes, timingSafeEqual } from 'node:crypto'
import Long from 'long'

export interface AuthTransferIdentity {
  platformId: string
  platformSessionId: string
}

export interface ExportedAuthTransfer {
  id: Long
  bytes: Uint8Array
}

interface AuthTransferEntry extends AuthTransferIdentity {
  bytes: Uint8Array
  targetDcId: number
  expiresAt: number
}

/** Short-lived, one-shot tickets used to authorize a second logical DC connection. */
export class AuthTransferStore {
  private readonly entries = new Map<string, AuthTransferEntry>()

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Uint8Array = randomBytes,
  ) {}

  issue(identity: AuthTransferIdentity, targetDcId: number): ExportedAuthTransfer {
    this.prune()
    let id: Long
    let key: string
    do {
      id = Long.fromBytesLE([...this.random(8)], true)
      key = id.toUnsigned().toString()
    } while (this.entries.has(key))

    const bytes = this.random(32)
    this.entries.set(key, {
      ...identity,
      bytes: bytes.slice(),
      targetDcId,
      expiresAt: this.now() + this.ttlMs,
    })
    return { id, bytes }
  }

  take(id: Long, bytes: Uint8Array): AuthTransferIdentity | undefined {
    const key = id.toUnsigned().toString()
    const entry = this.getValid(id)
    if (!entry || !equalBytes(entry.bytes, bytes)) return
    this.entries.delete(key)
    return { platformId: entry.platformId, platformSessionId: entry.platformSessionId }
  }

  private getValid(id: Long): AuthTransferEntry | undefined {
    const key = id.toUnsigned().toString()
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt > this.now()) return entry
    if (entry) this.entries.delete(key)
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}

function equalBytes(expected: Uint8Array, actual: Uint8Array): boolean {
  return expected.length === actual.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}
