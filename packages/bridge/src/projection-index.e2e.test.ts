import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import { MessageStore } from './message-store.js'
import type { IMMessage, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'projection-index-session',
  platformId: 'test',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createDatabase() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const driver = (ctx.database as any).drivers[0]
  return { ctx, driver, store: new MessageStore(ctx.database) }
}

describe('projection index schema', () => {
  it('creates no index for query shapes that no longer exist', async () => {
    const { driver } = await createDatabase()

    const parts = await driver.getIndexes('mtproto_tl_message_part')
    const partNames = parts.map((index: { name: string }) => index.name)
    // messageId 查询由 unique(messageId, ordinal) 的左前缀承担。
    expect(partNames).not.toContain('index:mtproto_tl_message_part:messageId')
    // 会话维度的有序读取已经改为按 messageId 取分片后在内存比较。
    expect(partNames).not.toContain(
      'index:mtproto_tl_message_part:platformSessionId+conversationId+tlMessageId',
    )

    const messages = await driver.getIndexes('mtproto_im_message')
    const messageNames = messages.map((index: { name: string }) => index.name)
    // senderUserId 从来不是查询条件。
    expect(messageNames).not.toContain('index:mtproto_im_message:senderUserId')
    // 历史分页依赖的索引必须保留。
    expect(messageNames).toContain('index:mtproto_im_message:conversationId+timestamp')

    // 左前缀重复的 messageId 单列索引不再出现在任何一张表上。
    for (const table of ['mtproto_im_media', 'mtproto_im_message_reaction']) {
      const names = (await driver.getIndexes(table)).map((index: { name: string }) => index.name)
      expect(names).not.toContain(`index:${table}:messageId`)
    }
  })

  it('still enforces per-scope message id uniqueness after the key reorder', async () => {
    const { ctx } = await createDatabase()

    const base = {
      platformSessionId: session.platformSessionId,
      conversationId: 1,
      messageId: 1,
      scope: 'channel:scope-a',
      tlMessageId: 100,
      nativeSequence: null,
      nativeOrderKey: null,
      allocationVersion: null,
      groupedId: null,
    }
    await ctx.database.create('mtproto_tl_message_part', { ...base, ordinal: 0 })
    await expect(ctx.database.create('mtproto_tl_message_part', {
      ...base, messageId: 2, ordinal: 0,
    })).rejects.toThrow()
    // 不同唯一域可以复用同一个 tlMessageId。
    await expect(ctx.database.create('mtproto_tl_message_part', {
      ...base, messageId: 3, scope: 'channel:scope-b', ordinal: 0,
    })).resolves.toBeDefined()
  })

  it('answers the oldest projected id for a topic without a conversation-ordered index', async () => {
    const { store } = await createDatabase()
    const conversation = { id: 'topic-index', kind: 'channel' as const, title: 'Topic' }
    const make = (sequence: number): IMMessage => ({
      id: `topic-${sequence}`,
      conversationId: conversation.id,
      senderId: 'sender',
      timestamp: 100,
      metadata: { qqMsgSeq: String(sequence) },
      content: { parts: [{ type: 'text', text: String(sequence) }] },
    })

    const newest = await store.ingest(session, conversation, make(102))
    const oldest = await store.ingest(session, conversation, make(100), { allocation: 'history' })
    const middle = await store.ingest(session, conversation, make(101), { allocation: 'history' })

    const ids = [oldest, middle, newest].map((item) => item.projection[0].tlMessageId)
    expect(ids[0]).toBeLessThan(ids[1])
    expect(ids[1]).toBeLessThan(ids[2])
    await expect(store.getOldestTlMessageId(session.platformSessionId, conversation.id))
      .resolves.toBe(ids[0])
  })

  it('keeps platform message identity unique per conversation without the session prefix', async () => {
    const { ctx } = await createDatabase()
    const alias = {
      platformSessionId: session.platformSessionId,
      conversationId: 7,
      platformMessageId: 'qq-message-1',
      messageId: 11,
      ordinal: 0,
    }
    await ctx.database.create('mtproto_im_message_alias', alias)
    // 同一会话内的同一平台消息 id 仍然只能有一行。
    await expect(ctx.database.create('mtproto_im_message_alias', {
      ...alias, messageId: 12,
    })).rejects.toThrow()
    // 换成另一个会话（conversationId 全局唯一，因此也换了会话归属）可以重复。
    await expect(ctx.database.create('mtproto_im_message_alias', {
      ...alias, conversationId: 8,
    })).resolves.toBeDefined()

    const message = {
      platformSessionId: session.platformSessionId,
      conversationId: 7,
      primaryPlatformMessageId: 'qq-message-1',
      senderUserId: 1,
      text: 'hello',
      content: { parts: [{ type: 'text', text: 'hello' }] },
      timestamp: 100,
      outgoing: false,
      deleted: false,
      platformGroupId: null,
      metadata: {},
    }
    await ctx.database.create('mtproto_im_message', message)
    await expect(ctx.database.create('mtproto_im_message', { ...message, text: 'duplicate' }))
      .rejects.toThrow()
  })
})
