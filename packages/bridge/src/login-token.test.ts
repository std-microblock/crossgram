import { describe, expect, it } from 'vitest'
import {
  LoginTokenSourceLimitError, LoginTokenStore, LoginTokenStoreFullError, parseTelegramLoginToken,
} from './login-token.js'

const token = new Uint8Array(32).fill(7)
const authKey = new Uint8Array(8).fill(1)
const identity = { platformId: 'static', platformSessionId: 'static-session' }

describe('Telegram login tokens', () => {
  it('parses canonical padded and unpadded 32-byte Telegram login URL tokens', () => {
    const encoded = Buffer.from(token).toString('base64url')
    const padded = `${encoded}=`
    expect(encoded).toHaveLength(43)
    expect(padded).toHaveLength(44)
    expect(parseTelegramLoginToken(`tg://login?token=${encoded}`)).toEqual(token)
    expect(parseTelegramLoginToken(`tg://login?token=${padded}`)).toEqual(token)
  })

  it('rejects non-canonical Telegram login URL tokens', () => {
    const encoded = Buffer.from(token).toString('base64url')
    expect(parseTelegramLoginToken(`tg://login?token=${encoded.slice(1)}`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${encoded}a`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${encoded}==`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${encoded}===`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${encoded.slice(0, 20)}=${encoded.slice(20)}`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${encoded.slice(0, -1)}$`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${Buffer.alloc(31).toString('base64url')}`)).toBeUndefined()
    expect(parseTelegramLoginToken('https://example.com/login?token=abc')).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://logout?token=${encoded}`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login/other?token=${encoded}`)).toBeUndefined()
  })

  it('lets the issuing auth key commit an approval only once', () => {
    const store = new LoginTokenStore()
    store.issue(authKey, token)
    expect(store.approve(token, identity)).toEqual(authKey)
    const claim = store.claim(token, authKey)
    expect(claim?.identity).toEqual(identity)
    expect(store.claim(token, authKey)).toBeUndefined()
    store.commit(claim!)
    expect(store.claim(token, authKey)).toBeUndefined()
  })

  it('does not replace approved or claimed tokens for the same auth key', () => {
    const store = new LoginTokenStore()
    const replacement = new Uint8Array(32).fill(8)
    store.issue(authKey, token)
    store.approve(token, identity)

    expect(() => store.issue(authKey, replacement)).toThrow(LoginTokenStoreFullError)
    const claim = store.claimApprovedForAuthKey(authKey)
    expect(claim?.identity).toEqual(identity)
    expect(() => store.issue(authKey, replacement)).toThrow(LoginTokenStoreFullError)
    store.rollback(claim!)
    expect(store.claim(token, authKey)?.identity).toEqual(identity)
  })

  it('limits active tokens per source while allowing refreshes for an existing auth key', () => {
    const store = new LoginTokenStore(1_000, Date.now, 8, 2)
    const otherAuthKey = new Uint8Array(8).fill(2)
    const thirdAuthKey = new Uint8Array(8).fill(3)
    store.issue(authKey, token, '127.0.0.1')
    store.issue(otherAuthKey, new Uint8Array(32).fill(8), '127.0.0.1')
    expect(() => store.issue(thirdAuthKey, new Uint8Array(32).fill(9), '127.0.0.1'))
      .toThrow(LoginTokenSourceLimitError)
    expect(store.issue(authKey, new Uint8Array(32).fill(10), '127.0.0.1'))
      .toEqual(new Uint8Array(32).fill(10))
  })

  it('retains the existing token when a replacement cannot be issued', () => {
    const store = new LoginTokenStore(1_000, Date.now, 2, 1)
    const otherAuthKey = new Uint8Array(8).fill(2)
    const otherToken = new Uint8Array(32).fill(8)
    store.issue(authKey, token, 'issuer')
    store.issue(otherAuthKey, otherToken, 'full')

    expect(() => store.issue(authKey, new Uint8Array(32).fill(9), 'full'))
      .toThrow(LoginTokenSourceLimitError)
    expect(store.approve(token, identity)).toEqual(authKey)
    expect(store.claim(token, authKey)?.identity).toEqual(identity)
  })

  it('retains the existing token when a replacement token already belongs to another key', () => {
    const store = new LoginTokenStore()
    const otherAuthKey = new Uint8Array(8).fill(2)
    const replacement = new Uint8Array(32).fill(8)
    store.issue(authKey, token)
    store.issue(otherAuthKey, replacement)

    expect(() => store.issue(authKey, replacement)).toThrow(LoginTokenStoreFullError)
    expect(store.approve(token, identity)).toEqual(authKey)
    expect(store.claim(token, authKey)?.identity).toEqual(identity)
  })

  it('evicts the oldest token so refreshed old keys cannot block a new key', () => {
    const store = new LoginTokenStore(1_000, Date.now, 2)
    const otherAuthKey = new Uint8Array(8).fill(2)
    const thirdAuthKey = new Uint8Array(8).fill(3)
    const otherToken = new Uint8Array(32).fill(8)
    store.issue(authKey, token)
    store.issue(otherAuthKey, otherToken)
    for (const byte of [9, 10, 11]) store.issue(authKey, new Uint8Array(32).fill(byte))

    store.issue(thirdAuthKey, new Uint8Array(32).fill(12))
    expect(store.approve(otherToken, identity)).toBeUndefined()
  })

  it('never evicts approved or claimed tokens when capacity is full', () => {
    const store = new LoginTokenStore(1_000, Date.now, 2)
    const approvedAuthKey = new Uint8Array(8).fill(2)
    const claimedAuthKey = new Uint8Array(8).fill(3)
    const approvedToken = new Uint8Array(32).fill(8)
    const claimedToken = new Uint8Array(32).fill(9)
    store.issue(approvedAuthKey, approvedToken)
    store.issue(claimedAuthKey, claimedToken)
    expect(store.approve(approvedToken, identity)).toEqual(approvedAuthKey)
    expect(store.approve(claimedToken, identity)).toEqual(claimedAuthKey)
    expect(store.claim(claimedToken, claimedAuthKey)).toBeDefined()

    expect(() => store.issue(authKey, token)).toThrow(LoginTokenStoreFullError)
    expect(store.claim(approvedToken, approvedAuthKey)?.identity).toEqual(identity)
  })

  it('uses the protocol-second expiry boundary for approval and import', () => {
    const issuedAt = 1_000_999
    const expiresAt = 1_060_000
    let now = issuedAt

    const beforeExpiry = new LoginTokenStore(60_000, () => now)
    const beforeToken = new Uint8Array(32).fill(7)
    beforeExpiry.issue(authKey, beforeToken)
    expect(beforeExpiry.expiresAt(beforeToken)).toBe(expiresAt)
    now = expiresAt - 1
    expect(beforeExpiry.approve(beforeToken, identity)).toEqual(authKey)
    expect(beforeExpiry.claim(beforeToken, authKey)?.identity).toEqual(identity)

    now = issuedAt
    const atExpiryApproval = new LoginTokenStore(60_000, () => now)
    const atExpiryToken = new Uint8Array(32).fill(8)
    atExpiryApproval.issue(authKey, atExpiryToken)
    now = expiresAt
    expect(atExpiryApproval.approve(atExpiryToken, identity)).toBeUndefined()

    now = issuedAt
    const atExpiryImport = new LoginTokenStore(60_000, () => now)
    const importToken = new Uint8Array(32).fill(9)
    atExpiryImport.issue(authKey, importToken)
    expect(atExpiryImport.approve(importToken, identity)).toEqual(authKey)
    now = expiresAt
    expect(atExpiryImport.claim(importToken, authKey)).toBeUndefined()

    now = issuedAt
    const afterExpiry = new LoginTokenStore(60_000, () => now)
    const afterToken = new Uint8Array(32).fill(10)
    afterExpiry.issue(authKey, afterToken)
    now = expiresAt + 1
    expect(afterExpiry.approve(afterToken, identity)).toBeUndefined()
    expect(afterExpiry.claim(afterToken, authKey)).toBeUndefined()
  })

  it('rejects expired tokens and tokens from a different auth key', () => {
    let now = 0
    const store = new LoginTokenStore(1_000, () => now)
    store.issue(authKey, token)
    expect(store.approve(token, identity)).toEqual(authKey)
    expect(store.claim(token, new Uint8Array(8).fill(2))).toBeUndefined()
    now = 1_000
    expect(store.claim(token, authKey)).toBeUndefined()
  })
})
