import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveCredentials,
  profilePaths,
  readCredentialSession,
  resolveE2eProfile,
  sshNetworkHost,
  validateProfileName,
  writeCredentialSession,
} from './profile.js'

const directories: string[] = []
const publicKey = `-----BEGIN RSA PUBLIC KEY-----
ZmFrZQ==
-----END RSA PUBLIC KEY-----
`

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MTProto E2E profiles', () => {
  it('rejects path traversal and derives network hosts from SSH targets', () => {
    expect(validateProfileName('production-debug')).toBe('production-debug')
    expect(() => validateProfileName('../production')).toThrow(/Invalid profile/)
    expect(sshNetworkHost('root@118.89.184.208')).toBe('118.89.184.208')
    expect(sshNetworkHost('relay-alias:2222')).toBe('relay-alias')
    expect(sshNetworkHost('root@[2001:db8::1]:2222')).toBe('2001:db8::1')
  })

  it('persists public connection metadata without copying the private key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crossgram-e2e-profile-'))
    directories.push(root)
    const rsaKeyPath = join(root, 'rsa-key.json')
    await writeFile(rsaKeyPath, JSON.stringify({ publicKeyPem: publicKey, privateKeyPem: 'must-not-copy' }))
    const profile = await resolveE2eProfile({
      root, profile: 'local', host: '127.0.0.1', port: 4430, rsaKeyPath,
      approval: { kind: 'http', origin: 'http://127.0.0.1:3140', platformId: 'static' },
    })
    const saved = await readFile(profile.paths.config, 'utf8')
    expect(saved).toContain('BEGIN RSA PUBLIC KEY')
    expect(saved).not.toContain('must-not-copy')
    expect(profile.paths).toEqual(profilePaths('local', root))
  })

  it('archives credentials instead of deleting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crossgram-e2e-archive-'))
    directories.push(root)
    const paths = profilePaths('local', root)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.credentials, 'credentials')
    const moved = await archiveCredentials(paths)
    expect(moved).toHaveLength(1)
    await expect(stat(paths.credentials)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(moved[0]!, 'utf8')).resolves.toBe('credentials')
  })

  it('round trips the reusable mtcute session in the private credential file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crossgram-e2e-credentials-'))
    directories.push(root)
    const paths = profilePaths('local', root)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.directory, { recursive: true })
    await writeCredentialSession(paths, 'session-secret')
    await expect(readCredentialSession(paths)).resolves.toBe('session-secret')
    expect(JSON.parse(await readFile(paths.credentials, 'utf8'))).toEqual({
      version: 1, session: 'session-secret',
    })
  })
})
