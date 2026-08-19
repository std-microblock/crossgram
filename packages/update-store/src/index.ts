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
  payload: UpdateJson | null
}

export type NewUpdateDelivery = Omit<UpdateDelivery, 'messageId'>

export interface UpdateStoreBackend {
  get(eventKey: string): Promise<UpdateDelivery | undefined>
  create(delivery: NewUpdateDelivery): Promise<UpdateDelivery>
  markPublished(eventKey: string): Promise<void>
  setPayload(eventKey: string, payload: UpdateJson): Promise<void>
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
  abstract setPayload(eventKey: string, payload: UpdateJson): Promise<void>
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
