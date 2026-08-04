import { createHash } from 'node:crypto'
import type { tl } from '@mtcute/core'
import { describe, expect, it } from 'vitest'
import { getDhConfig } from './dh-config.js'

function request(version: number, randomLength = 256): tl.messages.RawGetDhConfigRequest {
  return { _: 'messages.getDhConfig', version, randomLength }
}

describe('voice DH configuration', () => {
  it('returns the exact DH group consumed by the native voice worker', () => {
    const result = getDhConfig(request(0), size => new Uint8Array(size).fill(0x5a))

    expect(result).toMatchObject({ _: 'messages.dhConfig', g: 3, version: 1 })
    if (result._ !== 'messages.dhConfig') throw new Error('expected full DH config')
    expect(result.p).toHaveLength(256)
    expect(createHash('sha256').update(result.p).digest('hex'))
      .toBe('02f85e7687fc6f33ba678226a963b3c8a191b47c890cf30debe17c1d623b5af1')
    expect(result.random).toEqual(new Uint8Array(256).fill(0x5a))
  })

  it('returns fresh random bytes without resending a cached config version', () => {
    const result = getDhConfig(request(1, 32), size => new Uint8Array(size).fill(0xa5))

    expect(result).toEqual({
      _: 'messages.dhConfigNotModified', random: new Uint8Array(32).fill(0xa5),
    })
  })

  it.each([-1, 1.5, 1_025])('rejects unsafe random length %s', (randomLength) => {
    expect(() => getDhConfig(request(0, randomLength))).toThrowError(
      expect.objectContaining({ code: 400, text: 'RANDOM_LENGTH_INVALID' }),
    )
  })

  it('rejects a random source that does not honor the requested length', () => {
    expect(() => getDhConfig(request(0, 32), () => new Uint8Array(31))).toThrowError(
      expect.objectContaining({ code: 500, text: 'DH_RANDOM_FAILED' }),
    )
  })
})
