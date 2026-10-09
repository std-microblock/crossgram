import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CrossGramServerConfig,
  PlatformAccountDuplicateGroup,
} from '../src/dashboard-types.js'
import {
  botLink,
  copyText,
  describeDuplicateGroup,
  duplicateOwners,
  duplicatePlatformIds,
  formatEndpoint,
  formatPhone,
  parseTelegramLoginUrl,
  remainingSeconds,
  safeImageURL,
  sameOriginPath,
  withServerEndpoint,
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
describe('copied configuration endpoints', () => {
  const config: CrossGramServerConfig = {
    name: 'CrossGram',
    enable_special_config: false,
    host: '203.0.113.8',
    port: 4430,
    rsa_key: 'PUBLIC_KEY',
    dcs: [
      { id: 1, ip: '203.0.113.8', port: 4430 },
      { id: 2, ip: '203.0.113.8', port: 4430 },
    ],
  }
  it('formats endpoints the way a client configuration spells them', () => {
    expect(formatEndpoint({ host: '203.0.113.8', port: 4430 })).toBe(
      '203.0.113.8:4430',
    )
    expect(formatEndpoint({ host: '2001:db8::1', port: 8443 })).toBe(
      '[2001:db8::1]:8443',
    )
  })
  it('rewrites only the host and port of a copied document', () => {
    const rewritten = withServerEndpoint(config, {
      host: 'backup.example.test',
      port: 8443,
      primary: false,
    })
    expect(rewritten).toEqual({
      ...config,
      host: 'backup.example.test',
      port: 8443,
      dcs: [
        { id: 1, ip: 'backup.example.test', port: 8443 },
        { id: 2, ip: 'backup.example.test', port: 8443 },
      ],
    })
    // The copied document keeps the page's readable layout, only the address differs.
    expect(JSON.stringify(rewritten, null, 2)).toContain('"host": "backup.example.test"')
    // Selecting the primary endpoint leaves the document exactly as configured.
    expect(
      withServerEndpoint(config, {
        host: '203.0.113.8',
        port: 4430,
        primary: true,
      }),
    ).toEqual(config)
  })
})

describe('duplicate account presentation', () => {
  const groups: PlatformAccountDuplicateGroup[] = [
    {
      keep: 'qqnt',
      remove: ['qqnt-2', 'qqnt-3'],
      reason: 'virtual-phone',
    },
    { keep: 'matrix', remove: ['matrix-2'], reason: 'identity' },
  ]
  it('maps every duplicated entry to the entry that keeps the account', () => {
    expect([...duplicateOwners(groups)]).toEqual([
      ['qqnt-2', 'qqnt'],
      ['qqnt-3', 'qqnt'],
      ['matrix-2', 'matrix'],
    ])
    expect(duplicateOwners([]).size).toBe(0)
  })
  it('lists duplicated entries once, in a stable order', () => {
    expect(duplicatePlatformIds(groups)).toEqual([
      'matrix-2',
      'qqnt-2',
      'qqnt-3',
    ])
    expect(
      duplicatePlatformIds([...groups, { keep: 'other', remove: ['qqnt-2'], reason: 'identity' }]),
    ).toEqual(['matrix-2', 'qqnt-2', 'qqnt-3'])
  })
  it('states why a group counts as duplicated', () => {
    expect(describeDuplicateGroup(groups[0]!)).toBe(
      'qqnt-2, qqnt-3 duplicate qqnt (already serves the same virtual phone)',
    )
    expect(describeDuplicateGroup(groups[1]!)).toBe(
      'matrix-2 duplicates matrix (resolves to the same platform user)',
    )
  })
})
