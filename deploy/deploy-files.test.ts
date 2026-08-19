import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe('Crossgram Linux deployment', () => {
  it('keeps installer and updater valid POSIX shell', () => {
    for (const file of ['install.sh', 'update.sh']) {
      expect(() => execFileSync('sh', ['-n', join(root, 'deploy', file)]), file).not.toThrow()
    }
    const stages = execFileSync('git', [
      'ls-files', '--stage', 'deploy/install.sh', 'deploy/update.sh', 'deploy/generate-client-config.mjs',
    ], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    expect(stages).toHaveLength(3)
    expect(stages.every((stage) => stage.startsWith('100755 '))).toBe(true)
  })

  it('runs as an unprivileged hardened systemd service with persistent state', () => {
    const unit = readFileSync(join(root, 'deploy', 'crossgram.service'), 'utf8')
    expect(unit).toContain('User=crossgram')
    expect(unit).toContain('NODE_OPTIONS=--import tsx --import @cordisjs/unyaml')
    expect(unit).toContain('EnvironmentFile=-/etc/qqnt-bridge.env')
    expect(unit).toContain('cordis run /opt/crossgram/.runtime/app.yml')
    expect(unit).not.toContain('--no-daemon')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(unit).toContain('ProtectSystem=full')
    expect(unit).toContain('ReadWritePaths=/var/lib/crossgram')

    const config = readFileSync(join(root, 'deploy', 'app.production.yml'), 'utf8')
    expect(config).toContain('host: 0.0.0.0')
    expect(config).toContain('serverHost: __CROSSGRAM_PUBLIC_HOST__')
    expect(config).toContain('/var/lib/crossgram/data/rsa-key.json')
    expect(config).toContain("name: '@mtproto-relay/merged-forward'")
    expect(config).toContain("name: '@mtproto-relay/mtproto-statistics'")
    expect(config).toContain("name: '@mtproto-relay/update-store-database'")
    expect(config).toContain('retention: 10000')
    expect(config).toContain('historySeconds: 900')
    expect(config).not.toMatch(/^\s*token:/m)
    const installer = readFileSync(join(root, 'deploy', 'install.sh'), 'utf8')
    expect(installer).toContain('$install_dir/.runtime/app.yml')
    expect(installer).toContain('chown root:"$service_user" "$install_dir/.runtime/app.yml"')
    expect(installer).toContain('chmod 0640 "$install_dir/.runtime/app.yml"')
  })

  it('fast-forwards, installs immutably, builds, and restarts during an update', () => {
    const temp = mkdtempSync(join(tmpdir(), 'crossgram-update-'))
    const checkout = join(temp, 'checkout')
    const calls = join(temp, 'calls')
    try {
      mkdirSync(join(checkout, '.git'), { recursive: true })
      const fake = (name: string, body: string) => {
        const path = join(temp, name)
        writeFileSync(path, `#!/bin/sh\n${body}\n`)
        chmodSync(path, 0o755)
        return path
      }
      const runAs = fake('run-as', 'exec "$@"')
      const git = fake('git', 'printf \'git %s\\n\' "$*" >> "$CROSSGRAM_TEST_CALLS"; case "$*" in *rev-parse*) printf \'abc123\\n\';; esac')
      const corepack = fake('corepack', 'printf \'corepack %s scripts=%s\\n\' "$*" "${YARN_ENABLE_SCRIPTS:-}" >> "$CROSSGRAM_TEST_CALLS"')
      const systemctl = fake('systemctl', 'printf \'systemctl %s\\n\' "$*" >> "$CROSSGRAM_TEST_CALLS"')

      execFileSync('sh', [join(root, 'deploy', 'update.sh')], {
        env: {
          ...process.env,
          CROSSGRAM_INSTALL_DIR: checkout,
          CROSSGRAM_RUN_AS: runAs,
          CROSSGRAM_GIT: git,
          CROSSGRAM_COREPACK: corepack,
          CROSSGRAM_SYSTEMCTL: systemctl,
          CROSSGRAM_TEST_CALLS: calls,
          CROSSGRAM_ALLOW_NON_ROOT_TEST: '1',
        },
      })

      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
        'git fetch --prune origin main',
        'git merge --ff-only origin/main',
        'corepack yarn install --immutable scripts=true',
        'corepack yarn build scripts=',
        'systemctl restart crossgram.service',
        'git rev-parse --short HEAD',
      ])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('generates the shared Android and Desktop import JSON from the persisted RSA key', () => {
    const temp = mkdtempSync(join(tmpdir(), 'crossgram-client-config-'))
    const key = join(temp, 'rsa-key.json')
    try {
      const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      writeFileSync(key, JSON.stringify({ publicKeyPem: publicKey }))
      const output = execFileSync(process.execPath, [
        join(root, 'deploy', 'generate-client-config.mjs'),
        '--host', '203.0.113.10', '--port', '4430', '--name', 'CrossGram Test', '--key', key,
      ], { encoding: 'utf8' })
      const config = JSON.parse(output)

      expect(config).toMatchObject({
        name: 'CrossGram Test', enable_special_config: false,
        host: '203.0.113.10', port: 4430,
      })
      expect(config.rsa_key).toMatch(/^-----BEGIN RSA PUBLIC KEY-----/)
      expect(config.dcs).toEqual([1, 2, 3, 4, 5].map((id) => ({
        id, ip: '203.0.113.10', port: 4430,
      })))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
