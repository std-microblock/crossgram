import { describe, expect, it } from 'vitest'
import { MemoryUpdateDeliveryJournal } from './update-journal.js'

function delivery(eventKey: string, platformSessionId: string, pts: number) {
  return {
    eventKey, platformSessionId, scope: 'account', pts, ptsCount: 1, seq: pts - 1, date: 100 + pts,
    published: false, payload: '',
  }
}

describe('MemoryUpdateDeliveryJournal', () => {
  it('deduplicates events, assigns process-local IDs, and returns defensive copies', async () => {
    const journal = new MemoryUpdateDeliveryJournal(10)
    const first = await journal.create(delivery('first', 'session', 2))
    const repeated = await journal.create({ ...delivery('first', 'session', 99), payload: 'different' })
    const second = await journal.create(delivery('second', 'session', 3))

    expect(first).toMatchObject({ messageId: 1, pts: 2 })
    expect(repeated).toEqual(first)
    expect(second.messageId).toBe(2)
    first.payload = 'mutated outside journal'
    expect(await journal.get('first')).toMatchObject({ payload: '' })
  })

  it('tracks payload and publication while ordering pending rows by pts', async () => {
    const journal = new MemoryUpdateDeliveryJournal(10)
    await journal.create(delivery('later', 'session', 3))
    await journal.create(delivery('earlier', 'session', 2))
    await journal.setPayload('earlier', 'encoded')
    await journal.markPublished('later')

    expect(await journal.getPending('session')).toMatchObject([{
      eventKey: 'earlier', pts: 2, payload: 'encoded', published: false,
    }])
    expect((await journal.getAfter('session', 'account', 1, 1))[0]).toMatchObject({ eventKey: 'earlier', pts: 2 })
  })

  it('applies retention independently to each platform session', async () => {
    const journal = new MemoryUpdateDeliveryJournal(2)
    await journal.create(delivery('a-1', 'a', 2))
    await journal.create(delivery('b-1', 'b', 2))
    await journal.create(delivery('a-2', 'a', 3))
    await journal.create(delivery('a-3', 'a', 4))

    expect(await journal.get('a-1')).toBeUndefined()
    expect((await journal.getAfter('a', 'account', 1, 10)).map((row) => row.eventKey)).toEqual(['a-2', 'a-3'])
    expect((await journal.getAfter('b', 'account', 1, 10)).map((row) => row.eventKey)).toEqual(['b-1'])
  })

  it('supports zero retention without leaking event-key entries', async () => {
    const journal = new MemoryUpdateDeliveryJournal(0)
    await journal.create(delivery('discarded', 'session', 2))

    expect(await journal.get('discarded')).toBeUndefined()
    expect(await journal.getAfter('session', 'account', 1, 10)).toEqual([])
  })
})
