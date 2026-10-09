import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CrossGramServerConfig } from '../src/dashboard-types.js'
import {
  botLink,
  copyText,
  formatPhone,
  formatServerConfig,
  parseTelegramLoginUrl,
  remainingSeconds,
  safeImageURL,
  sameOriginPath,
  serializeServerConfig,
} from './bridge-model.js'
afterEach(() => vi.restoreAllMocks())
describe('bridge dashboard input boundaries', () => {
  const token = btoa('x'.repeat(32))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  it('accepts canonical 32-byte Telegram tokens and strips unrelated parameters', () => {
    expect(parseTelegramLoginUrl('tg://login?token=' + token)).toBe(
      'tg://login?token=' + token,
    )
    expect(
      parseTelegramLoginUrl('tg://login/?token=' + token + '=&ignored=value'),
    ).toBe('tg://login?token=' + token)
    for (const url of [
      'https://example.test?token=' + token,
      'tg://login/other?token=' + token,
      'tg://user@login?token=' + token,
      'tg://login?token=short',
      'tg://login?token=' + token + '==',
      'tg://login?token=' + token + '#fragment',
    ])
      expect(parseTelegramLoginUrl(url)).toBeUndefined()
  })
  it('never turns unsafe bot/image values into executable URLs or sends credentials across origins', () => {
    expect(botLink('crossgram_bot')).toBe('https://t.me/crossgram_bot')
    for (const username of ['evil/path', 'me?x=1', 'javascript:alert(1)', ''])
      expect(botLink(username)).toBeUndefined()
    expect(safeImageURL('javascript:alert(1)')).toBeUndefined()
    expect(safeImageURL('/avatar.png')).toContain('/avatar.png')
    expect(() => sameOriginPath('https://other.invalid/api')).toThrow('unsafe')
    expect(sameOriginPath('/api/approve')).toContain('/api/approve')
  })
  it('formats virtual phones and never treats expired codes as valid', () => {
    expect(formatPhone('+888123456789')).toBe('+888 123 456 789')
    expect(formatPhone()).toBe('Unavailable')
    expect(remainingSeconds(30_001, 1000)).toBe(30)
    expect(remainingSeconds(1000, 1001)).toBe(0)
  })
  it('surfaces clipboard failures rather than claiming a successful copy', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('permission denied'),
    )
    await expect(copyText('credential')).rejects.toThrow('permission denied')
  })
})
describe('server configuration copying', () => {
  const config: CrossGramServerConfig = {
    name: 'CrossGram',
    enable_special_config: false,
    host: 'relay.example.test',
    port: 4430,
    rsa_key:
      '-----BEGIN RSA PUBLIC KEY-----\nPLACEHOLDER_KEY\n-----END RSA PUBLIC KEY-----',
    dcs: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      ip: 'relay.example.test',
      port: 4430,
    })),
  }
  // Android clients reject the pasted configuration as invalid JSON while it contains line
  // breaks, and import the identical document once it is a single line.
  it('copies a single-line document without losing fields or escaping PEM newlines', () => {
    const copied = serializeServerConfig(config)!
    expect(copied).not.toMatch(/[\r\n\u2028\u2029]/)
    expect(copied.trim()).toBe(copied)
    expect(copied).toBe(JSON.stringify(config))
    expect(copied).toContain('\\n')
    expect(JSON.parse(copied)).toEqual(config)
    expect(JSON.parse(copied).rsa_key).toContain('\n')
    expect(JSON.parse(copied).dcs).toHaveLength(5)
  })
  it('keeps the readable multi-line form for on-page display only', () => {
    const displayed = formatServerConfig(config)!
    expect(displayed.split('\n').length).toBeGreaterThan(1)
    expect(displayed.length).toBeGreaterThan(serializeServerConfig(config)!.length)
    expect(JSON.parse(displayed)).toEqual(JSON.parse(serializeServerConfig(config)!))
  })
  it('treats a missing configuration as nothing to copy or display', () => {
    expect(serializeServerConfig(undefined)).toBeUndefined()
    expect(formatServerConfig(undefined)).toBeUndefined()
  })
})
