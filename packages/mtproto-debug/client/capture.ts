import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import type { MtprotoCaptureSnapshot } from '../src/capture-api.js'

export const CAPTURE_PAGE_SIZE = 100
export const CAPTURE_POLL_MS = 1_000

/** Page-scoped HTTP transport: no subscription or history exists outside this component. */
export function useCapturePages(
  data: Ref<MtprotoDebugData>,
  filter: Ref<string>,
  typeFilter: Ref<{ mode: 'include' | 'exclude', value: string } | undefined>,
) {
  const events = shallowRef<CapturedMtprotoEvent[]>([])
  const snapshot = shallowRef<MtprotoCaptureSnapshot>()
  const loading = ref(false)
  const error = ref('')
  const live = ref(true)
  const details = shallowRef(new Map<number, CapturedMtprotoEvent>())
  const controllers = new Set<AbortController>()
  let active = false
  let generation = 0
  let cursor: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined

  async function request(params: URLSearchParams): Promise<MtprotoCaptureSnapshot> {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(data.value.apiPath + '?' + params, {
        signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
      })
      if (!response.ok) throw new Error('Capture request failed: HTTP ' + response.status)
      return await response.json()
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }

  function cancel() {
    generation++
    for (const controller of controllers) controller.abort()
    controllers.clear()
    clearTimeout(timer)
    loading.value = false
  }

  function schedule() {
    clearTimeout(timer)
    if (active && live.value) timer = setTimeout(() => {
      if (document.hidden) schedule()
      else void load('poll')
    }, CAPTURE_POLL_MS)
  }

  async function load(mode: 'latest' | 'older' | 'newer' | 'poll' = 'latest') {
    if (!active || (mode === 'poll' && loading.value)) return
    if (mode !== 'poll') {
      cancel()
      live.value = mode === 'latest'
    }
    const current = generation
    loading.value = true
    error.value = ''
    const params = new URLSearchParams({ limit: String(CAPTURE_PAGE_SIZE), summary: 'true' })
    if (filter.value.trim()) params.set('grep', filter.value.trim())
    if (typeFilter.value) params.set(typeFilter.value.mode === 'include' ? 'typeName' : 'excludeName', typeFilter.value.value)
    if (mode === 'older' && events.value[0]) params.set('beforeId', String(events.value[0].id))
    if (mode === 'newer' && events.value.at(-1)) params.set('afterId', String(events.value.at(-1)!.id))
    if (mode === 'poll' && cursor !== undefined) params.set('afterId', String(cursor))
    try {
      const result = await request(params)
      if (!active || current !== generation) return
      snapshot.value = result
      if (mode === 'poll') {
        const retained = events.value.filter(event => result.oldestId !== undefined && event.id >= result.oldestId)
        const unique = new Map(retained.map(event => [event.id, event]))
        for (const event of result.events) unique.set(event.id, event)
        events.value = [...unique.values()].sort((a, b) => a.id - b.id).slice(-CAPTURE_PAGE_SIZE)
      } else {
        events.value = result.events
      }
      // Do not skip a forward page when more than 100 events arrived in a burst.
      cursor = result.hasNewer ? result.events.at(-1)?.id : result.newestId
      if (mode === 'poll' && events.value.length && result.oldestId !== undefined) {
        snapshot.value = { ...result, hasOlder: events.value[0].id > result.oldestId }
      }
      const retainedIds = new Set(events.value.map(event => event.id))
      details.value = new Map([...details.value].filter(([id]) => retainedIds.has(id)))
    } catch (cause) {
      if (active && current === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (active && current === generation) {
        loading.value = false
        schedule()
      }
    }
  }

  async function loadDetails(event: CapturedMtprotoEvent) {
    if (!event.payloadOmitted || details.value.has(event.id)) return
    const current = generation
    try {
      const result = await request(new URLSearchParams({ id: String(event.id), limit: '1' }))
      if (!active || current !== generation) return
      const detail = result.events.find(item => item.id === event.id)
      if (!detail) throw new Error('This event has expired from the capture buffer.')
      details.value = new Map(details.value).set(event.id, detail)
    } catch (cause) {
      if (active && current === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  watch([filter, typeFilter], () => {
    cancel()
    clearTimeout(debounce)
    // Do not keep showing stale search results while the new request is pending.
    events.value = []
    details.value = new Map()
    debounce = setTimeout(() => void load('latest'), 200)
  })
  onMounted(() => {
    active = true
    void load('latest')
  })
  onBeforeUnmount(() => {
    active = false
    cancel()
    clearTimeout(debounce)
    events.value = []
    details.value = new Map()
  })
  return { events, snapshot, loading, error, live, details, load, loadDetails }
}
