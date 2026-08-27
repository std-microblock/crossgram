import { describe, expect, it, vi } from 'vitest'
import {
  approvalEndpoint,
  approveLoginToken,
  fetchRemotePublicKey,
  validateLoginUrl,
} from './approval.js'
import type { ProcessExecutor } from './process.js'

const publicKey = `-----BEGIN RSA PUBLIC KEY-----
ZmFrZQ==
-----END RSA PUBLIC KEY-----
`

describe('MTProto E2E approval transport', () => {
  it('builds a bounded platform approval endpoint', () => {
    expect(approvalEndpoint('http://127.0.0.1:3140/', 'qqnt.main')).toBe(
      'http://127.0.0.1:3140/api/login-tokens/qqnt.main/approve',
    )
    expect(() => approvalEndpoint('file:///tmp/socket', 'qqnt')).toThrow(/HTTP/)
    expect(() => approvalEndpoint('http://127.0.0.1:3140', '../qqnt')).toThrow(/platform id/)
  })

  it('accepts only Telegram login URLs with a bounded token', () => {
    expect(() => validateLoginUrl(`tg://login?token=${'a'.repeat(43)}`)).not.toThrow()
    expect(() => validateLoginUrl('https://example.com/login?token=abc')).toThrow(/Unexpected/)
    expect(() => validateLoginUrl('tg://login?token=short')).toThrow(/Malformed/)
  })

  it('passes the login token over SSH stdin instead of command arguments', async () => {
    const executor = vi.fn<ProcessExecutor>(async () => ({ code: 0, stdout: '', stderr: '' }))
    const url = `tg://login?token=${'a'.repeat(43)}`
    await approveLoginToken({
      kind: 'ssh-http', sshHost: 'root@relay', platformId: 'qqnt',
      origin: 'http://127.0.0.1:3140', remoteRsaKeyPath: '/var/lib/crossgram/data/rsa-key.json',
    }, url, executor)
    expect(executor).toHaveBeenCalledOnce()
    const [command, args, options] = executor.mock.calls[0]!
    expect(command).toBe('ssh')
    expect(args.join(' ')).not.toContain(url)
    expect(options?.input).toBe(JSON.stringify({ token: url }))
  })

  it('posts direct local approvals as JSON and surfaces HTTP failures', async () => {
    const url = `tg://login?token=${'b'.repeat(43)}`
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    await approveLoginToken({
      kind: 'http', origin: 'http://127.0.0.1:3140', platformId: 'static',
    }, url, undefined, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3140/api/login-tokens/static/approve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: url }) }),
    )

    const rejectedFetch = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }))
    await expect(approveLoginToken({
      kind: 'http', origin: 'http://127.0.0.1:3140', platformId: 'static',
    }, url, undefined, rejectedFetch)).rejects.toThrow(/HTTP 403.*denied/)
  })

  it('fetches only the public PEM through the remote helper', async () => {
    const executor = vi.fn<ProcessExecutor>(async () => ({ code: 0, stdout: publicKey, stderr: '' }))
    await expect(fetchRemotePublicKey('root@relay', '/var/lib/crossgram/data/rsa-key.json', executor))
      .resolves.toBe(publicKey)
    const command = executor.mock.calls[0]![1][1]!
    expect(command).toContain('publicKeyPem')
    expect(command).not.toContain('privateKeyPem')
  })
})
