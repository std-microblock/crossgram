import type { Context } from 'cordis'
import z from 'schemastery'
import {
  UpdateStore,
  type NewUpdateDelivery,
  type UpdateDelivery,
  type UpdateJson,
  type UpdateStoreBackend,
} from '@mtproto-relay/update-store'

export interface Config {
  /** Maximum retained deliveries for each Telegram account and update scope. */
  retention?: number
}

export const Config = z.object({
  retention: z.natural().max(1_000_000).default(1_000)
    .description('Maximum retained update deliveries for each Telegram account and update scope.'),
})

/** Context-free backend used by the provider and focused store tests. */
export class MemoryUpdateStoreBackend implements UpdateStoreBackend {
  private readonly _byEventKey = new Map<string, UpdateDelivery>()
  private readonly _eventKeysByScope = new Map<string, string[]>()
  private _nextMessageId = 1
  private readonly _retention: number

  constructor(config: Config = {}) {
    this._retention = normalizeRetention(config.retention)
  }

  async get(eventKey: string): Promise<UpdateDelivery | undefined> {
    return clone(this._byEventKey.get(eventKey))
  }

  async create(delivery: NewUpdateDelivery): Promise<UpdateDelivery> {
    const existing = this._byEventKey.get(delivery.eventKey)
    if (existing) return clone(existing)!

    const row: UpdateDelivery = {
      ...delivery,
      payload: clonePayload(delivery.payload),
      messageId: this._nextMessageId++,
    }
    this._byEventKey.set(row.eventKey, row)
    const scopeKey = this._scopeKey(row.platformSessionId, row.scope)
    const eventKeys = this._eventKeysByScope.get(scopeKey) ?? []
    eventKeys.push(row.eventKey)
    this._eventKeysByScope.set(scopeKey, eventKeys)
    this._prune(scopeKey, eventKeys)
    return clone(row)!
  }

  async markPublished(eventKey: string): Promise<void> {
    const row = this._byEventKey.get(eventKey)
    if (row) row.published = true
  }

  async setPayload(eventKey: string, payload: UpdateJson): Promise<void> {
    const row = this._byEventKey.get(eventKey)
    if (row) row.payload = clonePayload(payload)
  }

  async getPending(platformSessionId: string): Promise<UpdateDelivery[]> {
    return [...this._byEventKey.values()]
      .filter((delivery) => delivery.platformSessionId === platformSessionId && !delivery.published)
      .sort((left, right) => left.seq - right.seq || left.messageId - right.messageId)
      .map((delivery) => clone(delivery)!)
  }

  async getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDelivery[]> {
    return this._rows(platformSessionId, scope)
      .filter((delivery) => delivery.pts > pts)
      .sort((left, right) => left.pts - right.pts || left.messageId - right.messageId)
      .slice(0, Math.max(0, Math.trunc(limit)))
      .map((delivery) => clone(delivery)!)
  }

  async getSince(platformSessionId: string, date: number): Promise<UpdateDelivery[]> {
    return [...this._byEventKey.values()]
      .filter((delivery) => delivery.platformSessionId === platformSessionId && delivery.date >= date)
      .sort((left, right) => left.seq - right.seq || left.messageId - right.messageId)
      .map((delivery) => clone(delivery)!)
  }

  async prune(platformSessionId: string, scope: string): Promise<void> {
    const scopeKey = this._scopeKey(platformSessionId, scope)
    const eventKeys = this._eventKeysByScope.get(scopeKey)
    if (eventKeys) this._prune(scopeKey, eventKeys)
  }

  private _prune(scopeKey: string, eventKeys: string[]): void {
    if (eventKeys.length <= this._retention) return
    for (const eventKey of eventKeys.splice(0, eventKeys.length - this._retention)) {
      this._byEventKey.delete(eventKey)
    }
    if (!eventKeys.length) this._eventKeysByScope.delete(scopeKey)
  }

  private _rows(platformSessionId: string, scope: string): UpdateDelivery[] {
    return (this._eventKeysByScope.get(this._scopeKey(platformSessionId, scope)) ?? [])
      .map((eventKey) => this._byEventKey.get(eventKey))
      .filter((delivery): delivery is UpdateDelivery => Boolean(delivery))
  }

  private _scopeKey(platformSessionId: string, scope: string): string {
    return `${platformSessionId}\u0000${scope}`
  }
}

/** Bounded process-local Cordis update-store provider. */
export class MemoryUpdateStore extends UpdateStore {
  static Config = Config
  private readonly _backend: MemoryUpdateStoreBackend

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this._backend = new MemoryUpdateStoreBackend(config)
  }

  get(eventKey: string) { return this._backend.get(eventKey) }
  create(delivery: NewUpdateDelivery) { return this._backend.create(delivery) }
  markPublished(eventKey: string) { return this._backend.markPublished(eventKey) }
  setPayload(eventKey: string, payload: UpdateJson) { return this._backend.setPayload(eventKey, payload) }
  getPending(platformSessionId: string) { return this._backend.getPending(platformSessionId) }
  getAfter(platformSessionId: string, scope: string, pts: number, limit: number) {
    return this._backend.getAfter(platformSessionId, scope, pts, limit)
  }
  getSince(platformSessionId: string, date: number) { return this._backend.getSince(platformSessionId, date) }
  prune(platformSessionId: string, scope: string) { return this._backend.prune(platformSessionId, scope) }
}

function normalizeRetention(retention: number | undefined): number {
  return Math.max(0, Math.trunc(retention ?? 1_000))
}

function clone(row: UpdateDelivery | undefined): UpdateDelivery | undefined {
  return row ? { ...row, payload: clonePayload(row.payload) } : undefined
}

function clonePayload(payload: UpdateJson | null): UpdateJson | null {
  return payload === null ? null : structuredClone(payload)
}

export default MemoryUpdateStore
