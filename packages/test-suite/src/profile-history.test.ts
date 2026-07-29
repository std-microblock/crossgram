import { describe, expect, it } from 'vitest'
import { parseHistoryProfileOptions, percentile, stableSyntheticId } from './profile-history-utils.js'

describe('history profiler', () => {
  it('parses the Telegram Desktop unread-window request shape', () => {
    expect(parseHistoryProfileOptions([
      '--conversation', '54404627', '--offset-id', '1', '--add-offset', '-25',
      '--limit', '50', '--repeat', '7',
    ])).toMatchObject({
      operation: 'history', host: '127.0.0.1', port: 4430, conversation: '54404627',
      rsaKey: expect.stringMatching(/[\\/]data[\\/]rsa-key\.json$/),
      authKeyStore: expect.stringMatching(/[\\/]data[\\/]auth-keys\.json$/),
      offsetId: 1, addOffset: -25, limit: 50, warmup: 1, repeat: 7,
      timeoutMs: 30_000, logLevel: 0,
    })
  })

  it('keeps synthetic peer IDs and percentile selection deterministic', () => {
    expect(stableSyntheticId('peer:54404627')).toBe(309770360)
    expect(percentile([30, 10, 50, 20, 40], 0.5)).toBe(30)
    expect(percentile([30, 10, 50, 20, 40], 0.95)).toBe(50)
  })

  it('rejects ambiguous and malformed targets', () => {
    expect(() => parseHistoryProfileOptions([])).toThrow(/conversation.*peer/)
    expect(() => parseHistoryProfileOptions(['--peer', 'channel:1', '--repeat', '0'])).toThrow(/repeat/)
    expect(() => parseHistoryProfileOptions(['--operation', 'unknown'])).toThrow(/operation/)
  })

  it('allows dialog-list profiling without a peer target', () => {
    expect(parseHistoryProfileOptions(['--operation', 'dialogs'])).toMatchObject({
      operation: 'dialogs', conversation: undefined, peer: undefined,
    })
    expect(() => parseHistoryProfileOptions(['--operation', 'conversation']))
      .toThrow(/conversation.*peer/)
  })
})
