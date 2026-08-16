import { describe, expect, it, vi } from 'vitest'
import { isPublicAddress, postPublicWebhook, resolvePublicAddresses, type WebhookTransport } from './webhook.js'

const publicAddress = '8.8.8.8'

function transport(addresses = [publicAddress], statusCode = 204): WebhookTransport {
  return { resolve: vi.fn(async () => addresses), request: vi.fn(async () => statusCode) }
}

describe('public webhook transport', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::1', '64:ff9b:1::1', '100:0:0:1::', '100::1', '2001:db8::1', '2002::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1',
  ])('rejects non-public literal %s', async (address) => {
    expect(isPublicAddress(address)).toBe(false)
    await expect(resolvePublicAddresses(address)).rejects.toThrow('exclusively to public')
  })

  it('allows public IPv4 and IPv6 literals', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('accepts an all-public DNS response and rejects a mixed response', async () => {
    await expect(resolvePublicAddresses('hook.example', async () => ['8.8.8.8', '2606:4700:4700::1111'])).resolves.toEqual(['8.8.8.8', '2606:4700:4700::1111'])
    await expect(resolvePublicAddresses('hook.example', async () => ['8.8.8.8', '127.0.0.1'])).rejects.toThrow('exclusively to public')
  })

  it('pins TCP to an audited address while retaining hostname SNI and certificate verification', async () => {
    const seam = transport(['2606:4700:4700::1111'])
    await postPublicWebhook(new URL('https://hook.example:8443/a?b=c'), '{"update_id":1}', 'secret-value', seam)
    expect(seam.request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '2606:4700:4700::1111', servername: 'hook.example', port: 8443, path: '/a?b=c',
      headers: expect.objectContaining({ host: 'hook.example:8443', 'x-telegram-bot-api-secret-token': 'secret-value' }),
    }), '{"update_id":1}')
  })

  it('accepts a public IPv6 URL literal without DNS resolution', async () => {
    const seam = transport(['2606:4700:4700::1111'])
    await postPublicWebhook(new URL('https://[2606:4700:4700::1111]/'), '{}', undefined, seam)
    expect(seam.resolve).toHaveBeenCalledWith('2606:4700:4700::1111')
    expect(seam.request).toHaveBeenCalledWith(expect.objectContaining({ hostname: '2606:4700:4700::1111', servername: '2606:4700:4700::1111', headers: expect.objectContaining({ host: '[2606:4700:4700::1111]' }) }), '{}')
  })

  it.each([[301], [302], [307], [308]])('fails redirects rather than following them (%i)', async (statusCode) => {
    await expect(postPublicWebhook(new URL('https://hook.example/'), '{}', undefined, transport([publicAddress], statusCode))).rejects.toThrow(`HTTP ${statusCode}`)
  })

  it('fails non-successful status codes', async () => {
    await expect(postPublicWebhook(new URL('https://hook.example/'), '{}', undefined, transport([publicAddress], 500))).rejects.toThrow('HTTP 500')
  })
})
