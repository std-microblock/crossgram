import { describe, expect, it, vi } from 'vitest'
import { defineModels } from './models.js'

describe('bridge models', () => {
  it('indexes session-wide Telegram message ID lookups', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)

    const definition = extend.mock.calls.find(([table]) => table === 'mtproto_tl_message_part')
    expect(definition).toBeDefined()
    expect(definition?.[2]).toMatchObject({
      indexes: expect.arrayContaining([['platformSessionId', 'tlMessageId']]),
    })
  })

  it('provides a native-sequence index matching allocation queries without PostgreSQL name collisions', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)
    const [, , options] = extend.mock.calls.find(([table]) => table === 'mtproto_tl_message_part')!
    expect(options.indexes).toContainEqual(['conversationId', 'nativeSequence'])
    const names = options.indexes.map((keys: string | string[]) =>
      Buffer.from('index:mtproto_tl_message_part:' + (Array.isArray(keys) ? keys.join('+') : keys)).subarray(0, 63).toString())
    expect(new Set(names).size).toBe(names.length)
    expect(Buffer.byteLength('index:mtproto_tl_message_part:conversationId+nativeSequence')).toBeLessThanOrEqual(63)
  })

  it('stores media sizes as scale-zero numeric values for large files', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)

    const definition = extend.mock.calls.find(([table]) => table === 'mtproto_im_media')
    expect(definition?.[1]?.size).toMatchObject({ type: 'decimal', precision: 20, scale: 0, nullable: true })
  })

  it('leads the part uniqueness key with tlMessageId so projection writes stay append-shaped', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)
    const [, , options] = extend.mock.calls.find(([table]) => table === 'mtproto_tl_message_part')!

    // 判重语义仍是 (scope, tlMessageId) 这一对值，只是顺序换成 tlMessageId 在前，
    // 让按 tlMessageId 递增的投影写入近似追加。
    expect(options.unique).toContainEqual(['tlMessageId', 'scope'])
    expect(options.unique).not.toContainEqual(['scope', 'tlMessageId'])
  })

  it('drops indexes that no query shape uses', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)
    const partOptions = extend.mock.calls.find(([table]) => table === 'mtproto_tl_message_part')![2]
    const messageOptions = extend.mock.calls.find(([table]) => table === 'mtproto_im_message')![2]
    const mediaOptions = extend.mock.calls.find(([table]) => table === 'mtproto_im_media')![2]
    const reactionOptions = extend.mock.calls.find(([table]) => table === 'mtproto_im_message_reaction')![2]

    // messageId 查询由 unique(messageId, ordinal) 的左前缀承担。
    expect(partOptions.indexes).not.toContainEqual('messageId')
    // getOldestTlMessageId 已改为按 messageId 取分片后在内存比较。
    expect(partOptions.indexes).not.toContainEqual(['platformSessionId', 'conversationId', 'tlMessageId'])
    // senderUserId 从不是查询条件。
    expect(messageOptions.indexes).not.toContainEqual('senderUserId')
    // 媒体与回应的查询同样是 messageId = / IN (...)，unique 左前缀已覆盖。
    expect(mediaOptions.indexes ?? []).not.toContainEqual('messageId')
    expect(reactionOptions.indexes ?? []).not.toContainEqual('messageId')
  })

  it('declares the covering index that lets shared-media scans stay index-only', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)
    const messageOptions = extend.mock.calls.find(([table]) => table === 'mtproto_im_message')![2]

    // 共享媒体（计数 / 滚动条 / 日历）一次要读出会话里所有带媒体类别的消息。
    // 索引必须把查询里出现的列全部覆盖（conversationId / deleted / searchKinds / timestamp / id），
    // 否则 PostgreSQL 会退回「按会话逐行回表」甚至全表顺序扫描 1.9 GB。
    expect(messageOptions.indexes).toContainEqual({
      name: 'mtproto_im_message_media_index',
      keys: { conversationId: 'asc', deleted: 'asc', searchKinds: 'asc', timestamp: 'asc', id: 'asc' },
    })
    expect(Buffer.byteLength('mtproto_im_message_media_index')).toBeLessThanOrEqual(63)
  })

  it('keys platform message identity by conversation instead of repeating the session id', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)
    const messageOptions = extend.mock.calls.find(([table]) => table === 'mtproto_im_message')![2]
    const aliasOptions = extend.mock.calls.find(([table]) => table === 'mtproto_im_message_alias')![2]

    // conversationId 是全局唯一行号，已隐含 platformSessionId，
    // 判重键不再重复携带 32 字节的会话 id。
    expect(messageOptions.unique).toEqual([['conversationId', 'primaryPlatformMessageId']])
    expect(aliasOptions.unique).toEqual([['conversationId', 'platformMessageId']])
  })
})
