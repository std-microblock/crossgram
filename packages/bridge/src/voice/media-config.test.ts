import { createHmac } from 'node:crypto'
import type { PlatformSession } from '../platform.js'
import type { VoiceWorkerCall } from './call-registry.js'
import { createBuiltInVoiceMediaProvider, isDirectIceHost } from './media-config.js'
import { describe, expect, it } from 'vitest'

const session: PlatformSession = {
  platformSessionId: 'voice-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const call = { callId: '99' } as VoiceWorkerCall

const allowedHosts = [
  'localhost', 'LOCALHOST',
  '127.0.0.1', '127.255.255.255',
  '10.0.0.0', '10.255.255.255',
  '172.16.0.0', '172.31.255.255',
  '192.168.0.0', '192.168.255.255',
  '::1', 'fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '::ffff:127.0.0.1', '::ffff:10.255.255.255', '::ffff:172.16.0.1',
  '::ffff:192.168.99.1', '::ffff:c0a8:6301',
]

const rejectedHosts = [
  undefined, '', 'localhost.', 'bridge.local', '127.0.0', '127.0.0.1:443',
  '8.8.8.8', '0.0.0.0', '169.254.1.1', '172.15.255.255', '172.32.0.0', '192.167.255.255',
  'fe80::1', '2001:db8::1', 'ff02::1', '::ffff:8.8.8.8', '::ffff:169.254.1.1',
  '::ffff:172.15.0.1', '::ffff:172.32.0.1', '::ffff:fe80:1', 'not-an-address',
]

describe('isDirectIceHost', () => {
  it.each(allowedHosts)('allows %s', (host) => {
    expect(isDirectIceHost(host)).toBe(true)
  })

  it.each(rejectedHosts)('rejects %s', (host) => {
    expect(isDirectIceHost(host)).toBe(false)
  })
})

describe('createBuiltInVoiceMediaProvider', () => {
  it('provides direct ICE with no relay settings for a private LAN host', async () => {
    const provider = createBuiltInVoiceMediaProvider({
      serverHost: '192.168.99.1', directIce: true, workerTimeoutMs: 5_000,
    })

    await expect(provider!.get(call, session)).resolves.toMatchObject({
      initializationTimeoutMs: 5_000,
      receiveTimeoutMs: 5_000,
      enableP2p: true,
      endpoints: [],
      rtcServers: [],
    })
  })

  it.each([
    { name: 'direct ICE is disabled', serverHost: '192.168.99.1', directIce: false },
    { name: 'the configured host is public', serverHost: '8.8.8.8', directIce: true },
  ])('returns undefined without TURN when $name', ({ serverHost, directIce }) => {
    expect(createBuiltInVoiceMediaProvider({ serverHost, directIce })).toBeUndefined()
  })

  it('keeps call-scoped TURN HMAC and TTL behavior for a public host', async () => {
    const provider = createBuiltInVoiceMediaProvider({
      serverHost: '8.8.8.8',
      directIce: true,
      workerTimeoutMs: 9_000,
      turn: { host: 'turn.example.test', port: 5349, sharedSecret: 'turn-secret', ttlSeconds: 60 },
      now: () => 1_700_000_000_000,
    })

    const config = await provider!.get(call, session)
    const username = '1700000060:99'
    expect(config).toMatchObject({
      initializationTimeoutMs: 9_000,
      receiveTimeoutMs: 9_000,
      enableP2p: true,
      endpoints: [],
      rtcServers: [{
        id: 1,
        host: 'turn.example.test',
        port: 5349,
        username,
        password: createHmac('sha1', 'turn-secret').update(username).digest('base64'),
        turn: true,
        tcp: false,
      }],
    })
  })
})
