import { $, type Database } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'
import { decode, encode } from '@msgpack/msgpack'
import z from 'schemastery'
import {
  UpdateStore,
  type ChannelScopeUpdate,
  type NewUpdateDelivery,
  type UpdateDelivery,
  type UpdateJson,
  type UpdateStoreBackend,
} from '@mtproto-relay/update-store'

interface UpdateDeliveryRecord {
  messageId: number
  eventKey: string
  platformSessionId: string
  scope: string
  pts: number
  ptsCount: number
  seq: number
  date: number
  published: boolean
  /** 最近一次发布者认领的秒级时间戳；未认领时为 `null`。 */
  claimedAt: number | null
  /** MessagePack 编码的 `UpdateJson`；发布者仍在构造更新时为 `null`。 */
  payload: ArrayBuffer | null
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_update_delivery: UpdateDeliveryRecord
  }
}

export interface Config {
  /** 每个账号与 scope 下最多保留的 delivery 条数。 */
  retention?: number
  /** 单条 delivery 的最大保留秒数；`0` 表示仅按条数清理。 */
  retentionSeconds?: number
}

export const Config = z.object({
  retention: z.natural().max(1_000_000).default(10_000)
    .description('Maximum retained update deliveries for each Telegram account and update scope.'),
  retentionSeconds: z.natural().max(90 * 24 * 3600).default(3 * 24 * 3600)
    .description('delivery 的保留时长（秒）：更旧的会被清理，0 表示只按条数保留。'),
})

const RETENTION_SWEEP_INTERVAL_MS = 5 * 60 * 1000

const DEFAULT_RETENTION_SECONDS = 3 * 24 * 3600

export class DatabaseUpdateStoreBackend implements UpdateStoreBackend {
  private readonly _database: Database
  private readonly _retention: number
  private readonly _retentionSeconds: number

  constructor(database: Database, config: Config = {}) {
    this._database = database
    this._retention = Math.max(0, Math.trunc(config.retention ?? 10_000))
    this._retentionSeconds = Math.max(
      0, Math.trunc(config.retentionSeconds ?? DEFAULT_RETENTION_SECONDS),
    )
  }

  get retentionSeconds(): number {
    return this._retentionSeconds
  }

  async get(eventKey: string): Promise<UpdateDelivery | undefined> {
    const [row] = await this._database.get('mtproto_update_delivery', { eventKey })
    return row ? decodeRow(row) : undefined
  }

  async create(delivery: NewUpdateDelivery): Promise<UpdateDelivery> {
    return this._database.withTransaction(async (database) => {
      const [existing] = await database.get('mtproto_update_delivery', { eventKey: delivery.eventKey })
      if (existing) return decodeRow(existing)

      const row = await database.create('mtproto_update_delivery', encodeNewRow(delivery))
      await this._prune(database, delivery.platformSessionId, delivery.scope)
      return decodeRow(row)
    })
  }

  async markPublished(eventKey: string): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { published: true })
  }

  async claim(eventKey: string, claimedAt: number): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { claimedAt })
  }

  async setPayload(eventKey: string, payload: UpdateJson): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { payload: encodePayload(payload) })
  }

  async remove(eventKey: string): Promise<void> {
    await this._database.remove('mtproto_update_delivery', { eventKey })
  }

  async getPending(platformSessionId: string): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, published: false,
    }).orderBy('seq').orderBy('messageId').execute()
    return rows.map(decodeRow)
  }

  async getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, scope, pts: { $gt: pts },
    }).orderBy('pts').orderBy('messageId').limit(Math.max(0, Math.trunc(limit))).execute()
    return rows.map(decodeRow)
  }

  async getFirst(platformSessionId: string, scope: string): Promise<UpdateDelivery | undefined> {
    const [row] = await this._database.select('mtproto_update_delivery', {
      platformSessionId, scope,
    }).orderBy('pts').orderBy('messageId').limit(1).execute()
    return row ? decodeRow(row) : undefined
  }

  async getSince(platformSessionId: string, date: number, limit: number): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, date: { $gte: date },
    }).orderBy('seq').orderBy('messageId').limit(Math.max(0, Math.trunc(limit))).execute()
    return rows.map(decodeRow)
  }

  /** 在数据库侧按频道 scope 分组聚合最大 `pts` 与最小 `messageId`，避免旧 `date` 游标解码全量 payload。 */
  async getChangedChannelScopes(
    platformSessionId: string,
    date: number,
  ): Promise<ChannelScopeUpdate[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, date: { $gte: date }, ptsCount: { $gt: 0 }, payload: { $exists: true },
    }).groupBy('scope', (row) => ({
      pts: $.max(row.pts),
      firstDeliveryId: $.min(row.messageId),
    })).execute() as unknown as Array<{
      scope: string
      pts: number | string
      firstDeliveryId: number | string
    }>
    return rows
      .filter((row) => row.scope.startsWith('channel:'))
      .map((row) => ({
        scope: row.scope,
        pts: Number(row.pts),
        firstDeliveryId: Number(row.firstDeliveryId),
      }))
      .sort((left, right) => left.firstDeliveryId - right.firstDeliveryId)
  }

  async prune(platformSessionId: string, scope: string): Promise<void> {
    await this._database.withTransaction((database) => this._prune(database, platformSessionId, scope))
  }

  private async _prune(database: Database, platformSessionId: string, scope: string): Promise<void> {
    if (!this._retention) {
      await database.remove('mtproto_update_delivery', { platformSessionId, scope })
      return
    }

    // 通过单次索引偏移定位超出条数上限的临界 `messageId`，避免读取 payload。
    const [oldestOverflow] = await database.select('mtproto_update_delivery', {
      platformSessionId, scope,
    }).orderBy('messageId', 'desc').offset(this._retention).limit(1).execute(['messageId'])
    if (!oldestOverflow) return
    await database.remove('mtproto_update_delivery', {
      platformSessionId, scope, messageId: { $lte: oldestOverflow.messageId },
    })
  }

  /** 全表清理超过保留时长的 delivery（弥补单 scope 条数上限无法清理静默频道旧记录的问题）。 */
  async pruneExpired(now = Date.now()): Promise<number> {
    if (!this._retentionSeconds) return 0
    const cutoff = Math.floor(now / 1000) - this._retentionSeconds
    const { removed } = await this._database.remove('mtproto_update_delivery', {
      date: { $lt: cutoff },
    })
    return removed ?? 0
  }
}

