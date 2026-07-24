/** @jsxImportSource vue */
/** @jsxRuntime automatic */

import type { Context } from 'cordis'
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, resolveComponent, Teleport, watch } from 'vue'
import { useRpc } from '@cordisjs/client'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { countGroupedEvents, filterEventGroups, getRpcResultMetrics, groupRpcEvents } from '../src/event-groups.js'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import './style.css'

const JsonNode = defineComponent({
  name: 'MtprotoJsonNode',
  props: {
    name: { type: String, default: '' },
    value: { required: false },
    depth: { type: Number, default: 0 },
  },
  setup(props) {
    const expanded = ref(props.depth === 0)
    return () => {
      const value = props.value as unknown
      const prefix = props.name
        ? <><span class="json-key">{props.name}</span><span>: </span></>
        : null
      if (value === null) {
        return <div class="json-line">{prefix}<span class="json-null">null</span></div>
      }
      if (Array.isArray(value) || (typeof value === 'object' && value)) {
        const entries = Object.entries(value as Record<string, unknown>)
        const open = Array.isArray(value) ? '[' : '{'
        const close = Array.isArray(value) ? ']' : '}'
        return <div class="json-node">
          <button
            class="json-toggle"
            type="button"
            aria-expanded={expanded.value}
            onClick={() => { expanded.value = !expanded.value }}
          >
            <span class={['json-chevron', { expanded: expanded.value }]}>{'\u203a'}</span>
            {prefix}
            <span class="json-bracket">{open}</span>
            {!expanded.value && <span class="json-summary">
              {entries.length} {Array.isArray(value) ? 'items' : 'keys'}
            </span>}
            {!expanded.value && <span class="json-bracket">{close}</span>}
          </button>
          {expanded.value && <div class="json-children">
            {entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} depth={props.depth + 1} />)}
            <div class="json-line json-bracket">{close}</div>
          </div>}
        </div>
      }
      const type = typeof value
      const text = type === 'string' ? JSON.stringify(value) : String(value)
      return <div class="json-line">
        {prefix}
        <span class={`json-${type}`}>{text}</span>
      </div>
    }
  },
})

export const EventRow = defineComponent({
  name: 'MtprotoEventRow',
  props: {
    event: { type: Object as () => CapturedMtprotoEvent, required: true },
    result: { type: Object as () => CapturedMtprotoEvent, required: false },
    expanded: { type: Boolean, default: false },
  },
  emits: ['toggle', 'contextmenu'],
  setup(props, { emit }) {
    const showContextMenu = (mouseEvent: MouseEvent, target: CapturedMtprotoEvent) => {
      mouseEvent.preventDefault()
      mouseEvent.stopPropagation()
      emit('contextmenu', { mouseEvent, target })
    }
    return () => {
      const event = props.event
      const direction = event.direction === 'client->server' ? 'C -> S' : 'S -> C'
      const rpcMetrics = getRpcResultMetrics(event, props.result)
      return <article class={[
        'debug-event',
        `direction-${event.direction.replace('->', '-')}`,
        rpcMetrics && `rpc-${rpcMetrics.state}`,
      ]}>
        <button
          type="button"
          class="event-header"
          aria-expanded={props.expanded}
          onClick={() => emit('toggle')}
          onContextmenu={mouseEvent => showContextMenu(mouseEvent, event)}
        >
          <span class={['event-chevron', { expanded: props.expanded }]}>{'\u203a'}</span>
          <code class="event-name" title={event.name}>{event.name}</code>
          <time class="event-time" title="timestamp" datetime={new Date(event.timestamp).toISOString()}>{formatTime(event.timestamp)}</time>
          <span class="direction-label" title="direction">{direction}</span>
          <code class="event-connection" title="connection">{event.connectionId}</code>
          <code class="event-message" title="message id">{event.messageId ?? '\u2014'}</code>
          <code class="event-seq" title="sequence number">{event.seqNo === undefined ? '\u2014' : `seq:${event.seqNo}`}</code>
          <code class="event-auth" title="auth key id">{event.authKeyId ? `key:${event.authKeyId}` : '\u2014'}</code>
          <code class="event-session" title="session id">{event.sessionId ? `sid:${event.sessionId}` : '\u2014'}</code>
          {rpcMetrics
            ? <code
              class={['rpc-duration', `rpc-duration-${rpcMetrics.state}`]}
              title={`RPC returned in ${rpcMetrics.durationMs} ms`}
            >{formatDuration(rpcMetrics.durationMs)}</code>
            : <span class="rpc-duration-empty" aria-hidden="true">{`\u2014`}</span>}
          {props.result
            ? <code
              class={['rpc-result-summary', `rpc-result-${rpcMetrics?.state ?? 'ok'}`]}
              title={props.result.name}
              onContextmenu={mouseEvent => showContextMenu(mouseEvent, props.result!)}
            >result:{props.result.name}</code>
            : <span class="event-result-empty" aria-hidden="true">{'\u2014'}</span>}
          <span class="event-phase">{event.phase}</span>
        </button>
        {props.expanded && <div class="event-detail">
          <div class="payload-label">payload</div>
          <JsonNode value={event.payload} depth={0} />
          {event.error && <div class="event-error">{event.error}</div>}
          {props.result && <div class="rpc-result-detail">
            <div class="payload-label">result payload</div>
            <JsonNode value={props.result.payload} depth={0} />
            {props.result.error && <div class="event-error">{props.result.error}</div>}
          </div>}
        </div>}
      </article>
    }
  },
})

