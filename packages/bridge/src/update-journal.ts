import type { UpdateDeliveryRow } from './models.js'

export type NewUpdateDelivery = Omit<UpdateDeliveryRow, 'messageId'>

/** Replaceable process-local journal used for update deduplication and gap recovery. */
export interface UpdateDeliveryJournal {
  get(eventKey: string): Promise<UpdateDeliveryRow | undefined>
  create(delivery: NewUpdateDelivery): Promise<UpdateDeliveryRow>
  markPublished(eventKey: string): Promise<void>
  setPayload(eventKey: string, payload: string): Promise<void>
  getPending(platformSessionId: string): Promise<UpdateDeliveryRow[]>
  getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDeliveryRow[]>
  prune(platformSessionId: string, scope: string): Promise<void>
}

/** Bounded in-memory update journal. Its contents intentionally do not survive a process restart. */
export class MemoryUpdateDeliveryJournal implements UpdateDeliveryJournal {
  private readonly _byEventKey = new Map<string, UpdateDeliveryRow>()
  private readonly _eventKeysByScope = new Map<string, string[]>()
  private _nextMessageId = 1

  constructor(private readonly _retention: number) {}

  async get(eventKey: string): Promise<UpdateDeliveryRow | undefined> {
    return clone(this._byEventKey.get(eventKey))
  }

  async create(delivery: NewUpdateDelivery): Promise<UpdateDeliveryRow> {
    const existing = this._byEventKey.get(delivery.eventKey)
    if (existing) return clone(existing)!

    const row = { ...delivery, messageId: this._nextMessageId++ }
    this._byEventKey.set(row.eventKey, row)
    const scopeKey = this._scopeKey(row.platformSessionId, row.scope)
    const eventKeys = this._eventKeysByScope.get(scopeKey) ?? []
    eventKeys.push(row.eventKey)
    this._eventKeysByScope.set(scopeKey, eventKeys)
    await this.prune(row.platformSessionId, row.scope)
    return { ...row }
  }

  async markPublished(eventKey: string): Promise<void> {
    const row = this._byEventKey.get(eventKey)
    if (row) row.published = true
  }

  async setPayload(eventKey: string, payload: string): Promise<void> {
    const row = this._byEventKey.get(eventKey)
    if (row) row.payload = payload
  }

  async getPending(platformSessionId: string): Promise<UpdateDeliveryRow[]> {
    return [...this._byEventKey.values()]
      .filter((delivery) => delivery.platformSessionId === platformSessionId)
      .filter((delivery) => !delivery.published)
      .sort((left, right) => left.seq - right.seq)
      .map((delivery) => ({ ...delivery }))
  }

  async getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDeliveryRow[]> {
    return this._rows(platformSessionId, scope)
      .filter((delivery) => delivery.pts > pts)
      .sort((left, right) => left.pts - right.pts)
      .slice(0, limit)
      .map((delivery) => ({ ...delivery }))
  }

  async prune(platformSessionId: string, scope: string): Promise<void> {
    const retain = Math.max(0, Math.trunc(this._retention))
    const scopeKey = this._scopeKey(platformSessionId, scope)
    const eventKeys = this._eventKeysByScope.get(scopeKey)
    if (!eventKeys || eventKeys.length <= retain) return
    for (const eventKey of eventKeys.splice(0, eventKeys.length - retain)) {
      this._byEventKey.delete(eventKey)
    }
    if (!eventKeys.length) this._eventKeysByScope.delete(scopeKey)
  }

  private _rows(platformSessionId: string, scope: string): UpdateDeliveryRow[] {
    return (this._eventKeysByScope.get(this._scopeKey(platformSessionId, scope)) ?? [])
      .map((eventKey) => this._byEventKey.get(eventKey))
      .filter((delivery): delivery is UpdateDeliveryRow => Boolean(delivery))
  }

  private _scopeKey(platformSessionId: string, scope: string): string {
    return `${platformSessionId}\u0000${scope}`
  }
}

function clone(row: UpdateDeliveryRow | undefined): UpdateDeliveryRow | undefined {
  return row ? { ...row } : undefined
}
