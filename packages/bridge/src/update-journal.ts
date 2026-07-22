import type { UpdateDeliveryRow } from './models.js'

export type NewUpdateDelivery = Omit<UpdateDeliveryRow, 'messageId'>

/** Replaceable process-local journal used for update deduplication and gap recovery. */
export interface UpdateDeliveryJournal {
  get(eventKey: string): Promise<UpdateDeliveryRow | undefined>
  create(delivery: NewUpdateDelivery): Promise<UpdateDeliveryRow>
  markPublished(eventKey: string): Promise<void>
  setPayload(eventKey: string, payload: string): Promise<void>
  getPending(platformSessionId: string): Promise<UpdateDeliveryRow[]>
  getAfter(platformSessionId: string, pts: number, limit: number): Promise<UpdateDeliveryRow[]>
  prune(platformSessionId: string): Promise<void>
}

/** Bounded in-memory update journal. Its contents intentionally do not survive a process restart. */
export class MemoryUpdateDeliveryJournal implements UpdateDeliveryJournal {
  private readonly _byEventKey = new Map<string, UpdateDeliveryRow>()
  private readonly _eventKeysBySession = new Map<string, string[]>()
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
    const eventKeys = this._eventKeysBySession.get(row.platformSessionId) ?? []
    eventKeys.push(row.eventKey)
    this._eventKeysBySession.set(row.platformSessionId, eventKeys)
    await this.prune(row.platformSessionId)
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
    return this._rows(platformSessionId)
      .filter((delivery) => !delivery.published)
      .sort((left, right) => left.pts - right.pts)
      .map((delivery) => ({ ...delivery }))
  }

  async getAfter(platformSessionId: string, pts: number, limit: number): Promise<UpdateDeliveryRow[]> {
    return this._rows(platformSessionId)
      .filter((delivery) => delivery.pts > pts)
      .sort((left, right) => left.pts - right.pts)
      .slice(0, limit)
      .map((delivery) => ({ ...delivery }))
  }

  async prune(platformSessionId: string): Promise<void> {
    const retain = Math.max(0, Math.trunc(this._retention))
    const eventKeys = this._eventKeysBySession.get(platformSessionId)
    if (!eventKeys || eventKeys.length <= retain) return
    for (const eventKey of eventKeys.splice(0, eventKeys.length - retain)) {
      this._byEventKey.delete(eventKey)
    }
    if (!eventKeys.length) this._eventKeysBySession.delete(platformSessionId)
  }

  private _rows(platformSessionId: string): UpdateDeliveryRow[] {
    return (this._eventKeysBySession.get(platformSessionId) ?? [])
      .map((eventKey) => this._byEventKey.get(eventKey))
      .filter((delivery): delivery is UpdateDeliveryRow => Boolean(delivery))
  }
}

function clone(row: UpdateDeliveryRow | undefined): UpdateDeliveryRow | undefined {
  return row ? { ...row } : undefined
}
