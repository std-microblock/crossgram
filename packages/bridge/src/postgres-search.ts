import type { Database } from '@cordisjs/plugin-database'
import {
  mediaSearchKind, partKindsMatchSearchKinds, SEARCH_KIND, searchTermBigrams,
} from './message-search.js'
import type { IMMediaKind } from './platform.js'

export const POSTGRES_SEARCH_BIGRAMS_FN = 'crossgram_search_bigrams'
export const POSTGRES_SEARCH_GIN_INDEX = 'mtproto_im_message_search_bigrams_gin'
export const POSTGRES_MEDIA_CONV_INDEX = 'mtproto_im_message_media_conv_partial_idx'
export const POSTGRES_MEDIA_SESSION_INDEX = 'mtproto_im_message_media_session_partial_idx'

/**
 * 文本搜索 Stage 1（近期窗口探测）最多向前检查多少条消息。
 *
 * 对「可以」「哈哈」这类高频词，GIN 索引会召回上万行再按时间排序取前 21 条，反而比按时间倒序扫
 * 几百条热页慢得多；先在最新的 2000 条里用 `(conversationId|platformSessionId, timestamp)` 倒序
 * 探测，凑满 `limit + 1` 条就立即返回（亚毫秒），凑不够再走 bigram GIN 索引精确召回。
 */
const RECENT_PROBE_LIMIT = 2_000
const RECENT_PROBE_MAX_PAGE_LIMIT = 200

export interface PostgresClient {
  unsafe<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>
}

export interface PostgresSearchParams {
  platformSessionId: string
  conversationIds?: readonly number[]
  terms: readonly string[]
  senderUserId?: number
  minTimestamp?: number
  maxTimestamp?: number
  kinds?: number
  before?: { timestamp: number, messageId: number }
}

export interface PostgresPartIndexRow {
  tlMessageId: number
  timestamp: number
  messageId: number
  ordinal: number
  partKind: number
  messageKinds: number
}

export interface PostgresPartCountGroup {
  ordinal: number
  partKind: number
  messageKinds: number
  count: number
}

interface RawPartCountGroupRow {
  isFirst: boolean
  messageKinds: number | string
  mediaKind: string | null
  mediaMimeType: string | null
  mediaVoice: boolean | null
  cnt: number | string
}

interface RawPartIndexRow {
  tlMessageId: number | string
  timestamp: number | string
  messageId: number | string
  ordinal: number | string
  messageKinds: number | string
  mediaKind: string | null
  mediaMimeType: string | null
  mediaVoice: boolean | null
}

/**
 * 如果底层数据库驱动是 PostgreSQL，返回它的原始 `postgres.js` 客户端；
 * SQLite / 内存驱动 / 计数代理等非 PostgreSQL 场景返回 `undefined`，自动走通用查询路径。
 */
export function getPostgresClient(database: Database): PostgresClient | undefined {
  try {
    const driver = (database as unknown as {
      getDriver?: (table: string) => { constructor?: { name?: string }, postgres?: PostgresClient } | undefined
    }).getDriver?.('mtproto_im_message')
    if (driver?.constructor?.name === 'postgres' && typeof driver.postgres?.unsafe === 'function') {
      return driver.postgres
    }
  } catch {
    return undefined
  }
  return undefined
}

const CREATE_BIGRAMS_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION "${POSTGRES_SEARCH_BIGRAMS_FN}"(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT DISTINCT substr(input, i, 2)
      FROM generate_series(1, GREATEST(char_length(input) - 1, 0)) AS i
      WHERE ascii(substr(input, i, 1)) > 32 AND ascii(substr(input, i + 1, 1)) > 32
    ),
    ARRAY[]::text[]
  );
