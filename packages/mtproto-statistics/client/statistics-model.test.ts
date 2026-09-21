import { describe, expect, it } from 'vitest'
import {
  distributionSlices,
  downsample,
  formatMs,
  formatPercent,
  sparkPath,
  uptime,
} from './statistics-model.js'
describe('lightweight statistical visualization', () => {
  it('bounds SVG points without losing narrow peaks, troughs or endpoints', () => {
    const values = Array(20_000).fill(10)
    values[1234] = 999
    values[8000] = 0
    const points = downsample(values)
    expect(points.length).toBeLessThanOrEqual(120)
    expect(points[0].index).toBe(0)
    expect(points.at(-1)?.index).toBe(19_999)
    expect(
      points.some((point) => point.index === 1234 && point.value === 999),
    ).toBe(true)
    expect(
      points.some((point) => point.index === 8000 && point.value === 0),
    ).toBe(true)
    expect(
      points.every(
        (point, index) => !index || point.index >= points[index - 1].index,
      ),
    ).toBe(true)
  })
  it('handles empty, single, constant, and non-finite time series', () => {
    expect(sparkPath([])).toBe('')
    expect(sparkPath([0])).toBe('M0.0,66.0')
    expect(sparkPath([NaN, Infinity, -1])).not.toMatch(/NaN|Infinity/)
    expect(downsample([1, 2, 3])).toEqual([
      { index: 0, value: 1 },
      { index: 1, value: 2 },
      { index: 2, value: 3 },
    ])
  })
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
