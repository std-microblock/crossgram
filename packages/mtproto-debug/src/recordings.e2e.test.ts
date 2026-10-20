import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import WebUI from 'cordis-webui-react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import * as debug from './index.js'
import { RECORDING_FORMAT, RECORDING_VERSION } from './recordings.js'

async function startCapture(options: {
  maxRecordings?: number
  recordingsApiPath?: string
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-recording-e2e-'))
  const ctx = new Context()
  const disposeMtproto = ctx.provide('mtproto', {} as never)
  await Promise.resolve(disposeMtproto as any)
  const fibers = [
    ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(WebUI, { uiPath: '', apiPath: '/api' }),
    ctx.plugin(debug, {
      maxEvents: 100,
      recordingsPath: directory,
      ...(options.maxRecordings === undefined ? {} : { maxRecordings: options.maxRecordings }),
      ...(options.recordingsApiPath === undefined ? {} : { recordingsApiPath: options.recordingsApiPath }),
    }),
  ]
  await Promise.all(fibers)
  await new Promise(resolve => setTimeout(resolve, 100))
  return {
    ctx,
    directory,
    recordings: new URL(options.recordingsApiPath ?? '/api/mtproto-debug/recordings', ctx.server.baseUrl),
    emit(name: string, payload: Record<string, unknown> = {}, timestamp = Date.now()) {
      ctx.emit('mtproto/debug', {
        direction: 'client->server',
        phase: 'message',
        connectionId: 'conn-e2e',
        timestamp,
        messageId: '0x' + Number(timestamp).toString(16),
        payload: { _: name, ...payload },
      } satisfies MtprotoDebugEvent)
    },
    async dispose() {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
      await Promise.resolve(disposeMtproto())
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function save(recordings: URL, label?: unknown) {
  const response = await fetch(recordings, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(label === undefined ? {} : { label }),
  })
  return { response, body: await response.json() as any }
}

describe('MTProto capture recordings HTTP API e2e', () => {
  it('saves the live buffer to disk, lists and downloads it, then deletes it', async () => {
    const capture = await startCapture()
    try {
      const empty = await fetch(capture.recordings)
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({ recordings: [] })

      capture.emit('messages.sendMessage', { peer: { channelId: 42 }, message: 'hello recording' }, 1_700_000_000_000)
      capture.emit('messages.getHistory', { peer: { _: 'inputPeerSelf' } }, 1_700_000_000_100)
      const saved = await save(capture.recordings, '  e2e   capture ')
      expect(saved.response.status).toBe(201)
      expect(saved.response.headers.get('cache-control')).toBe('no-store')
      const summary = saved.body.recording
      expect(summary).toMatchObject({
        label: 'e2e capture',
        eventCount: 2,
        dropped: 0,
        maxEvents: 100,
        firstTimestamp: 1_700_000_000_000,
        lastTimestamp: 1_700_000_000_100,
      })
      expect(summary.id).toMatch(/^mtproto-\d{8}-\d{6}-\d{3}-[0-9a-f]{6}$/)
      expect(summary.bytes).toBeGreaterThan(0)

      const text = await readFile(join(capture.directory, summary.id + '.json'), 'utf8')
      const recording = JSON.parse(text)
      expect(recording).toMatchObject({
        format: RECORDING_FORMAT,
        version: RECORDING_VERSION,
        label: 'e2e capture',
        capturing: true,
        dropped: 0,
        maxEvents: 100,
      })
      expect(recording.events).toHaveLength(2)
      expect(recording.events[0]).toMatchObject({
        name: 'messages.sendMessage',
        connectionId: 'conn-e2e',
        payload: { message: 'hello recording' },
        searchText: expect.stringContaining('hello recording'),
      })

      const list = await fetch(capture.recordings)
      expect(await list.json()).toEqual({ recordings: [summary] })

      const download = await fetch(new URL(summary.id, capture.recordings + '/'))
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${summary.id}.json"`)
      expect(download.headers.get('cache-control')).toBe('no-store')
      expect(await download.text()).toBe(text)

      const removed = await fetch(new URL(summary.id, capture.recordings + '/'), { method: 'DELETE' })
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ deleted: summary.id })
      expect(await (await fetch(capture.recordings)).json()).toEqual({ recordings: [] })
      const again = await fetch(new URL(summary.id, capture.recordings + '/'), { method: 'DELETE' })
      expect(again.status).toBe(404)
    } finally {
      await capture.dispose()
    }
  })

  it('validates requests and rejects saving an empty buffer', async () => {
    const capture = await startCapture()
    try {
      const noEvents = await save(capture.recordings)
      expect(noEvents.response.status).toBe(409)
      expect(noEvents.body).toEqual({ error: 'No captured events to save' })

      capture.emit('messages.getDialogs')
      const badLabel = await save(capture.recordings, 42)
      expect(badLabel.response.status).toBe(400)
      expect(badLabel.body.error).toMatch(/must be a string/)

      const malformed = await fetch(capture.recordings, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'Invalid recording request body' })

      const invalidId = await fetch(new URL('not-a-recording', capture.recordings + '/'))
      expect(invalidId.status).toBe(400)
      const missing = await fetch(new URL('mtproto-20261020-100500-123-abcdef', capture.recordings + '/'))
      expect(missing.status).toBe(404)
    } finally {
      await capture.dispose()
    }
  })

  it('keeps only the newest recordings and honours a custom API path', async () => {
    const capture = await startCapture({ maxRecordings: 2, recordingsApiPath: '/api/capture-recordings' })
    try {
      capture.emit('messages.getDialogs')
      const first = (await save(capture.recordings, 'first')).body.recording
      await new Promise(resolve => setTimeout(resolve, 3))
      const second = (await save(capture.recordings, 'second')).body.recording
      await new Promise(resolve => setTimeout(resolve, 3))
      const third = (await save(capture.recordings, 'third')).body.recording

      const list = await (await fetch(capture.recordings)).json() as { recordings: Array<{ id: string }> }
      expect(list.recordings.map(item => item.id)).toEqual([third.id, second.id])
      const pruned = await fetch(new URL(first.id, capture.recordings + '/'))
      expect(pruned.status).toBe(404)
    } finally {
      await capture.dispose()
    }
  })
})
