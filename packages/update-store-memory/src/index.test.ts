import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { MemoryUpdateStore } from './index.js'

function delivery(eventKey: string, platformSessionId: string, pts: number, scope = 'account') {
  return {
    eventKey, platformSessionId, scope, pts, ptsCount: 1, seq: pts - 1, date: 100 + pts,
    published: false, claimedAt: null, payload: null,
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

  it('records the claim of a publisher and returns defensive copies', async () => {
    const store = new MemoryUpdateStore(new Context(), { retention: 10 })
    await store.create(delivery('a-1', 'a', 2))
    expect((await store.get('a-1'))?.claimedAt).toBeNull()

    await store.claim('a-1', 1_700_000_123)
    await store.claim('missing', 1_700_000_123)
    expect((await store.get('a-1'))?.claimedAt).toBe(1_700_000_123)
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

  it('removes a reserved delivery and its scope index entry', async () => {
    const store = new MemoryUpdateStore(new Context(), { retention: 10 })
    await store.create(delivery('a-1', 'a', 2))
    await store.create(delivery('a-2', 'a', 3))
    await store.remove('a-1')
    await store.remove('missing')

    expect(await store.get('a-1')).toBeUndefined()
    expect((await store.getAfter('a', 'account', 1, 10)).map((row) => row.eventKey)).toEqual(['a-2'])
    expect((await store.getPending('a')).map((row) => row.eventKey)).toEqual(['a-2'])

    const recreated = await store.create(delivery('a-1', 'a', 4))
    expect(recreated.messageId).toBeGreaterThan(2)
    // getAfter orders by pts, so the re-created reservation sorts last
    expect((await store.getAfter('a', 'account', 1, 10)).map((row) => row.eventKey)).toEqual(['a-2', 'a-1'])
  })

  it('supports zero retention without leaking deduplication keys', async () => {
    const store = new MemoryUpdateStore(new Context(), { retention: 0 })
    await store.create(delivery('discarded', 'session', 2))
    expect(await store.get('discarded')).toBeUndefined()
  })

  it('aggregates changed channel scopes per scope and pages the date scan', async () => {
    const store = new MemoryUpdateStore(new Context(), { retention: 100 })
    const payload = { _: 'updates', updates: [], users: [], chats: [] }
    await store.create(delivery('account-1', 'a', 2))
    await store.setPayload('account-1', payload)
    for (const [eventKey, pts] of [['alpha-1', 2], ['alpha-2', 3]] as const) {
      await store.create(delivery(eventKey, 'a', pts, 'channel:10'))
      await store.setPayload(eventKey, payload)
    }
    await store.create(delivery('beta-1', 'a', 2, 'channel:11'))
    await store.setPayload('beta-1', payload)
    await store.create(delivery('quiet-1', 'a', 2, 'channel:12'))
    await store.setPayload('quiet-1', payload)
    // A reservation whose payload is not durable yet is not announced: its
    // marker would point at a pts the channel difference cannot surface.
    await store.create({ ...delivery('pending', 'a', 4, 'channel:13'), date: 104 })
    await store.create(delivery('other-session', 'b', 2, 'channel:10'))
    await store.setPayload('other-session', payload)

    // One row per changed channel, with the newest pts and the oldest retained
    // delivery that only keeps the announcement order stable.
    expect(await store.getChangedChannelScopes('a', 0)).toEqual([
      { scope: 'channel:10', pts: 3, firstDeliveryId: 2 },
      { scope: 'channel:11', pts: 2, firstDeliveryId: 4 },
      { scope: 'channel:12', pts: 2, firstDeliveryId: 5 },
    ])
    expect(await store.getChangedChannelScopes('a', 102)).toEqual([
      { scope: 'channel:10', pts: 3, firstDeliveryId: 2 },
      { scope: 'channel:11', pts: 2, firstDeliveryId: 4 },
      { scope: 'channel:12', pts: 2, firstDeliveryId: 5 },
    ])
    expect(await store.getChangedChannelScopes('a', 105)).toEqual([])
    // The date scan is a page, so a cursor from days ago cannot load the journal.
    expect((await store.getSince('a', 0, 2)).map((row) => row.eventKey))
      .toEqual(['account-1', 'alpha-1'])
    expect((await store.getSince('a', 0, 0))).toEqual([])
    expect((await store.getSince('a', 0, 50)).map((row) => row.eventKey))
      .toEqual(['account-1', 'alpha-1', 'beta-1', 'quiet-1', 'alpha-2', 'pending'])
  })
})
