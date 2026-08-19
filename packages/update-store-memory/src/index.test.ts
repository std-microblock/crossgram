import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { MemoryUpdateStore } from './index.js'

function delivery(eventKey: string, platformSessionId: string, pts: number, scope = 'account') {
  return {
    eventKey, platformSessionId, scope, pts, ptsCount: 1, seq: pts - 1, date: 100 + pts,
    published: false, payload: null,
  }
}

describe('MemoryUpdateStore', () => {
  it('deduplicates, retains JSON payloads, and returns defensive copies', async () => {
    const ctx = new Context()
    const store = new MemoryUpdateStore(ctx, { retention: 10 })
    const first = await store.create(delivery('first', 'session', 2))
    const repeated = await store.create({ ...delivery('first', 'session', 99), payload: { ignored: true } })
    await store.setPayload('first', { _: 'updates', nested: { value: 1 } })

    expect(first.messageId).toBe(1)
    expect(repeated).toEqual(first)
    const loaded = await store.get('first')
    expect(loaded?.payload).toEqual({ _: 'updates', nested: { value: 1 } })
    ;(loaded!.payload!.nested as { value: number }).value = 9
    expect((await store.get('first'))?.payload).toEqual({ _: 'updates', nested: { value: 1 } })
  })

  it('orders pending rows and prunes each account scope independently', async () => {
    const store = new MemoryUpdateStore(new Context(), { retention: 2 })
    await store.create(delivery('a-1', 'a', 2))
    await store.create(delivery('a-channel', 'a', 2, 'channel:10'))
    await store.create(delivery('b-1', 'b', 2))
    await store.create(delivery('a-2', 'a', 3))
    await store.create(delivery('a-3', 'a', 4))
    await store.markPublished('a-3')

    expect(await store.get('a-1')).toBeUndefined()
    expect((await store.getAfter('a', 'account', 1, 10)).map((row) => row.eventKey)).toEqual(['a-2', 'a-3'])
    expect((await store.getAfter('a', 'channel:10', 1, 10)).map((row) => row.eventKey)).toEqual(['a-channel'])
    expect((await store.getAfter('b', 'account', 1, 10)).map((row) => row.eventKey)).toEqual(['b-1'])
    expect((await store.getPending('a')).map((row) => row.eventKey)).toEqual(['a-channel', 'a-2'])
  })

  it('supports zero retention without leaking deduplication keys', async () => {
    const store = new MemoryUpdateStore(new Context(), { retention: 0 })
    await store.create(delivery('discarded', 'session', 2))
    expect(await store.get('discarded')).toBeUndefined()
  })
})
