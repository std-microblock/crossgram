import type { Context } from 'cordis'
import { computed, defineComponent, h, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { countGroupedEvents, filterEventGroups, groupRpcEvents } from '../src/event-groups.js'
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
      const prefix = props.name ? [h('span', { class: 'json-key' }, props.name), h('span', ': ')] : []
      if (value === null) return h('div', { class: 'json-line' }, [...prefix, h('span', { class: 'json-null' }, 'null')])
      if (Array.isArray(value) || (typeof value === 'object' && value)) {
        const entries = Object.entries(value as Record<string, unknown>)
        const open = Array.isArray(value) ? '[' : '{'
        const close = Array.isArray(value) ? ']' : '}'
        return h('div', { class: 'json-node' }, [
          h('button', {
            class: 'json-toggle', type: 'button',
            'aria-expanded': expanded.value,
            onClick: () => { expanded.value = !expanded.value },
          }, [
            h('span', { class: ['json-chevron', { expanded: expanded.value }] }, '\u203a'),
            ...prefix,
            h('span', { class: 'json-bracket' }, open),
            !expanded.value && h('span', { class: 'json-summary' }, `${entries.length} ${Array.isArray(value) ? 'items' : 'keys'}`),
            !expanded.value && h('span', { class: 'json-bracket' }, close),
          ]),
          expanded.value && h('div', { class: 'json-children' }, [
            ...entries.map(([key, item]) => h(JsonNode, {
              key, name: key, value: item, depth: props.depth + 1,
            })),
            h('div', { class: 'json-line json-bracket' }, close),
          ]),
        ])
      }
      const type = typeof value
      const text = type === 'string' ? JSON.stringify(value) : String(value)
      return h('div', { class: 'json-line' }, [
        ...prefix,
        h('span', { class: `json-${type}` }, text),
      ])
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
  emits: ['toggle'],
  setup(props, { emit }) {
    return () => {
      const event = props.event
      const direction = event.direction === 'client->server' ? 'C -> S' : 'S -> C'
      return h('article', { class: ['debug-event', `direction-${event.direction.replace('->', '-')}`] }, [
        h('button', {
          type: 'button', class: 'event-header', 'aria-expanded': props.expanded,
          onClick: () => emit('toggle'),
        }, [
          h('span', { class: ['event-chevron', { expanded: props.expanded }] }, '\u203a'),
          h('code', { class: 'event-name', title: event.name }, event.name),
          h('time', { class: 'event-time', title: 'timestamp', datetime: new Date(event.timestamp).toISOString() }, formatTime(event.timestamp)),
          h('span', { class: 'direction-label', title: 'direction' }, direction),
          h('code', { class: 'event-connection', title: 'connection' }, event.connectionId),
          event.messageId && h('code', { class: 'event-message', title: 'message id' }, event.messageId),
          event.seqNo !== undefined && h('code', { class: 'event-seq', title: 'sequence number' }, `seq:${event.seqNo}`),
          event.authKeyId && h('code', { class: 'event-auth', title: 'auth key id' }, `key:${event.authKeyId}`),
          event.sessionId && h('code', { class: 'event-session', title: 'session id' }, `sid:${event.sessionId}`),
          props.result && h('code', { class: 'rpc-result-summary', title: props.result.name }, `result:${props.result.name}`),
          h('span', { class: 'event-phase' }, event.phase),
        ]),
        props.expanded && h('div', { class: 'event-detail' }, [
          h('div', { class: 'payload-label' }, 'payload'),
          h(JsonNode, { value: event.payload, depth: 0 }),
          event.error && h('div', { class: 'event-error' }, event.error),
          props.result && h('div', { class: 'rpc-result-detail' }, [
            h('div', { class: 'payload-label' }, 'result payload'),
            h(JsonNode, { value: props.result.payload, depth: 0 }),
            props.result.error && h('div', { class: 'event-error' }, props.result.error),
          ]),
        ]),
      ])
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
    const groups = computed(() => groupRpcEvents(data.value.events))
    const visibleGroups = computed(() => filterEventGroups(groups.value, filter.value))
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
      const Layout = resolveComponent('k-layout')
      const Icon = resolveComponent('k-icon')
      return h(Layout, { class: 'mtproto-debug-page' }, {
        header: () => h('div', { class: 'debug-toolbar' }, [
          h('button', {
            class: ['capture-button', { active: data.value.capturing }],
            type: 'button', disabled: busy.value,
            title: data.value.capturing ? 'Pause capture' : 'Start capture',
            onClick: () => run(data.value.capturing ? 'pause' : 'start'),
          }, [
            h(Icon, { name: data.value.capturing ? 'pause' : 'play' }),
            h('span', data.value.capturing ? 'Pause' : 'Start'),
          ]),
          h('label', { class: 'filter-field' }, [
            h(Icon, { name: 'search' }),
            h('input', {
              value: filter.value,
              type: 'search',
              placeholder: 'Filter method, direction, payload...',
              'aria-label': 'Filter captured MTProto events',
              onInput: (event: Event) => { filter.value = (event.target as HTMLInputElement).value },
            }),
          ]),
          h('button', {
            class: 'icon-button', type: 'button', disabled: busy.value || !data.value.events.length,
            title: 'Clear captured events', 'aria-label': 'Clear captured events',
            onClick: () => run('clear'),
          }, h(Icon, { name: 'trash' })),
          h('div', { class: 'capture-stats' }, [
            h('span', `${visibleEventCount.value} / ${data.value.events.length}`),
            data.value.dropped > 0 && h('span', `${data.value.dropped} dropped`),
            h('span', { class: ['capture-state', { active: data.value.capturing }] }, data.value.capturing ? 'capturing' : 'paused'),
          ]),
          error.value && h('span', { class: 'control-error', title: error.value }, error.value),
        ]),
        default: () => visibleGroups.value.length
          ? h('main', { ref: scrollElement, class: 'debug-virtual-viewport' }, [
            h('div', {
              class: 'debug-virtual-content',
              style: { height: `${virtualizer.value.getTotalSize()}px` },
            }, virtualRows.value.map(row => {
              const group = visibleGroups.value[row.index]
              return h('div', {
                key: row.key,
                ref: (element: unknown) => virtualizer.value.measureElement(element as HTMLElement | null),
                class: 'debug-virtual-row',
                'data-index': row.index,
                style: { transform: `translateY(${row.start}px)` },
              }, [
                h(EventRow, {
                  event: group.event,
                  result: group.result,
                  expanded: expanded.value.has(group.event.id),
                  onToggle: () => toggle(group.event.id),
                }),
              ])
            })),
          ])
          : h('div', { class: 'empty-state' }, filter.value ? 'No matching MTProto events.' : 'No MTProto events captured.'),
      })
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
