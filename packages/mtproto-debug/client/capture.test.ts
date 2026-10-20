import { createElement } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCaptureQuery, queryCapture } from '../src/capture-api.js'
import type { CapturedMtprotoEvent } from '../src/types.js'
import {
  CAPTURE_FOLLOW_DELAY_MS,
  useCapturePages,
  type CaptureController,
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
/**
 * The hook is imperative, so the harness only needs a component that mounts it
 * and hands the controller back; every assertion reads the controller, which
 * stays live through refs across re-renders.
 */
function Probe(props: {
  filters: CaptureFilters
  ready: boolean
  revision: number
  capture: (value: CaptureController) => void
}) {
  props.capture(
    useCapturePages('/captures', props.filters, props.ready, props.revision),
  )
  return null
}
function harness() {
  let capture!: CaptureController
  let filters: CaptureFilters = {}
  let ready = true
  let revision = 0
  const grab = (value: CaptureController) => {
    capture = value
  }
  const view = () =>
    createElement(Probe, { filters, ready, revision, capture: grab })
  const result = render(view())
  const dispose = () => result.unmount()
  disposers.push(dispose)
  return {
    get capture() {
      return capture
    },
    setFilters(value: CaptureFilters) {
      filters = value
      result.rerender(view())
    },
    setReady(value: boolean) {
      ready = value
      result.rerender(view())
    },
    bumpRevision() {
      revision += 1
      result.rerender(view())
    },
    dispose,
  }
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
describe('capture transport', () => {
  it('loads summaries only, deduplicates detail requests and retains at most the active request/result pair', async () => {
    const { capture } = harness()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.events).toHaveLength(100)
    expect(capture.events[0].id).toBe(151)
    expect(capture.events[0].payload).toBeUndefined()
    const first = capture.events[0]
    capture.keepDetails([first.id])
    await Promise.all([capture.loadDetails(first), capture.loadDetails(first)])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(capture.details.get(151)?.payload).toEqual({
      secret: 'payload-151',
    })
    capture.keepDetails([])
    expect(capture.details.size).toBe(0)
  })
  it('accumulates older pages while keeping live following enabled', async () => {
    const { capture } = harness()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.events).toHaveLength(100)
    await capture.load('older')
    expect(capture.events[0].id).toBe(51)
    expect(capture.live).toBe(true)
    await capture.load('older')
    expect(capture.events[0].id).toBe(1)
    expect(capture.events).toHaveLength(250)
    const calls = transport.mock.calls.length
    await vi.advanceTimersByTimeAsync(2 * CAPTURE_FOLLOW_DELAY_MS)
    expect(transport).toHaveBeenCalledTimes(calls)
  })
  it('follows server-pushed revisions once per coalescing window and stops while paused', async () => {
    const { capture, bumpRevision } = harness()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport).toHaveBeenCalledTimes(1)
    // A revision with no new rows still costs one follow fetch, then settles.
    bumpRevision()
    await vi.advanceTimersByTimeAsync(CAPTURE_FOLLOW_DELAY_MS)
    expect(transport).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledTimes(2)
    // Two revisions inside one window collapse into a single request.
    rows.push(...Array.from({ length: 250 }, (_, i) => event(251 + i)))
    bumpRevision()
    bumpRevision()
    await vi.advanceTimersByTimeAsync(CAPTURE_FOLLOW_DELAY_MS)
    expect(transport).toHaveBeenCalledTimes(3)
    expect(capture.events.at(-1)?.id).toBe(350)
    // Pausing live view ignores later revisions until following resumes.
    capture.setLive(false)
    rows.push(...Array.from({ length: 50 }, (_, i) => event(501 + i)))
    bumpRevision()
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledTimes(3)
    expect(capture.live).toBe(false)
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
    const ids = capture.events.map((event) => event.id)
    resolve(Response.json({ events: [event(999)], total: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.events.map((event) => event.id)).toEqual(ids)
    expect(ids).not.toContain(999)
  })
  it('defers follow fetches while the page is hidden and recovers from a failed one', async () => {
    const { capture, bumpRevision } = harness()
    await vi.advanceTimersByTimeAsync(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    bumpRevision()
    await vi.advanceTimersByTimeAsync(3 * CAPTURE_FOLLOW_DELAY_MS)
    expect(transport).toHaveBeenCalledOnce()
    transport.mockResolvedValueOnce(new Response('failed', { status: 503 }))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.error).toContain('503')
    // The next server revision is what recovers the view; there is no timer.
    bumpRevision()
    await vi.advanceTimersByTimeAsync(CAPTURE_FOLLOW_DELAY_MS)
    expect(capture.error).toBe('')
    const count = transport.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledTimes(count)
  })
  it('expires old rows/details and suspends transport while the Muon channel reconnects', async () => {
    const { capture, setReady } = harness()
    await vi.advanceTimersByTimeAsync(0)
    const first = capture.events[0]
    capture.keepDetails([first.id])
    rows = []
    await capture.loadDetails(first)
    expect(capture.error).toContain('expired')
    expect(capture.details.size).toBe(0)
    setReady(false)
    const count = transport.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledTimes(count)
    setReady(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(transport.mock.calls.length).toBeGreaterThan(count)
  })
})
