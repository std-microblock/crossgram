import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteRecording,
  listRecordings,
  recordingDownloadUrl,
  saveRecording,
} from './recordings.js'
const endpoint = '/api/mtproto-debug/recordings'
const id = 'mtproto-20261020-100000-000-abcdef'
const summary = {
  id,
  label: 'e2e-recording',
  createdAt: 1_760_000_000_000,
  eventCount: 2,
  dropped: 0,
  maxEvents: 2_000,
  firstTimestamp: 1_760_000_000_000,
  lastTimestamp: 1_760_000_000_120,
  bytes: 128,
}
const absolute = (path: string) => new URL(path, location.href).href
let transport: ReturnType<typeof vi.fn>
beforeEach(() => {
  transport = vi.fn()
  vi.stubGlobal('fetch', transport)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('recordings transport', () => {
  it('lists recordings from the same-origin endpoint', async () => {
    transport.mockResolvedValue(Response.json({ recordings: [summary] }))
    await expect(listRecordings(endpoint)).resolves.toEqual([summary])
    expect(transport).toHaveBeenCalledTimes(1)
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe(absolute(endpoint))
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    expect(init.signal).toBeDefined()
  })
  it('saves a trimmed label as a JSON body', async () => {
    transport.mockResolvedValue(
      Response.json({ recording: summary }, { status: 201 }),
    )
    await expect(saveRecording(endpoint, '  e2e-recording  ')).resolves.toEqual(
      summary,
    )
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe(absolute(endpoint))
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ label: 'e2e-recording' })
  })
  it('omits an empty label from the request body', async () => {
    transport.mockResolvedValue(Response.json({ recording: summary }))
    await saveRecording(endpoint, '   ')
    expect(JSON.parse(transport.mock.calls[0][1].body as string)).toEqual({})
  })
  it('surfaces the server error message instead of the status', async () => {
    transport.mockResolvedValue(
      Response.json(
        { error: 'No captured events to save' },
        { status: 409 },
      ),
    )
    await expect(saveRecording(endpoint, 'x')).rejects.toThrow(
      'No captured events to save',
    )
  })
  it('falls back to the HTTP status for a non-JSON error body', async () => {
    transport.mockResolvedValue(new Response('bad gateway', { status: 502 }))
    await expect(listRecordings(endpoint)).rejects.toThrow(
      'Could not load recordings: HTTP 502 (bad gateway)',
    )
  })
  it('rejects a success payload that does not match the contract', async () => {
    transport.mockResolvedValue(Response.json({ ok: true }))
    await expect(listRecordings(endpoint)).rejects.toThrow('invalid response')
  })
  it('deletes by encoded id and returns the deleted id', async () => {
    transport.mockResolvedValue(Response.json({ deleted: id }))
    await expect(deleteRecording(endpoint, id)).resolves.toBe(id)
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe(absolute(endpoint + '/' + id))
    expect(init.method).toBe('DELETE')
  })
  it('builds download URLs on the same endpoint', () => {
    expect(recordingDownloadUrl(endpoint, id)).toBe(absolute(endpoint + '/' + id))
    expect(recordingDownloadUrl(endpoint + '/', 'a b/c')).toBe(
      absolute(endpoint + '/' + encodeURIComponent('a b/c')),
    )
  })
  it('aborts a stalled request after the timeout budget', async () => {
    vi.useFakeTimers()
    transport.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    const pending = saveRecording(endpoint)
    const assertion = expect(pending).rejects.toThrow('request timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })
})
