import { describe, expect, it } from 'vitest'
import {
  distributionSlices,
  formatMs,
  formatPercent,
  formatSampleTime,
  sampleUnit,
  sampleWindow,
  timedSeries,
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
describe('statistics sample times', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5, 678).getTime()
  it('labels raw samples with a wall clock and pads every field', () => {
    expect(formatSampleTime(at)).toBe('03:04:05')
    expect(formatSampleTime(new Date(2026, 10, 9, 23, 59, 59).getTime())).toBe(
      '23:59:59',
    )
    expect(formatSampleTime(0)).toBe('—')
  })
  it('snaps aggregate buckets back to the start of the bucket they cover', () => {
    expect(formatSampleTime(at, 'minutes')).toBe('03:04')
    expect(formatSampleTime(at, 'hours')).toBe('01-02 03:00')
    expect(
      formatSampleTime(new Date(2026, 11, 31, 23, 30).getTime(), 'hours'),
    ).toBe('12-31 23:00')
    expect(sampleUnit('seconds')).toBe('sample')
    expect(sampleUnit('minutes')).toBe('minute')
    expect(sampleUnit('hours')).toBe('hour')
  })
  it('describes the window covered by the samples on screen', () => {
    expect(sampleWindow([])).toBe('—')
    expect(sampleWindow([{ at }])).toBe('03:04:05')
    expect(
      sampleWindow([{ at }, { at: at + 4000 }], 'seconds'),
    ).toBe('03:04:05 → 03:04:09')
    expect(
      sampleWindow([{ at }, { at: at + 90_000 }], 'minutes'),
    ).toBe('03:04 → 03:05')
    expect(
      sampleWindow([{ at }, { at: at + 3 * 3_600_000 }], 'hours'),
    ).toBe('01-02 03:00 → 01-02 06:00')
  })
  it('keeps each plotted value next to the time it was observed at', () => {
    expect(timedSeries(undefined)).toEqual([])
    expect(
      timedSeries([
        { at, value: 3 },
        { at: at + 1000, value: 7 },
      ]),
    ).toEqual([
      { index: 0, at, time: '03:04:05', value: 3 },
      { index: 1, at: at + 1000, time: '03:04:06', value: 7 },
    ])
    expect(timedSeries([{ at, value: 1 }], 'minutes')[0]!.time).toBe('03:04')
    expect(timedSeries([{ at, value: 1 }], 'hours')[0]!.time).toBe(
      '01-02 03:00',
    )
  })
})
