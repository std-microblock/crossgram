import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { fetchMtprotoSnapshot } from './inspect-relay.mjs'

const require = createRequire(new URL('../../../../package.json', import.meta.url))
const { WebSocket, WebSocketServer } = require('ws')
const script = new URL('./inspect-relay.mjs', import.meta.url)

function execute(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(script), ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)))
  })
}

test('CLI discovers runtime databases and returns JSON from a child process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inspect-relay-e2e-'))
  mkdirSync(join(root, 'data'))
  const db = new DatabaseSync(join(root, 'data', 'cordis.db'))
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, \'ok\')')
  db.close()
  try {
    const doctor = await execute(['doctor', '--root', root], root)
    assert.equal(doctor.dbExists, true)
    const rows = await execute(['table', 'sample', '--root', root, '--where', 'id=1'], root)
    assert.deepEqual(rows, [{ id: 1, value: 'ok' }])
    const selected = await execute(['sql', 'SELECT value FROM sample', '--root', root], root)
    assert.deepEqual(selected, [{ value: 'ok' }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MTProto command waits through reload frames and consumes the real WebSocket protocol', async () => {
  const server = createServer()
  const sockets = new WebSocketServer({ server, path: '/api' })
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'entry:init', body: { version: 'test', entries: { unrelated: { data: { messages: [] } } } } }))
    setTimeout(() => socket.send(JSON.stringify({
      type: 'entry:init',
      body: {
        version: 'test',
        entries: {
          debug: { data: { capturing: true, dropped: 2, maxEvents: 2000, events: [
            { id: 1, timestamp: Date.now(), direction: 'client->server', phase: 'message', name: 'ping', searchText: 'ping' },
            { id: 2, timestamp: Date.now(), direction: 'server->client', phase: 'message', name: 'rpc_result -> pong', searchText: 'rpc_result pong' },
          ] } },
        },
      },
    })), 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const result = await fetchMtprotoSnapshot(`http://127.0.0.1:${port}`, { direction: 'server->client', grep: 'pong', limit: 10 }, WebSocket)
    assert.equal(result.capturing, true)
    assert.equal(result.dropped, 2)
    assert.deepEqual(result.events.map(event => event.id), [2])
  } finally {
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
})
