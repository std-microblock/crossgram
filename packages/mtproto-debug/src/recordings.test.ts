import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRecordingId, isRecordingId, normalizeRecordingLabel, RecordingError, RecordingStore,
  RECORDING_FORMAT, RECORDING_VERSION, resolveConfiguredPath,
} from './recordings.js'
import type { CapturedMtprotoEvent } from './types.js'

const temporaryDirectories: string[] = []

async function temporaryStore(maxRecordings = 50) {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-recordings-'))
  temporaryDirectories.push(directory)
  return { directory, store: new RecordingStore(directory, maxRecordings) }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function event(id: number): CapturedMtprotoEvent {
  return {
    id,
    timestamp: 1_700_000_000_000 + id,
    direction: 'client->server',
    phase: 'message',
    connectionId: 'conn-1',
    name: 'messages.sendMessage',
    messageId: '0x' + id.toString(16),
    payload: { _: 'messages.sendMessage', peer: { userId: id }, message: 'hello-' + id },
    searchText: 'private-search-' + id,
  }
}

function input(events: CapturedMtprotoEvent[], label?: unknown) {
  return { events, capturing: true, dropped: 2, maxEvents: 2_000, ...(label === undefined ? {} : { label }) }
}

async function expectRecordingError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(RecordingError)
  expect((error as RecordingError).status).toBe(status)
  if (message) expect((error as RecordingError).message).toMatch(message)
  return error as RecordingError
}

describe('MTProto capture recordings', () => {
  it('creates timestamped, filesystem-safe recording ids', () => {
    const id = createRecordingId(Date.UTC(2026, 9, 20, 10, 5, 0, 123), () => 'abcdef')
    expect(id).toBe('mtproto-20261020-100500-123-abcdef')
    expect(isRecordingId(id)).toBe(true)
    expect(isRecordingId('mtproto-20261020-100500-123-abcde')).toBe(false)
    expect(isRecordingId('../etc/passwd')).toBe(false)
    expect(() => createRecordingId(Date.now(), () => 'not-hex')).toThrow(/Invalid recording id/)
  })

  it('normalizes labels and rejects non-string or oversized labels', () => {
    expect(normalizeRecordingLabel(undefined)).toBeUndefined()
    expect(normalizeRecordingLabel('   ')).toBeUndefined()
    expect(normalizeRecordingLabel('  Nightly\u0000  repro\n case ')).toBe('Nightly repro case')
    expect(normalizeRecordingLabel('x'.repeat(120))).toHaveLength(120)
    expect(() => normalizeRecordingLabel('x'.repeat(121))).toThrow(/at most 120/)
    expect(() => normalizeRecordingLabel(42)).toThrow(/must be a string/)
  })

  it('writes a self-describing recording and its listing metadata', async () => {
    const { directory, store } = await temporaryStore()
    const now = Date.UTC(2026, 9, 20, 10, 5, 0, 123)
    const summary = await store.save(input([event(1), event(2)], '  Nightly   repro '), now)

    expect(summary.id).toMatch(/^mtproto-20261020-100500-123-[0-9a-f]{6}$/)
    expect(summary).toMatchObject({
      label: 'Nightly repro',
      createdAt: now,
      eventCount: 2,
      dropped: 2,
      maxEvents: 2_000,
      firstTimestamp: 1_700_000_000_001,
      lastTimestamp: 1_700_000_000_002,
    })
    expect(summary.bytes).toBeGreaterThan(0)

    const text = await readFile(join(directory, summary.id + '.json'), 'utf8')
    expect(Buffer.byteLength(text)).toBe(summary.bytes)
    const recording = JSON.parse(text)
    expect(recording).toMatchObject({
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      createdAt: now,
      label: 'Nightly repro',
      capturing: true,
      dropped: 2,
      maxEvents: 2_000,
    })
    expect(recording.events).toHaveLength(2)
    expect(recording.events[0]).toMatchObject({
      name: 'messages.sendMessage',
      payload: { message: 'hello-1' },
      searchText: 'private-search-1',
    })
    expect(JSON.parse(await readFile(join(directory, summary.id + '.meta.json'), 'utf8'))).toEqual(summary)
    expect(await store.list()).toEqual([summary])
  })

  it('lists newest first, reads, downloads and deletes recordings', async () => {
    const { directory, store } = await temporaryStore()
    const now = Date.UTC(2026, 9, 20, 10, 5, 0, 123)
    const older = await store.save(input([event(1)]), now)
    const newer = await store.save(input([event(2), event(3)]), now + 1_000)

    expect((await store.list()).map(item => item.id)).toEqual([newer.id, older.id])
    expect((await store.read(newer.id)).events.map(item => item.id)).toEqual([2, 3])
    expect(await store.readText(older.id)).toContain('hello-1')

    await store.remove(older.id)
    const files = (await readdir(directory)).sort()
    expect(files).toEqual([newer.id + '.json', newer.id + '.meta.json'])
    await expectRecordingError(store.read(older.id), 404, /not found/)
    await expectRecordingError(store.remove(older.id), 404, /not found/)
    await expectRecordingError(store.read('../secret'), 400, /Invalid recording id/)
  })

  it('prunes the oldest recordings past the retained limit', async () => {
    const { directory, store } = await temporaryStore(2)
    const now = Date.UTC(2026, 9, 20, 10, 5, 0, 123)
    const first = await store.save(input([event(1)]), now)
    const second = await store.save(input([event(2)]), now + 1_000)
    const third = await store.save(input([event(3)]), now + 2_000)

    expect((await store.list()).map(item => item.id)).toEqual([third.id, second.id])
    await expectRecordingError(store.read(first.id), 404, /not found/)
    expect((await readdir(directory)).sort()).toEqual([
      second.id + '.json', second.id + '.meta.json',
      third.id + '.json', third.id + '.meta.json',
    ])
  })

  it('refuses to save an empty capture', async () => {
    const { store } = await temporaryStore()
    await expectRecordingError(store.save(input([])), 409, /No captured events/)
  })

  it('skips corrupt listing metadata instead of breaking the list', async () => {
    const { directory, store } = await temporaryStore()
    const summary = await store.save(input([event(1)]))
    await writeFile(join(directory, 'mtproto-20261020-100500-123-abcdef.meta.json'), '{not json')
    await writeFile(join(directory, 'mtproto-20261020-100500-124-abcdef.meta.json'), JSON.stringify(summary))
    expect(await store.list()).toEqual([summary])
  })

  it('rejects files that are not recordings', async () => {
    const { directory, store } = await temporaryStore()
    const id = 'mtproto-20261020-100500-123-abcdef'
    await writeFile(join(directory, id + '.json'), '{broken')
    await expectRecordingError(store.read(id), 500, /not valid JSON/)
    await writeFile(join(directory, id + '.json'), JSON.stringify({ format: 'other', events: [] }))
    await expectRecordingError(store.read(id), 500, /unsupported format/)
  })

  it('resolves configured recording paths against the config base URL', () => {
    expect(resolveConfiguredPath(undefined, './data/recordings')).toBe(resolve('data/recordings'))
    expect(resolveConfiguredPath('http://example.test/app.yml', './data/recordings')).toBe(resolve('data/recordings'))
    const base = pathToFileURL(join(process.cwd(), 'app.yml')).href
    expect(resolveConfiguredPath(base, './data/recordings')).toBe(resolve('data/recordings'))
    const absolute = resolve('data/elsewhere')
    expect(resolveConfiguredPath(undefined, absolute)).toBe(absolute)
  })
})
