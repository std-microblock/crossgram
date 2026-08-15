import { describe, expect, it } from 'vitest'
import {
  LoginTokenSourceLimitError, LoginTokenStore, LoginTokenStoreFullError, parseTelegramLoginToken,
} from './login-token.js'

const token = new Uint8Array(32).fill(7)
const authKey = new Uint8Array(8).fill(1)
const identity = { platformId: 'static', platformSessionId: 'static-session' }

describe('Telegram login tokens', () => {
  it('parses only canonical 32-byte Telegram login URL tokens', () => {
    const encoded = Buffer.from(token).toString('base64url')
    expect(encoded).toHaveLength(43)
    expect(parseTelegramLoginToken(`tg://login?token=${encoded}`)).toEqual(token)
    expect(parseTelegramLoginToken(`tg://login?token=${encoded.slice(1)}`)).toBeUndefined()
    expect(parseTelegramLoginToken(`tg://login?token=${encoded}a`)).toBeUndefined()
    expect(parseTelegramLoginToken('https://example.com/login?token=abc')).toBeUndefined()
  })

  it('lets the issuing auth key commit an approval only once', () => {
    const store = new LoginTokenStore()
    store.issue(authKey, token)
    expect(store.approve(token, identity)).toBe(true)
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

  it('evicts the oldest token so refreshed old keys cannot block a new key', () => {
    const store = new LoginTokenStore(1_000, Date.now, 2)
    const otherAuthKey = new Uint8Array(8).fill(2)
    const thirdAuthKey = new Uint8Array(8).fill(3)
    const otherToken = new Uint8Array(32).fill(8)
    store.issue(authKey, token)
    store.issue(otherAuthKey, otherToken)
    for (const byte of [9, 10, 11]) store.issue(authKey, new Uint8Array(32).fill(byte))

    store.issue(thirdAuthKey, new Uint8Array(32).fill(12))
    expect(store.approve(otherToken, identity)).toBe(false)
  })

  it('never evicts approved or claimed tokens when capacity is full', () => {
    const store = new LoginTokenStore(1_000, Date.now, 2)
    const approvedAuthKey = new Uint8Array(8).fill(2)
    const claimedAuthKey = new Uint8Array(8).fill(3)
    const approvedToken = new Uint8Array(32).fill(8)
    const claimedToken = new Uint8Array(32).fill(9)
    store.issue(approvedAuthKey, approvedToken)
    store.issue(claimedAuthKey, claimedToken)
    expect(store.approve(approvedToken, identity)).toBe(true)
    expect(store.approve(claimedToken, identity)).toBe(true)
    expect(store.claim(claimedToken, claimedAuthKey)).toBeDefined()

    expect(() => store.issue(authKey, token)).toThrow(LoginTokenStoreFullError)
    expect(store.claim(approvedToken, approvedAuthKey)?.identity).toEqual(identity)
  })

  it('rejects expired tokens and tokens from a different auth key', () => {
    let now = 0
    const store = new LoginTokenStore(1_000, () => now)
    store.issue(authKey, token)
    expect(store.approve(token, identity)).toBe(true)
    expect(store.claim(token, new Uint8Array(8).fill(2))).toBeUndefined()
    now = 1_000
    expect(store.claim(token, authKey)).toBeUndefined()
  })
})
