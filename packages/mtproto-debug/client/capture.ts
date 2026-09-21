import {
  batch,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from 'solid-js'
import type { CapturedMtprotoEvent } from '../src/types.js'
import type { MtprotoCaptureSnapshot } from '../src/capture-api.js'
import { readResponse } from 'cordis-webui-solidjs/utils'
import { sameOriginPath } from 'cordis-webui-solidjs/utils'
export const CAPTURE_PAGE_SIZE = 100
export const CAPTURE_POLL_MS = 1000
export interface CaptureFilters {
  grep?: string
  typeName?: string
  excludeName?: string
  direction?: string
  phase?: string
  connectionId?: string
  field?: string
  since?: string
}
export function useCapturePages(
  endpoint: Accessor<string | undefined>,
  filters: Accessor<CaptureFilters>,
  enabled: Accessor<boolean>,
) {
  const [events, setEvents] = createSignal<CapturedMtprotoEvent[]>([]),
    [snapshot, setSnapshot] = createSignal<MtprotoCaptureSnapshot>()
  const [loading, setLoading] = createSignal(false),
    [error, setError] = createSignal(''),
    [live, setLive] = createSignal(true)
  const [details, setDetails] = createSignal(
    new Map<number, CapturedMtprotoEvent>(),
  )
  const controllers = new Set<AbortController>(),
    detailJobs = new Map<number, Promise<void>>()
  let active = true,
    generation = 0,
    cursor: number | undefined,
    initial = true,
    wantedDetails = new Set<number>()
  let timer: ReturnType<typeof setTimeout> | undefined,
    debounce: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    generation++
    for (const controller of controllers) controller.abort()
    controllers.clear()
    detailJobs.clear()
    clearTimeout(timer)
    setLoading(false)
  }
  const request = async (
    params: URLSearchParams,
    detail = false,
  ): Promise<MtprotoCaptureSnapshot> => {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const url = new URL(sameOriginPath(endpoint()!))
      url.search = params.toString()
      const response = await fetch(url.href, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok)
        throw new Error('Capture request failed: HTTP ' + response.status)
      const result = await readResponse(
        response,
        detail ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
      )
      if (result.truncated)
        throw new Error(
          detail
            ? 'This payload exceeds the 8 MiB preview budget. Use the raw event link to inspect it separately.'
            : 'This summary page exceeds the 2 MiB preview budget.',
        )
      const parsed = JSON.parse(result.text) as MtprotoCaptureSnapshot
      if (!Array.isArray(parsed.events))
        throw new Error('Invalid capture response')
      return parsed
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  const schedule = () => {
    clearTimeout(timer)
    if (active && enabled() && live() && !document.hidden)
      timer = setTimeout(
        () => void load('poll'),
        snapshot()?.hasNewer ? 150 : CAPTURE_POLL_MS,
      )
  }
  async function load(mode: 'latest' | 'older' | 'newer' | 'poll' = 'latest') {
    if (!active || !enabled() || !endpoint() || (mode === 'poll' && loading()))
      return
    if (mode !== 'poll') {
      cancel()
      setLive(mode === 'latest')
    }
    const current = generation
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      limit: String(CAPTURE_PAGE_SIZE),
      summary: 'true',
    })
    for (const [key, value] of Object.entries(filters()))
      if (value?.trim()) params.set(key, value.trim())
    if (mode === 'older' && events()[0])
      params.set('beforeId', String(events()[0].id))
    if (mode === 'newer' && events().at(-1))
      params.set('afterId', String(events().at(-1)!.id))
    if (mode === 'poll' && cursor !== undefined)
      params.set('afterId', String(cursor))
    try {
      const result = await request(params)
      if (!active || current !== generation) return
      batch(() => {
        if (mode === 'poll') {
          const retained = events().filter(
            (event) =>
              result.oldestId !== undefined && event.id >= result.oldestId,
          )
          const rows = new Map(retained.map((event) => [event.id, event]))
          for (const event of result.events) rows.set(event.id, event)
          setEvents(
            [...rows.values()]
              .sort((a, b) => a.id - b.id)
              .slice(-CAPTURE_PAGE_SIZE),
          )
        } else setEvents(result.events.slice(-CAPTURE_PAGE_SIZE))
        cursor = result.hasNewer ? result.events.at(-1)?.id : result.newestId
        setSnapshot(
          mode === 'poll' && events().length && result.oldestId !== undefined
            ? { ...result, hasOlder: events()[0].id > result.oldestId }
            : result,
        )
        const visible = new Set(events().map((event) => event.id))
        setDetails(
          (value) =>
            new Map(
              [...value].filter(
                ([id]) => visible.has(id) && wantedDetails.has(id),
              ),
            ),
        )
      })
    } catch (cause) {
      if (active && current === generation)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active && current === generation) {
        setLoading(false)
        schedule()
      }
    }
  }
  function keepDetails(ids: number[]) {
    wantedDetails = new Set(ids.slice(0, 2))
    setDetails(
      (value) => new Map([...value].filter(([id]) => wantedDetails.has(id))),
    )
  }
  async function loadDetails(event: CapturedMtprotoEvent): Promise<void> {
    if (!event.payloadOmitted || details().has(event.id)) return
    if (detailJobs.has(event.id)) return detailJobs.get(event.id)
    const current = generation
    const task = (async () => {
      try {
        const result = await request(
          new URLSearchParams({ id: String(event.id), limit: '1' }),
          true,
        )
        if (!active || current !== generation || !wantedDetails.has(event.id))
          return
        const detail = result.events.find((item) => item.id === event.id)
        if (!detail)
          throw new Error('This event has expired from the capture buffer.')
        setDetails((value) => new Map(value).set(event.id, detail))
      } catch (cause) {
        if (active && current === generation && wantedDetails.has(event.id))
          setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    detailJobs.set(event.id, task)
    await task
    if (detailJobs.get(event.id) === task) detailJobs.delete(event.id)
  }
  createEffect(() => {
    const ready = enabled(),
      path = endpoint()
    JSON.stringify(filters())
    untrack(() => {
      cancel()
      clearTimeout(debounce)
      if (!ready || !path) return
      setEvents([])
      setDetails(new Map())
      wantedDetails.clear()
      cursor = undefined
      setSnapshot(undefined)
      setError('')
      debounce = setTimeout(() => void load('latest'), initial ? 0 : 200)
      initial = false
    })
  })
  const visibility = () => {
    if (document.hidden) {
      clearTimeout(timer)
    } else if (live()) void load('poll')
  }
  document.addEventListener('visibilitychange', visibility)
  onCleanup(() => {
    active = false
    cancel()
    clearTimeout(debounce)
    document.removeEventListener('visibilitychange', visibility)
    wantedDetails.clear()
  })
  const setLiveMode = (value: boolean) => {
    setLive(value)
    if (value) void load('latest')
    else clearTimeout(timer)
  }
  return {
    events,
    snapshot,
    loading,
    error,
    live,
    details,
    load,
    loadDetails,
    keepDetails,
    setLive: setLiveMode,
  }
}
