import { request as httpRequest } from 'node:http'
import { expect } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import WebUI from 'cordis-webui-solidjs'
import { addPublicKey, findKeyByFingerprints, LogManager } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { NodePlatform } from '@mtcute/node'
import { Mtproto, generateRsaKeyPair } from '@mtproto-relay/mtproto'
import * as bridge from '@mtproto-relay/bridge'
import * as mergedForwardPlugin from '@mtproto-relay/merged-forward'
import * as staticPlatformPlugin from '@mtproto-relay/platform-static'
import * as telegramResourcesPlugin from '@mtproto-relay/telegram-resources'
import * as telegramBotApi from '@mtproto-relay/telegram-bot-api'
import DatabaseUpdateStore from '@mtproto-relay/update-store-database'

/** Full bridge e2e harness: db + server + mtproto + bridge, real socket client. */

const crypto = new NodeCryptoProvider()
const log = new LogManager('e2e', new NodePlatform())
log.level = LogManager.OFF

export async function startApp(options: {
  rsaKey?: ReturnType<typeof generateRsaKeyPair>
  databasePath?: string
  authKeyStorePath?: string
  bridgeConfig?: bridge.BridgeConfig
  platform?: { id: string, adapter: bridge.IMPlatform }
  botApi?: boolean
} = {}) {
  const rsaKey = options.rsaKey ?? generateRsaKeyPair()
  addPublicKey(crypto, rsaKey.publicKeyPem, false)
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Database),
    ctx.plugin(SQLiteDriver, { path: options.databasePath ?? ':memory:' }),
    ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(WebUI, { uiPath: '', apiPath: '/api' }),
    ctx.plugin(Mtproto, {
      port: 0, host: '127.0.0.1', rsaKey, log,
      authKeyStorePath: options.authKeyStorePath,
    }),
    ctx.plugin(DatabaseUpdateStore, { retention: 10_000 }),
    ctx.plugin(bridge, options.bridgeConfig ?? {}),
    ctx.plugin(mergedForwardPlugin),
    ...(options.botApi
      ? [ctx.plugin(telegramBotApi, { verifierSecret: 'mtproto-e2e-botfather-verifier' })]
      : []),
    ctx.plugin(telegramResourcesPlugin),
    options.platform
      ? ctx.plugin(makePlatformPlugin(options.platform.id, options.platform.adapter))
      : ctx.plugin(staticPlatformPlugin, {
          eventIntervalMs: 0,
          historySize: 10_000,
          // Keep live synthetic messages inside the same deterministic Telegram
          // message-ID time window as the reference adapter's seeded history.
          now: () => 1_700_001_000,
        } as staticPlatformPlugin.Config & Pick<staticPlatformPlugin.StaticPlatformOptions, 'now'>),
  ]
  await Promise.all(fibers)
  await new Promise((r) => setTimeout(r, 100)) // let fibers settle
  const pubKey = findKeyByFingerprints([rsaKey.fingerprint])!
  const stop = async () => { for (const f of fibers.reverse()) await Promise.resolve((f as any).dispose?.()) }
  return { ctx, port: ctx.mtproto.port, pubKey, rsaKey, stop }
}

export async function waitForPlatformLogin(ctx: Context, platformId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [auth] = await ctx.database.get('mtproto_auth_session', { platformId })
    if (auth) {
      const [session] = await ctx.database.get('mtproto_platform_session', { id: auth.platformSessionId })
      if (session) return { auth, session }
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`platform login was not provisioned: ${platformId}`)
}

export function makePlatformPlugin(id: string, platform: bridge.IMPlatform) {
  const plugin = (ctx: Context) => { ctx.imPlatform.register(platform, id) }
  plugin.inject = ['imPlatform']
  return plugin
}

export async function waitForWebuiRoute(ctx: Context, route: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entry = Object.values(ctx.webui.entries)
      .find(candidate => candidate.files.routes?.includes(route))
    if (entry) return entry
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`webui route was not registered: ${route}`)
}

export async function postChunked(
  port: number,
  path: string,
  chunks: Uint8Array[],
): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' },
    }, (response) => {
      const body: Buffer[] = []
      response.on('data', (chunk: Buffer) => body.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(body).toString('utf8') }))
    })
    request.on('error', reject)
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })
}

export async function assignStaticStickerPacksThroughDashboard(ctx: Context, platformSessionId: string) {
  const entry = await waitForWebuiRoute(ctx, '/sticker-packs')
  const data = entry.data as bridge.StickerPackDashboardData
  await data.refreshStickerPacks()
  const packs = data.stickerPacks.filter(pack => pack.providerId.startsWith('static:'))
  expect(packs.map(pack => pack.packId).sort()).toEqual(['native-pack', 'plugin-pack'])
  for (const pack of packs) {
    await data.setStickerPackAssigned(platformSessionId, pack.providerId, pack.packId, true)
  }
}
