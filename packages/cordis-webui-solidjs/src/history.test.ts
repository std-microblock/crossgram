import { describe, expect, it } from 'vitest'
import { apply, DeltaState, observe } from '@cordisjs/muon'
import { boundHistory } from './history.js'
describe('bounded server instrumentation state', () => {
  it.each([
    ['logs', 'messages', 'unused'],
    ['http', 'history', 'limit'],
    ['server', 'requests', 'requestLimit'],
  ])(
    'bounds %s before emitting a coherent Muon delta',
    (module, field, key) => {
      const data: Record<string, any> = {
        [field]: Array.from({ length: 1000 }, (_, id) => ({ id })),
        [key]: 1000,
      }
      const mirror = structuredClone(data),
        encoder = new DeltaState(),
        decoder = new DeltaState()
      const mutation = observe(data, (value) => {
        value[field].push(
          ...Array.from({ length: 100 }, (_, id) => ({ id: 1000 + id })),
        )
        boundHistory(module, value)
      })!
      expect(data[field]).toHaveLength(1000)
      expect(data[field][0].id).toBe(100)
      expect(apply(mirror, decoder.load(encoder.dump(mutation)))).toEqual(data)
    },
  )
  it('does not alter non-history plugin data and bounds pathological configured limits', () => {
    const data = {
      history: Array.from({ length: 3000 }, (_, id) => id),
      limit: 1e9,
    }
    boundHistory('statistics', data)
    expect(data.history).toHaveLength(3000)
    boundHistory('http', data)
    expect(data.history).toHaveLength(2000)
    data.limit = 0
    boundHistory('http', data)
    expect(data.history).toHaveLength(0)
    data.history = Array.from({ length: 3000 }, (_, id) => id)
    data.limit = NaN
    boundHistory('http', data)
    expect(data.history).toHaveLength(1000)
  })
})
