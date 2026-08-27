import type { TelegramClient, User } from '@mtcute/node'
import type { tl } from '@mtcute/core'

export interface HttpApprovalConfig {
  kind: 'http'
  origin: string
  platformId: string
}

export interface SshApprovalConfig {
  kind: 'ssh-http'
  sshHost: string
  origin: string
  platformId: string
  remoteRsaKeyPath: string
}

export type ApprovalConfig = HttpApprovalConfig | SshApprovalConfig

export interface E2eProfileConfig {
  version: 1
  host: string
  port: number
  publicKeyPem: string
  apiId: number
  apiHash: string
  approval?: ApprovalConfig
}

export interface E2eProfilePaths {
  root: string
  directory: string
  config: string
  credentials: string
}

export interface ResolvedE2eProfile {
  name: string
  config: E2eProfileConfig
  paths: E2eProfilePaths
}

export type E2eClientEvent =
  | { event: 'profile'; profile: string, host: string, port: number, credentials: string }
  | { event: 'credential-archived'; files: string[] }
  | { event: 'auth-required'; expiresAt: number, approval: ApprovalConfig['kind'] }
  | { event: 'auth-approved'; platformId: string }
  | { event: 'auth-retry'; reason: string }
  | { event: 'authenticated'; userId: number }

export interface OpenE2eClientOptions {
  profile?: string
  root?: string
  host?: string
  port?: number
  publicKeyPem?: string
  rsaKeyPath?: string
  apiId?: number
  apiHash?: string
  approval?: ApprovalConfig
  sshHost?: string
  platformId?: string
  approvalOrigin?: string
  remoteRsaKeyPath?: string
  fresh?: boolean
  timeoutMs?: number
  logLevel?: number
  onEvent?: (event: E2eClientEvent) => void
}

export interface OpenedE2eClient {
  client: TelegramClient
  user: User
  profile: ResolvedE2eProfile
  close(): Promise<void>
}

export interface MtprotoE2eProbeContext {
  client: TelegramClient
  profile: ResolvedE2eProfile
  user: User
  signal: AbortSignal
  call<T extends tl.RpcMethod>(request: T, timeoutMs?: number): Promise<tl.RpcCallReturn[T['_']]>
  publish(value: unknown): void
}

export type MtprotoE2eProbe = (context: MtprotoE2eProbeContext) => unknown | Promise<unknown>

export interface RunE2eProbeOptions extends OpenE2eClientOptions {
  probeTimeoutMs?: number
  callTimeoutMs?: number
  maxResultBytes?: number
  onResult?: (value: unknown) => void
}
