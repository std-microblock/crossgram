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
  /** 发布者认领该预留记录的秒级时间戳；为 `null` 时表示无进程认领，读取端可直接释放。 */
  claimedAt: number | null
  payload: UpdateJson | null
}

export type NewUpdateDelivery = Omit<UpdateDelivery, 'messageId'>

/** 游标 `date` 之后发生过更新的频道摘要（`pts` 为最新值，`firstDeliveryId` 用于稳定排序）。 */
export interface ChannelScopeUpdate {
  scope: string
  pts: number
  firstDeliveryId: number
}

export interface UpdateStoreBackend {
  get(eventKey: string): Promise<UpdateDelivery | undefined>
  create(delivery: NewUpdateDelivery): Promise<UpdateDelivery>
  markPublished(eventKey: string): Promise<void>
  claim(eventKey: string, claimedAt: number): Promise<void>
  setPayload(eventKey: string, payload: UpdateJson): Promise<void>
  remove(eventKey: string): Promise<void>
  getPending(platformSessionId: string): Promise<UpdateDelivery[]>
  getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDelivery[]>
  /**
   * 该 scope 下保留的最早一条 delivery（`pts` 最小）。
   *
   * 客户端拿它的 `pts - ptsCount` 判断自己有没有掉出保留窗口：早于这个值的 pts 对应更新已经被清理，
   * 服务端无法再连续补齐，只能按契约让客户端重建频道状态。
   */
  getFirst(platformSessionId: string, scope: string): Promise<UpdateDelivery | undefined>
  getSince(platformSessionId: string, date: number, limit: number): Promise<UpdateDelivery[]>
  getChangedChannelScopes(platformSessionId: string, date: number): Promise<ChannelScopeUpdate[]>
  prune(platformSessionId: string, scope: string): Promise<void>
}

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
  abstract getFirst(
    platformSessionId: string,
    scope: string,
  ): Promise<UpdateDelivery | undefined>
  abstract getSince(
    platformSessionId: string,
    date: number,
    limit: number,
  ): Promise<UpdateDelivery[]>
  abstract getChangedChannelScopes(
    platformSessionId: string,
    date: number,
  ): Promise<ChannelScopeUpdate[]>
  abstract prune(platformSessionId: string, scope: string): Promise<void>
}

declare module 'cordis' {
  interface Context {
    updateStore: UpdateStore
  }
}
