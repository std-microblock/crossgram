import { Service, type Context } from 'cordis'

export type UpdateJsonPrimitive = boolean | number | string | null
export type UpdateJsonValue = UpdateJsonPrimitive | UpdateJsonValue[] | { [key: string]: UpdateJsonValue }
export type UpdateJson = { [key: string]: UpdateJsonValue }

export interface UpdateDelivery {
  messageId: number
  eventKey: string
  platformSessionId: string
  scope: string
  pts: number
  ptsCount: number
  seq: number
  date: number
  published: boolean
  /**
   * Wall-clock second when a publisher last claimed responsibility for this
   * delivery's payload, or null when no publisher of the current process has
   * taken it. Readers keep waiting for a claimed reservation but may release
   * an unclaimed one, which can never be completed.
   */
  claimedAt: number | null
  payload: UpdateJson | null
}

export type NewUpdateDelivery = Omit<UpdateDelivery, 'messageId'>

export interface UpdateStoreBackend {
  get(eventKey: string): Promise<UpdateDelivery | undefined>
  create(delivery: NewUpdateDelivery): Promise<UpdateDelivery>
  markPublished(eventKey: string): Promise<void>
  claim(eventKey: string, claimedAt: number): Promise<void>
  setPayload(eventKey: string, payload: UpdateJson): Promise<void>
  /** Drop a reserved delivery whose payload never became durable. */
  remove(eventKey: string): Promise<void>
  getPending(platformSessionId: string): Promise<UpdateDelivery[]>
  getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDelivery[]>
  getSince(platformSessionId: string, date: number): Promise<UpdateDelivery[]>
  prune(platformSessionId: string, scope: string): Promise<void>
}

/** Hot-path storage seam for deduplication and Telegram update gap recovery. */
export abstract class UpdateStore extends Service implements UpdateStoreBackend {
  constructor(ctx: Context) {
    super(ctx, 'updateStore')
  }

  abstract get(eventKey: string): Promise<UpdateDelivery | undefined>
  abstract create(delivery: NewUpdateDelivery): Promise<UpdateDelivery>
  abstract markPublished(eventKey: string): Promise<void>
  abstract claim(eventKey: string, claimedAt: number): Promise<void>
  abstract setPayload(eventKey: string, payload: UpdateJson): Promise<void>
  abstract remove(eventKey: string): Promise<void>
  abstract getPending(platformSessionId: string): Promise<UpdateDelivery[]>
  abstract getAfter(
    platformSessionId: string,
    scope: string,
    pts: number,
    limit: number,
  ): Promise<UpdateDelivery[]>
  abstract getSince(platformSessionId: string, date: number): Promise<UpdateDelivery[]>
  abstract prune(platformSessionId: string, scope: string): Promise<void>
}

declare module 'cordis' {
  interface Context {
    updateStore: UpdateStore
  }
}
