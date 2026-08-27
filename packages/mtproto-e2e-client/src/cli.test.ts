import { describe, expect, it } from 'vitest'
import { clientOptions, parseArgs } from './cli.js'

describe('MTProto E2E CLI', () => {
  it('parses commands, positional probes, inline options, and booleans', () => {
    expect(parseArgs([
      'run', 'work/probe.ts', '--profile=production', '--ssh', 'root@relay', '--fresh',
    ])).toEqual({
      command: 'run',
      positional: ['work/probe.ts'],
      options: { profile: 'production', ssh: 'root@relay', fresh: true },
    })
  })

  it('combines explicit options with environment defaults', () => {
    const parsed = parseArgs(['auth', '--platform', 'qqnt', '--port', '4444'])
    const options = clientOptions(parsed, {
      CROSSGRAM_E2E_PROFILE: 'production',
      CROSSGRAM_E2E_SSH: 'root@relay',
    })
    expect(options).toMatchObject({
      profile: 'production', sshHost: 'root@relay', platformId: 'qqnt', port: 4444,
    })
  })

  it('rejects missing and malformed option values', () => {
    expect(() => clientOptions(parseArgs(['auth', '--ssh']))).toThrow(/requires a value/)
    expect(() => clientOptions(parseArgs(['auth', '--port', '70000']))).toThrow(/integer/)
  })
})
