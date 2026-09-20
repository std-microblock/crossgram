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
})
