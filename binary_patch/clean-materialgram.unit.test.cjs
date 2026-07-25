'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { resolve } = require('node:path')
const {
  assertSafeTarget,
  isMaterialgramRuntimeEntry,
  isRsaKeyArtifact,
  isWithin,
  parseListeningPorts,
  selectRelatedProcesses,
} = require('./materialgram/clean-materialgram.cjs')

function entry(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
  }
}

test('preserves every RSA key artifact while recognizing disposable data', () => {
  for (const name of ['rsa-key.json', 'rsa-key.json.pem', 'RSA_KEY-backup.pem', 'rsakey.cmd']) {
    assert.equal(isRsaKeyArtifact(name), true, name)
  }
  for (const name of ['auth-keys.json', 'cordis.db', 'logs.db', 'qqnt-media-cache']) {
    assert.equal(isRsaKeyArtifact(name), false, name)
  }
})

test('selects only known Materialgram runtime entries beside the executable', () => {
  for (const item of [
    entry('tdata', 'directory'), entry('logs', 'directory'), entry('cache', 'directory'),
    entry('log.txt', 'file'), entry('debug-2026.log', 'file'), entry('crash.dmp', 'file'),
  ]) assert.equal(isMaterialgramRuntimeEntry(item), true, item.name)
  for (const item of [
    entry('materialgram.exe', 'file'), entry('clean-materialgram.cmd', 'file'),
    entry('screenshots', 'directory'), entry('notes.txt', 'file'),
  ]) assert.equal(isMaterialgramRuntimeEntry(item), false, item.name)
})

test('refuses recursive targets outside or equal to an allowed base', () => {
  const root = resolve('C:/fixture/project')
  const data = resolve(root, 'data')
  assert.equal(isWithin(root, resolve(data, 'cordis.db')), true)
  assert.equal(assertSafeTarget(resolve(data, 'cordis.db'), [data]), resolve(data, 'cordis.db'))
  assert.throws(() => assertSafeTarget(data, [data]), /unsafe cleanup target/)
  assert.throws(() => assertSafeTarget(resolve(root, '..', 'other'), [data]), /unsafe cleanup target/)
})

test('parses listening ports and selects Materialgram plus project-owned servers', () => {
  const ports = parseListeningPorts([
    '  TCP    127.0.0.1:4430       0.0.0.0:0       LISTENING       20',
    '  TCP    127.0.0.1:3140       0.0.0.0:0       LISTENING       20',
    '  TCP    127.0.0.1:9999       0.0.0.0:0       LISTENING       30',
  ].join('\r\n'))
  assert.deepEqual([...ports.get(20)], [4430, 3140])

  const root = resolve('C:/fixture/project')
  const selected = selectRelatedProcesses([
    { pid: 10, name: 'materialgram.exe', commandLine: 'D:/downloads/materialgram.exe', listeningPorts: [] },
    { pid: 20, name: 'node.exe', commandLine: 'node server.js', listeningPorts: [4430, 3140] },
    { pid: 30, name: 'node.exe', commandLine: `node ${root}/server.js`, listeningPorts: [] },
    { pid: 40, name: 'node.exe', commandLine: 'node unrelated.js', listeningPorts: [9999] },
    { pid: 50, name: 'Code.exe', commandLine: root, listeningPorts: [] },
  ], root, 99)
  assert.deepEqual(selected.map(item => item.pid), [10, 20, 30])
})
