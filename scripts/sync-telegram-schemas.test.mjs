import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  extractSnapshots,
  normalizeSchema,
  parseArgs,
  parseLayerFromVersion,
  syncSchemas,
} from './sync-telegram-schemas.mjs'

const execFileAsync = promisify(execFile)

test('extracts MTPROTO_LAYER from TDLib Version.h', () => {
  assert.equal(parseLayerFromVersion('constexpr int32 MTPROTO_LAYER = 228;'), 228)
  assert.equal(parseLayerFromVersion('constexpr int32 VERSION = 228;'), null)
})

test('normalizes and validates a complete TDLib API schema', () => {
  const schema = normalizeSchema('thing#1234abcd value:int = Thing;\r\n\r\n---functions---\r\ngetThing#9876abcd = Thing;\r\n')
  assert.equal(schema.endsWith('getThing#9876abcd = Thing;\n'), true)
  assert.equal(schema.includes('\r'), false)
  assert.throws(() => normalizeSchema('thing#1234abcd = Thing;\n'), /functions/)
})

test('parses local TDLib history and layer range CLI options', () => {
  const options = parseArgs(['--', '--td-repo', '../td', '--ref', 'master', '--from', '199', '--to', '224'])
  assert.equal(options.tdRepo, resolve('../td'))
  assert.equal(options.ref, 'master')
  assert.equal(options.from, 199)
  assert.equal(options.to, 224)
  assert.throws(() => parseArgs(['--from', '224', '--to', '223']), /lower/)
})

test('uses the newest schema commit within each layer and writes a reproducible mirror', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tl-schema-test-'))
  const repo = join(root, 'td')
  const output = join(root, 'schemas')
  await execFileAsync('git', ['init', '-b', 'master', repo])
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Schema Test'])
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'schema@example.invalid'])

  const writeSnapshot = async (layer, constructor, message) => {
    await mkdir(join(repo, 'td/telegram'), { recursive: true })
    await mkdir(join(repo, 'td/generate/scheme'), { recursive: true })
    await writeFile(join(repo, 'td/telegram/Version.h'), `constexpr int32 MTPROTO_LAYER = ${layer};\n`)
    await writeFile(join(repo, 'td/generate/scheme/telegram_api.tl'), `${constructor} = Thing;\n---functions---\ngetThing#9876abcd = Thing;\n`)
    await execFileAsync('git', ['-C', repo, 'add', '.'])
    await execFileAsync('git', ['-C', repo, 'commit', '-m', message])
  }
  await writeSnapshot(100, 'thing#10000000', 'layer 100')
  await writeSnapshot(100, 'thing#10000001', 'later layer 100 schema fix')
  await writeSnapshot(101, 'thing#10100000', 'layer 101')

  const options = parseArgs(['--td-repo', repo, '--out', output])
  const snapshots = await extractSnapshots(options)
  assert.deepEqual(snapshots.map(snapshot => [snapshot.layer, snapshot.schema.split('\n', 1)[0]]), [
    [100, 'thing#10000001 = Thing;'],
    [101, 'thing#10100000 = Thing;'],
  ])

  const manifest = await syncSchemas(options)
  assert.equal(manifest.latestLayer, 101)
  assert.equal(manifest.source, 'https://github.com/tdlib/td')
  assert.equal((await readFile(join(output, 'layer-100.tl'), 'utf8')).startsWith('thing#10000001'), true)
  assert.equal(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).sourceRevision.length, 40)
})
