import type { VoiceWorkerMediaEndpoint } from '@mtproto-relay/bridge'
import type { QQVoiceMediaStartOptions } from './voice-media.js'
import { describe, expect, it, vi } from 'vitest'
import { QQNTPlatform } from './index.js'

const call = {
  callId: 'opaque-telegram-call', callerId: 1, participantId: 2, telegramRole: 'caller' as const,
  protocol: {
    _: 'phoneCallProtocol' as const, udpP2p: false, udpReflector: false,
    minLayer: 100, maxLayer: 100, libraryVersions: ['bridge'],
  },
}
const session = {
  platformSessionId: 'voice-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}
const endpoint: VoiceWorkerMediaEndpoint = {
  async send() {},
  async *receive() {},
  async close() {},
}

function mediaService(start: ReturnType<typeof vi.fn>) {
  return { start } as unknown as import('./voice-media.js').QQVoiceMedia
}

describe('QQ voice media composition', () => {
  it('consumes one lease token through QQVoiceMedia and zeroes its caller-owned bytes', async () => {
    const token = new Uint8Array(32).fill(7)
    let options: QQVoiceMediaStartOptions | undefined
    const start = vi.fn(async (_transport: unknown, value: QQVoiceMediaStartOptions) => {
      options = value
      return {
        send() {}, receive: async () => { throw new Error('not used') }, close: async () => {}, finished: new Promise<void>(() => {}),
      }
    })
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, mediaService(start))
    vi.spyOn(platform.client, 'mediaLease').mockResolvedValue({
      version: 1, socketPath: '/run/qq-bridge/media.sock', leaseId: '0123456789abcdef0123456789abcdef', token, expiry: 1,
    })

    await platform.voiceMedia!.start(call, session, endpoint)

    expect(start).toHaveBeenCalledOnce()
    expect(options?.callId).toBe(call.callId)
    expect(options?.token).toBe(token)
    expect(token).toEqual(new Uint8Array(32))
  })

  it('fails closed before requesting a lease for an invalid worker endpoint', async () => {
    const start = vi.fn()
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, mediaService(start))
    const lease = vi.spyOn(platform.client, 'mediaLease')

    await expect(platform.voiceMedia!.start(call, session, {} as VoiceWorkerMediaEndpoint)).rejects.toThrow('worker PCM endpoint')
    expect(lease).not.toHaveBeenCalled()
  })

  it('does not expose a media provider when no QQVoiceMedia service was installed', () => {
    const platform = new QQNTPlatform()
    expect(platform.voiceMedia).toBeUndefined()
  })
})