$$`

export class PostgresSearchBackend {
  private _ginReady: boolean | undefined
  private _ginCheckPending?: Promise<boolean>
  private _ensurePending?: Promise<void>

  constructor(private readonly _client: PostgresClient) {}

  get ginReady(): boolean {
    return this._ginReady === true
  }

  /**
   * 检查并按需以 `CREATE INDEX CONCURRENTLY` 建立 PostgreSQL 搜索索引：
   * - `mtproto_im_message_search_bigrams_gin`：中英文 2-gram GIN（带 `btree_gin` 时与 `conversationId` 复合）
   * - `mtproto_im_message_media_conv_partial_idx`：按会话的共享媒体部分索引（只含 `searchKinds > 0`）
   * - `mtproto_im_message_media_session_partial_idx`：跨会话的共享媒体部分索引（只含 `searchKinds > 0`）
   *
   * 若上次并发建索引意外中断留下 `INVALID` 索引，会自动清理后重建；已全部就绪时只做一次目录查询即返回。
   */
  async ensureIndexes(onTrace?: (format: string, ...args: unknown[]) => void): Promise<void> {
    if (this._ensurePending) return this._ensurePending
    const pending = this._ensureIndexesImpl(onTrace)
    this._ensurePending = pending
    try {
      await pending
    } finally {
      if (this._ensurePending === pending) this._ensurePending = undefined
    }
  }

  private async _ensureIndexesImpl(onTrace?: (format: string, ...args: unknown[]) => void): Promise<void> {
    const [tableCheck] = await this._client.unsafe<{ oid: string | null }>(
      `SELECT to_regclass('mtproto_im_message')::text AS oid`,
    )
    if (!tableCheck?.oid) return

    const expectedNames = [
      POSTGRES_SEARCH_GIN_INDEX,
      POSTGRES_MEDIA_CONV_INDEX,
      POSTGRES_MEDIA_SESSION_INDEX,
    ]
    const existing = await this._queryIndexStates(expectedNames)
    if (expectedNames.every((name) => existing.get(name) === true)) {
      this._ginReady = true
      return
    }

    for (const name of expectedNames) {
      if (existing.get(name) === false) {
        onTrace?.('postgres search dropping invalid index %s', name)
        await this._client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`)
        existing.delete(name)
      }
    }

    let createdGin = false
    let ginExprColumn = 2
    if (existing.get(POSTGRES_SEARCH_GIN_INDEX) !== true) {
      await this._client.unsafe(CREATE_BIGRAMS_FUNCTION_SQL)
      let hasBtreeGin = false
      try {
        await this._client.unsafe('CREATE EXTENSION IF NOT EXISTS btree_gin')
        hasBtreeGin = true
      } catch (error) {
        // 某些受限数据库无权启用扩展；降级为单列 bigram GIN，仍然加速全量文本搜索。
        const [ext] = await this._client.unsafe<{ ok: number }>(
          `SELECT 1 AS ok FROM pg_extension WHERE extname = 'btree_gin'`,
        )
        hasBtreeGin = Boolean(ext?.ok)
        if (!hasBtreeGin) onTrace?.('postgres btree_gin unavailable, falling back to single-column GIN: %s', String(error))
      }
      const keyExpr = hasBtreeGin
        ? `"conversationId", "${POSTGRES_SEARCH_BIGRAMS_FN}"("searchText")`
        : `"${POSTGRES_SEARCH_BIGRAMS_FN}"("searchText")`
      ginExprColumn = hasBtreeGin ? 2 : 1
      onTrace?.('postgres search creating index %s (btree_gin=%s)', POSTGRES_SEARCH_GIN_INDEX, String(hasBtreeGin))
      await this._client.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${POSTGRES_SEARCH_GIN_INDEX}" `
        + `ON "mtproto_im_message" USING gin (${keyExpr}) `
        + `WHERE "deleted" = false AND "searchKinds" IS NOT NULL AND "searchText" <> ''`,
      )
      createdGin = true
    }

    if (existing.get(POSTGRES_MEDIA_CONV_INDEX) !== true) {
      onTrace?.('postgres search creating index %s', POSTGRES_MEDIA_CONV_INDEX)
      await this._client.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${POSTGRES_MEDIA_CONV_INDEX}" `
        + `ON "mtproto_im_message" ("conversationId", "timestamp" DESC, "id" DESC, "searchKinds") `
        + `WHERE "deleted" = false AND "searchKinds" > 0`,
      )
    }

    if (existing.get(POSTGRES_MEDIA_SESSION_INDEX) !== true) {
      onTrace?.('postgres search creating index %s', POSTGRES_MEDIA_SESSION_INDEX)
      await this._client.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${POSTGRES_MEDIA_SESSION_INDEX}" `
        + `ON "mtproto_im_message" ("platformSessionId", "timestamp" DESC, "id" DESC, "searchKinds") `
        + `WHERE "deleted" = false AND "searchKinds" > 0`,
      )
    }

    if (createdGin) {
      try {
        await this._client.unsafe(
          `ALTER INDEX "${POSTGRES_SEARCH_GIN_INDEX}" ALTER COLUMN ${ginExprColumn} SET STATISTICS 500`,
        )
        await this._client.unsafe('ANALYZE "mtproto_im_message"')
      } catch (error) {
        onTrace?.('postgres search post-index analyze skipped: %s', String(error))
      }
    }

    const verified = await this._queryIndexStates([POSTGRES_SEARCH_GIN_INDEX])
    this._ginReady = verified.get(POSTGRES_SEARCH_GIN_INDEX) === true
    onTrace?.('postgres search indexes ready (gin=%s)', String(this._ginReady))
  }

  private async _queryIndexStates(names: readonly string[]): Promise<Map<string, boolean>> {
    const rows = await this._client.unsafe<{ relname: string, indisvalid: boolean }>(
      `SELECT c.relname, i.indisvalid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])`,
      [names],
    )
    return new Map(rows.map((row) => [row.relname, Boolean(row.indisvalid)]))
  }

  private async _isGinReady(): Promise<boolean> {
    if (this._ginReady !== undefined) return this._ginReady
    if (this._ginCheckPending) return this._ginCheckPending
    const pending = this._queryIndexStates([POSTGRES_SEARCH_GIN_INDEX])
      .then((states) => {
        const ready = states.get(POSTGRES_SEARCH_GIN_INDEX) === true
        this._ginReady = ready
        return ready
      })
      .catch(() => false)
    this._ginCheckPending = pending
    try {
      return await pending
    } finally {
      if (this._ginCheckPending === pending) this._ginCheckPending = undefined
    }
  }

  /**
   * 按 `(timestamp DESC, id DESC)` 返回一页匹配的消息 ID（多取 1 条用于判定 `hasMore`）。
   */
  async searchMessageIds(
    params: PostgresSearchParams,
    limit: number,
  ): Promise<{ ids: number[], hasMore: boolean }> {
    const bigrams = searchTermBigrams(params.terms)
    const useGin = bigrams.length > 0 && await this._isGinReady()
    const singleConversation = params.conversationIds?.length === 1
    const unscopedGlobal = params.conversationIds === undefined

    // 高频词快速通道：先在最新 RECENT_PROBE_LIMIT 条消息里按时间索引倒序探测，
    // 命中够一页即直接返回，避免 GIN 召回上万行热/冷堆页后再排序取前 21 条。
    if (useGin && limit > 0 && limit <= RECENT_PROBE_MAX_PAGE_LIMIT && (singleConversation || unscopedGlobal)) {
      const probed = await this._probeRecentMessageIds(params, limit)
      if (probed.length > limit) {
        return { ids: probed.slice(0, limit), hasMore: true }
      }
    }

    const builder = new SqlParams()
    const where = buildMessageWhere(params, builder, { useGin, bigrams })
    const limitParam = builder.add(limit + 1)
    const rows = await this._client.unsafe<{ id: number | string }>(
      `SELECT "id" FROM "mtproto_im_message"
       WHERE ${where}
       ORDER BY "timestamp" DESC, "id" DESC
       LIMIT ${limitParam}`,
      builder.values,
    )
    const ids = rows.slice(0, limit).map((row) => Number(row.id))
    return { ids, hasMore: rows.length > limit }
  }

  private async _probeRecentMessageIds(params: PostgresSearchParams, limit: number): Promise<number[]> {
    const builder = new SqlParams()
    const innerClauses: string[] = []
    if (params.conversationIds?.length === 1) {
      innerClauses.push(`"conversationId" = ${builder.add(params.conversationIds[0])}`)
    } else {
      innerClauses.push(`"platformSessionId" = ${builder.add(params.platformSessionId)}`)
    }
    if (params.kinds) {
      // 命中共享媒体部分索引，避免扫过大量 searchKinds = 0 的纯文本消息。
      innerClauses.push(`"deleted" = false`)
      innerClauses.push(`"searchKinds" > 0`)
    }
    if (params.minTimestamp !== undefined) {
      innerClauses.push(`"timestamp" > ${builder.add(params.minTimestamp)}`)
    }
    if (params.maxTimestamp !== undefined) {
      innerClauses.push(`"timestamp" < ${builder.add(params.maxTimestamp)}`)
    }
    if (params.before) {
      const tsParam = builder.add(params.before.timestamp)
      const idParam = builder.add(params.before.messageId)
      innerClauses.push(`"timestamp" <= ${tsParam}`)
      innerClauses.push(`("timestamp" < ${tsParam} OR "id" < ${idParam})`)
    }

    const outerClauses: string[] = [
      `"deleted" = false`,
      `"searchKinds" IS NOT NULL`,
    ]
    if (params.kinds) {
      outerClauses.push(`"searchKinds" > 0`)
      outerClauses.push(`("searchKinds" & ${builder.add(params.kinds)}) <> 0`)
    }
    if (!(params.kinds && (params.kinds & SEARCH_KIND.PHONE_CALL))) {
      outerClauses.push(`("searchKinds" & ${SEARCH_KIND.SERVICE}) = 0`)
    }
    if (params.senderUserId !== undefined) {
      outerClauses.push(`"senderUserId" = ${builder.add(params.senderUserId)}`)
    }
    for (const term of params.terms) {
      outerClauses.push(`strpos("searchText", ${builder.add(term)}) > 0`)
    }

    const probeLimit = Math.max(RECENT_PROBE_LIMIT, limit + 1)
    const probeParam = builder.add(probeLimit)
    const limitParam = builder.add(limit + 1)
    const rows = await this._client.unsafe<{ id: number | string }>(
      `WITH recent AS (
         SELECT "id", "timestamp", "deleted", "searchKinds", "senderUserId", "searchText"
         FROM "mtproto_im_message"
         WHERE ${innerClauses.join(' AND ')}
         ORDER BY "timestamp" DESC, "id" DESC
         LIMIT ${probeParam}
       )
       SELECT "id" FROM recent
       WHERE ${outerClauses.join(' AND ')}
       ORDER BY "timestamp" DESC, "id" DESC
       LIMIT ${limitParam}`,
      builder.values,
    )
    return rows.map((row) => Number(row.id))
  }

  /** 精确消息计数（逻辑消息条数）。 */
  async countMessages(params: Omit<PostgresSearchParams, 'before'>): Promise<number> {
    const bigrams = searchTermBigrams(params.terms)
    const useGin = bigrams.length > 0 && await this._isGinReady()
    const builder = new SqlParams()
    const where = buildMessageWhere(params, builder, { useGin, bigrams })
    const [row] = await this._client.unsafe<{ cnt: number | string }>(
      `SELECT count(*)::int AS cnt FROM "mtproto_im_message" WHERE ${where}`,
      builder.values,
    )
    return Number(row?.cnt ?? 0)
  }

  /**
   * 一次 SQL 聚合回答多个共享媒体过滤器的精确分片计数（`messages.getSearchCounters` 与首屏媒体计数）。
   * 仅传回按 `(ordinal = 0, searchKinds, media.kind, media.mimeType, media.voice)` 分组的几十行汇总，
   * 不再把数万条分片/媒体行分数百批拉回 Node.js 内存。
   */
  async countPartsByKinds(
    params: Omit<PostgresSearchParams, 'before' | 'kinds'>,
    masks: readonly number[],
  ): Promise<number[]> {
    const unionMask = masks.filter((mask) => mask !== 0).reduce((total, mask) => total | mask, 0)
    const hasZero = masks.includes(0)
    const hasNonZero = unionMask !== 0
    const counts = new Map<number, number>()

    if (hasNonZero) {
      const grouped = await this.queryPartCountGroups({ ...params, kinds: unionMask })
      for (const mask of masks) {
        if (mask === 0) continue
        let total = 0
        for (const group of grouped) {
          if (partKindsMatchSearchKinds(group.messageKinds, group.ordinal, group.partKind, mask)) {
            total += group.count
          }
        }
        counts.set(mask, total)
      }
    }
    if (hasZero) {
      const grouped = await this.queryPartCountGroups({ ...params, kinds: undefined })
      let total = 0
      for (const group of grouped) {
        if (group.ordinal === 0) total += group.count
      }
      counts.set(0, total)
    }

    return masks.map((mask) => counts.get(mask) ?? 0)
  }

  /**
   * 返回按 `(ordinal = 0, searchKinds, media.kind, media.mimeType, media.voice)` 分组后的分片计数汇总
   * （通常只有几十行），便于调用方按掩码子集做内存缓存复用。
   */
  async queryPartCountGroups(
    params: Omit<PostgresSearchParams, 'before'>,
  ): Promise<PostgresPartCountGroup[]> {
    const bigrams = searchTermBigrams(params.terms)
    const useGin = bigrams.length > 0 && await this._isGinReady()
    const builder = new SqlParams()
    const where = buildMessageWhere(params, builder, { useGin, bigrams, tableAlias: 'm' })
    const rows = await this._client.unsafe<RawPartCountGroupRow>(
      `SELECT
         (p."ordinal" = 0) AS "isFirst",
         m."searchKinds" AS "messageKinds",
         med."kind" AS "mediaKind",
         med."mimeType" AS "mediaMimeType",
         med."voice" AS "mediaVoice",
         count(*)::int AS "cnt"
       FROM "mtproto_im_message" m
       JOIN "mtproto_tl_message_part" p ON p."messageId" = m."id"
       LEFT JOIN "mtproto_im_media" med ON med."id" = p."mediaId"
       WHERE ${where}
       GROUP BY (p."ordinal" = 0), m."searchKinds", med."kind", med."mimeType", med."voice"`,
      builder.values,
    )
    return rows.map((row) => ({
      ordinal: row.isFirst ? 0 : 1,
      partKind: mediaSearchKind(row.mediaKind
        ? { kind: row.mediaKind as IMMediaKind, mimeType: row.mediaMimeType, voice: Boolean(row.mediaVoice) }
        : undefined),
      messageKinds: Number(row.messageKinds ?? 0),
      count: Number(row.cnt ?? 0),
    }))
  }

  /**
   * 一次 SQL JOIN 读取全部候选分片（按 `tlMessageId DESC` 排好序），替代原先按 500 条分批的数百次往返。
   */
  async loadPartIndexRows(params: Omit<PostgresSearchParams, 'before'>): Promise<PostgresPartIndexRow[]> {
    const bigrams = searchTermBigrams(params.terms)
    const useGin = bigrams.length > 0 && await this._isGinReady()
    const builder = new SqlParams()
    const where = buildMessageWhere(params, builder, { useGin, bigrams, tableAlias: 'm' })
    const rows = await this._client.unsafe<RawPartIndexRow>(
      `SELECT
         p."tlMessageId" AS "tlMessageId",
         m."timestamp" AS "timestamp",
         m."id" AS "messageId",
         p."ordinal" AS "ordinal",
         m."searchKinds" AS "messageKinds",
         med."kind" AS "mediaKind",
         med."mimeType" AS "mediaMimeType",
         med."voice" AS "mediaVoice"
       FROM "mtproto_im_message" m
       JOIN "mtproto_tl_message_part" p ON p."messageId" = m."id"
       LEFT JOIN "mtproto_im_media" med ON med."id" = p."mediaId"
       WHERE ${where}
       ORDER BY p."tlMessageId" DESC`,
      builder.values,
    )
    return rows.map((row) => ({
      tlMessageId: Number(row.tlMessageId),
      timestamp: Number(row.timestamp),
      messageId: Number(row.messageId),
      ordinal: Number(row.ordinal),
      partKind: mediaSearchKind(row.mediaKind
        ? { kind: row.mediaKind as IMMediaKind, mimeType: row.mediaMimeType, voice: Boolean(row.mediaVoice) }
        : undefined),
      messageKinds: Number(row.messageKinds ?? 0),
    }))
  }
}

