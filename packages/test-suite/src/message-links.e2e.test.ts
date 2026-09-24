import { describe, expect, it } from 'vitest'
import { parseMarkedPeerId, type Dialog } from '@mtcute/core'
import { addPublicKey } from '@mtcute/core/utils.js'
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import * as bridge from '@mtproto-relay/bridge'
import { startApp, waitForPlatformLogin } from './harness.js'

/**
 * Bounds one step of the link flow so a stall names itself instead of only
 * showing up as the test timeout.
 */
async function step<T>(name: string, work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`message link e2e stalled in ${name}`)), timeoutMs)
      timer.unref?.()
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('bridge message links e2e', () => {
  it('resolves the link a client copies from a private channel', async () => {
    const { ctx, port, rsaKey, stop } = await startApp()
    try {
      const login = await waitForPlatformLogin(ctx, 'static')
      addPublicKey(new NodeCryptoProvider(), rsaKey.publicKeyPem, false)
      const dc = { id: 1, ipAddress: '127.0.0.1', port }
      const client = new TelegramClient({
        apiId: 1,
        apiHash: 'crossgram-message-link-e2e',
        storage: new MemoryStorage(),
        defaultDcs: { main: dc, media: dc },
        updates: {},
        logLevel: 0,
        initConnectionOptions: {
          deviceModel: 'Crossgram message link E2E',
          systemVersion: `${process.platform} ${process.arch}`,
          appVersion: '0.1.0',
          systemLangCode: 'en',
          langPack: '',
          langCode: 'en',
        },
      })
      try {
        await step('login', client.start({
          phone: `+${login.auth.virtualPhone}`,
          code: () => bridge.generateLoginCode(login.auth.totpSecret),
        }))

        const config = await step('help.getConfig', client.call({ _: 'help.getConfig' }))
        expect(config.meUrlPrefix).toBe('https://t.me/')

        const dialogs: Dialog[] = []
        await step('dialogs', (async () => {
          for await (const dialog of client.iterDialogs({ limit: 100 })) dialogs.push(dialog)
        })())
        const dialog = dialogs.find((candidate) => (
          candidate.peer.type === 'chat'
          && (candidate.peer.chatType === 'channel' || candidate.peer.chatType === 'supergroup')
          && candidate.lastMessage !== null
        ))
        expect(dialog).toBeDefined()
        const target = dialog!.lastMessage!
        const [, channelId] = parseMarkedPeerId(dialog!.peer.id)

        // What the clients copy: Telegram Desktop and Telegram Android append
        // `c/<channel>/<post>` to the advertised prefix and read the same shape
        // back as their own private-post link (`Core::TryConvertUrlToLocal`,
        // `Browser.isInternalUri`), so the host of the prefix decides whether a
        // click resolves through this relay or leaves for a browser.
        const link = `${config.meUrlPrefix}c/${channelId}/${target.id}`
        expect(link).toBe(`https://t.me/c/${channelId}/${target.id}`)

        // The client resolves the link by loading the channel by its bare ID and
        // then the post itself, both of which ignore the peer access hash — the
        // values a client sends when the peer is not in its local cache yet.
        const resolved = await step('message link', client.getMessageByLink(link))
        expect(resolved?.id).toBe(target.id)
        expect(resolved?.chat.id).toBe(dialog!.peer.id)
      } finally {
        await client.destroy()
      }
    } finally {
      await stop()
    }
  }, 30_000)
})
