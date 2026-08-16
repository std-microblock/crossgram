import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request } from 'node:https'

const REQUEST_TIMEOUT_MS = 30_000

export interface WebhookRequestOptions {
  hostname: string
  servername: string
  port: number
  path: string
  headers: Record<string, string | number>
}

/** Small test seam: resolution and the already-pinned HTTPS request. */
export interface WebhookTransport {
  resolve(hostname: string): Promise<string[]>
  request(options: WebhookRequestOptions, body: string): Promise<number>
}

const nodeWebhookTransport: WebhookTransport = {
  async resolve(hostname) {
    const literal = isIP(hostname)
    if (literal) return [hostname]
    const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)])
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  },
  request(options, body) {
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => {
        req.destroy(new Error('webhook request timed out'))
        finish(() => reject(new Error('webhook request timed out')))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      const req = request({
        protocol: 'https:',
        hostname: options.hostname,
        servername: options.servername,
        port: options.port,
        path: options.path,
        method: 'POST',
        agent: false,
        headers: options.headers,
      }, (response) => {
        response.resume()
        finish(() => resolve(response.statusCode ?? 0))
      })
      req.once('error', (error) => finish(() => reject(error)))
      req.end(body)
    })
  },
}

/** Deliver directly to an audited public address; never consult proxy environment variables. */
export async function postPublicWebhook(url: URL, body: string, secretToken?: string, transport = nodeWebhookTransport): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('webhook url must use HTTPS')
  const hostname = hostnameForResolution(url.hostname)
  const addresses = await resolvePublicAddresses(hostname, transport.resolve)
  const statusCode = await transport.request({
    // Use the audited address for the TCP connection, but retain the hostname for
    // TLS SNI and the default TLS hostname/certificate verification.
    hostname: addresses[0],
    servername: hostname,
    port: Number(url.port) || 443,
    path: `${url.pathname}${url.search}`,
    headers: {
      host: url.host,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(secretToken ? { 'x-telegram-bot-api-secret-token': secretToken } : {}),
    },
  }, body)
  // node:https never follows redirects. Treat every one as an unsuccessful delivery.
  if (statusCode < 200 || statusCode >= 300) throw new Error(`webhook returned HTTP ${statusCode}`)
}

export async function resolvePublicAddresses(hostname: string, resolve = nodeWebhookTransport.resolve): Promise<string[]> {
  hostname = hostnameForResolution(hostname)
  const addresses = await resolve(hostname)
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('webhook host must resolve exclusively to public addresses')
  }
  return addresses
}

function hostnameForResolution(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

function isPublicIpv4(address: string): boolean {
  const [a, b, c, d] = address.split('.').map(Number)
  const value = (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0
  const inRange = (base: number, mask: number) => (value & mask) === (base & mask)
  return !(
    inRange(0x00000000, 0xff000000) || // unspecified
    inRange(0x0a000000, 0xff000000) || // RFC 1918
    inRange(0x64400000, 0xffc00000) || // shared/CGNAT
    inRange(0x7f000000, 0xff000000) || // loopback
    inRange(0xa9fe0000, 0xffff0000) || // link local
    inRange(0xac100000, 0xfff00000) || // RFC 1918
    inRange(0xc0000000, 0xffffff00) || // IETF protocol assignments
    inRange(0xc0000200, 0xffffff00) || // documentation
    inRange(0xc01fc400, 0xffffff00) || // AS112
    inRange(0xc034c100, 0xffffff00) || // AMT
    inRange(0xc0586300, 0xffffff00) || // deprecated 6to4 relay
    inRange(0xc0a80000, 0xffff0000) || // RFC 1918
    inRange(0xc0af3000, 0xffffff00) || // AS112
    inRange(0xc6120000, 0xfffe0000) || // benchmarking
    inRange(0xc6336400, 0xffffff00) || // documentation
    inRange(0xcb007100, 0xffffff00) || // documentation
    inRange(0xe0000000, 0xf0000000) || // multicast
    inRange(0xf0000000, 0xf0000000) // reserved
  )
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address)
  const inRange = (base: bigint, bits: number) => value >> BigInt(128 - bits) === base >> BigInt(128 - bits)
  if (
    inRange(0n, 128) || // unspecified
    inRange(1n, 128) || // loopback
    inRange(0n, 96) || // IPv4-compatible/reserved
    inRange(0xffffn << 32n, 96) || // IPv4-mapped
    inRange(0x64ff9bn << 96n, 96) || // NAT64 well-known prefix
    inRange(0x64ff9b0001n << 80n, 48) || // NAT64 local-use prefix
    inRange(0x100000000000001n << 64n, 64) || // IPv6 dummy prefix
    inRange(0x100n << 112n, 64) || // discard-only
    inRange(0x2001n << 112n, 23) || // IETF protocol assignments
    inRange(0x20010db8n << 96n, 32) || // documentation
    inRange(0x2002n << 112n, 16) || // 6to4
    inRange(0x3fffn << 112n, 20) || // documentation
    inRange(0x5f00n << 112n, 16) || // segment routing
    inRange(0xfc00n << 112n, 7) || // unique local
    inRange(0xfe80n << 112n, 10) || // link local
    inRange(0xff00n << 112n, 8) // multicast
  ) return false
  return true
}

function ipv6Value(address: string): bigint {
  const [before, after = ''] = address.toLowerCase().split('::')
  const left = before ? before.split(':') : []
  const right = after ? after.split(':') : []
  const expand = (part: string) => part.includes('.')
    ? part.split('.').map(Number).reduce<number[]>((result, byte, index, bytes) => index % 2 ? result.concat((bytes[index - 1] << 8) + byte) : result, [])
    : [Number.parseInt(part, 16)]
  const groups = [...left.flatMap(expand), ...Array(8 - left.flatMap(expand).length - right.flatMap(expand).length).fill(0), ...right.flatMap(expand)]
  return groups.reduce((value, group) => (value << 16n) + BigInt(group), 0n)
}
