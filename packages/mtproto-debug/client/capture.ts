import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapturedMtprotoEvent } from '../src/types.js'
import type { MtprotoCaptureSnapshot } from '../src/capture-api.js'
import { readResponse, sameOriginPath } from 'cordis-webui-react/utils'
export const CAPTURE_PAGE_SIZE = 100
/**
 * Coalescing window for server-pushed capture revisions. The server bumps the
 * Muon `revision` field after each flush; the page waits this long before
 * fetching so a burst collapses into one request. There is no periodic timer.
 */
export const CAPTURE_FOLLOW_DELAY_MS = 250
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
export type CaptureMode = 'latest' | 'older' | 'follow'
/**
 * The capture session is imperative (abortable requests, a detail cache) but
 * every value a page renders is exposed as a plain property. The setters below
 * mirror each React state into a ref, so async work that happens between
 * renders always reads the value it just produced; the state copy is what makes
 * React re-render.
 */
export interface CaptureController {
  readonly events: CapturedMtprotoEvent[]
  readonly snapshot: MtprotoCaptureSnapshot | undefined
  readonly loading: boolean
  readonly error: string
  readonly live: boolean
  readonly details: ReadonlyMap<number, CapturedMtprotoEvent>
  /** Reload the window (or page it with `older`/`newer`); `follow` appends. */
  load(mode?: CaptureMode): Promise<void>
  loadDetails(event: CapturedMtprotoEvent): Promise<void>
  /** Only these ids keep their fetched payload across the next window change. */
  keepDetails(ids: number[]): void
  /** Follow server-pushed revisions, or stop following entirely. */
  setLive(value: boolean): void
}
export function useCapturePages(
  endpoint: string | undefined,
  filters: CaptureFilters,
  enabled: boolean,
  revision: number,
): CaptureController {
  const [events, setEventsState] = useState<CapturedMtprotoEvent[]>([])
  const [snapshot, setSnapshotState] = useState<MtprotoCaptureSnapshot>()
  const [loading, setLoadingState] = useState(false)
  const [error, setErrorState] = useState('')
  const [live, setLiveState] = useState(true)
  const [details, setDetailsState] = useState<
    Map<number, CapturedMtprotoEvent>
  >(() => new Map())
  const eventsRef = useRef(events),
    snapshotRef = useRef(snapshot),
    loadingRef = useRef(loading),
    errorRef = useRef(error),
    liveRef = useRef(live),
    detailsRef = useRef(details)
  const setEvents = useCallback((next: CapturedMtprotoEvent[]) => {
    eventsRef.current = next
    setEventsState(next)
  }, [])
  const setSnapshot = useCallback(
    (next: MtprotoCaptureSnapshot | undefined) => {
      snapshotRef.current = next
      setSnapshotState(next)
    },
    [],
  )
  const setLoading = useCallback((next: boolean) => {
    loadingRef.current = next
    setLoadingState(next)
  }, [])
  const setError = useCallback((next: string) => {
    errorRef.current = next
    setErrorState(next)
  }, [])
  const setLiveValue = useCallback((next: boolean) => {
    liveRef.current = next
    setLiveState(next)
  }, [])
  const setDetails = useCallback(
    (
      next:
        | Map<number, CapturedMtprotoEvent>
        | ((
            value: Map<number, CapturedMtprotoEvent>,
          ) => Map<number, CapturedMtprotoEvent>),
    ) => {
      const value = typeof next === 'function' ? next(detailsRef.current) : next
      detailsRef.current = value
      setDetailsState(value)
    },
    [],
  )
  // Always read the latest inputs from async callbacks and timers.
  const endpointRef = useRef(endpoint),
    filtersRef = useRef(filters),
    enabledRef = useRef(enabled)
  endpointRef.current = endpoint
  filtersRef.current = filters
  enabledRef.current = enabled
  const controllers = useRef(new Set<AbortController>()),
    detailJobs = useRef(new Map<number, Promise<void>>())
  const active = useRef(true),
    generation = useRef(0),
    initial = useRef(true)
  const cursor = useRef<number | undefined>(undefined),
    wantedDetails = useRef(new Set<number>())
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    followPending = useRef(false),
    lastRevision = useRef(revision)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancel = useCallback(() => {
    generation.current++
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
    detailJobs.current.clear()
    clearTimeout(followTimer.current)
    followPending.current = false
    setLoading(false)
  }, [setLoading])
  const request = useCallback(
    async (
      params: URLSearchParams,
      detail = false,
    ): Promise<MtprotoCaptureSnapshot> => {
      const controller = new AbortController()
      controllers.current.add(controller)
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        const url = new URL(sameOriginPath(endpointRef.current!))
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
        controllers.current.delete(controller)
      }
    },
    [],
  )
  const loadRef = useRef<(mode?: CaptureMode) => Promise<void>>(async () => {})
  /** One follow fetch per coalescing window, and only while following. */
  const scheduleFollow = useCallback(() => {
    if (
      !active.current ||
      !enabledRef.current ||
      !liveRef.current ||
      document.hidden
    )
      return
    if (loadingRef.current) {
      // Finish the in-flight page first; the newest revision stays pending.
      followPending.current = true
      return
    }
    clearTimeout(followTimer.current)
    followTimer.current = setTimeout(
      () => void loadRef.current('follow'),
      CAPTURE_FOLLOW_DELAY_MS,
    )
  }, [])
  const load = useCallback(
    async (mode: CaptureMode = 'latest') => {
      if (
        !active.current ||
        !enabledRef.current ||
        !endpointRef.current ||
        (mode === 'follow' && loadingRef.current)
      )
        return
      if (mode !== 'follow') {
        cancel()
        if (mode === 'latest') setLiveValue(true)
      }
      const current = generation.current
      setLoading(true)
      setError('')
      const params = new URLSearchParams({
        limit: String(CAPTURE_PAGE_SIZE),
        summary: 'true',
      })
      for (const [key, value] of Object.entries(filtersRef.current))
        if (value?.trim()) params.set(key, value.trim())
      const rows = eventsRef.current
      if (mode === 'older' && rows[0])
        params.set('beforeId', String(rows[0].id))
      if (mode === 'follow' && cursor.current !== undefined)
        params.set('afterId', String(cursor.current))
      try {
        const result = await request(params)
        if (!active.current || current !== generation.current) return
        if (mode === 'follow') {
          const retained = eventsRef.current.filter(
            (event) =>
              result.oldestId !== undefined && event.id >= result.oldestId,
          )
          const merged = new Map(retained.map((event) => [event.id, event]))
          for (const event of result.events) merged.set(event.id, event)
          setEvents([...merged.values()].sort((a, b) => a.id - b.id))
        } else if (mode === 'older') {
          // Infinite scroll accumulates older pages instead of replacing the
          // window; the follow cursor keeps pointing at the newest event.
          const merged = new Map(
            eventsRef.current.map((event) => [event.id, event]),
          )
          for (const event of result.events) merged.set(event.id, event)
          setEvents([...merged.values()].sort((a, b) => a.id - b.id))
        } else setEvents(result.events)
        if (mode !== 'older')
          cursor.current = result.hasNewer
            ? result.events.at(-1)?.id
            : result.newestId
        setSnapshot(
          mode === 'follow' &&
            eventsRef.current.length &&
            result.oldestId !== undefined
            ? { ...result, hasOlder: eventsRef.current[0].id > result.oldestId }
            : result,
        )
        const visible = new Set(eventsRef.current.map((event) => event.id))
        setDetails(
          (value) =>
            new Map(
              [...value].filter(
                ([id]) => visible.has(id) && wantedDetails.current.has(id),
              ),
            ),
        )
      } catch (cause) {
        if (active.current && current === generation.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (active.current && current === generation.current) {
          setLoading(false)
          if (followPending.current) {
            followPending.current = false
            scheduleFollow()
          }
        }
      }
    },
    [
      cancel,
      request,
      scheduleFollow,
      setDetails,
      setError,
      setEvents,
      setLoading,
      setLiveValue,
      setSnapshot,
    ],
  )
  loadRef.current = load
  const keepDetails = useCallback(
    (ids: number[]) => {
      wantedDetails.current = new Set(ids.slice(0, 2))
      setDetails(
        (value) =>
          new Map([...value].filter(([id]) => wantedDetails.current.has(id))),
      )
    },
    [setDetails],
  )
  const loadDetails = useCallback(
    async (event: CapturedMtprotoEvent): Promise<void> => {
      if (!event.payloadOmitted || detailsRef.current.has(event.id)) return
      const pending = detailJobs.current.get(event.id)
      if (pending) return pending
      const current = generation.current
      const task = (async () => {
        try {
          const result = await request(
            new URLSearchParams({ id: String(event.id), limit: '1' }),
            true,
          )
          if (
            !active.current ||
            current !== generation.current ||
            !wantedDetails.current.has(event.id)
          )
            return
          const detail = result.events.find((item) => item.id === event.id)
          if (!detail)
            throw new Error('This event has expired from the capture buffer.')
          setDetails((value) => new Map(value).set(event.id, detail))
        } catch (cause) {
          if (
            active.current &&
            current === generation.current &&
            wantedDetails.current.has(event.id)
          )
            setError(cause instanceof Error ? cause.message : String(cause))
        }
      })()
      detailJobs.current.set(event.id, task)
      await task
      if (detailJobs.current.get(event.id) === task)
        detailJobs.current.delete(event.id)
    },
    [request, setDetails, setError],
  )
  const filtersKey = JSON.stringify(filters)
  useEffect(() => {
    cancel()
    clearTimeout(debounce.current)
    if (!enabled || !endpoint) return
    setEvents([])
    setDetails(new Map())
    wantedDetails.current.clear()
    cursor.current = undefined
    setSnapshot(undefined)
    setError('')
    debounce.current = setTimeout(
      () => void load('latest'),
      initial.current ? 0 : 200,
    )
    initial.current = false
    // `filtersKey` is the value-equality source of truth, like the original
    // effect that tracked `JSON.stringify(filters())`.
  }, [
    cancel,
    enabled,
    endpoint,
    filtersKey,
    load,
    setDetails,
    setError,
    setEvents,
    setSnapshot,
  ])
  useEffect(() => {
    active.current = true
    const visibility = () => {
      if (document.hidden) clearTimeout(followTimer.current)
      else if (liveRef.current) void loadRef.current('follow')
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      active.current = false
      cancel()
      clearTimeout(debounce.current)
      document.removeEventListener('visibilitychange', visibility)
      wantedDetails.current.clear()
    }
  }, [cancel])
  useEffect(() => {
    // The first revision belongs to the initial page load; later ones mean the
    // server buffer changed and the follow fetch should catch up once.
    if (revision === lastRevision.current) return
    lastRevision.current = revision
    scheduleFollow()
  }, [revision, scheduleFollow])
  const setLiveMode = useCallback(
    (value: boolean) => {
      setLiveValue(value)
      if (value) void load('latest')
      else clearTimeout(followTimer.current)
    },
    [load, setLiveValue],
  )
  return {
    get events() {
      return eventsRef.current
    },
    get snapshot() {
      return snapshotRef.current
    },
    get loading() {
      return loadingRef.current
    },
    get error() {
      return errorRef.current
    },
    get live() {
      return liveRef.current
    },
    get details() {
      return detailsRef.current
    },
    load,
    loadDetails,
    keepDetails,
    setLive: setLiveMode,
  }
}
