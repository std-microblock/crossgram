import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import type { VoiceMediaStartProvider } from './call-registry.js'
import type { VoiceWorkerRtcServer } from './voice-worker-client.js'

export interface BuiltInVoiceMediaProviderOptions {
  readonly serverHost?: string
  readonly directIce?: boolean
  readonly workerTimeoutMs?: number
  readonly turn?: {
    readonly host?: string
    readonly port?: number
    readonly sharedSecret?: string
    readonly ttlSeconds?: number
  }
  readonly envTurnSharedSecret?: string
  readonly now?: () => number
}

export function isDirectIceHost(host: string | undefined): boolean {
  if (!host) return false
  if (host.toLowerCase() === 'localhost') return true
  const family = isIP(host)
  if (family === 4) return isAllowedIpv4(host)
  if (family !== 6) return false

  const words = ipv6Words(host)
  if (!words) return false
  if (words.every((word, index) => word === (index === 7 ? 1 : 0))) return true
  if ((words[0] & 0xfe00) === 0xfc00) return true
  return words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff
    && isAllowedIpv4(`${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`)
}

export function createBuiltInVoiceMediaProvider(
  options: BuiltInVoiceMediaProviderOptions,
): VoiceMediaStartProvider | undefined {
  const hasDirectIce = options.directIce && isDirectIceHost(options.serverHost)
  const turnSharedSecret = options.turn?.sharedSecret || options.envTurnSharedSecret
  const hasTurn = Boolean(options.turn?.host && turnSharedSecret)
  if (!hasDirectIce && !hasTurn) return undefined

  return {
    async get(call) {
      const rtcServers: VoiceWorkerRtcServer[] = []
      if (hasTurn) {
        const expires = Math.floor((options.now?.() ?? Date.now()) / 1_000) + (options.turn?.ttlSeconds ?? 3_600)
        const username = `${expires}:${call.callId}`
        rtcServers.push({
          id: 1,
          host: options.turn!.host!,
          port: options.turn!.port ?? 3478,
          username,
          password: createHmac('sha1', turnSharedSecret!).update(username).digest('base64'),
          turn: true,
          tcp: false,
        })
      }
      return {
        initializationTimeoutMs: options.workerTimeoutMs,
        receiveTimeoutMs: options.workerTimeoutMs,
        enableP2p: hasDirectIce || hasTurn, allowTcp: false, protocolV1: true,
        enableAec: true, enableNs: true, enableAgc: true, endpoints: [],
        rtcServers,
      }
    },
  }
}

function isAllowedIpv4(host: string): boolean {
  const [first, second] = host.split('.').map(Number)
  return first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function ipv6Words(host: string): number[] | undefined {
  const ipv4Start = host.lastIndexOf(':')
  const ipv4 = host.includes('.')
    ? host.slice(ipv4Start + 1).split('.').map(Number)
    : undefined
  const address = ipv4
    ? `${host.slice(0, ipv4Start)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`
    : host
  const [left, right] = address.split('::')
  const leftWords = left ? left.split(':').map((word) => Number.parseInt(word, 16)) : []
  const rightWords = right ? right.split(':').map((word) => Number.parseInt(word, 16)) : []
  const words = [...leftWords, ...Array(8 - leftWords.length - rightWords.length).fill(0), ...rightWords]
  return words.length === 8 ? words : undefined
}
