import { describe, expect, it, vi } from 'vitest'
import { QQNTClient } from './client.js'

const leaseId = '0123456789abcdef0123456789abcdef'
const token = Buffer.alloc(32, 7).toString('base64url')

function validLease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    socketPath: '/run/qq-bridge/media.sock',
    leaseId,
    token,
    expiry: 30_000,
    ...overrides,
  }
}

describe('QQNTClient media leases', () => {
  it('uses the authenticated JSON route and returns a typed, decoded lease', async () => {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = [input, init]
      return Response.json(validLease())
    }
    const client = new QQNTClient({ endpoint: 'http://bridge.invalid/v1/', token: 'bridge-secret', fetch })

    const lease = await client.mediaLease('call-id/opaque')

    expect(request).toBeDefined()
    const [url, init] = request!
    expect(String(url)).toBe('http://bridge.invalid/v1/calls/media-lease')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ callId: 'call-id/opaque' }) })
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer bridge-secret')
    expect(lease).toMatchObject({ version: 1, socketPath: '/run/qq-bridge/media.sock', leaseId, expiry: 30_000 })
    expect(lease.token).toEqual(new Uint8Array(32).fill(7))
  })

  it('preserves the gateway monotonic capability expiry without consulting the wall clock', async () => {
    // Mirrors qqnt-bridge's media-lease response serialization in src/server.ts.
    const gatewayLease = validLease({ expiry: 4_294_967_296 })
    const now = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
    const client = new QQNTClient({ fetch: async () => Response.json(gatewayLease) })
    try {
      const lease = await client.mediaLease('opaque-call-id')

      expect(lease).toStrictEqual({
        version: 1,
        socketPath: '/run/qq-bridge/media.sock',
        leaseId,
        token: new Uint8Array(32).fill(7),
        expiry: 4_294_967_296,
      })
      expect(now).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it.each([
    ['unsupported version', validLease({ version: 2 })],
    ['relative socket path', validLease({ socketPath: 'relative/media.sock' })],
    ['missing monotonic expiry', validLease({ expiry: undefined })],
    ['negative monotonic expiry', validLease({ expiry: -1 })],
    ['fractional monotonic expiry', validLease({ expiry: 1.5 })],
    ['short token', validLease({ token: Buffer.alloc(31).toString('base64url') })],
    ['long token', validLease({ token: Buffer.alloc(33).toString('base64url') })],
    ['bad lease identifier', validLease({ leaseId: 'a'.repeat(31) })],
  ])('rejects %s without exposing capability data', async (_name, response) => {
    const secret = 'call=opaque token=secret path=/private/bridge header=Bearer secret'
    const client = new QQNTClient({
      token: secret,
      fetch: vi.fn(async () => new Response(JSON.stringify({ ...response, diagnostic: secret }), {
        headers: { 'content-type': 'application/json', 'x-secret': secret },
      })),
    })

    const error = await client.mediaLease(secret).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('QQNT media lease request failed')
    expect((error as Error).message).not.toContain(secret)
    expect((error as Error).message).not.toContain('/private/bridge')
  })

  it('sanitizes rejected HTTP responses without reading response details into errors', async () => {
    const secret = 'token=private-body call=opaque-id path=/private.sock'
    const client = new QQNTClient({
      fetch: vi.fn(async () => new Response(secret, { status: 403, headers: { 'x-secret': secret } })),
    })

    const error = await client.mediaLease('opaque-id').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('QQNT media lease request failed')
    expect((error as Error).message).not.toContain(secret)
  })
})
