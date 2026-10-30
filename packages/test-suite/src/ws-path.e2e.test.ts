import { describe, it, expect } from 'vitest'
import { connectWs } from '@fuman/net'
import { IntermediatePacketCodec, ObfuscatedPacketCodec, type TelegramTransport } from '@mtcute/core'
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import { addPublicKey } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { startApp } from './harness.js'

/**
 * Same-origin WebSocket route (`wsPath` on the shared HTTP server): a modified
 * Telegram Web client connects to `<page origin>/apiws`, appending `_test` /
 * `_premium` suffixes for test-server / premium sessions. Verifies login works
 * through a suffixed path, the way a premium web account would.
 */
const WS_PATH = '/apiws'

function sameOriginWsTransport(port: number, suffix = ''): TelegramTransport {
  return {
    connect: (dc, abortSignal) =>
      connectWs({ url: `ws://127.0.0.1:${port}${WS_PATH}${suffix}` }, abortSignal),
    packetCodec: () => new ObfuscatedPacketCodec(new IntermediatePacketCodec()),
  }
}

describe('e2e: same-origin websocket path', () => {
  it('accepts plain and suffixed (premium) wsPath routes and logs in via QR', async () => {
    const { ctx, rsaKey, stop } = await startApp({ wsPath: WS_PATH })
    try {
      addPublicKey(new NodeCryptoProvider(), rsaKey.publicKeyPem, false)
      const dc = { id: 1, ipAddress: '127.0.0.1', port: ctx.server.port }

      for (const suffix of ['', '_premium']) {
        const client = new TelegramClient({
          apiId: 1,
          apiHash: 'crossgram-e2e',
          storage: new MemoryStorage(),
          defaultDcs: { main: dc, media: dc },
          transport: sameOriginWsTransport(ctx.server.port, suffix),
          updates: {},
          logLevel: 1,
          initConnectionOptions: {
            deviceModel: 'Crossgram WS-Path E2E',
            systemVersion: 'test',
            appVersion: '0.1.0',
            systemLangCode: 'en',
            langPack: '',
            langCode: 'en',
          },
        })

        const user = await client.start({
          qrCodeHandler: async (url) => {
            const response = await fetch(`http://127.0.0.1:${ctx.server.port}/api/login-tokens/static/approve`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: url }),
            })
            expect(response.ok).toBe(true)
          },
        })
        expect(user.isSelf).toBe(true)
        const me = await client.getMe()
        expect(me.id).toBe(user.id)
        await client.destroy()
      }
    } finally {
      await stop()
    }
  })
})
