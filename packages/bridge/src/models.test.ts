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

  it('stores media sizes as scale-zero numeric values for large files', () => {
    const extend = vi.fn()
    defineModels({ model: { extend } } as never)

    const definition = extend.mock.calls.find(([table]) => table === 'mtproto_im_media')
    expect(definition?.[1]?.size).toMatchObject({ type: 'decimal', precision: 20, scale: 0, nullable: true })
  })
})
