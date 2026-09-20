// @vitest-environment happy-dom
import { defineComponent, h, ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCaptureQuery, queryCapture } from '../src/capture-api.js'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import { CAPTURE_POLL_MS, useCapturePages } from './capture.js'

enableAutoUnmount(afterEach)
let rows: CapturedMtprotoEvent[]
let transport: ReturnType<typeof vi.fn>
const makeEvent = (id: number): CapturedMtprotoEvent => ({
  id, timestamp: id, direction: 'client->server', phase: 'message', connectionId: 'test',
  name: 'call.' + id, payload: { private: 'payload-' + id }, searchText: 'payload-' + id,
})

function harness() {
  let capture!: ReturnType<typeof useCapturePages>
  const filter = ref('')
  const wrapper = mount(defineComponent({
    setup() {
      const data = ref<MtprotoDebugData>({ apiPath: '/captures', capturing: true, dropped: 0, maxEvents: 2000,
        start: async () => {}, pause: async () => {}, clear: async () => {} })
      capture = useCapturePages(data, filter, ref())
      return () => h('div')
    },
  }))
  return { wrapper, filter, get capture() { return capture } }
}

beforeEach(() => {
  vi.useFakeTimers()
  rows = Array.from({ length: 250 }, (_, index) => makeEvent(index + 1))
  transport = vi.fn(async (input: string) => ({ ok: true,
    json: async () => queryCapture({ capturing: true, dropped: 0, maxEvents: 2000, events: rows },
      parseCaptureQuery(new URL(input, 'http://localhost').searchParams)),
  }))
  vi.stubGlobal('fetch', transport)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('page-scoped capture transport', () => {
  it('only fetches one summary page on mount and details only when requested', async () => {
    const h = harness()
    await flushPromises()
    expect(transport).toHaveBeenCalledOnce()
    expect(h.capture.events.value).toHaveLength(100)
    expect(h.capture.events.value[0].id).toBe(151)
    expect(h.capture.events.value[0].payload).toBeUndefined()
    await h.capture.loadDetails(h.capture.events.value[0])
    expect(h.capture.details.value.get(151)?.payload).toEqual({ private: 'payload-151' })
    await h.capture.loadDetails(h.capture.events.value[0])
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('pages backward/forward, pauses live polling in history, and stays bounded', async () => {
    const h = harness()
    await flushPromises()
    await h.capture.load('older')
    expect(h.capture.events.value.map(event => event.id)).toEqual(Array.from({ length: 100 }, (_, i) => i + 51))
    expect(h.capture.live.value).toBe(false)
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS * 3)
    expect(transport).toHaveBeenCalledTimes(2)
    await h.capture.load('newer')
    expect(h.capture.events.value[0].id).toBe(151)
    await h.capture.load('latest')
    rows.push(...Array.from({ length: 220 }, (_, i) => makeEvent(i + 251)))
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(h.capture.events.value[0].id).toBe(251)
    expect(h.capture.events.value.at(-1)?.id).toBe(350)
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(h.capture.events.value.at(-1)?.id).toBe(450)
    expect(h.capture.events.value).toHaveLength(100)
  })

  it('aborts pending requests and stops timers on unmount', async () => {
    let signal!: AbortSignal
    transport.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const h = harness()
    h.wrapper.unmount()
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS * 3)
    expect(transport).toHaveBeenCalledOnce()
  })

  it('ignores stale responses after a search and aborts the previous request', async () => {
    let resolveOld!: (value: unknown) => void
    let signal!: AbortSignal
    transport.mockImplementationOnce((_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(resolve => { resolveOld = resolve })
    })
    const h = harness()
    h.filter.value = 'payload-1'
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(signal.aborted).toBe(true)
    const expected = h.capture.events.value.map(event => event.id)
    resolveOld({ ok: true, json: async () => ({ events: [makeEvent(999)], total: 1 }) })
    await flushPromises()
    expect(h.capture.events.value.map(event => event.id)).toEqual(expected)
    expect(expected).not.toContain(999)
  })

  it('suppresses polling in background tabs and recovers from HTTP failures', async () => {
    const h = harness()
    await flushPromises()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS * 2)
    expect(transport).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
    transport.mockResolvedValueOnce({ ok: false, status: 503 })
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(h.capture.error.value).toContain('503')
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(h.capture.error.value).toBe('')
    expect(h.capture.snapshot.value?.hasOlder).toBe(true)
  })

  it('removes expired rows and reports expired detail requests without caching them', async () => {
    const h = harness()
    await flushPromises()
    const event = h.capture.events.value[0]
    rows = []
    await h.capture.loadDetails(event)
    expect(h.capture.error.value).toContain('expired')
    expect(h.capture.details.value.size).toBe(0)
    await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS)
    expect(h.capture.events.value).toEqual([])
  })
})
