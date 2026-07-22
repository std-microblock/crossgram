import type { Context } from 'cordis'
import { computed, defineComponent, h, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
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

const EventRow = defineComponent({
  name: 'MtprotoEventRow',
  props: {
    event: { type: Object as () => CapturedMtprotoEvent, required: true },
  },
  setup(props) {
    const expanded = ref(false)
    return () => {
      const event = props.event
      const direction = event.direction === 'client->server' ? 'C -> S' : 'S -> C'
      return h('article', { class: ['debug-event', `direction-${event.direction.replace('->', '-')}`] }, [
        h('button', {
          type: 'button', class: 'event-header', 'aria-expanded': expanded.value,
          onClick: () => { expanded.value = !expanded.value },
        }, [
          h('span', { class: ['event-chevron', { expanded: expanded.value }] }, '\u203a'),
          h('time', { datetime: new Date(event.timestamp).toISOString() }, formatTime(event.timestamp)),
          h('span', { class: 'direction-label' }, direction),
          h('code', { class: 'event-name', title: event.name }, event.name),
          h('code', { class: 'connection-id' }, event.connectionId),
          h('span', { class: 'event-phase' }, event.phase),
        ]),
        expanded.value && h('div', { class: 'event-detail' }, [
          h(JsonNode, { value: eventForDisplay(event), depth: 0 }),
        ]),
      ])
    }
  },
})

const DebugPage = defineComponent({
  name: 'MtprotoDebugPage',
  setup() {
    const data = useRpc<MtprotoDebugData>()
    const filter = ref('')
    const busy = ref(false)
    const error = ref('')
    const visibleEvents = computed(() => {
      const terms = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (!terms.length) return data.value.events
      return data.value.events.filter(event => terms.every(term => event.searchText.includes(term)))
    })

    const run = async (action: 'start' | 'pause' | 'clear') => {
      busy.value = true
      error.value = ''
      try {
        await data.value[action]()
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
            h('span', `${visibleEvents.value.length} / ${data.value.events.length}`),
            data.value.dropped > 0 && h('span', `${data.value.dropped} dropped`),
            h('span', { class: ['capture-state', { active: data.value.capturing }] }, data.value.capturing ? 'capturing' : 'paused'),
          ]),
          error.value && h('span', { class: 'control-error', title: error.value }, error.value),
        ]),
        default: () => h('main', { class: 'debug-stream' }, [
          visibleEvents.value.length
            ? visibleEvents.value.map(event => h(EventRow, { key: event.id, event }))
            : h('div', { class: 'empty-state' }, filter.value ? 'No matching MTProto events.' : 'No MTProto events captured.'),
        ]),
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

function eventForDisplay(event: CapturedMtprotoEvent): Omit<CapturedMtprotoEvent, 'searchText'> {
  const { searchText: _searchText, ...visible } = event
  return visible
}
