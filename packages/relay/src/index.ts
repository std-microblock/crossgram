import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import { BaseTelegramClient } from '@mtcute/node'
import { bareVector, RpcError, type RpcResult } from '@mtproto-relay/mtproto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export const name = 'mtproto-relay'
export const inject = ['mtproto', 'database', 'model']

interface RouteBindingRow {
  authKeyId: string
  routeId: string
  createdAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_route_binding: RouteBindingRow
  }
}

export interface RelayClient {
  readonly onServerUpdate: {
    add(listener: (update: tl.TypeUpdates) => void): unknown
    remove(listener: (update: tl.TypeUpdates) => void): unknown
  }
  call(request: tl.RpcMethod): Promise<unknown>
  notifyLoggedIn?(authorization: tl.auth.TypeAuthorization | tl.RawUser): Promise<tl.RawUser>
  notifyLoggedOut?(): Promise<void>
  destroy(): Promise<void>
}

export interface RelayClientFactoryOptions {
  authKeyId: Uint8Array
  authKeyHex: string
  config: RelayConfig
}

export type RelayClientFactory =
  (options: RelayClientFactoryOptions) => RelayClient | Promise<RelayClient>

export interface RelayConfig {
  apiId: number
  apiHash: string
  /** One mtcute SQLite storage file is created per downstream permanent auth key. */
  storagePath?: string
  /** Disable mtcute's difference loop; raw server updates are still forwarded. */
  disableUpdates?: boolean
  /** Account route exposed to the MTProto service (default: relay:official). */
  routeId?: string
  /** Injectable for tests and custom upstream transports. */
  clientFactory?: RelayClientFactory
}

export const Config = z.object({
  apiId: z.natural().min(1).required(),
  apiHash: z.string().min(1).required().role('secret'),
  storagePath: z.string().default('data/relay'),
  disableUpdates: z.boolean().default(true),
  routeId: z.string().default('relay:official'),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

interface RelayEntry {
  client: RelayClient
  onUpdate: (update: tl.TypeUpdates) => void
}

/**
 * Raw Telegram relay backend.
 *
 * Every downstream permanent auth key owns one upstream mtcute client. RPC
 * methods are forwarded without interpreting their payload, and raw Telegram
 * updates are sent back only to the matching downstream account.
 */
export function apply(ctx: Context, config: RelayConfig): void {
  if (!config?.apiId || !config.apiHash) {
    throw new Error('relay apiId and apiHash are required')
  }

  const clients = new Map<string, Promise<RelayEntry>>()
  const factory = config.clientFactory ?? createDefaultClient
  const routeId = config.routeId ?? 'relay:official'
  const rpc = ctx.mtproto.route(routeId)

  ctx.model.extend('mtproto_route_binding', {
    authKeyId: 'string', routeId: 'string', createdAt: 'timestamp',
  }, { primary: 'authKeyId' })

  ctx.mtproto.resolveRoute(async (requestContext, request) => {
    if (!requestContext.authKeyId) return
    const authKeyHex = Buffer.from(requestContext.authKeyId).toString('hex')
    const [binding] = await ctx.database.get('mtproto_route_binding', { authKeyId: authKeyHex })
    if (binding) return binding.routeId
    if (request._ !== 'auth.sendCode') return
    const phone = String((request as unknown as { phoneNumber?: string }).phoneNumber ?? '')
      .replace(/\D/g, '')
    // 999... is reserved by bridge's virtual-phone login flow.
    if (!phone || phone.startsWith('999')) return
    await ctx.database.upsert('mtproto_route_binding', [{
      authKeyId: authKeyHex, routeId, createdAt: new Date(),
    }])
    return routeId
  })

  async function requireClient(authKeyId: Uint8Array | null): Promise<RelayEntry> {
    if (!authKeyId) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
    const authKeyHex = Buffer.from(authKeyId).toString('hex')
    let pending = clients.get(authKeyHex)
    if (!pending) {
      pending = Promise.resolve(factory({ authKeyId, authKeyHex, config })).then((client) => {
        const onUpdate = (update: tl.TypeUpdates) => {
          ctx.mtproto.sendUpdateToAuthKey(authKeyId, update)
        }
        client.onServerUpdate.add(onUpdate)
        return { client, onUpdate }
      }).catch((error) => {
        clients.delete(authKeyHex)
        throw error
      })
      clients.set(authKeyHex, pending)
    }
    return pending
  }

  rpc.fallback(async (requestContext, request) => {
    const { client } = await requireClient(requestContext.authKeyId)
    try {
      const result = await client.call(request)
      if (request._ === 'auth.signIn' || request._ === 'auth.signUp'
        || request._ === 'auth.importLoginToken' || request._ === 'auth.importBotAuthorization') {
        if (isAuthorization(result)) await client.notifyLoggedIn?.(result)
      } else if (request._ === 'auth.logOut') {
        await client.notifyLoggedOut?.()
      }
      return normalizeResult(result)
    } catch (error) {
      throw normalizeError(error)
    }
  })

  ctx.effect(() => () => {
    const pending = [...clients.values()]
    clients.clear()
    return Promise.allSettled(pending.map(async (entryPromise) => {
      const entry = await entryPromise
      entry.client.onServerUpdate.remove(entry.onUpdate)
      await entry.client.destroy()
    })).then(() => undefined)
  }, 'mtproto.relay.clients')
}

function createDefaultClient({ authKeyHex, config }: RelayClientFactoryOptions): RelayClient {
  const basePath = config.storagePath ?? 'data/relay'
  const storage = `${basePath.replace(/\/$/, '')}/${authKeyHex}.session`
  mkdirSync(dirname(storage), { recursive: true })
  return new BaseTelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage,
    disableUpdates: config.disableUpdates ?? true,
  })
}

function normalizeResult(result: unknown): RpcResult {
  if (Array.isArray(result)) return bareVector(result as tl.TlObject[])
  if (result && typeof result === 'object' && '_' in result) return result as tl.TlObject
  throw new Error(`unsupported upstream RPC result: ${String(result)}`)
}

function isAuthorization(result: unknown): result is tl.auth.TypeAuthorization {
  return !!result && typeof result === 'object'
    && '_' in result
    && ((result as { _: string })._ === 'auth.authorization'
      || (result as { _: string })._ === 'auth.authorizationSignUpRequired')
}

function normalizeError(error: unknown): Error {
  if (error instanceof RpcError) return error
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown, text?: unknown, errorCode?: unknown, errorMessage?: unknown }
    const code = Number(value.code ?? value.errorCode)
    const text = value.text ?? value.errorMessage
    if (Number.isInteger(code) && typeof text === 'string') return new RpcError(code, text)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export default Object.assign(apply, { Config, inject })
