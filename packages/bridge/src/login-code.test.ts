import { describe, expect, it } from 'vitest'
import {
  generateLoginCode, getLoginCodeState, LOGIN_CODE_PERIOD_SECONDS, verifyLoginCode,
} from './login-code.js'

const rfcSecret = Buffer.from('12345678901234567890').toString('hex')

describe('30-second platform login code', () => {
  it('implements the RFC 6238 SHA-1 vectors truncated to six digits', () => {
    expect(generateLoginCode(rfcSecret, 59_000)).toBe('287082')
    expect(generateLoginCode(rfcSecret, 1_111_111_109_000)).toBe('081804')
    expect(generateLoginCode(rfcSecret, 1_234_567_890_000)).toBe('005924')
  })

  it('changes exactly at a 30-second boundary and reports its countdown', () => {
    expect(LOGIN_CODE_PERIOD_SECONDS).toBe(30)
    const before = getLoginCodeState(rfcSecret, 29_001)
    const after = getLoginCodeState(rfcSecret, 30_000)
    expect(before).toMatchObject({ period: 0, validUntil: 30_000, remainingSeconds: 1 })
    expect(after).toMatchObject({ period: 1, validUntil: 60_000, remainingSeconds: 30 })
    expect(before.code).not.toBe(after.code)
  })

  it('accepts only the current six-digit value', () => {
    const now = 61_000
    expect(verifyLoginCode(rfcSecret, generateLoginCode(rfcSecret, now), now)).toBe(true)
    expect(verifyLoginCode(rfcSecret, generateLoginCode(rfcSecret, 29_000), now)).toBe(false)
    expect(verifyLoginCode(rfcSecret, '12345', now)).toBe(false)
    expect(verifyLoginCode(rfcSecret, 'abcdef', now)).toBe(false)
  })
})
