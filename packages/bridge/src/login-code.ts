import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const LOGIN_CODE_PERIOD_SECONDS = 30
export const LOGIN_CODE_DIGITS = 6

export interface LoginCodeState {
  code: string
  period: number
  validUntil: number
  remainingSeconds: number
}

/** Generate a process-independent secret suitable for RFC 6238 TOTP. */
export function generateLoginSecret(): string {
  return randomBytes(20).toString('hex')
}

/** Return the six-digit RFC 6238 code for a hexadecimal secret. */
export function generateLoginCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / LOGIN_CODE_PERIOD_SECONDS)
  const input = Buffer.alloc(8)
  input.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', Buffer.from(secret, 'hex')).update(input).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  return String(binary % 10 ** LOGIN_CODE_DIGITS).padStart(LOGIN_CODE_DIGITS, '0')
}

/** Verify only the currently displayed period, matching the Cordis countdown. */
export function verifyLoginCode(secret: string, candidate: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(candidate)) return false
  const expected = Buffer.from(generateLoginCode(secret, now))
  return timingSafeEqual(expected, Buffer.from(candidate))
}

export function getLoginCodeState(secret: string, now = Date.now()): LoginCodeState {
  const period = Math.floor(now / 1000 / LOGIN_CODE_PERIOD_SECONDS)
  const validUntil = (period + 1) * LOGIN_CODE_PERIOD_SECONDS * 1000
  return {
    code: generateLoginCode(secret, now),
    period,
    validUntil,
    remainingSeconds: Math.max(1, Math.ceil((validUntil - now) / 1000)),
  }
}
