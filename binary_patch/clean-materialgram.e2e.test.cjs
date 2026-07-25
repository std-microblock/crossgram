'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, stat, writeFile } = require('node:fs/promises')
const test = require('node:test')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const cleanupScript = resolve(__dirname, 'materialgram/clean-materialgram.cjs')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'materialgram-clean-'))
  const client = join(root, 'binary_patch', 'materialgram')
  const data = join(root, 'data')
  await Promise.all([
    mkdir(join(client, 'tdata', 'user_data'), { recursive: true }),
    mkdir(join(client, 'logs'), { recursive: true }),
    mkdir(join(data, 'qqnt-media-cache', 'qqnt'), { recursive: true }),
    mkdir(join(data, 'bridge-uploads', 'staged'), { recursive: true }),
    mkdir(join(root, 'cache', 'vite'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'package.json'), '{}'),
    writeFile(join(client, 'materialgram.exe'), 'fixture executable'),
    writeFile(join(client, 'log.txt'), 'client log'),
    writeFile(join(client, 'notes.txt'), 'keep unrelated neighbor'),
    writeFile(join(client, 'tdata', 'user_data', 'map0'), 'session'),
    writeFile(join(client, 'logs', 'current.log'), 'log'),
    writeFile(join(data, 'cordis.db'), 'db'),
    writeFile(join(data, 'cordis.db-wal'), 'wal'),
    writeFile(join(data, 'logs.db'), 'logs'),
    writeFile(join(data, 'auth-keys.json'), 'auth'),
    writeFile(join(data, 'qqnt-media-cache', 'qqnt', 'avatar.webp'), 'cache'),
    writeFile(join(data, 'bridge-uploads', 'staged', 'part'), 'upload'),
    writeFile(join(data, 'rsa-key.json'), 'private key fixture'),
    writeFile(join(data, 'rsa-key.json.pem'), 'public key fixture'),
    writeFile(join(root, 'cache', 'vite', 'metadata.json'), 'cache'),
  ])
  return { root, client, data }
}

async function invoke(root, ...args) {
  return execFileAsync(process.execPath, [cleanupScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MATERIALGRAM_CLEANUP_TEST_ROOT: root,
      MATERIALGRAM_CLEANUP_SKIP_PROCESSES: '1',
    },
  })
}

test('dry-run lists exact targets without changing the fixture', async () => {
  const { root, client, data } = await fixture()
  try {
    const { stdout } = await invoke(root, '--dry-run')
    assert.match(stdout, /DRY RUN/)
    assert.match(stdout, /cordis\.db/)
    assert.match(stdout, /\[keep\].*rsa-key\.json/)
    assert.equal(await exists(join(client, 'tdata')), true)
    assert.equal(await exists(join(data, 'cordis.db')), true)
    assert.equal(await exists(join(root, 'cache')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one-shot cleanup removes sessions, logs, DBs and caches but keeps RSA keys and binaries', async () => {
  const { root, client, data } = await fixture()
  try {
    const { stdout } = await invoke(root, '--yes')
    assert.match(stdout, /Cleanup complete/)

    for (const path of [
      join(client, 'tdata'), join(client, 'logs'), join(client, 'log.txt'),
      join(data, 'cordis.db'), join(data, 'cordis.db-wal'), join(data, 'logs.db'),
      join(data, 'auth-keys.json'), join(data, 'qqnt-media-cache'), join(data, 'bridge-uploads'),
      join(root, 'cache'),
    ]) assert.equal(await exists(path), false, path)

    assert.equal(await readFile(join(data, 'rsa-key.json'), 'utf8'), 'private key fixture')
    assert.equal(await readFile(join(data, 'rsa-key.json.pem'), 'utf8'), 'public key fixture')
    assert.equal(await readFile(join(client, 'materialgram.exe'), 'utf8'), 'fixture executable')
    assert.equal(await readFile(join(client, 'notes.txt'), 'utf8'), 'keep unrelated neighbor')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
