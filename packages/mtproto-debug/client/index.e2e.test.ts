// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import { chunkEvents, flattenChunks, replaceChunks } from '../src/chunks.js'

const rpcState = vi.hoisted(() => ({ data: undefined as unknown, current: undefined as unknown }))

vi.mock('@cordisjs/client', async () => {
  const { ref } = await import('vue')
  return {
    useRpc: () => {
      const current = ref(rpcState.data)
      rpcState.current = current
      return current
    },
  }
})

import { DebugPage, EventRow, formatDuration } from './index.js'

describe('MTProto debug client', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        if ((this as HTMLElement).classList.contains('debug-virtual-viewport')) return 600
        if ((this as HTMLElement).classList.contains('debug-virtual-row')) return 44
        return 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return 1_200
      },
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  beforeEach(() => {
    rpcState.data = debugData([])
  })

  it('keeps metadata in one row and expands only the paired payloads', async () => {
    const call = event(1, {
      messageId: '0x100', seqNo: 7, authKeyId: 'deadbeef', sessionId: '0x200',
      payload: { _: 'messages.getHistory', peer: { _: 'inputPeerSelf' } },
    })
    const result = event(2, {
      direction: 'server->client', name: 'rpc_result -> messages.messages',
      requestMessageId: '0x100', payload: { _: 'rpc_result', result: { _: 'messages.messages' } },
    })
    const Harness = defineComponent({
      setup() {
        const expanded = ref(false)
        return () => h(EventRow, {
          event: call,
          result,
          expanded: expanded.value,
          onToggle: () => { expanded.value = !expanded.value },
        })
      },
    })
    const wrapper = mount(Harness)
    const header = wrapper.get('.event-header')

    expect(wrapper.find('.event-meta').exists()).toBe(false)
    expect(header.find('.event-time').exists()).toBe(true)
    expect(header.get('.direction-label').text()).toBe('C -> S')
    expect(header.get('.event-connection').text()).toBe('conn-1')
    expect(header.get('.event-message').text()).toBe('0x100')
    expect(header.get('.event-seq').text()).toBe('seq:7')
    expect(header.get('.event-auth').text()).toBe('key:deadbeef')
    expect(header.get('.event-session').text()).toBe('sid:0x200')
    expect(header.get('.rpc-result-summary').text()).toContain('messages.messages')
    expect(header.get('.rpc-duration').text()).toBe('1 ms')
    expect(header.get('.rpc-duration').attributes('title')).toBe('RPC returned in 1 ms')
    expect(header.element.children).toHaveLength(12)
    expect(wrapper.find('.event-detail').exists()).toBe(false)

    await header.trigger('click')

    expect(wrapper.get('.event-detail').text()).toContain('messages.getHistory')
    expect(wrapper.get('.rpc-result-detail').text()).toContain('rpc_result')
    expect(wrapper.get('.rpc-result-detail').classes()).toContain('rpc-result-detail')
    expect(getComputedStyle(wrapper.get('.rpc-result-detail').element).filter).not.toContain('grayscale')
  })

  it('uses distinct row markers for slow results and returned RPC errors', () => {
    const call = event(1, { timestamp: 10_000, messageId: '0x1' })
    const fast = event(2, {
      timestamp: 10_025,
      direction: 'server->client',
      name: 'rpc_result -> boolTrue',
      requestMessageId: '0x1',
      payload: { _: 'rpc_result', result: { _: 'boolTrue' } },
    })
    const slowCall = event(3, { timestamp: 20_000, messageId: '0x2' })
    const slow = event(4, {
      timestamp: 22_345,
      direction: 'server->client',
      name: 'rpc_result -> messages.messages',
      requestMessageId: '0x2',
      payload: { _: 'rpc_result', result: { _: 'messages.messages' } },
    })
    const errorCall = event(5, { timestamp: 30_000, messageId: '0x3' })
    const error = event(6, {
      timestamp: 34_500,
      direction: 'server->client',
      name: 'rpc_result -> mt_rpc_error',
      requestMessageId: '0x3',
      payload: {
        _: 'rpc_result',
        result: { _: 'mt_rpc_error', errorCode: 400, errorMessage: 'BAD_REQUEST' },
      },
    })

    const fastRow = mount(EventRow, { props: { event: call, result: fast } })
    const slowRow = mount(EventRow, { props: { event: slowCall, result: slow } })
    const errorRow = mount(EventRow, { props: { event: errorCall, result: error } })

    expect(fastRow.get('.debug-event').classes()).toContain('rpc-ok')
    expect(fastRow.get('.rpc-duration').text()).toBe('25 ms')
    expect(slowRow.get('.debug-event').classes()).toContain('rpc-slow')
    expect(slowRow.get('.rpc-duration').classes()).toContain('rpc-duration-slow')
    expect(slowRow.get('.rpc-duration').text()).toBe('2.35 s')
    expect(errorRow.get('.debug-event').classes()).toContain('rpc-error')
    expect(errorRow.get('.debug-event').classes()).not.toContain('rpc-slow')
    expect(errorRow.get('.rpc-duration').classes()).toContain('rpc-duration-error')
    expect(errorRow.get('.rpc-result-summary').classes()).toContain('rpc-result-error')
    expect(errorRow.get('.rpc-result-summary').text()).toContain('mt_rpc_error')
  })

  it('formats sub-second and multi-second return times consistently', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(999)).toBe('999 ms')
    expect(formatDuration(1_000)).toBe('1.00 s')
    expect(formatDuration(12_345)).toBe('12.35 s')
  })

  it('virtualizes a large stream and keeps a correlated result at the call row', async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => event(index + 1, {
      messageId: `0x${(index + 1).toString(16)}`,
      name: index === 0 ? 'messages.getHistory' : `test.call${index}`,
    }))
    events.push(event(1_001, {
      direction: 'server->client', name: 'rpc_result -> messages.channelMessages',
      requestMessageId: '0x1', searchText: 'rpc_result messages.channelmessages server->client',
    }))
    rpcState.data = debugData(events)

    const wrapper = mount(DebugPage, {
      global: {
        stubs: {
          'k-layout': layoutStub,
          'k-icon': iconStub,
        },
      },
    })
    await nextTick()
    await nextTick()

    const renderedRows = wrapper.findAll('.debug-event')
    expect(wrapper.find('.debug-virtual-viewport').exists()).toBe(true)
    expect(renderedRows.length).toBeGreaterThan(0)
    expect(renderedRows.length).toBeLessThan(100)
    expect(wrapper.findAll('.rpc-result-summary')).toHaveLength(1)
    expect(wrapper.findAll('.event-name').map(node => node.text())).not.toContain('rpc_result -> messages.channelMessages')

    await wrapper.get('.event-header').trigger('click')
    await nextTick()

    expect(wrapper.find('.event-detail').exists()).toBe(true)
    expect(wrapper.findAll('.debug-event').length).toBeLessThan(100)
  })

  it('opens type actions on right click and applies an exact-only filter', async () => {
    rpcState.data = debugData([
      event(1, { name: 'messages.getHistory' }),
      event(2, { name: 'updates.getState' }),
    ])
    const wrapper = mount(DebugPage, {
      global: { stubs: { 'k-layout': layoutStub, 'k-icon': iconStub } },
    })
    await nextTick()

    await wrapper.get('.event-header').trigger('contextmenu', { clientX: 30, clientY: 40 })
    await nextTick()
    const menu = document.body.querySelector('.debug-context-menu') as HTMLElement
    expect(menu).not.toBeNull()
    expect(wrapper.find('.debug-context-menu').exists()).toBe(false)
    expect(menu.getAttribute('style')).toContain('left: 30px')
    expect(menu.textContent).toContain('Only messages.getHistory')
    expect(menu.textContent).toContain('Exclude messages.getHistory')

    menu.querySelector('button')!.click()
    await nextTick()

    expect(wrapper.get('.type-filter-pill').text()).toContain('only: messages.getHistory')
    expect(wrapper.findAll('.event-name').map(node => node.text())).toEqual(['messages.getHistory'])
  })

  it('follows new events only while the user remains at the bottom', async () => {
    rpcState.data = debugData(Array.from({ length: 50 }, (_, index) => event(index + 1)))
    const wrapper = mount(DebugPage, {
      global: { stubs: { 'k-layout': layoutStub, 'k-icon': iconStub } },
    })
    await nextTick()
    const viewport = wrapper.get('.debug-virtual-viewport').element as HTMLElement
    const scrollHeight = 2_200
    let scrollTop = 0
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = Math.max(0, Math.min(Number(value), scrollHeight - 600)) },
    })

    viewport.scrollTop = 1_585
    viewport.dispatchEvent(new Event('scroll'))
    rotateEvent(debugRef(), event(51))
    await nextTick()
    await nextTick()
    expect(viewport.scrollTop).toBe(1_600)

    viewport.scrollTop = 1_200
    viewport.dispatchEvent(new Event('scroll'))
    rotateEvent(debugRef(), event(52))
    await nextTick()
    await nextTick()
    expect(viewport.scrollTop).toBe(1_200)
  })
})

const layoutStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', [h('header', slots.header?.()), h('section', slots.default?.())])
  },
})

const iconStub = defineComponent({
  setup() {
    return () => h('i', { class: 'k-icon' })
  },
})

function debugData(events: CapturedMtprotoEvent[]): MtprotoDebugData {
  return {
    chunks: chunkEvents(events),
    dropped: 0,
    maxEvents: 2_000,
    capturing: true,
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }
}

/** Drop the oldest event and append a new one, keeping the buffer length stable. */
function rotateEvent(data: MtprotoDebugData, next: CapturedMtprotoEvent): void {
  const events = flattenChunks(data.chunks)
  events.shift()
  events.push(next)
  replaceChunks(data.chunks, events)
}

function debugRef(): MtprotoDebugData {
  return (rpcState.current as Ref<MtprotoDebugData>).value
}

function event(id: number, overrides: Partial<CapturedMtprotoEvent> = {}): CapturedMtprotoEvent {
  const name = overrides.name ?? 'messages.getHistory'
  return {
    id,
    timestamp: 1_900_000_000_000 + id,
    direction: 'client->server',
    phase: 'message',
    connectionId: 'conn-1',
    name,
    payload: { _: name },
    searchText: `${name} client->server conn-1`.toLowerCase(),
    ...overrides,
  }
}
