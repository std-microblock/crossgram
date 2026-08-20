import type { Database } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'
import { decode, encode } from '@msgpack/msgpack'
import z from 'schemastery'
import {
  UpdateStore,
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
  /** MessagePack-encoded UpdateJson. Null while the publisher is constructing the update. */
  payload: ArrayBuffer | null
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_update_delivery: UpdateDeliveryRecord
  }
}

export interface Config {
  /** Maximum retained deliveries for each Telegram account and update scope. */
  retention?: number
}

export const Config = z.object({
  retention: z.natural().max(1_000_000).default(10_000)
    .description('Maximum retained update deliveries for each Telegram account and update scope.'),
})

/** Context-free durable backend using compact MessagePack payloads and indexed account partitions. */
export class DatabaseUpdateStoreBackend implements UpdateStoreBackend {
  private readonly _database: Database
  private readonly _retention: number

  constructor(database: Database, config: Config = {}) {
    this._database = database
    this._retention = Math.max(0, Math.trunc(config.retention ?? 10_000))
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

  async setPayload(eventKey: string, payload: UpdateJson): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { payload: encodePayload(payload) })
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

  async getSince(platformSessionId: string, date: number): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, date: { $gte: date },
    }).orderBy('seq').orderBy('messageId').execute()
    return rows.map(decodeRow)
  }

  async prune(platformSessionId: string, scope: string): Promise<void> {
    await this._database.withTransaction((database) => this._prune(database, platformSessionId, scope))
  }

  private async _prune(database: Database, platformSessionId: string, scope: string): Promise<void> {
    if (!this._retention) {
      await database.remove('mtproto_update_delivery', { platformSessionId, scope })
      return
    }

    // One indexed seek detects overflow. Removing through the oldest overflow
    // ID keeps exactly the newest configured count without loading payloads.
    const [oldestOverflow] = await database.select('mtproto_update_delivery', {
      platformSessionId, scope,
    }).orderBy('messageId', 'desc').offset(this._retention).limit(1).execute(['messageId'])
    if (!oldestOverflow) return
    await database.remove('mtproto_update_delivery', {
      platformSessionId, scope, messageId: { $lte: oldestOverflow.messageId },
    })
  }
}

/** Durable Cordis update-store provider. */
export class DatabaseUpdateStore extends UpdateStore {
  static inject = ['database', 'model']
  static Config = Config
  private readonly _backend: DatabaseUpdateStoreBackend

  constructor(ctx: Context, config: Config = {}) {
    defineModel(ctx)
    super(ctx)
    this._backend = new DatabaseUpdateStoreBackend(ctx.database, config)
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

export function defineModel(ctx: Context): void {
  ctx.model.extend('mtproto_update_delivery', {
    messageId: 'unsigned', eventKey: 'text', platformSessionId: 'string', scope: 'string',
    pts: 'unsigned', ptsCount: 'unsigned', seq: 'unsigned', date: 'unsigned', published: 'boolean',
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