class SqlParams {
  readonly values: unknown[] = []

  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

function buildMessageWhere(
  params: PostgresSearchParams,
  builder: SqlParams,
  options: { useGin: boolean, bigrams: readonly string[], tableAlias?: string },
): string {
  const col = (name: string): string => options.tableAlias ? `${options.tableAlias}."${name}"` : `"${name}"`
  const clauses: string[] = []

  if (params.conversationIds?.length === 1) {
    // 单会话查询不重复携带 platformSessionId（conversationId 已全局唯一），保持与部分索引/复合 GIN 键一致。
    clauses.push(`${col('conversationId')} = ${builder.add(params.conversationIds[0])}`)
  } else {
    clauses.push(`${col('platformSessionId')} = ${builder.add(params.platformSessionId)}`)
    if (params.conversationIds && params.conversationIds.length > 1) {
      clauses.push(`${col('conversationId')} = ANY(${builder.add([...params.conversationIds])}::int[])`)
    }
  }

  clauses.push(`${col('deleted')} = false`)
  clauses.push(`${col('searchKinds')} IS NOT NULL`)
  if (params.kinds) {
    clauses.push(`${col('searchKinds')} > 0`)
    clauses.push(`(${col('searchKinds')} & ${builder.add(params.kinds)}) <> 0`)
  }
  if (!(params.kinds && (params.kinds & SEARCH_KIND.PHONE_CALL))) {
    clauses.push(`(${col('searchKinds')} & ${SEARCH_KIND.SERVICE}) = 0`)
  }
  if (params.senderUserId !== undefined) {
    clauses.push(`${col('senderUserId')} = ${builder.add(params.senderUserId)}`)
  }
  if (params.minTimestamp !== undefined) {
    clauses.push(`${col('timestamp')} > ${builder.add(params.minTimestamp)}`)
  }
  if (params.maxTimestamp !== undefined) {
    clauses.push(`${col('timestamp')} < ${builder.add(params.maxTimestamp)}`)
  }
  if (params.before) {
    const tsParam = builder.add(params.before.timestamp)
    const idParam = builder.add(params.before.messageId)
    clauses.push(`${col('timestamp')} <= ${tsParam}`)
    clauses.push(`(${col('timestamp')} < ${tsParam} OR ${col('id')} < ${idParam})`)
  }
  if (options.useGin && options.bigrams.length > 0) {
    clauses.push(`${col('searchText')} <> ''`)
    clauses.push(`"${POSTGRES_SEARCH_BIGRAMS_FN}"(${col('searchText')}) @> ${builder.add([...options.bigrams])}::text[]`)
  }
  for (const term of params.terms) {
    clauses.push(`strpos(${col('searchText')}, ${builder.add(term)}) > 0`)
  }

  return clauses.join(' AND ')
}
