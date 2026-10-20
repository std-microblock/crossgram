import { describe, expect, it } from 'vitest'
import {
  distributionSlices,
  formatMs,
  formatPercent,
  uptime,
} from './statistics-model.js'
describe('statistics model', () => {
  it('keeps all calls represented in the distribution and labels duration/rates accurately', () => {
    const slices = distributionSlices(
      Array.from({ length: 10 }, (_, i) => ({ method: 'm' + i, count: 10 })),
      100,
    )
    expect(slices.at(-1)).toEqual({ label: 'Other methods', value: 30 })
    expect(slices.reduce((total, slice) => total + slice.value, 0)).toBe(100)
    expect(formatMs(0.12)).toBe('120 µs')
    expect(formatMs(1500)).toBe('1.50 s')
    expect(formatPercent(0.025)).toBe('2.50%')
    expect(uptime(90000)).toBe('1d 1h')
  })
})
