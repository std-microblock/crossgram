import { addPublicKey } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { MemoryStorage, TelegramClient, type User } from '@mtcute/node'
import { approveLoginToken } from './approval.js'
import {
  archiveCredentials,
  credentialsExist,
  readCredentialSession,
  resolveE2eProfile,
  secureCredentialFiles,
  writeCredentialSession,
} from './profile.js'
import type {
  E2eClientEvent,
  OpenE2eClientOptions,
  OpenedE2eClient,
  ResolvedE2eProfile,
} from './types.js'

export async function openE2eClient(options: OpenE2eClientOptions = {}): Promise<OpenedE2eClient> {
  const profile = await resolveE2eProfile(options)
  options.onEvent?.({
    event: 'profile', profile: profile.name,
    host: profile.config.host, port: profile.config.port,
    credentials: profile.paths.credentials,
  })
  if (options.fresh) await archiveCredentials(profile.paths, options.onEvent)
  const hadCredentials = await credentialsExist(profile.paths)
  try {
    return await openOnce(profile, options)
  } catch (error) {
    if (!hadCredentials || !profile.config.approval || !isStaleSessionError(error)) throw error
    options.onEvent?.({ event: 'auth-retry', reason: errorMessage(error) })
    await archiveCredentials(profile.paths, options.onEvent)
    return openOnce(profile, options)
  }
}

async function openOnce(
  profile: ResolvedE2eProfile,
  options: OpenE2eClientOptions,
): Promise<OpenedE2eClient> {
  addPublicKey(new NodeCryptoProvider(), profile.config.publicKeyPem, false)
  const dc = { id: 1, ipAddress: profile.config.host, port: profile.config.port }
  const client = new TelegramClient({
    apiId: profile.config.apiId,
    apiHash: profile.config.apiHash,
    storage: new MemoryStorage(),
    defaultDcs: { main: dc, media: dc },
    updates: {},
    logLevel: options.logLevel ?? 0,
    initConnectionOptions: {
      deviceModel: 'Crossgram MTProto E2E',
      systemVersion: `${process.platform} ${process.arch}`,
      appVersion: '0.1.0',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
    },
  })
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 45_000
  const timer = setTimeout(() => controller.abort(new Error(`MTProto authentication timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref()
  let approvalFailure: unknown
  let approvalQueue = Promise.resolve()
  try {
    const savedSession = await readCredentialSession(profile.paths)
    const user = await client.start({
      session: savedSession,
      sessionForce: true,
      abortSignal: controller.signal,
      qrCodeHandler: (url, expires) => {
        const approval = profile.config.approval
        if (!approval) {
          approvalFailure = new Error('This profile is not authorized and has no automatic approval configuration')
          controller.abort(approvalFailure)
          return
        }
        options.onEvent?.({ event: 'auth-required', expiresAt: expires.getTime(), approval: approval.kind })
        approvalQueue = approvalQueue
          .then(() => approveLoginToken(approval, url))
          .then(() => options.onEvent?.({ event: 'auth-approved', platformId: approval.platformId }))
          .catch((error) => {
            approvalFailure = error
            controller.abort(error)
          })
      },
    })
    await approvalQueue
    if (approvalFailure) throw approvalFailure
    await writeCredentialSession(profile.paths, await client.exportSession())
    await secureCredentialFiles(profile.paths)
    options.onEvent?.(authenticatedEvent(user))
    return {
      client,
      user,
      profile,
      close: async () => {
        try {
          await writeCredentialSession(profile.paths, await client.exportSession())
        } finally {
          await client.destroy()
          await secureCredentialFiles(profile.paths)
        }
      },
    }
  } catch (error) {
    await approvalQueue.catch(() => {})
    await client.destroy().catch(() => {})
    await secureCredentialFiles(profile.paths)
    throw approvalFailure ?? error
  } finally {
    clearTimeout(timer)
  }
}

function authenticatedEvent(user: User): E2eClientEvent {
  return {
    event: 'authenticated',
    userId: user.id,
  }
}

export function isStaleSessionError(error: unknown): boolean {
  return /AUTH_KEY_(?:UNREGISTERED|INVALID)|SESSION_REVOKED/i.test(errorMessage(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