export const DebugPage = defineComponent({
  name: 'MtprotoDebugPage',
  setup() {
    const data = useRpc<MtprotoDebugData>()
    const filter = ref('')
    const busy = ref(false)
    const error = ref('')
    const expanded = ref(new Set<number>())
    const scrollElement = ref<HTMLElement | null>(null)
    const typeFilter = ref<{ mode: 'include' | 'exclude', value: string }>()
    const contextMenu = ref<{ x: number, y: number, event: CapturedMtprotoEvent }>()
    const autoScroll = ref(true)
    let lastScrollTop = 0

    const groups = computed(() => groupRpcEvents(data.value.events))
    const visibleGroups = computed(() => filterEventGroups(groups.value, filter.value, typeFilter.value))
    const visibleEventCount = computed(() => countGroupedEvents(visibleGroups.value))
    const virtualizer = useVirtualizer(computed(() => ({
      count: visibleGroups.value.length,
      getScrollElement: () => scrollElement.value,
      estimateSize: () => 44,
      getItemKey: (index: number) => visibleGroups.value[index]?.event.id ?? index,
      initialRect: { width: 1200, height: 600 },
      overscan: 12,
    })))
    const virtualRows = computed(() => virtualizer.value.getVirtualItems())

    const toggle = (id: number) => {
      const next = new Set(expanded.value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      expanded.value = next
    }
    const closeContextMenu = () => { contextMenu.value = undefined }
    const showContextMenu = (payload: { mouseEvent: MouseEvent, target: CapturedMtprotoEvent }) => {
      contextMenu.value = {
        x: Math.max(8, Math.min(payload.mouseEvent.clientX, window.innerWidth - 360)),
        y: Math.max(8, Math.min(payload.mouseEvent.clientY, window.innerHeight - 120)),
        event: payload.target,
      }
    }
    const applyTypeFilter = (mode: 'include' | 'exclude') => {
      if (!contextMenu.value) return
      typeFilter.value = { mode, value: contextMenu.value.event.name }
      closeContextMenu()
    }
    const isAtBottom = () => {
      const element = scrollElement.value
      return !element || element.scrollHeight - element.scrollTop - element.clientHeight <= 24
    }
    const onScroll = () => {
      const currentScrollTop = scrollElement.value?.scrollTop ?? 0
      autoScroll.value = currentScrollTop >= lastScrollTop && isAtBottom()
      lastScrollTop = currentScrollTop
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) autoScroll.value = false
    }
    const scrollToBottom = () => {
      const lastIndex = visibleGroups.value.length - 1
      if (lastIndex < 0 || !autoScroll.value) return
      virtualizer.value.scrollToIndex(lastIndex, { align: 'end' })
      const element = scrollElement.value
      if (element) element.scrollTop = element.scrollHeight
    }

    watch(scrollElement, (element, previous) => {
      previous?.removeEventListener('scroll', onScroll)
      previous?.removeEventListener('wheel', onWheel)
      element?.addEventListener('scroll', onScroll, { passive: true })
      element?.addEventListener('wheel', onWheel, { passive: true })
      lastScrollTop = element?.scrollTop ?? 0
      autoScroll.value = isAtBottom()
    }, { flush: 'post' })
    watch(() => data.value.events[data.value.events.length - 1]?.id, async () => {
      await nextTick()
      scrollToBottom()
    }, { flush: 'post' })
    onMounted(() => window.addEventListener('pointerdown', closeContextMenu))
    onBeforeUnmount(() => {
      scrollElement.value?.removeEventListener('scroll', onScroll)
      scrollElement.value?.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointerdown', closeContextMenu)
    })

    const run = async (action: 'start' | 'pause' | 'clear') => {
      busy.value = true
      error.value = ''
      try {
        await data.value[action]()
        if (action === 'clear') expanded.value = new Set()
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally {
        busy.value = false
      }
    }

    return () => {
      const Layout = resolveComponent('k-layout') as ReturnType<typeof defineComponent>
      const Icon = resolveComponent('k-icon') as ReturnType<typeof defineComponent>
      const content = visibleGroups.value.length
        ? <main ref={scrollElement} class="debug-virtual-viewport">
          <div class="debug-virtual-content" style={{ height: `${virtualizer.value.getTotalSize()}px` }}>
            {virtualRows.value.map((row) => {
              const group = visibleGroups.value[row.index]
              return <div
                key={String(row.key)}
                ref={element => virtualizer.value.measureElement(element as HTMLElement | null)}
                class="debug-virtual-row"
                data-index={row.index}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <EventRow
                  event={group.event}
                  result={group.result}
                  expanded={expanded.value.has(group.event.id)}
                  onToggle={() => toggle(group.event.id)}
                  onContextmenu={showContextMenu}
                />
              </div>
            })}
          </div>
        </main>
        : <div class="empty-state">{filter.value || typeFilter.value ? 'No matching MTProto events.' : 'No MTProto events captured.'}</div>

      return <>
        <Layout class="mtproto-debug-page">{
          {
            header: () => <div class="debug-toolbar">
              <button
                class={['capture-button', { active: data.value.capturing }]}
                type="button"
                disabled={busy.value}
                title={data.value.capturing ? 'Pause capture' : 'Start capture'}
                onClick={() => run(data.value.capturing ? 'pause' : 'start')}
              >
                <Icon name={data.value.capturing ? 'pause' : 'play'} />
                <span>{data.value.capturing ? 'Pause' : 'Start'}</span>
              </button>
              <label class="filter-field">
                <Icon name="search" />
                <input
                  value={filter.value}
                  type="search"
                  placeholder="Filter method, direction, payload..."
                  aria-label="Filter captured MTProto events"
                  onInput={event => { filter.value = (event.target as HTMLInputElement).value }}
                />
              </label>
              {typeFilter.value && <button
                class="type-filter-pill"
                type="button"
                title="Clear type filter"
                onClick={() => { typeFilter.value = undefined }}
              >
                <span>{typeFilter.value.mode === 'include' ? 'only' : 'exclude'}: {typeFilter.value.value}</span>
                <Icon name="close" />
              </button>}
              <button
                class="icon-button"
                type="button"
                disabled={busy.value || !data.value.events.length}
                title="Clear captured events"
                aria-label="Clear captured events"
                onClick={() => run('clear')}
              ><Icon name="trash" /></button>
              <div class="capture-stats">
                <span>{visibleEventCount.value} / {data.value.events.length}</span>
                {data.value.dropped > 0 && <span>{data.value.dropped} dropped</span>}
                <span class={['capture-state', { active: data.value.capturing }]}>{data.value.capturing ? 'capturing' : 'paused'}</span>
              </div>
              {error.value && <span class="control-error" title={error.value}>{error.value}</span>}
            </div>,
            default: () => content,
          }
        }</Layout>
        {contextMenu.value && <Teleport to="body">
          <div
            class="debug-context-menu"
            style={{ left: `${contextMenu.value.x}px`, top: `${contextMenu.value.y}px` }}
            onPointerdown={event => event.stopPropagation()}
          >
            <div class="context-menu-title">{contextMenu.value.event.name}</div>
            <button type="button" onClick={() => applyTypeFilter('include')}>Only {contextMenu.value.event.name}</button>
            <button type="button" onClick={() => applyTypeFilter('exclude')}>Exclude {contextMenu.value.event.name}</button>
          </div>
        </Teleport>}
      </>
    }
  },
})

export default function apply(ctx: Context): void {
  ctx.client.router.page({
    path: '/mtproto-debug',
    name: 'MTProto Debug',
    icon: 'activity:default',
    order: 120,
    component: DebugPage,
  })
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(2)} s`
}
