import { describe, expect, it } from 'vitest'
import { RecentPromiseCache } from './recent-promise-cache.js'

describe('RecentPromiseCache', () => {
  it('keeps recent successful results and evicts the oldest settled entry', async () => {
    const cache = new RecentPromiseCache<number>(2)
    cache.set('first', Promise.resolve(1))
    cache.set('second', Promise.resolve(2))
    cache.set('third', Promise.resolve(3))
    await Promise.resolve()

    expect(cache.size).toBe(2)
    expect(cache.get('first')).toBeUndefined()
    await expect(cache.get('second')).resolves.toBe(2)
    await expect(cache.get('third')).resolves.toBe(3)
  })

  it('drops failed results so a retry can execute again', async () => {
    const cache = new RecentPromiseCache<number>(2)
    const failure = Promise.reject(new Error('temporary failure'))
    cache.set('request', failure)
    await expect(failure).rejects.toThrow('temporary failure')
    await Promise.resolve()

    expect(cache.get('request')).toBeUndefined()
  })

  it('never evicts an in-flight operation even when the settled limit is exceeded', async () => {
    const cache = new RecentPromiseCache<number>(1)
    let resolve!: (value: number) => void
    const pending = new Promise<number>((done) => { resolve = done })
    cache.set('pending', pending)
    cache.set('settled', Promise.resolve(2))
    await Promise.resolve()

    expect(cache.get('pending')).toBe(pending)
    expect(cache.get('settled')).toBeUndefined()
    resolve(1)
    await expect(pending).resolves.toBe(1)
    expect(cache.size).toBe(1)
  })

  it('refreshes recency when a duplicate request reads an existing result', async () => {
    const cache = new RecentPromiseCache<number>(2)
    cache.set('first', Promise.resolve(1))
    cache.set('second', Promise.resolve(2))
    await Promise.resolve()
    await cache.get('first')
    cache.set('third', Promise.resolve(3))
    await Promise.resolve()

    expect(cache.get('second')).toBeUndefined()
    await expect(cache.get('first')).resolves.toBe(1)
    await expect(cache.get('third')).resolves.toBe(3)
  })
})
