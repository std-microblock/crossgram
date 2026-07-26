import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  findRuntime, parseArgs, parseDuration, queryLogs, queryMessage, queryReadOnlySql, queryTable,
} from './inspect-relay.mjs'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'inspect-relay-unit-'))
  const db = new DatabaseSync(join(directory, 'cordis.db'))
  db.exec(`
    CREATE TABLE mtproto_im_message (id INTEGER PRIMARY KEY, platformSessionId TEXT, conversationId INTEGER, primaryPlatformMessageId TEXT, senderUserId INTEGER, text TEXT, content TEXT);
    CREATE TABLE mtproto_im_message_alias (id INTEGER PRIMARY KEY, platformSessionId TEXT, conversationId INTEGER, platformMessageId TEXT, messageId INTEGER, ordinal INTEGER);
    CREATE TABLE mtproto_im_media (id INTEGER PRIMARY KEY, messageId INTEGER, locator TEXT);
    CREATE TABLE mtproto_tl_message_part (id INTEGER PRIMARY KEY, messageId INTEGER, tlMessageId INTEGER);
    CREATE TABLE mtproto_im_message_reaction (id INTEGER PRIMARY KEY, messageId INTEGER, definition TEXT);
    CREATE TABLE mtproto_im_conversation (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE mtproto_im_user (id INTEGER PRIMARY KEY, firstName TEXT);
    CREATE TABLE mtproto_update_delivery (messageId INTEGER PRIMARY KEY, eventKey TEXT, platformSessionId TEXT, published INTEGER);
    INSERT INTO mtproto_im_message VALUES (42, 'qq:1', 7, 'native-9', 3, 'hello', '{"type":"text"}');
    INSERT INTO mtproto_im_message_alias VALUES (1, 'qq:1', 7, 'native-9', 42, 0);
    INSERT INTO mtproto_im_media VALUES (2, 42, '{"url":"x"}');
    INSERT INTO mtproto_tl_message_part VALUES (4, 42, 1001);
    INSERT INTO mtproto_im_message_reaction VALUES (5, 42, '{"emoji":"👍"}');
    INSERT INTO mtproto_im_conversation VALUES (7, 'test room');
    INSERT INTO mtproto_im_user VALUES (3, 'Alice');
    INSERT INTO mtproto_update_delivery VALUES (42, 'message:native-9', 'qq:1', 0);
  `)
  const logs = new DatabaseSync(join(directory, 'logs.db'))
  logs.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, sn INTEGER, ts INTEGER, type TEXT, level INTEGER, name TEXT, body TEXT, entry_id TEXT)`)
  logs.prepare('INSERT INTO logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, Date.now() - 60_000, 'log', 1, 'bridge', 'started', null)
  logs.prepare('INSERT INTO logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(2, 2, Date.now(), 'log', 3, 'mtproto', 'RPC failed', 'mtproto01')
  return { directory, db, logs, close() { db.close(); logs.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test('parseArgs supports positional values, camelized options, and repeated filters', () => {
  assert.deepEqual(parseArgs(['table', 'items', '--logs-db', 'x.db', '--where', 'a=1', '--where=b=2']), {
    command: 'table', options: { _: ['items'], logsDb: 'x.db', where: ['a=1', 'b=2'] },
  })
})

test('parseDuration accepts relative durations, epochs, and ISO timestamps', () => {
  assert.equal(parseDuration('30m', 2_000_000), 200_000)
  assert.equal(parseDuration('1234'), 1234)
  assert.equal(parseDuration('1970-01-01T00:00:01Z'), 1000)
  assert.throws(() => parseDuration('yesterday-ish'), /Invalid time value/)
})

test('findRuntime resolves explicit relative paths from the project root', () => {
  const runtime = findRuntime('C:\\repo', { root: 'C:\\repo', db: 'state/main.db', logsDb: 'state/logs.db' })
  assert.match(runtime.db, /state[\\/]main\.db$/)
  assert.match(runtime.logsDb, /state[\\/]logs\.db$/)
})

test('queryLogs applies level, name, text, time, order, and limit filters', () => {
  const state = fixture()
  try {
    const rows = queryLogs(state.logs, { level: 'warn', name: 'proto', grep: 'failed', since: '5m', limit: 1 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].body, 'RPC failed')
    assert.equal(rows[0].entryId, 'mtproto01')
  } finally { state.close() }
})

test('queryMessage returns the complete normalized message graph by either id', () => {
  const state = fixture()
  try {
    for (const [identifier, options] of [[42, {}], ['native-9', { platformId: true, conversation: 7 }]]) {
      const result = queryMessage(state.db, identifier, options)
      assert.equal(result.message.content.type, 'text')
      assert.equal(result.aliases[0].platformMessageId, 'native-9')
      assert.equal(result.media[0].locator.url, 'x')
      assert.equal(result.telegramParts[0].tlMessageId, 1001)
      assert.equal(result.reactions[0].definition.emoji, '👍')
      assert.equal(result.conversation.title, 'test room')
      assert.equal(result.sender.firstName, 'Alice')
      assert.equal(result.deliveries[0].published, 0)
    }
  } finally { state.close() }
})

test('generic table and SQL access remain bounded and read-only', () => {
  const state = fixture()
  try {
    assert.equal(queryTable(state.db, 'mtproto_im_message', { where: ['id=42'], limit: 10 })[0].text, 'hello')
    assert.equal(queryReadOnlySql(state.db, 'SELECT count(*) AS count FROM mtproto_im_message')[0].count, 1)
    assert.throws(() => queryTable(state.db, 'mtproto_im_message; DROP TABLE x', {}), /Unknown table/)
    assert.throws(() => queryReadOnlySql(state.db, 'DELETE FROM mtproto_im_message'), /Only SELECT/)
  } finally { state.close() }
})
