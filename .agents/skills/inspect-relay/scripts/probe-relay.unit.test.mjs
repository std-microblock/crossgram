import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRemoteInstallCommand,
  localPaths,
  normalizeScriptName,
  parseArgs,
  remotePaths,
  runtimeOptions,
  shellQuote,
} from './probe-relay.mjs'

test('argument parsing supports camelized options and positional values', () => {
  assert.deepEqual(
    parseArgs([
      'wait',
      'issue/probe.ts',
      '--remote-root',
      '/state',
      '--timeout=3000',
      '--result',
    ]),
    {
      command: 'wait',
      options: {
        _: ['issue/probe.ts'],
        remoteRoot: '/state',
        timeout: '3000',
        result: true,
      },
    },
  )
})

test('script names accept nested TypeScript paths and reject traversal or hidden files', () => {
  assert.equal(normalizeScriptName('issue\\probe.ts'), 'issue/probe.ts')
  for (const value of [
    '../probe.ts',
    '.probe.ts',
    'issue/.probe.ts',
    '/probe.ts',
    'probe.d.ts',
    'probe.js',
  ]) {
    assert.throws(() => normalizeScriptName(value), /Invalid debug script name/)
  }
})

test('local and remote paths preserve the validated relative script name', () => {
  assert.match(
    localPaths('/state', 'issue/probe.ts').status,
    /debug-results[\\/]issue[\\/]probe\.ts\.json$/,
  )
  assert.equal(
    remotePaths('/state/', 'issue/probe.ts').script,
    '/state/debug-scripts/issue/probe.ts',
  )
})

test('remote install commands quote paths and install probes as the service user', () => {
  const command = buildRemoteInstallCommand(
    '/var/lib/crossgram',
    "issue/o'hare.ts",
    '/tmp/probe.ts',
  )
  assert.match(command, /install -m 0600 -o crossgram -g crossgram/)
  assert.match(command, /o'\\''hare\.ts/)
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})

test('runtime options apply bounded defaults and environment host overrides', () => {
  assert.deepEqual(
    runtimeOptions({ localRoot: '.' }, { CROSSGRAM_INSPECT_HOST: 'root@test' }),
    {
      host: 'root@test',
      remoteRoot: '/var/lib/crossgram',
      localRoot: process.cwd(),
      timeout: 10_000,
      interval: 250,
    },
  )
  assert.throws(
    () => runtimeOptions({ timeout: 1 }, {}),
    /Invalid numeric option/,
  )
})
