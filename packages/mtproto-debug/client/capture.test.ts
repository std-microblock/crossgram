import { createRoot, createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseCaptureQuery,
  queryCapture,
} from '../src/capture-api.js'
import type { CapturedMtprotoEvent } from '../src/types.js'
import {
  CAPTURE_POLL_MS,
  useCapturePages,
  type CaptureFilters,
} from './capture.js'
let rows: CapturedMtprotoEvent[], transport: ReturnType<typeof vi.fn>
const disposers: (() => void)[] = []
const event = (id: number): CapturedMtprotoEvent => ({
  id,
  timestamp: id,
  direction: 'client->server',
  phase: 'message',
  connectionId: 'test',
  name: 'method.' + id,
  searchText: 'private payload-' + id,
  payload: { secret: 'payload-' + id },
})
function harness() {
  const [filters, setFilters] = createSignal<CaptureFilters>({}),
    [ready, setReady] = createSignal(true)
  let capture!: ReturnType<typeof useCapturePages>
  createRoot((dispose) => {
    disposers.push(dispose)
    capture = useCapturePages(() => '/captures', filters, ready)
  })
  return { capture, setFilters, setReady, dispose: disposers.at(-1)! }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  rows = Array.from({ length: 250 }, (_, i) => event(i + 1))
  transport = vi.fn(async (url: string) =>
    Response.json(
      queryCapture(
        { capturing: true, dropped: 0, maxEvents: 2000, events: rows },
        parseCaptureQuery(new URL(url).searchParams),
      ),
    ),
  )
  vi.stubGlobal('fetch', transport)
})
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('Solid capture transport', () => {
  it('loads summaries only, deduplicates detail requests and retains at most the active request/result pair', async () => {
    const { capture } = harness()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.events()).toHaveLength(100)
    expect(capture.events()[0].id).toBe(151)
    expect(capture.events()[0].payload).toBeUndefined()
    const first = capture.events()[0]
    capture.keepDetails([first.id])
    await Promise.all([capture.loadDetails(first), capture.loadDetails(first)])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(capture.details().get(151)?.payload).toEqual({
      secret: 'payload-151',
    })
    capture.keepDetails([])
    expect(capture.details().size).toBe(0)
  })
  it('pages backwards and forwards, and consumes bursts without skipping the first forward page', async () => {
    const { capture } = harness()
    await vi.advanceTimersByTimeAsync(0)
    await capture.load('older')
    expect(capture.events()[0].id).toBe(51)
    expect(capture.live()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * CAPTURE_POLL_MS)
    expect(transport).toHaveBeenCalledTimes(2)
    await capture.load('newer')
    expect(capture.events()[0].id).toBe(151)
    await capture.load('latest')
    rows.push(...Array.from({ length: 250 }, (_, i) => event(251 + i)))
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(capture.events().at(-1)?.id).toBe(350)
    await vi.advanceTimersByTimeAsync(150)
    expect(capture.events().at(-1)?.id).toBe(450)
    await vi.advanceTimersByTimeAsync(150)
    expect(capture.events().at(-1)?.id).toBe(500)
    expect(capture.events()).toHaveLength(100)
  })
  it('aborts stale filter requests and never accepts their late responses', async () => {
    let resolve!: (response: Response) => void, signal!: AbortSignal
    transport.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal!
      return new Promise<Response>((done) => {
        resolve = done
      })
    })
    const { capture, setFilters } = harness()
    await vi.advanceTimersByTimeAsync(0)
    setFilters({ grep: 'payload-1' })
    await vi.advanceTimersByTimeAsync(200)
    expect(signal.aborted).toBe(true)
    const ids = capture.events().map((event) => event.id)
    resolve(Response.json({ events: [event(999)], total: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.events().map((event) => event.id)).toEqual(ids)
    expect(ids).not.toContain(999)
  })
  it('stops polling in hidden pages and on disposal, then recovers from a failed poll', async () => {
    const { capture, dispose } = harness()
    await vi.advanceTimersByTimeAsync(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(3 * CAPTURE_POLL_MS)
    expect(transport).toHaveBeenCalledOnce()
    transport.mockResolvedValueOnce(new Response('failed', { status: 503 }))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.error()).toContain('503')
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(capture.error()).toBe('')
    dispose()
    const count = transport.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledTimes(count)
  })
  it('expires old rows/details and suspends transport while the Muon channel reconnects', async () => {
    const { capture, setReady } = harness()
    await vi.advanceTimersByTimeAsync(0)
    const first = capture.events()[0]
    capture.keepDetails([first.id])
    rows = []
    await capture.loadDetails(first)
    expect(capture.error()).toContain('expired')
    expect(capture.details().size).toBe(0)
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(capture.events()).toEqual([])
    setReady(false)
    const count = transport.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledTimes(count)
    setReady(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(transport.mock.calls.length).toBeGreaterThan(count)
  })
})