export class DatabaseUpdateStore extends UpdateStore {
  static inject = ['database', 'model']
  static Config = Config
  private readonly _backend: DatabaseUpdateStoreBackend

  constructor(ctx: Context, config: Config = {}) {
    defineModel(ctx)
    super(ctx)
    this._backend = new DatabaseUpdateStoreBackend(ctx.database, config)
    if (this._backend.retentionSeconds) {
      const logger = ctx.logger('update-store')
      const sweep = setInterval(() => {
        void this._backend.pruneExpired().then((removed) => {
          if (removed) {
            logger.info('清理 %d 条超过 %d 秒的 delivery', removed, this._backend.retentionSeconds)
          }
        }).catch((error) => {
          logger.warn('清理过期 delivery 失败：%s', error instanceof Error ? error.message : error)
        })
      }, RETENTION_SWEEP_INTERVAL_MS)
      sweep.unref?.()
      ctx.effect(() => () => clearInterval(sweep), 'update-store-database.retention-sweep')
    }
  }

  pruneExpired(now = Date.now()) { return this._backend.pruneExpired(now) }

  get(eventKey: string) { return this._backend.get(eventKey) }
  create(delivery: NewUpdateDelivery) { return this._backend.create(delivery) }
  markPublished(eventKey: string) { return this._backend.markPublished(eventKey) }
  claim(eventKey: string, claimedAt: number) { return this._backend.claim(eventKey, claimedAt) }
  setPayload(eventKey: string, payload: UpdateJson) { return this._backend.setPayload(eventKey, payload) }
  remove(eventKey: string) { return this._backend.remove(eventKey) }
  getPending(platformSessionId: string) { return this._backend.getPending(platformSessionId) }
  getAfter(platformSessionId: string, scope: string, pts: number, limit: number) {
    return this._backend.getAfter(platformSessionId, scope, pts, limit)
  }
  getFirst(platformSessionId: string, scope: string) {
    return this._backend.getFirst(platformSessionId, scope)
  }
  getSince(platformSessionId: string, date: number, limit: number) {
    return this._backend.getSince(platformSessionId, date, limit)
  }
  getChangedChannelScopes(platformSessionId: string, date: number) {
    return this._backend.getChangedChannelScopes(platformSessionId, date)
  }
  prune(platformSessionId: string, scope: string) { return this._backend.prune(platformSessionId, scope) }
}

export function defineModel(ctx: Context): void {
  ctx.model.extend('mtproto_update_delivery', {
    messageId: 'unsigned', eventKey: 'text', platformSessionId: 'string', scope: 'string',
    pts: 'unsigned', ptsCount: 'unsigned', seq: 'unsigned', date: 'unsigned', published: 'boolean',
    claimedAt: { type: 'unsigned', nullable: true },
    payload: { type: 'binary', nullable: true },
  }, {
    primary: 'messageId', autoInc: true,
    unique: ['eventKey'],
    indexes: [
      ['platformSessionId', 'scope', 'messageId'],
      ['platformSessionId', 'published', 'seq', 'messageId'],
      ['platformSessionId', 'scope', 'pts', 'messageId'],
      ['platformSessionId', 'date', 'seq', 'messageId'],
    ],
  })
}

function encodeNewRow(delivery: NewUpdateDelivery): Omit<UpdateDeliveryRecord, 'messageId'> {
  return {
    ...delivery,
    payload: delivery.payload === null ? null : encodePayload(delivery.payload),
  }
}

function decodeRow(row: UpdateDeliveryRecord): UpdateDelivery {
  return {
    ...row,
    payload: row.payload === null ? null : decodePayload(row.payload),
  }
}

function encodePayload(payload: UpdateJson): ArrayBuffer {
  const bytes = encode(payload)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function decodePayload(payload: ArrayBuffer): UpdateJson {
  return decode(new Uint8Array(payload)) as UpdateJson
}

export default DatabaseUpdateStore
