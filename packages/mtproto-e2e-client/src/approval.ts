import type { ApprovalConfig } from './types.js'
import { executeProcess, shellQuote, type ProcessExecutor } from './process.js'

export async function fetchRemotePublicKey(
  sshHost: string,
  remotePath: string,
  executor: ProcessExecutor = executeProcess,
): Promise<string> {
  if (!sshHost.trim()) throw new Error('SSH host must not be empty')
  if (!remotePath.startsWith('/')) throw new Error('Remote RSA key path must be absolute')
  const script = [
    "const fs=require('fs')",
    'const value=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'))',
    "if(typeof value.publicKeyPem!=='string')throw new Error('publicKeyPem missing')",
    'process.stdout.write(value.publicKeyPem)',
  ].join(';')
  const result = await executor('ssh', [
    sshHost,
    `node -e ${shellQuote(script)} ${shellQuote(remotePath)}`,
  ], { timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new Error(`Failed to fetch the MTProto public key through SSH: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return normalizePublicKey(result.stdout)
}

export async function approveLoginToken(
  config: ApprovalConfig,
  loginUrl: string,
  executor: ProcessExecutor = executeProcess,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  validateLoginUrl(loginUrl)
  const endpoint = approvalEndpoint(config.origin, config.platformId)
  const body = JSON.stringify({ token: loginUrl })
  if (config.kind === 'http') {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`Login-token approval failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    }
    return
  }
  const command = [
    'curl --fail-with-body --silent --show-error',
    "-X POST -H 'content-type: application/json' --data-binary @-",
    shellQuote(endpoint),
  ].join(' ')
  const result = await executor('ssh', [config.sshHost, command], {
    input: body,
    timeoutMs: 30_000,
  })
  if (result.code !== 0) {
    throw new Error(`Login-token approval through SSH failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`)
  }
}

export function approvalEndpoint(origin: string, platformId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(platformId)) throw new Error(`Invalid platform id: ${platformId}`)
  const url = new URL(origin)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Approval origin must use HTTP or HTTPS')
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/login-tokens/${encodeURIComponent(platformId)}/approve`
  url.search = ''
  url.hash = ''
  return url.href
}

export function validateLoginUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'tg:' || url.hostname !== 'login') throw new Error('Unexpected MTProto login-token URL')
  const token = url.searchParams.get('token')
  if (!token || token.length < 20 || token.length > 128) throw new Error('Malformed MTProto login token')
}

export function normalizePublicKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('-----BEGIN RSA PUBLIC KEY-----') || !trimmed.endsWith('-----END RSA PUBLIC KEY-----')) {
    throw new Error('MTProto RSA public key must be a PKCS#1 public PEM')
  }
  return `${trimmed}\n`
}
