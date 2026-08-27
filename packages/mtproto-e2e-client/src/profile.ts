import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fetchRemotePublicKey, normalizePublicKey } from './approval.js'
import type {
  ApprovalConfig,
  E2eClientEvent,
  E2eProfileConfig,
  E2eProfilePaths,
  OpenE2eClientOptions,
  ResolvedE2eProfile,
} from './types.js'

const DEFAULT_ROOT = 'data/mtproto-e2e'
const DEFAULT_REMOTE_RSA_KEY = '/var/lib/crossgram/data/rsa-key.json'
const DEFAULT_APPROVAL_ORIGIN = 'http://127.0.0.1:3140'

export function validateProfileName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new Error(`Invalid profile name: ${value}`)
  return value
}

export function profilePaths(name: string, root = DEFAULT_ROOT): E2eProfilePaths {
  const profile = validateProfileName(name)
  const resolvedRoot = resolve(root)
  const directory = resolve(resolvedRoot, profile)
  return {
    root: resolvedRoot,
    directory,
    config: resolve(directory, 'profile.json'),
    credentials: resolve(directory, 'credentials.json'),
  }
}

export async function resolveE2eProfile(options: OpenE2eClientOptions = {}): Promise<ResolvedE2eProfile> {
  const name = validateProfileName(options.profile ?? 'default')
  const paths = profilePaths(name, options.root)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await chmod(paths.directory, 0o700).catch(() => {})
  const saved = await readProfile(paths.config)
  const sshHost = options.sshHost
    ?? (options.approval?.kind === 'ssh-http' ? options.approval.sshHost : undefined)
    ?? (saved?.approval?.kind === 'ssh-http' ? saved.approval.sshHost : undefined)
  const remoteRsaKeyPath = options.remoteRsaKeyPath
    ?? (options.approval?.kind === 'ssh-http' ? options.approval.remoteRsaKeyPath : undefined)
    ?? (saved?.approval?.kind === 'ssh-http' ? saved.approval.remoteRsaKeyPath : undefined)
    ?? DEFAULT_REMOTE_RSA_KEY
  const publicKeyPem = options.publicKeyPem
    ? normalizePublicKey(options.publicKeyPem)
    : options.rsaKeyPath
      ? await readPublicKey(options.rsaKeyPath)
      : options.sshHost
        ? await fetchRemotePublicKey(options.sshHost, remoteRsaKeyPath)
        : saved?.publicKeyPem
          ? normalizePublicKey(saved.publicKeyPem)
          : sshHost
            ? await fetchRemotePublicKey(sshHost, remoteRsaKeyPath)
            : undefined
  if (!publicKeyPem) {
    throw new Error('No MTProto RSA public key is configured; pass --rsa-key or --ssh')
  }
  const approval = resolveApproval(options, saved?.approval, sshHost, remoteRsaKeyPath)
  const host = options.host ?? saved?.host ?? (sshHost ? sshNetworkHost(sshHost) : '127.0.0.1')
  const port = options.port ?? saved?.port ?? 4430
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid MTProto port: ${port}`)
  const config: E2eProfileConfig = {
    version: 1,
    host,
    port,
    publicKeyPem,
    apiId: options.apiId ?? saved?.apiId ?? 1,
    apiHash: options.apiHash ?? saved?.apiHash ?? 'crossgram-mtproto-e2e',
    approval,
  }
  await atomicJson(paths.config, config)
  return { name, paths, config }
}

function resolveApproval(
  options: OpenE2eClientOptions,
  saved: ApprovalConfig | undefined,
  sshHost: string | undefined,
  remoteRsaKeyPath: string,
): ApprovalConfig | undefined {
  if (options.approval) return options.approval
  const platformId = options.platformId ?? saved?.platformId
  if (options.sshHost) {
    if (!platformId) throw new Error('Pass --platform when configuring SSH-backed authentication')
    return {
      kind: 'ssh-http',
      sshHost: options.sshHost,
      platformId,
      origin: options.approvalOrigin ?? DEFAULT_APPROVAL_ORIGIN,
      remoteRsaKeyPath,
    }
  }
  if (sshHost && platformId && saved?.kind === 'ssh-http') {
    return {
      kind: 'ssh-http', sshHost, platformId,
      origin: options.approvalOrigin ?? saved.origin,
      remoteRsaKeyPath,
    }
  }
  if (options.approvalOrigin && platformId) {
    return { kind: 'http', origin: options.approvalOrigin, platformId }
  }
  return saved
}

export async function archiveCredentials(
  paths: E2eProfilePaths,
  onEvent?: (event: E2eClientEvent) => void,
): Promise<string[]> {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const archive = resolve(paths.directory, 'stale', timestamp)
  const candidates = [paths.credentials]
  const existing: string[] = []
  for (const candidate of candidates) {
    if (await exists(candidate)) existing.push(candidate)
  }
  if (!existing.length) return []
  await mkdir(archive, { recursive: true, mode: 0o700 })
  const moved: string[] = []
  for (const candidate of existing) {
    const destination = resolve(archive, basename(candidate))
    await rename(candidate, destination)
    moved.push(destination)
  }
  onEvent?.({ event: 'credential-archived', files: moved })
  return moved
}

export async function secureCredentialFiles(paths: E2eProfilePaths): Promise<void> {
  await chmod(paths.credentials, 0o600).catch(() => {})
}

export async function credentialsExist(paths: E2eProfilePaths): Promise<boolean> {
  return exists(paths.credentials)
}

export async function readCredentialSession(paths: E2eProfilePaths): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.credentials, 'utf8')) as { version?: unknown, session?: unknown }
    if (value.version !== 1 || typeof value.session !== 'string' || !value.session) {
      throw new Error(`Malformed MTProto E2E credentials: ${paths.credentials}`)
    }
    return value.session
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeCredentialSession(paths: E2eProfilePaths, session: string): Promise<void> {
  if (!session) throw new Error('Refusing to persist an empty MTProto session')
  await atomicJson(paths.credentials, { version: 1, session })
}

export function sshNetworkHost(target: string): string {
  const withoutUser = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target
  if (withoutUser.startsWith('[')) {
    const end = withoutUser.indexOf(']')
    if (end < 0) throw new Error(`Invalid SSH host: ${target}`)
    return withoutUser.slice(1, end)
  }
  const colon = withoutUser.lastIndexOf(':')
  return colon > 0 && /^\d+$/.test(withoutUser.slice(colon + 1))
    ? withoutUser.slice(0, colon)
    : withoutUser
}

async function readProfile(path: string): Promise<E2eProfileConfig | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as E2eProfileConfig
    if (value.version !== 1) throw new Error(`Unsupported profile version in ${path}`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function readPublicKey(path: string): Promise<string> {
  const source = await readFile(resolve(path), 'utf8')
  if (source.trimStart().startsWith('{')) {
    const value = JSON.parse(source) as { publicKeyPem?: unknown }
    if (typeof value.publicKeyPem !== 'string') throw new Error(`publicKeyPem is missing from ${path}`)
    return normalizePublicKey(value.publicKeyPem)
  }
  return normalizePublicKey(source)
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => {})
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
